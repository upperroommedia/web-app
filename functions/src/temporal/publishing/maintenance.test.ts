jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    auth: () => ({ getUser: mockGetUser }),
    firestore: () => {
      throw new Error('Unexpected Firestore access');
    },
  },
}));
jest.mock('../../helpers/backfillSeriesItemSubtitles', () => ({ runSeriesItemSubtitleBackfill: jest.fn() }));
jest.mock('../../helpers/backfillListOverflowMetadata', () => ({ runListOverflowMetadataBackfill: jest.fn() }));
jest.mock('../../speakers/speakerMutations', () => ({
  requireSquareImage: jest.fn(),
  requireTrimmedSpeakerName: jest.fn(),
  updateSubsplashSpeakerTagSquareImage: jest.fn(),
}));

import {
  createMaintenancePageExecutor,
  executeMaintenancePage,
  normalizeMaintenanceInput,
  type MaintenanceDependencies,
  type MaintenanceRef,
  type MaintenanceInput,
} from './maintenance';

const mockGetUser = jest.fn();
const ref = { jobId: 'job-1', projectId: 'urm-app-staging' };
const input = normalizeMaintenanceInput({ operation: 'series-subtitles', pageSize: 2 });

function harness() {
  const records = new Map<string, unknown>();
  const authorize = jest.fn(async () => {});
  const list = jest.fn(async () => ({ ids: ['a', 'b'], done: false }));
  const process = jest.fn(async (_id: string, _ref: MaintenanceRef, _input: MaintenanceInput) => ({
    planned: 1,
    updated: 0,
    skipped: 0,
  }));
  const checkpoint: MaintenanceDependencies['checkpoint'] = async (id, update) => {
    const next = update(records.get(id) as Parameters<typeof update>[0]);
    if (next.record) records.set(id, structuredClone(next.record));
    return next.value;
  };
  const deps: MaintenanceDependencies = {
    authorize,
    list,
    process,
    checkpoint,
    now: () => 100,
    owner: () => 'owner-1',
  };
  return { records, authorize, list, process, deps, execute: createMaintenancePageExecutor(deps) };
}

describe('maintenance input', () => {
  it('defaults to dry-run and returns an immutable whitelist intent', () => {
    const normalized = normalizeMaintenanceInput({ operation: 'speaker-tag-images' });
    expect(normalized).toEqual({ operation: 'speaker-tag-images', apply: false, pageSize: 25 });
    expect(Object.isFrozen(normalized)).toBe(true);
  });
  it.each([
    null,
    [],
    { operation: 'delete-all' },
    { operation: 'sermon-status', apply: 'true' },
    { operation: 'sermon-status', pageSize: 26 },
    { operation: 'sermon-status', pageSize: 0 },
    { operation: 'sermon-status', pageSize: 1.5 },
    { operation: 'sermon-status', cursor: '../bad' },
    { operation: 'sermon-status', collection: 'users' },
  ])('rejects unsafe or unbounded input %p', (raw) => {
    expect(() => normalizeMaintenanceInput(raw)).toThrow('Invalid maintenance intent');
  });
});

describe('maintenance page durability', () => {
  it('returns bounded cumulative counts and caches completed pages', async () => {
    const h = harness();
    const first = await h.execute(ref, 'actor', input);
    expect(first).toEqual({
      counts: { scanned: 2, planned: 2, updated: 0, skipped: 0 },
      processedIds: ['a', 'b'],
      nextCursor: 'b',
      done: false,
    });
    expect(await h.execute(ref, 'actor', input)).toEqual(first);
    expect(h.process).toHaveBeenCalledTimes(2);
    expect(h.authorize).toHaveBeenCalledTimes(2);
    expect(h.list).toHaveBeenCalledTimes(1);
  });
  it('resumes after the last successful entity without relisting or replaying it', async () => {
    const h = harness();
    h.process
      .mockImplementationOnce(async () => ({ planned: 1, updated: 0, skipped: 0 }))
      .mockRejectedValueOnce(new Error('secret provider response'));
    await expect(h.execute(ref, 'actor', input)).rejects.toThrow('Maintenance could not complete');
    h.list.mockResolvedValue({ ids: ['new-id'], done: true });
    const result = await h.execute(ref, 'actor', input);
    expect(h.process.mock.calls.map((call) => call[0])).toEqual(['a', 'b', 'b']);
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(result.counts.scanned).toBe(2);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('cannot change dry-run to apply within the same page/job identity', async () => {
    const h = harness();
    await h.execute(ref, 'actor', input);
    await expect(h.execute(ref, 'actor', { ...input, apply: true })).rejects.toThrow('intent cannot change');
    expect(h.process).toHaveBeenCalledTimes(2);
  });
  it('starts a fresh bounded page at the explicit cursor', async () => {
    const h = harness();
    await h.execute(ref, 'actor', input);
    h.list.mockResolvedValue({ ids: ['c'], done: true });
    const result = await h.execute(ref, 'actor', { ...input, cursor: 'b' });
    expect(result.done).toBe(true);
    expect(result.nextCursor).toBeUndefined();
    expect(result.processedIds).toEqual(['c']);
  });
  it('does not perform provider work when current permission was revoked', async () => {
    const h = harness();
    h.authorize.mockRejectedValue(new Error('revoked'));
    await expect(h.execute(ref, 'actor', input)).rejects.toThrow('revoked');
    expect(h.records.size).toBe(0);
    expect(h.process).not.toHaveBeenCalled();
  });
  it('rejects unsafe IDs from a candidate page before provider work', async () => {
    const h = harness();
    h.list.mockResolvedValue({ ids: ['nested/id'], done: true });
    await expect(h.execute(ref, 'actor', input)).rejects.toThrow('Maintenance could not complete');
    expect(h.process).not.toHaveBeenCalled();
  });
  it('does not allow a concurrent activity to replay a running page', async () => {
    const h = harness();
    let release!: () => void;
    h.process.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ planned: 1, updated: 0, skipped: 0 });
        })
    );
    const first = h.execute(ref, 'actor', input);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    await expect(h.execute(ref, 'actor', input)).rejects.toThrow('already running');
    release();
    await first;
    expect(h.process).toHaveBeenCalledTimes(2);
  });
});

describe('canonical maintenance authorization', () => {
  beforeEach(() => mockGetUser.mockReset());
  it.each([
    { uid: 'actor', customClaims: { role: 'publisher' }, emailVerified: true, email: 'youssef.a.asaad@gmail.com' },
    { uid: 'actor', customClaims: { role: 'admin' }, emailVerified: false, email: 'youssef.a.asaad@gmail.com' },
    { uid: 'actor', customClaims: { role: 'admin' }, emailVerified: true, email: 'other@example.com' },
    {
      uid: 'actor',
      disabled: true,
      customClaims: { role: 'admin' },
      emailVerified: true,
      email: 'youssef.a.asaad@gmail.com',
    },
  ])('denies unauthorized restricted script runner %p', async (actor) => {
    mockGetUser.mockResolvedValue(actor);
    await expect(
      executeMaintenancePage(ref, 'actor', normalizeMaintenanceInput({ operation: 'sermon-status' }))
    ).rejects.toThrow('authorized administrator');
  });
  it('denies nonadmin subtitle maintenance', async () => {
    mockGetUser.mockResolvedValue({ uid: 'actor', customClaims: { role: 'publisher' } });
    await expect(executeMaintenancePage(ref, 'actor', input)).rejects.toThrow('authorized administrator');
  });
});
