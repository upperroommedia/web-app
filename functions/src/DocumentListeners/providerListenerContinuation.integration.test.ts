import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { Timestamp, FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  runLegacyProviderListener,
  LEGACY_PROVIDER_LISTENER_RECEIPTS,
  parseProviderEventTime,
} from './providerListenerContinuation';
import type { ProviderListenerEvent } from './providerListenerContinuation';
import {
  withLegacyAdmissionLease,
  type LegacyAdmissionLease,
  type LegacyAdmissionLeaseOptions,
} from '../temporal/legacyAdmissionLease';

let mockAfterEffectsMarker: (() => Promise<void>) | undefined;
jest.mock('../temporal/legacyAdmissionLease', () => {
  const actual = jest.requireActual<typeof import('../temporal/legacyAdmissionLease')>(
    '../temporal/legacyAdmissionLease'
  );
  return {
    ...actual,
    withLegacyAdmissionLease: (
      firestore: Firestore,
      options: LegacyAdmissionLeaseOptions,
      callback: (lease: LegacyAdmissionLease) => Promise<unknown>
    ) =>
      actual.withLegacyAdmissionLease(firestore, options, (lease) =>
        callback({
          ...lease,
          async markEffectsStarted() {
            await lease.markEffectsStarted();
            await mockAfterEffectsMarker?.();
          },
        })
      ),
  };
});

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (_options: unknown, handler: unknown) => handler,
  onDocumentDeleted: (_options: unknown, handler: unknown) => handler,
}));
jest.mock('../removeFromList', () => ({ removeFromList: jest.fn() }));
jest.mock('../helpers/seriesHelpers', () => ({
  getSeriesSubtitleFromPublishedCount: (count: number) => `${count} part series`,
  patchSeriesMetadata: jest.fn(),
}));
jest.mock('../subsplashUtils', () => ({ authenticateSubsplash: jest.fn(async () => 'test-token') }));
jest.mock('../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: async (_keys: string[], run: () => Promise<unknown>) => run(),
}));
jest.mock('../handleError', () => ({ __esModule: true, default: (error: unknown) => error }));
import { removeFromList } from '../removeFromList';
import { patchSeriesMetadata } from '../helpers/seriesHelpers';
import sermonListOnDelete from './SermonLists/sermonListOnDelete';
import {
  handleSeriesItemWrite,
  deriveCurrentSeriesMetadata,
  SERIES_METADATA_CONTINUATIONS,
} from './Series/seriesItemOnWrite';

const remoteSeries = {
  id: 'remote-series',
  app_key: 'test-app',
  title: 'Test series',
  slug: 'test-series',
  media_items_count: 1,
  published_media_items_count: 1,
  display_type: 'list',
  status: 'draft' as const,
  short_code: 'test',
  is_default: false,
  position: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  _links: { self: { href: 'https://example.test/series' }, 'media-items': { href: 'https://example.test/items' } },
};

const db = firebaseAdmin.firestore(),
  projectId = firebaseAdmin.app().options.projectId!;
const control = db.doc('_control/temporalRelease'),
  barrier = db.doc('_control/temporalProviderUsage');
const parent = db.doc('series/provider-listener-fence');
const releaseState = db.doc('_control/temporalReleaseState');
async function compatibilityCutoff(cutoff?: Timestamp) {
  const stamp = cutoff ?? FieldValue.serverTimestamp(),
    batch = db.batch();
  batch.update(control, {
    admission: 'paused',
    'domains.publishing.admission': 'paused',
    legacyAdmissionCutoff: stamp,
  });
  batch.set(releaseState, {
    mode: 'initial-cutover',
    releaseId: 'listener-fence-test',
    legacySettlingCutoff: stamp,
    compatibilityVerifiedAt: stamp,
    legacySettlingGraceSeconds: 3600,
    maximumLegacyExecutionSeconds: 540,
  });
  await batch.commit();
}
let event: ProviderListenerEvent;
const wireTime = (value: Timestamp) =>
  `${new Date(value.seconds * 1000).toISOString().slice(0, 19)}.${String(value.nanoseconds).padStart(9, '0')}Z`;
