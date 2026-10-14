import { Firestore, Timestamp } from 'firebase-admin/firestore';
import { withLegacyAdmissionLease } from './legacyAdmissionLease';

// Synthetic native snapshots exercise a late platform delivery without backdating
// a real Firestore document or treating a client clock as production authority.
function harness() {
  const cutoff = new Timestamp(1000, 123456789);
  const source = { sermonId: 'original', uploaderId: 'owner', sourceStartTime: 0, trimDurationSeconds: 20 };
  const records: Record<string, Record<string, any>> = {
    '_control/temporalRelease': {
      schemaVersion: 1,
      revision: 1,
      releaseId: 'release',
      updatedAt: 1,
      admission: 'paused',
      domains: { media: { owner: 'legacy', admission: 'paused' } },
      legacyAdmissionCutoff: cutoff,
    },
    '_control/temporalReleaseState': {
      releaseId: 'release',
      mode: 'initial-cutover',
      legacySettlingCutoff: cutoff,
      compatibilityVerifiedAt: cutoff,
      legacySettlingGraceSeconds: 3600,
      maximumLegacyExecutionSeconds: 3570,
    },
    'sermons/original': {
      uploaderId: 'owner',
      sourceStartTime: 0,
      trimDurationSeconds: 20,
      status: { audioStatus: 'PENDING' },
    },
  };
  let sourceCreated = new Timestamp(900, 0);
  const ref = (path: string) => ({ path });
  const tx = {
    get: jest.fn(async ({ path }: { path: string }) => ({
      exists: !!records[path],
      data: () => records[path],
      createTime: path === 'sermons/original' ? sourceCreated : new Timestamp(100, 0),
      readTime: new Timestamp(9000, 0),
      get: (key: string) => key.split('.').reduce<any>((value, part) => value?.[part], records[path]),
    })),
    create: jest.fn(({ path }: { path: string }, value: Record<string, any>) => {
      records[path] = value;
    }),
    update: jest.fn(({ path }: { path: string }, value: Record<string, any>) => {
      Object.assign(records[path], value);
    }),
  };
  const db = {
    doc: ref,
    collection: (path: string) => ({ doc: (id: string) => ref(`${path}/${id}`) }),
    runTransaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  } as unknown as Firestore;
  const options = {
    projectId: 'project',
    domain: 'media',
    actorUid: 'system:firebase-event',
    operation: 'sermonaudiocreatetrigger',
    legacySourceUpload: source,
  };
  return {
    db,
    tx,
    records,
    options,
    created: (value: Timestamp) => {
      sourceCreated = value;
    },
  };
}
it('finishes the original pre-cutoff canonical admission when its first platform event arrives after grace', async () => {
  const h = harness(),
    effect = jest.fn(async (lease) => {
      await lease.markEffectsStarted();
      return 'done';
    });
  await expect(withLegacyAdmissionLease(h.db, h.options, effect)).resolves.toBe('done');
  expect(effect).toHaveBeenCalledTimes(1);
  const leases = Object.entries(h.records).filter(([path]) => path.startsWith('legacyAdmissionLeases/'));
  expect(leases).toHaveLength(1);
  expect(leases[0][1]).toMatchObject({ state: 'completed', effectsStarted: true, legacySourceSermonId: 'original' });
});
it('does not extend this exception to an ordinary fresh listener continuation', async () => {
  const h = harness(),
    effect = jest.fn();
  await expect(
    withLegacyAdmissionLease(h.db, { ...h.options, legacySourceUpload: undefined, continuation: true }, effect)
  ).rejects.toMatchObject({ code: 'unavailable' });
  expect(effect).not.toHaveBeenCalled();
  expect(h.tx.create).not.toHaveBeenCalled();
});
it.each(['PROCESSING', 'PROCESSED'])('rejects source replays after canonical status becomes %s', async (status) => {
  const h = harness(),
    effect = jest.fn();
  h.records['sermons/original'].status.audioStatus = status;
  await expect(withLegacyAdmissionLease(h.db, h.options, effect)).rejects.toMatchObject({ code: 'aborted' });
  expect(effect).not.toHaveBeenCalled();
  expect(h.tx.create).not.toHaveBeenCalled();
});
it('rejects a source created after cutoff instead of exempting an arbitrary pending row', async () => {
  const h = harness(),
    effect = jest.fn();
  h.created(new Timestamp(1000, 123456790));
  await expect(withLegacyAdmissionLease(h.db, h.options, effect)).rejects.toMatchObject({ code: 'aborted' });
  expect(effect).not.toHaveBeenCalled();
  expect(h.tx.create).not.toHaveBeenCalled();
});
it.each(['owner', 'selection', 'operation', 'checkpoint', 'durable'])(
  'rejects a changed %s before the typed exception',
  async (change) => {
    const h = harness(),
      effect = jest.fn();
    if (change === 'owner') h.records['sermons/original'].uploaderId = 'other';
    if (change === 'selection') h.records['sermons/original'].trimDurationSeconds = 21;
    if (change === 'operation') h.options.operation = 'arbitrary';
    if (change === 'checkpoint')
      h.records['_control/temporalReleaseState'].compatibilityVerifiedAt = new Timestamp(1001, 0);
    if (change === 'durable') h.records['sermons/original'].activeDurableJobs = { audio: { jobId: 'durable' } };
    await expect(withLegacyAdmissionLease(h.db, h.options, effect)).rejects.toBeDefined();
    expect(effect).not.toHaveBeenCalled();
    expect(h.tx.create).not.toHaveBeenCalled();
  }
);
