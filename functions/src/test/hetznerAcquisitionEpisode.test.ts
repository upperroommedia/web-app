import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { hostResourceRequest } from '../../../apps/process-audio/src/host/resources';
import {
  prepareNativeYouTubeEpisode,
  readPreparedYouTubeEpisode,
  recordYouTubeEpisodeResource,
  assertReleasedYouTubeEpisode,
} from '../../../apps/process-audio/src/temporal/hetzner-acquisition-episode';
import { reserveYouTubeEpisodeResources } from '../../../apps/process-audio/src/temporal/hetzner-acquisition-resources';
import {
  createYouTubeAcquisitionHostStore,
  closeYouTubeAcquisitionNativeProcess,
  YOUTUBE_ACQUISITIONS,
} from '../../../apps/process-audio/src/temporal/hetzner-acquisition-store';
import { youtubeAcquisitionId } from '../../../apps/process-audio/src/temporal/hetzner-acquisition';
import type { MediaJobRef } from '../../../apps/process-audio/src/temporal/types';
jest.mock('../../../apps/process-audio/src/host/resources', () => ({ hostResourceRequest: jest.fn() }));
// Actual dedicated Firestore transactions and immutable native timestamps.
// Native Activity callback/kernel/root socket/drain/capacity are CONTROLLED.
let app: App, db: Firestore, ref: MediaJobRef;
const buildId = 'a'.repeat(40),
  caller = {
    buildId,
    serviceAccount: `tw-m-${'a'.repeat(20)}@urm-app-staging.iam.gserviceaccount.com`,
    instanceId: 'CONTROLLED_NATIVE_ACTIVITY',
  };