const effect = jest.fn<Promise<void>, [string]>();
const execute = (overrides: Partial<Parameters<typeof runLegacyProviderListener>[0]> = {}) =>
  runLegacyProviderListener({
    firestore: db,
    projectId,
    operation: 'seriesItemOnWrite',
    entityPath: parent.path,
    event,
    validateCurrent: async (tx) => {
      const current = await tx.get(parent);
      return current.exists;
    },
    effect,
    ...overrides,
  });
beforeEach(async () => {
  jest.clearAllMocks();
  mockAfterEffectsMarker = undefined;
  effect.mockResolvedValue(undefined);
  jest
    .mocked(removeFromList)
    .mockResolvedValue([{ listId: 'remote-list', status: 'success', listItemId: 'remote-row' }]);
  jest.mocked(patchSeriesMetadata).mockReset().mockResolvedValue(remoteSeries);
  delete process.env.TASK_ORCHESTRATOR_PUBLISHING;
  await Promise.all([
    db.recursiveDelete(db.collection(LEGACY_PROVIDER_LISTENER_RECEIPTS)),
    db.recursiveDelete(db.collection('legacyProviderListenerHeads')),
    db.recursiveDelete(db.collection(SERIES_METADATA_CONTINUATIONS)),
    db.recursiveDelete(db.collection('legacyAdmissionLeases')),
    db.recursiveDelete(parent),
    db.recursiveDelete(db.doc('sermons/provider-listener-fence')),
    barrier.delete(),
    releaseState.delete(),
  ]);
  await control.set({
    schemaVersion: 1,
    revision: 1,
    releaseId: 'listener-fence-test',
    admission: 'open',
    domains: { publishing: { owner: 'legacy', admission: 'open' } },
    updatedAt: Date.now(),
  });
  await parent.set({ subsplashId: 'remote-series', subtitle: '0 part series' });
  const sourceCreatedAt = (await parent.get()).createTime!;
  event = { id: 'provider-event-1', time: wireTime(Timestamp.now()), sourceCreatedAt };
});
afterAll(async () => {
  await Promise.all([
    control.delete(),
    barrier.delete(),
    releaseState.delete(),
    db.recursiveDelete(parent),
    db.recursiveDelete(db.doc('sermons/provider-listener-fence')),
    db.recursiveDelete(db.collection(LEGACY_PROVIDER_LISTENER_RECEIPTS)),
    db.recursiveDelete(db.collection('legacyProviderListenerHeads')),
    db.recursiveDelete(db.collection(SERIES_METADATA_CONTINUATIONS)),
    db.recursiveDelete(db.collection('legacyAdmissionLeases')),
  ]);
});

test('preserves event nanoseconds and rejects malformed/noncanonical platform times', () => {
  expect(parseProviderEventTime('2026-01-01T00:00:00.000000001Z').nanoseconds).toBe(1);
  expect(parseProviderEventTime('2026-01-01T00:00:00.999999999Z').nanoseconds).toBe(999999999);
  for (const time of ['2026-02-30T00:00:00Z', '2026-01-01', '2026-01-01T00:00:00.1234567891Z'])
    expect(() => parseProviderEventTime(time)).toThrow();
});
test('awaits drain-visible effects marker, settles successfully and deduplicates the immutable event', async () => {
  effect.mockImplementation(async () => {
    const lease = (await db.collection('legacyAdmissionLeases').get()).docs[0];
    expect(lease.data()).toMatchObject({ state: 'active', effectsStarted: true, operation: 'seriesItemOnWrite' });
  });
  expect(await execute()).toBe('completed');
  expect(await execute()).toBe('duplicate');
  expect(effect).toHaveBeenCalledTimes(1);
  expect((await db.collection('legacyAdmissionLeases').where('state', '==', 'needs_attention').get()).empty).toBe(true);
});
test('rejects reuse of a completed event id with a changed native identity', async () => {
  await execute();
  await expect(execute({ event: { ...event, time: '2026-01-01T00:00:00.000000001Z' } })).rejects.toMatchObject({
    code: 'failed-precondition',
  });
  expect(effect).toHaveBeenCalledTimes(1);
});
test('concurrent delivery cannot start another provider effect', async () => {
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  effect.mockImplementation(async () => {
    started();
    await waiting;
  });
  const first = execute();
  await active;
  await expect(execute()).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(effect).toHaveBeenCalledTimes(1);
  release();
  await first;
});
test('unknown outcomes retain a needs_attention lease and block both repeated and newer events', async () => {
  effect.mockRejectedValue(new Error('provider timed out after accepting request'));
  await expect(execute()).rejects.toThrow('provider timed out');
  const lease = (await db.collection('legacyAdmissionLeases').get()).docs[0];
  expect(lease.data()).toMatchObject({ state: 'needs_attention', outcome: 'unknown', effectsStarted: true });
  await expect(execute()).rejects.toMatchObject({ code: 'failed-precondition' });
  await expect(execute({ event: { ...event, id: 'newer-event' } })).rejects.toMatchObject({
    code: 'failed-precondition',
  });
  expect(effect).toHaveBeenCalledTimes(1);
});
test('allows only factual pre-cutoff events during the compatibility pause', async () => {
  await compatibilityCutoff();
  expect(await execute()).toBe('completed');
  const cutoff = (await control.get()).get('legacyAdmissionCutoff') as Timestamp;
  const future = new Timestamp(cutoff.seconds + 1, cutoff.nanoseconds);
  await expect(execute({ event: { ...event, id: 'post-cutoff', time: wireTime(future) } })).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(effect).toHaveBeenCalledTimes(1);
});
test.each(['building', 'ready'])(
  'provider usage %s barrier blocks even pre-cutoff server continuations',
  async (status) => {
    await control.update({ admission: 'paused' });
    await barrier.set({ releaseId: 'listener-fence-test', status });
    await expect(execute()).rejects.toMatchObject({ code: 'unavailable' });
    expect(effect).not.toHaveBeenCalled();
    expect((await db.collection('legacyAdmissionLeases').get()).empty).toBe(true);
  }
);
test('actual Temporal ownership overrides stale legacy environment flags', async () => {
  await control.update({ 'domains.publishing.owner': 'temporal' });
  await expect(execute()).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(effect).not.toHaveBeenCalled();
});
test('rechecks canonical state immediately before the provider boundary', async () => {
  let validations = 0;
  expect(
    await execute({
      validateCurrent: async (tx) => {
        await tx.get(parent);
        return ++validations === 1;
      },
    })
  ).toBe('stale');
  expect(effect).not.toHaveBeenCalled();
  expect(validations).toBe(2);
});

async function deletedMembershipEvent() {
  const sermon = db.doc('sermons/provider-listener-fence');
  await sermon.set({ subsplashId: 'remote-media' });
  const membership = sermon.collection('sermonLists').doc('provider-list');
  await membership.set({ subsplashId: 'remote-list', uploadStatus: { status: 'UPLOADED', listItemId: 'remote-row' } });
  const data = await membership.get();
  await membership.delete();
  return {
    id: 'membership-delete',
    time: wireTime(Timestamp.now()),
    params: { sermonId: sermon.id, sermonListId: membership.id },
    data,
  };
}
const invokeDelete = (input: Awaited<ReturnType<typeof deletedMembershipEvent>>) =>
  (sermonListOnDelete as unknown as (event: typeof input) => Promise<void>)(input);