const owner = { buildId, bootId: 'b'.repeat(36), pidNamespace: 'pid:[1234]', processId: 7, startTicks: '100' };
const root = () => db.collection(YOUTUBE_ACQUISITIONS).doc(youtubeAcquisitionId(ref));
const gateRef = () => db.doc(`_testEpisodeAuthority/${ref.jobId}`);
const current = async (tx: Transaction) => {
  if (!(await tx.get(gateRef())).get('allowed')) throw Error('CONTROLLED_REVOKED');
};
const prepare = () => prepareNativeYouTubeEpisode({ firestore: db, ref, caller, assertCurrent: current });
const read = () => readPreparedYouTubeEpisode({ firestore: db, ref, verifiedCallerEmail: caller.serviceAccount });
beforeAll(() => {
  if (!/^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? ''))
    throw Error('Dedicated emulator required');
  app = initializeApp({ projectId: 'urm-app-staging' }, `episode-${randomUUID()}`);
  db = getFirestore(app);
});
beforeEach(async () => {
  jest.clearAllMocks();
  ref = {
    projectId: 'urm-app-staging',
    jobId: `owned-episode-${randomUUID()}`,
    sermonId: 'owned-sermon',
    revision: 1,
    requestVersion: 'b'.repeat(16),
  };
  await gateRef().set({ allowed: true });
  jest.mocked(hostResourceRequest).mockImplementation(async (id, action) => ({
    v: 1,
    id,
    peerBound: true,
    state:
      action === 'reserve' ? 'reserved' : action === 'seal' ? 'drained' : action === 'release' ? 'closed' : 'enrolled',
    receiptHash: 'c'.repeat(64),
    ...(action === 'reserve' || action === 'enroll' ? { directory: `/workspace/yt-acquisition-scratch/${id}` } : {}),
    ...(action === 'seal' || action === 'release' ? { groupAbsent: true } : {}),
  }));
});
afterEach(async () => {
  jest.restoreAllMocks();
  await db.recursiveDelete(root());
  await gateRef().delete();
});
afterAll(async () => {
  await db.terminate();
  await deleteApp(app);
});
test('native preparation atomically creates exactly one first intent; repeats retain original and require current authorization', async () => {
  await prepare();
  const first = await read();
  await prepareNativeYouTubeEpisode({
    firestore: db,
    ref,
    caller: { ...caller, instanceId: 'CONTROLLED_CURRENT_RETRY_ACTIVITY' },
    assertCurrent: current,
  });
  expect(await read()).toEqual(first);
  const [parent, original, all] = await Promise.all([
    root().get(),
    root().collection('episodes').doc(first.id).get(),
    root().collection('episodes').get(),
  ]);
  expect(all.size).toBe(1);
  expect(original.createTime?.isEqual(parent.createTime!)).toBe(true);
  expect(original.createTime?.isEqual(original.updateTime!)).toBe(true);
  await gateRef().update({ allowed: false });
  await expect(prepare()).rejects.toThrow('CONTROLLED_REVOKED');
});
test('committed intent ACK loss cannot create its known-ACK permission, backfill it, or invent a successor', async () => {
  const actual = db.runTransaction.bind(db);
  jest.spyOn(db, 'runTransaction').mockImplementationOnce(async (run, options) => {
    await actual(run, options);
    throw Error('CONTROLLED_COMMITTED_ACK_LOSS');
  });
  await expect(prepare()).rejects.toThrow('CONTROLLED_COMMITTED_ACK_LOSS');
  jest.restoreAllMocks();
  const saved = await root().get(),
    id = saved.get('preparedEpisode');
  expect((await root().collection('episodes').doc(id).get()).exists).toBe(true);
  expect((await root().collection('episodes').doc(id).collection('facts').doc('authorized').get()).exists).toBe(false);
  await expect(read()).rejects.toThrow('YOUTUBE_EPISODE_UNCONFIRMED');
  await expect(prepare()).rejects.toThrow('YOUTUBE_EPISODE_UNCONFIRMED');
  expect((await root().collection('episodes').get()).size).toBe(1);
});
test('later immutable ordinal-one intent cannot backfill the original delegation atomic creation', async () => {
  await prepare();
  const original = await read(),
    id = randomUUID();
  const replacement = { ...original, id };
  const doc = root().collection('episodes').doc(id);
  await doc.create(replacement);
  await doc.collection('facts').doc('authorized').create({ schemaVersion: 1, episode: replacement });
  await root().update({ preparedEpisode: id });
  await expect(read()).rejects.toThrow('YOUTUBE_EPISODE_UNCONFIRMED');
});
test('actual helper enrollment proof must join immutable enrollment and original birth hashes', async () => {
  const { episode } = await running();
  const changed = createYouTubeAcquisitionHostStore({
    firestore: db,
    projectId: ref.projectId,
    owner,
    episodeId: episode.id,
    nativeEnrollment: {
      v: 1,
      id: episode.id,
      peerBound: true,
      state: 'enrolled',
      directory: `/workspace/yt-acquisition-scratch/${episode.id}`,
      receiptHash: 'd'.repeat(64),
    },
    assertEligible: current,
  });
  await expect(changed.assertCurrent(ref)).rejects.toThrow('YOUTUBE_EPISODE_UNCONFIRMED');
});
test('unknown physical reserve ACK is GET-only and cannot enroll or create resource permission', async () => {
  await prepare();
  const episode = await read();
  jest.mocked(hostResourceRequest).mockImplementation(async (id, action) => {
    if (action === 'reserve') throw Error('CONTROLLED_UNKNOWN_ROOT_ACK');
    return {
      v: 1,
      id,
      peerBound: true,
      state: 'reserved',
      directory: `/workspace/yt-acquisition-scratch/${id}`,
      receiptHash: 'c'.repeat(64),
    };
  });
  await expect(
    reserveYouTubeEpisodeResources({
      firestore: db,
      episode,
      startSignal: new AbortController().signal,
      assertCurrent: current,
    })
  ).rejects.toThrow('YOUTUBE_EPISODE_RESOURCES_UNCONFIRMED');
  expect(jest.mocked(hostResourceRequest).mock.calls.map((c) => c[1])).toEqual(['reserve', 'get']);
  expect((await root().collection('episodes').doc(episode.id).collection('facts').doc('reserved').get()).exists).toBe(
    false
  );
});
test('unknown native enrollment ACK cannot persist an enrollment permit or authorize a claim', async () => {
  await prepare();
  const episode = await read();
  const reservation = await reserveYouTubeEpisodeResources({
    firestore: db,
    episode,
    startSignal: new AbortController().signal,
    assertCurrent: current,
  });
  const original = jest.mocked(hostResourceRequest).getMockImplementation()!;
  jest.mocked(hostResourceRequest).mockImplementation(async (id, action, extra) => {
    if (action === 'enroll') throw Error('CONTROLLED_UNKNOWN_ENROLLMENT_ACK');
    return original(id, action, extra);
  });
  await expect(reservation.enroll(owner.processId, new AbortController().signal)).rejects.toThrow(
    'YOUTUBE_EPISODE_RESOURCES_UNCONFIRMED'
  );
  expect((await root().collection('episodes').doc(episode.id).collection('facts').doc('enrolled').get()).exists).toBe(
    false
  );
  expect(jest.mocked(hostResourceRequest).mock.calls.map((call) => call[1])).toEqual(['reserve', 'enroll', 'get']);
  const store = createYouTubeAcquisitionHostStore({
    firestore: db,
    projectId: ref.projectId,
    owner,
    episodeId: episode.id,
    assertEligible: current,
  });
  await expect(store.claim(ref, caller.serviceAccount)).rejects.toThrow('YOUTUBE_EPISODE_UNCONFIRMED');
});
async function running() {
  await prepare();
  const episode = await read();
  const reservation = await reserveYouTubeEpisodeResources({
    firestore: db,
    episode,
    startSignal: new AbortController().signal,
    assertCurrent: current,
  });
  await reservation.enroll(owner.processId, new AbortController().signal);
  const store = createYouTubeAcquisitionHostStore({
    firestore: db,
    projectId: ref.projectId,
    owner,
    episodeId: episode.id,
    nativeEnrollment: {
      v: 1,
      id: episode.id,
      peerBound: true,
      state: 'enrolled',
      directory: `/workspace/yt-acquisition-scratch/${episode.id}`,
      receiptHash: 'c'.repeat(64),
    },
    assertEligible: current,
  });
  const startedAt = Date.now();
  expect(await store.claim(ref, caller.serviceAccount, startedAt)).toEqual({ launch: true });
  return { episode, reservation, store, startedAt };
}
test('real claim atomically binds known reservation/enrollment to original birth; old claim path and rewritten birth deny', async () => {
  await prepare();
  const episode = await read();
  const old = createYouTubeAcquisitionHostStore({
    firestore: db,
    projectId: ref.projectId,
    owner,
    assertEligible: current,
  });
  await expect(old.claim(ref, caller.serviceAccount)).rejects.toThrow('YOUTUBE_EPISODE_UNCONFIRMED');
  for (const phase of ['reserved', 'enrolled'] as const)
    await recordYouTubeEpisodeResource({
      firestore: db,
      episode,
      phase,
      proof: {
        v: 1,
        id: episode.id,
        state: phase,
        peerBound: true,
        directory: `/workspace/yt-acquisition-scratch/${episode.id}`,
        receiptHash: 'c'.repeat(64),
      },
      assertCurrent: current,
    });
  const store = createYouTubeAcquisitionHostStore({
    firestore: db,
    projectId: ref.projectId,
    owner,
    episodeId: episode.id,
    nativeEnrollment: {
      v: 1,
      id: episode.id,
      peerBound: true,
      state: 'enrolled',
      directory: `/workspace/yt-acquisition-scratch/${episode.id}`,
      receiptHash: 'c'.repeat(64),
    },
    assertEligible: current,
  });
  expect(await store.claim(ref, caller.serviceAccount)).toEqual({ launch: true });
  await store.assertCurrent(ref);
  const birth = root().collection('episodes').doc(episode.id).collection('facts').doc('birth'),
    original = (await birth.get()).data()!;
  await birth.update({ startedAt: original.startedAt + 1 });
  await birth.set(original);
  await expect(store.assertCurrent(ref)).rejects.toThrow('YOUTUBE_EPISODE_UNCONFIRMED');
});
test('committed native claim ACK loss retains one original birth and never grants a second launch', async () => {
  await prepare();
  const episode = await read();
  const reservation = await reserveYouTubeEpisodeResources({
    firestore: db,
    episode,
    startSignal: new AbortController().signal,
    assertCurrent: current,
  });
  await reservation.enroll(owner.processId, new AbortController().signal);
  const store = createYouTubeAcquisitionHostStore({
    firestore: db,
    projectId: ref.projectId,
    owner,
    episodeId: episode.id,
    assertEligible: current,
  });
  const actual = db.runTransaction.bind(db);
  jest.spyOn(db, 'runTransaction').mockImplementationOnce(async (run, options) => {
    expect(options && 'maxAttempts' in options ? options.maxAttempts : undefined).toBe(1);
    await actual(run, options);
    throw Error('CONTROLLED_COMMITTED_CLAIM_ACK_LOSS');
  });
  await expect(store.claim(ref, caller.serviceAccount)).rejects.toThrow('CONTROLLED_COMMITTED_CLAIM_ACK_LOSS');
  jest.restoreAllMocks();
  const birth = root().collection('episodes').doc(episode.id).collection('facts').doc('birth'),
    before = await birth.get();
  expect(before.exists).toBe(true);
  expect(await store.claim(ref, caller.serviceAccount)).toEqual({ launch: false });
  expect((await birth.get()).updateTime?.isEqual(before.updateTime!)).toBe(true);
});
test('seal retains capacity until immutable original DB CLOSE; both adoption gate and root release require exact original episode', async () => {
  const { episode, reservation, store, startedAt } = await running();
  const artifact = {
    path: `workflow-audio/${ref.sermonId}/${ref.requestVersion}/source-${randomUUID()}.bin`,
    generation: '1',
    bytes: 1,
    crc32c: 'AAAAAA==',
  };
  await store.settle(ref, { kind: 'source', artifact }, async () => undefined);
  const sealed = await reservation.sealAfterNativeClose();
  await expect(reservation.releaseAfterNativeDrain()).rejects.toThrow();
  expect(jest.mocked(hostResourceRequest).mock.calls.some((call) => call[1] === 'release')).toBe(false);
  // A source seal alone cannot authorize source adoption.
  await expect(
    db.runTransaction(async (tx) => assertReleasedYouTubeEpisode(tx, await tx.get(root())))
  ).rejects.toThrow();
  await closeYouTubeAcquisitionNativeProcess({
    firestore: db,
    ref,
    owner,
    startedAt,
    fact: { processId: owner.processId, exitCode: 0, exitSignal: null, outcome: 'completed', closedAt: Date.now() },
    episode: { id: episode.id, proof: sealed },
  });
  const originalRequest = jest.mocked(hostResourceRequest).getMockImplementation()!;
  let rootReleased = false;
  jest.mocked(hostResourceRequest).mockImplementation(async (id, action, extra) => {
    if (action === 'release') {
      expect((await root().collection('nativeClose').doc('original').get()).exists).toBe(true);
      rootReleased = true;
      throw Error('CONTROLLED_COMMITTED_RELEASE_ACK_LOSS');
    }
    if (action === 'get' && rootReleased)
      return { v: 1, id, peerBound: true, state: 'closed', groupAbsent: true, receiptHash: sealed.receiptHash };
    return originalRequest(id, action, extra);
  });
  await reservation.releaseAfterNativeDrain();
  expect(jest.mocked(hostResourceRequest).mock.calls.filter((call) => call[1] === 'release')).toHaveLength(1);
  await db.runTransaction(async (tx) => assertReleasedYouTubeEpisode(tx, await tx.get(root())));
  const saved = root().collection('episodes').doc(episode.id).collection('facts').doc('sealed'),
    original = (await saved.get()).data()!;
  await saved.update({ changed: true });
  await saved.set(original);
  await expect(db.runTransaction(async (tx) => assertReleasedYouTubeEpisode(tx, await tx.get(root())))).rejects.toThrow(
    'YOUTUBE_EPISODE_UNCONFIRMED'
  );
});