test('membership removal is deduplicated and per-list provider errors remain unsettled', async () => {
  const deleted = await deletedMembershipEvent();
  jest
    .mocked(removeFromList)
    .mockResolvedValue([{ listId: 'remote-list', status: 'error', error: 'uncertain response' }]);
  await expect(invokeDelete(deleted)).rejects.toThrow('needs reconciliation');
  await expect(invokeDelete(deleted)).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(removeFromList).toHaveBeenCalledTimes(1);
  expect((await db.collection('legacyAdmissionLeases').where('state', '==', 'needs_attention').get()).size).toBe(1);
});
test.each(['membership', 'sermon'])('late delete never removes a recreated %s generation', async (kind) => {
  const deleted = await deletedMembershipEvent();
  const sermon = db.doc('sermons/provider-listener-fence');
  if (kind === 'membership') await deleted.data.ref.set(deleted.data.data()!);
  else {
    await sermon.delete();
    await sermon.set({ subsplashId: 'remote-media' });
  }
  await invokeDelete(deleted);
  expect(removeFromList).not.toHaveBeenCalled();
});
test('legacy series patch uses current aggregate and uncertainty preserves the pending event', async () => {
  await parent.collection('seriesItems').doc('published').set({ publishedToSubsplash: true });
  const source = await parent.collection('seriesItems').doc('published').get();
  const actual = { ...event, sourceCreatedAt: source.createTime!, params: { seriesId: parent.id } };
  jest.mocked(patchSeriesMetadata).mockRejectedValue(new Error('unknown metadata response'));
  await expect(handleSeriesItemWrite(actual)).rejects.toThrow('unknown metadata response');
  expect((await parent.get()).get('_durableMetadataPendingEventId')).toMatch(/^series-metadata-[a-f0-9]{64}$/);
  expect(patchSeriesMetadata).toHaveBeenCalledWith('remote-series', { subtitle: '1 part series' }, 'test-token');
  await expect(handleSeriesItemWrite(actual)).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(patchSeriesMetadata).toHaveBeenCalledTimes(1);
});
test('series event for a deleted parent cannot patch a recreated parent', async () => {
  const original = { ...event, params: { seriesId: parent.id } };
  await parent.delete();
  await parent.set({ subsplashId: 'replacement', subtitle: '0 part series' });
  await parent.collection('seriesItems').doc('new').set({ publishedToSubsplash: true });
  await handleSeriesItemWrite(original);
  expect(patchSeriesMetadata).not.toHaveBeenCalled();
  expect((await parent.get()).get('subtitle')).toBe('0 part series');
});

test.each(['owner', 'barrier'])(
  'actual %s change after the effects marker prevents provider transport',
  async (change) => {
    mockAfterEffectsMarker = async () => {
      if (change === 'owner') await control.update({ 'domains.publishing.owner': 'temporal' });
      else {
        await control.update({ admission: 'paused' });
        await barrier.set({ releaseId: 'listener-fence-test', status: 'building' });
      }
    };
    await expect(execute()).rejects.toMatchObject({ code: change === 'owner' ? 'failed-precondition' : 'unavailable' });
    expect(effect).not.toHaveBeenCalled();
    expect((await db.collection('legacyAdmissionLeases').get()).docs[0].data()).toMatchObject({
      state: 'needs_attention',
      effectsStarted: true,
    });
    expect((await db.collection(LEGACY_PROVIDER_LISTENER_RECEIPTS).get()).docs[0].get('state')).toBe('needs_attention');
  }
);

test('actual canonical deletion after the effects marker settles stale without transport', async () => {
  mockAfterEffectsMarker = async () => {
    await parent.delete();
  };
  expect(await execute()).toBe('stale');
  expect(effect).not.toHaveBeenCalled();
  expect((await db.collection('legacyAdmissionLeases').get()).docs[0].data()).toMatchObject({
    state: 'completed',
    outcome: 'succeeded',
  });
});

test('native cutoff boundary rejects an event just one nanosecond after the original admitted event', async () => {
  const seconds = Timestamp.now().seconds;
  event = { ...event, time: wireTime(new Timestamp(seconds, 1000)) };
  const cutoff = parseProviderEventTime(event.time);
  await compatibilityCutoff(new Timestamp(cutoff.seconds, cutoff.nanoseconds));
  expect(await execute()).toBe('completed');
  await expect(
    execute({ event: { ...event, id: 'one-nanosecond-too-late', time: wireTime(new Timestamp(seconds, 1001)) } })
  ).rejects.toMatchObject({ code: 'unavailable' });
  expect(effect).toHaveBeenCalledTimes(1);
});

test('successful membership cleanup acknowledges replay without a second provider call', async () => {
  const deleted = await deletedMembershipEvent();
  await invokeDelete(deleted);
  await invokeDelete(deleted);
  expect(removeFromList).toHaveBeenCalledTimes(1);
  expect(removeFromList).toHaveBeenCalledWith(
    ['remote-list'],
    ['remote-row'],
    ['remote-media'],
    ['media-item'],
    undefined,
    expect.stringMatching(/^provider-listener:[a-f0-9]{64}$/),
    expect.any(Function)
  );
  expect((await db.collection('legacyAdmissionLeases').where('state', '==', 'needs_attention').get()).empty).toBe(true);
});

test('stale acknowledgment stays inert after recreated membership is later deleted', async () => {
  const deleted = await deletedMembershipEvent();
  await deleted.data.ref.set(deleted.data.data()!);
  await invokeDelete(deleted);
  await deleted.data.ref.delete();
  await invokeDelete(deleted);
  expect(removeFromList).not.toHaveBeenCalled();
  expect((await db.collection(LEGACY_PROVIDER_LISTENER_RECEIPTS).get()).docs[0].data()).toMatchObject({
    state: 'completed',
    outcome: 'stale',
  });
});

test('an older unseen membership event cannot revive after a newer event completed', async () => {
  event = { ...event, time: '2026-01-01T00:00:01.000000001Z' };
  await execute({ operation: 'sermonListOnDelete' });
  expect(
    await execute({
      operation: 'sermonListOnDelete',
      event: { ...event, id: 'delayed-original-event', time: '2026-01-01T00:00:00.999999999Z' },
    })
  ).toBe('stale');
  expect(effect).toHaveBeenCalledTimes(1);
});

test('duplicate old series delivery converges newer actual rows and A -> B -> A never reuses a completed receipt', async () => {
  const firstRow = parent.collection('seriesItems').doc('first');
  await firstRow.set({ publishedToSubsplash: true });
  const original = { ...event, sourceCreatedAt: (await firstRow.get()).createTime!, params: { seriesId: parent.id } };
  await handleSeriesItemWrite(original);
  const secondRow = parent.collection('seriesItems').doc('second');
  await secondRow.set({ publishedToSubsplash: true });
  await handleSeriesItemWrite(original);
  await secondRow.update({ publishedToSubsplash: false });
  await handleSeriesItemWrite(original);
  expect(jest.mocked(patchSeriesMetadata).mock.calls.map((call) => call[1])).toEqual([
    { subtitle: '1 part series' },
    { subtitle: '2 part series' },
    { subtitle: '1 part series' },
  ]);
  expect((await db.collection(LEGACY_PROVIDER_LISTENER_RECEIPTS).get()).size).toBe(3);
  await handleSeriesItemWrite({ ...original, id: 'actual-newer-delivery' });
  expect(patchSeriesMetadata).toHaveBeenCalledTimes(3);
  const current = await parent.get();
  expect(current.get('_durableMetadataPendingEventId')).toBeUndefined();
  expect(current.get('_durableMetadataPendingEvent')).toBeUndefined();
  const protectedRef = db.collection(SERIES_METADATA_CONTINUATIONS).doc(parent.id);
  const completed = (await protectedRef.get()).data()!;
  expect(completed).toMatchObject({ state: 'completed', admittedProjection: { publishedItemCount: 1 } });
  await parent.update({
    _durableMetadataPendingEventId: event.id,
    _durableMetadataPendingEvent: {
      id: event.id,
      time: '1970-01-01T00:00:00Z',
      sourceCreatedAt: { seconds: 0, nanoseconds: 0 },
    },
  });
  await handleSeriesItemWrite(original);
  expect(patchSeriesMetadata).toHaveBeenCalledTimes(3);
  expect((await protectedRef.get()).get('event')).toEqual(completed.event);
});

test('a pending metadata revision survives a different event retry with its original identity/time/generation', async () => {
  const row = parent.collection('seriesItems').doc('published');
  await row.set({ publishedToSubsplash: true });
  const original = { ...event, sourceCreatedAt: (await row.get()).createTime!, params: { seriesId: parent.id } };
  jest.mocked(patchSeriesMetadata).mockRejectedValueOnce(new Error('unknown response'));
  await expect(handleSeriesItemWrite(original)).rejects.toThrow('unknown response');
  const protectedHead = db.collection(SERIES_METADATA_CONTINUATIONS).doc(parent.id);
  const pending = (await protectedHead.get()).get('event');
  await parent.update({
    _durableMetadataPendingEvent: {
      id: 'forged-client',
      time: '1970-01-01T00:00:00Z',
      sourceCreatedAt: { seconds: 0, nanoseconds: 0 },
    },
  });
  await expect(
    handleSeriesItemWrite({ ...original, id: 'different-delivery', time: wireTime(Timestamp.now()) })
  ).rejects.toMatchObject({ code: 'failed-precondition' });
  expect((await protectedHead.get()).get('event')).toEqual(pending);
  expect(patchSeriesMetadata).toHaveBeenCalledTimes(1);
});

test('successful provider acknowledgment cannot clear a replacement private pending revision', async () => {
  const row = parent.collection('seriesItems').doc('published');
  await row.set({ publishedToSubsplash: true });
  let replacementId: string | undefined;
  jest.mocked(patchSeriesMetadata).mockImplementationOnce(async () => {
    const newer = parent.collection('seriesItems').doc('newer');
    await newer.set({ publishedToSubsplash: true });
    const replacement = await deriveCurrentSeriesMetadata(parent.id, {
      id: 'replacement-event',
      time: wireTime(Timestamp.now()),
      sourceCreatedAt: (await newer.get()).createTime!,
    });
    replacementId = replacement?.pendingEventId;
    return remoteSeries;
  });
  await handleSeriesItemWrite({
    ...event,
    sourceCreatedAt: (await row.get()).createTime!,
    params: { seriesId: parent.id },
  });
  expect(replacementId).toMatch(/^series-metadata-[a-f0-9]{64}$/);
  expect((await parent.get()).get('_durableMetadataPendingEventId')).toBe(replacementId);
  expect((await db.collection(SERIES_METADATA_CONTINUATIONS).doc(parent.id).get()).data()).toMatchObject({
    state: 'pending',
    event: { id: replacementId },
  });
});

test('successful provider acknowledgment cannot clear a recreated parent even when its pending marker is copied', async () => {
  const row = parent.collection('seriesItems').doc('published');
  await row.set({ publishedToSubsplash: true });
  let copiedId: string | undefined;
  jest.mocked(patchSeriesMetadata).mockImplementationOnce(async () => {
    const old = (await parent.get()).data()!;
    copiedId = old._durableMetadataPendingEventId;
    await parent.delete();
    await parent.set(old);
    return remoteSeries;
  });
  await handleSeriesItemWrite({
    ...event,
    sourceCreatedAt: (await row.get()).createTime!,
    params: { seriesId: parent.id },
  });
  expect((await parent.get()).get('_durableMetadataPendingEventId')).toBe(copiedId);
});

test('client-forged pending timestamps cannot admit a post-cutoff event or replace protected source facts', async () => {
  await compatibilityCutoff(new Timestamp(Timestamp.now().seconds, 0));
  await parent.update({
    _durableMetadataPendingEventId: 'forged-client-event',
    _durableMetadataPendingEvent: {
      id: 'forged-client-event',
      time: '1970-01-01T00:00:00Z',
      sourceCreatedAt: { seconds: 0, nanoseconds: 0 },
    },
  });
  await expect(handleSeriesItemWrite({ ...event, params: { seriesId: parent.id } })).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(patchSeriesMetadata).not.toHaveBeenCalled();
  expect((await db.collection(SERIES_METADATA_CONTINUATIONS).doc(parent.id).get()).exists).toBe(false);
  const row = parent.collection('seriesItems').doc('post-cutoff');
  await row.set({ publishedToSubsplash: true });
  await expect(
    handleSeriesItemWrite({ ...event, sourceCreatedAt: (await row.get()).createTime!, params: { seriesId: parent.id } })
  ).rejects.toMatchObject({ code: 'unavailable' });
  expect(patchSeriesMetadata).not.toHaveBeenCalled();
  expect((await db.collection(SERIES_METADATA_CONTINUATIONS).doc(parent.id).get()).exists).toBe(false);
});

test('late legacy series delivery after the actual server settling window leaves all metadata and pending facts untouched', async () => {
  const row = parent.collection('seriesItems').doc('late');
  await row.set({ publishedToSubsplash: true });
  await compatibilityCutoff(Timestamp.fromMillis(Date.now() - 3_601_000));
  const before = await parent.get();
  await expect(
    handleSeriesItemWrite({ ...event, sourceCreatedAt: (await row.get()).createTime!, params: { seriesId: parent.id } })
  ).rejects.toMatchObject({ code: 'unavailable' });
  const after = await parent.get();
  expect(after.data()).toEqual(before.data());
  expect(after.updateTime).toEqual(before.updateTime);
  expect((await db.collection(SERIES_METADATA_CONTINUATIONS).get()).empty).toBe(true);
  expect((await db.collection(LEGACY_PROVIDER_LISTENER_RECEIPTS).get()).empty).toBe(true);
  expect((await db.collection('legacyAdmissionLeases').get()).empty).toBe(true);
  expect(patchSeriesMetadata).not.toHaveBeenCalled();
});

test('one accepted series lifetime lease finishes after the server deadline without a second fresh claim', async () => {
  const row = parent.collection('seriesItems').doc('accepted');
  await row.set({ publishedToSubsplash: true });
  // Controlled Eventarc timestamp fixture near the END of a one-hour grace period.
  const cutoff = Timestamp.fromMillis(Date.now() - 3_598_000);
  await compatibilityCutoff(cutoff);
  let crossed = false;
  mockAfterEffectsMarker = async () => {
    if (crossed) return;
    crossed = true;
    const leases = await db.collection('legacyAdmissionLeases').get();
    expect(leases.size).toBe(1);
    expect(leases.docs[0].data()).toMatchObject({ state: 'active', effectsStarted: true });
    await new Promise((resolve) => setTimeout(resolve, 2300));
    const now = (await control.get()).readTime;
    expect(now.toMillis()).toBeGreaterThanOrEqual(cutoff.toMillis() + 3_600_000);
  };
  await handleSeriesItemWrite({
    ...event,
    time: wireTime(cutoff),
    sourceCreatedAt: (await row.get()).createTime!,
    params: { seriesId: parent.id },
  });
  expect(crossed).toBe(true);
  const leases = await db.collection('legacyAdmissionLeases').get();
  expect(leases.size).toBe(1);
  expect(leases.docs[0].data()).toMatchObject({ state: 'completed', outcome: 'succeeded', effectsStarted: true });
  expect((await db.collection(LEGACY_PROVIDER_LISTENER_RECEIPTS).get()).docs[0].get('leaseId')).toBe(leases.docs[0].id);
  expect((await db.collection(SERIES_METADATA_CONTINUATIONS).doc(parent.id).get()).get('state')).toBe('completed');
  expect(patchSeriesMetadata).toHaveBeenCalledTimes(1);
});

test.each(['project', 'domain', 'actor', 'operation'])(
  'an active %s-mismatched lease cannot be reused for a provider listener',
  async (mismatch) => {
    await control.update({ 'domains.accounts': { owner: 'legacy', admission: 'open' } });
    const options = {
      projectId,
      domain: 'publishing',
      actorUid: 'system:firebase-event',
      operation: 'seriesItemOnWrite',
      continuation: true,
      ...(mismatch === 'project' ? { projectId: 'different-project' } : {}),
      ...(mismatch === 'domain' ? { domain: 'accounts' } : {}),
      ...(mismatch === 'actor' ? { actorUid: 'system:other-event' } : {}),
      ...(mismatch === 'operation' ? { operation: 'other-operation' } : {}),
    };
    await withLegacyAdmissionLease(db, options, async (lease) => {
      await expect(execute({ existingLease: lease })).rejects.toMatchObject({ code: 'failed-precondition' });
    });
    expect(effect).not.toHaveBeenCalled();
    expect((await db.collection(LEGACY_PROVIDER_LISTENER_RECEIPTS).get()).empty).toBe(true);
  }
);

test('a completed lease cannot escape its callback to prepare metadata or execute a provider receipt', async () => {
  const lease = await withLegacyAdmissionLease(
    db,
    {
      projectId,
      domain: 'publishing',
      actorUid: 'system:firebase-event',
      operation: 'seriesItemOnWrite',
      continuation: true,
    },
    async (accepted) => accepted
  );
  const before = await parent.get();
  await expect(
    deriveCurrentSeriesMetadata(parent.id, event, event.sourceCreatedAt, {
      lease,
      projectId,
      operation: 'seriesItemOnWrite',
      event,
    })
  ).rejects.toMatchObject({ code: 'failed-precondition' });
  await expect(execute({ existingLease: lease })).rejects.toMatchObject({ code: 'failed-precondition' });
  expect((await parent.get()).updateTime).toEqual(before.updateTime);
  expect((await db.collection(SERIES_METADATA_CONTINUATIONS).get()).empty).toBe(true);
  expect(effect).not.toHaveBeenCalled();
});
