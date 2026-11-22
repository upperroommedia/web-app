import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { hostResourceRequest } from '../../../apps/process-audio/src/host/resources';
import {
  prepareNativeYouTubeEpisode,
  readPreparedYouTubeEpisode,
  readPreparedYouTubeEpisodeInTransaction,
  recordYouTubeEpisodeResource,
  assertReleasedYouTubeEpisode,
  readAcquisitionExecution,
} from '../../../apps/process-audio/src/temporal/hetzner-acquisition-episode';
import { reserveYouTubeEpisodeResources } from '../../../apps/process-audio/src/temporal/hetzner-acquisition-resources';
import {
  createYouTubeAcquisitionHostStore,
  closeYouTubeAcquisitionNativeProcess,
  YOUTUBE_ACQUISITIONS,
} from '../../../apps/process-audio/src/temporal/hetzner-acquisition-store';
import { youtubeAcquisitionId } from '../../../apps/process-audio/src/temporal/hetzner-acquisition';
import {
  reserveYouTubeRenderDispatch,
  youtubeRenderSlot,
} from '../../../apps/process-audio/src/temporal/hetzner-render-slot';
import { waitForYouTubeRender } from '../../../apps/process-audio/src/temporal/hetzner-render-client';
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
const nativeInvocation = {
  workflowId: 'CONTROLLED_WORKFLOW',
  runId: 'CONTROLLED_RUN',
  activityId: 'CONTROLLED_ACTIVITY',
  attempt: 1,
};
const prepare = (attempt = 1) =>
  prepareNativeYouTubeEpisode({
    firestore: db,
    ref,
    caller,
    invocation: { ...nativeInvocation, attempt },
    assertCurrent: current,
  });
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
    invocation: nativeInvocation,
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
async function running(attempt = 1, processOwner = owner) {
  await prepare(attempt);
  const episode = await read();
  const reservation = await reserveYouTubeEpisodeResources({
    firestore: db,
    episode,
    startSignal: new AbortController().signal,
    assertCurrent: current,
  });
  await reservation.enroll(processOwner.processId, new AbortController().signal);
  const store = createYouTubeAcquisitionHostStore({
    firestore: db,
    projectId: ref.projectId,
    owner: processOwner,
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

const providerEvidence = { attemptedModes: ['public_provider' as const], requiresAuthenticationRecovery: false };
async function knownRetry() {
  const original = await running();
  await original.store.settle(ref, { kind: 'retryable' }, async () => undefined, providerEvidence);
  const sealed = await original.reservation.sealAfterNativeClose();
  await closeYouTubeAcquisitionNativeProcess({
    firestore: db,
    ref,
    owner,
    startedAt: original.startedAt,
    fact: { processId: owner.processId, exitCode: 0, exitSignal: null, outcome: 'completed', closedAt: Date.now() },
    episode: { id: original.episode.id, proof: sealed },
  });
  await original.reservation.releaseAfterNativeDrain();
  return original;
}
test('successor uses a distinct native owner/upload/close while preserving original history and adopts exact current source chain', async () => {
  const first = await knownRetry();
  const original = await root().get(),
    oldClose = await root().collection('nativeClose').doc('original').get();
  const nextOwner = { ...owner, processId: 8, startTicks: '200' };
  const next = await running(2, nextOwner);
  expect(next.episode.ordinal).toBe(2);
  expect(next.episode.predecessor?.id).toBe(first.episode.id);
  expect(next.episode.invocation.attempt).toBe(2);
  const attempt = randomUUID(),
    upload = next.store.upload(ref, attempt);
  expect(await upload.begin()).toEqual({ launch: true });
  await upload.recordBytes({ bytes: 1, crc32c: 'AAAAAA==' });
  const artifact = { path: upload.path, generation: '1', bytes: 1, crc32c: 'AAAAAA==' };
  await upload.retain(artifact);
  await next.store.settle(ref, { kind: 'source', artifact }, async () => undefined);
  const sealed = await next.reservation.sealAfterNativeClose();
  await closeYouTubeAcquisitionNativeProcess({
    firestore: db,
    ref,
    owner: nextOwner,
    startedAt: next.startedAt,
    fact: { processId: nextOwner.processId, exitCode: 0, exitSignal: null, outcome: 'completed', closedAt: Date.now() },
    episode: { id: next.episode.id, proof: sealed },
  });
  await next.reservation.releaseAfterNativeDrain();
  await db.runTransaction(async (tx) => {
    const selected = await readAcquisitionExecution(tx, await tx.get(root()));
    expect(selected.ref.path).toBe(
      root().collection('episodes').doc(next.episode.id).collection('runtime').doc('current').path
    );
    await assertReleasedYouTubeEpisode(tx, selected);
    expect(selected.get('owner')).toEqual(nextOwner);
    expect(selected.get('activeUpload')).toBe(attempt);
    expect((await tx.get(selected.ref.collection('uploads').doc(attempt))).get('receipt')).toEqual(artifact);
  });
  const retained = await root().get();
  expect(retained.get('preparedEpisode')).toBe(first.episode.id);
  for (const key of ['owner', 'startedAt', 'result', 'nativeClose', 'status'])
    expect(retained.get(key)).toEqual(original.get(key));
  expect((await root().collection('nativeClose').doc('original').get()).updateTime?.isEqual(oldClose.updateTime!)).toBe(
    true
  );
  expect((await root().collection('uploads').get()).empty).toBe(true);
});
test('known retry successor requires strictly later SAME native Activity attempt and current actor; same attempt is GET-only', async () => {
  await knownRetry();
  await prepare();
  expect((await root().collection('episodes').get()).size).toBe(1);
  for (const changed of [
    { ...nativeInvocation, runId: 'OTHER_RUN', attempt: 2 },
    { ...nativeInvocation, activityId: 'OTHER_ACTIVITY', attempt: 2 },
  ]) {
    await expect(
      prepareNativeYouTubeEpisode({ firestore: db, ref, caller, invocation: changed, assertCurrent: current })
    ).rejects.toThrow();
  }
  await gateRef().update({ allowed: false });
  await expect(prepare(2)).rejects.toThrow('CONTROLLED_REVOKED');
  expect((await root().collection('episodes').get()).size).toBe(1);
});
test('retry classification never clears unknown upload fences or substitutes auth/archive/generic failure', async () => {
  const active = await running();
  await expect(active.store.settle(ref, { kind: 'retryable' }, async () => undefined)).rejects.toThrow();
  await expect(
    active.store.settle(ref, { kind: 'retryable' }, async () => undefined, {
      ...providerEvidence,
      requiresAuthenticationRecovery: true,
    })
  ).rejects.toThrow();
  await active.store.upload(ref, randomUUID()).begin();
  await expect(
    active.store.settle(ref, { kind: 'retryable' }, async () => undefined, providerEvidence)
  ).rejects.toThrow();
  await expect(prepare(2)).rejects.toThrow();
  expect((await root().collection('episodes').get()).size).toBe(1);
  expect((await root().get()).get('activeUpload')).toBeDefined();
});
test('committed successor intent ACK loss has no launch authorization/backfill or later successor', async () => {
  await knownRetry();
  const actual = db.runTransaction.bind(db);
  jest.spyOn(db, 'runTransaction').mockImplementationOnce(async (run, options) => {
    await actual(run, options);
    throw Error('CONTROLLED_SUCCESSOR_COMMIT_ACK_LOSS');
  });
  await expect(prepare(2)).rejects.toThrow('CONTROLLED_SUCCESSOR_COMMIT_ACK_LOSS');
  jest.restoreAllMocks();
  const head = (await root().get()).get('headEpisode');
  expect((await root().collection('episodes').doc(head).collection('facts').doc('authorized').get()).exists).toBe(
    false
  );
  await expect(read()).rejects.toThrow();
  await expect(prepare(2)).rejects.toThrow();
  await expect(prepare(3)).rejects.toThrow();
  expect((await root().collection('episodes').get()).size).toBe(2);
});
test('current successor rereads immutable predecessor close/release stamps; rewritten history denies', async () => {
  await knownRetry();
  await prepare(2);
  const before = await read();
  const close = root().collection('nativeClose').doc('original'),
    original = (await close.get()).data()!;
  await close.update({ closedAt: original.closedAt + 1 });
  await close.set(original);
  await expect(read()).rejects.toThrow();
  expect(before.ordinal).toBe(2);
});

test.each(['rewrite', 'recreate'])(
  'successor rejects original provider classification %s after its own creation',
  async (mode) => {
    const first = await knownRetry();
    await prepare(2);
    expect((await read()).ordinal).toBe(2);
    const outcome = root().collection('episodes').doc(first.episode.id).collection('facts').doc('providerOutcome');
    const original = (await outcome.get()).data()!;
    if (mode === 'rewrite') {
      await outcome.update({ attemptedModes: ['cookie_provider'] });
      await outcome.set(original);
    } else {
      await outcome.delete();
      await outcome.create(original);
    }
    await expect(read()).rejects.toThrow('YOUTUBE_EPISODE_UNCONFIRMED');
  }
);

test.each(['accepted', 'stopped', 'slot-rewritten'] as const)(
  'a lost reservation commit acknowledgement permits only the original unsent POST (%s)',
  async (mode) => {
    const episodeId = await prepareNativeYouTubeEpisode({
      firestore: db,
      ref,
      caller,
      invocation: nativeInvocation,
      assertCurrent: current,
      render: true,
    });
    const slotRef = db.collection('temporalYouTubeRenderHosts').doc('staging');
    if ((await slotRef.get()).exists) throw Error('Isolated emulator render slot is occupied');
    const selectedSlot = youtubeRenderSlot(ref, episodeId);
    let loseAck = true;
    const firestore = new Proxy(db, {
      get(target, key) {
        if (key === 'runTransaction') {
          return async <T>(...parameters: Parameters<Firestore['runTransaction']>) => {
            const result = await target.runTransaction(...parameters);
            if (loseAck && result === true && parameters[1] && !('readOnly' in parameters[1])) {
              loseAck = false;
              if (mode === 'stopped') await root().update({ renderStopped: true });
              if (mode === 'slot-rewritten') {
                await slotRef.update({ controlledMutation: true });
                await slotRef.set(selectedSlot);
              }
              throw Error('CONTROLLED_FIRESTORE_COMMIT_ACK_LOST');
            }
            return result as T;
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const signal = new AbortController().signal;
    const authorizeDispatch = () =>
      reserveYouTubeRenderDispatch({
        firestore,
        signal,
        assertCurrent: current,
        read: async (tx) => {
          const { root, episode, execution } = await readPreparedYouTubeEpisodeInTransaction(tx, {
            firestore: db,
            ref,
            verifiedCallerEmail: caller.serviceAccount,
            render: true,
          });
          return {
            dispatch: await tx.get(execution.ref.collection('render').doc('dispatch')),
            body: { schemaVersion: 1, ref, episodeId },
            slot: selectedSlot,
            active:
              root.get('renderStopped') !== true &&
              episode.id === episodeId &&
              execution.get('renderClaim') === undefined,
          };
        },
      });
    const operationId = youtubeAcquisitionId(ref);
    const request = jest
      .fn()
      .mockResolvedValueOnce({ operationId, status: 'missing' })
      .mockRejectedValueOnce(new Error('CONTROLLED_HTTP_ACK_LOST'))
      .mockResolvedValueOnce({ operationId, status: 'rendered' });
    try {
      const observed = waitForYouTubeRender({
        ref,
        signal,
        request,
        authorizeDispatch,
        heartbeat: () => undefined,
        wait: async () => undefined,
        maxPolls: 3,
      });
      if (mode !== 'accepted') {
        await expect(observed).rejects.toThrow('CONTROLLED_FIRESTORE_COMMIT_ACK_LOST');
        expect(request.mock.calls.map(([method]) => method)).toEqual(['GET']);
      } else {
        await expect(observed).resolves.toBe('rendered');
        expect(request.mock.calls.map(([method]) => method)).toEqual(['GET', 'POST', 'GET']);
      }
      expect(loseAck).toBe(false);
      expect((await slotRef.get()).data()).toEqual(selectedSlot);
      await expect(authorizeDispatch()).resolves.toBe(false);
    } finally {
      const slot = await slotRef.get();
      if (slot.get('operationId') === selectedSlot.operationId) await slotRef.delete();
    }
  }
);

test('a Moses render stays on the authorized host across retries and rejects a rewritten route', async () => {
  const selected = { runtimeId: '12345678-0000-4000-8000-000000000001', commit: 'a'.repeat(40) };
  const prepareRender = (renderTarget: 'moses' | 'hetzner', renderRuntime?: typeof selected) =>
    prepareNativeYouTubeEpisode({
      firestore: db,
      ref,
      caller,
      invocation: nativeInvocation,
      assertCurrent: current,
      render: true,
      renderTarget,
      renderRuntime,
    });
  const id = await prepareRender('moses', selected);
  await expect(
    prepareRender('moses', { ...selected, runtimeId: '12345678-0000-4000-8000-000000000002' })
  ).rejects.toThrow('YOUTUBE_EPISODE_UNCONFIRMED');
  await expect(prepareRender('moses')).resolves.toBe(id);
  await expect(prepareRender('hetzner')).rejects.toThrow('YOUTUBE_EPISODE_UNCONFIRMED');

  const readRender = () =>
    db.runTransaction((tx) =>
      readPreparedYouTubeEpisodeInTransaction(tx, {
        firestore: db,
        ref,
        verifiedCallerEmail: caller.serviceAccount,
        render: true,
      })
    );
  await expect(readRender()).resolves.toMatchObject({
    episode: { id, renderTarget: 'moses', renderRuntime: selected },
  });
  await root().update({ renderTarget: 'hetzner' });
  await expect(readRender()).rejects.toThrow('YOUTUBE_EPISODE_UNCONFIRMED');
  expect((await root().collection('episodes').get()).size).toBe(1);
});

test('a closed guest challenge can append one pinned backup without replacing the original authority', async () => {
  const moses = { runtimeId: '12345678-0000-4000-8000-000000000001', commit: buildId };
  const hetzner = { ...moses, runtimeId: '12345678-0000-4000-8000-000000000002' };
  const prepareRender = (renderTarget: 'moses' | 'hetzner', renderRuntime?: typeof moses, guestFailoverFrom?: string) =>
    prepareNativeYouTubeEpisode({
      firestore: db,
      ref,
      caller,
      invocation: nativeInvocation,
      assertCurrent: current,
      render: true,
      renderTarget,
      renderRuntime,
      guestFailoverFrom,
    });
  const id = await prepareRender('moses', moses);
  const render = root().collection('render');
  const first = root().collection('episodes').doc(id);
  const slot = db.doc('temporalYouTubeRenderHosts/staging');
  await expect(prepareRender('hetzner', hetzner, id)).rejects.toThrow('YOUTUBE_EPISODE_UNCONFIRMED');
  const startedAt = Date.now();
  const claim = { schemaVersion: 1, ref, episodeId: id, operationId: root().id, owner, startedAt };
  await db.runTransaction(async (tx) => {
    if ((await tx.get(slot)).exists) throw Error('Isolated emulator render slot is occupied');
    tx.create(slot, youtubeRenderSlot(ref, id));
    tx.create(render.doc('claim'), claim);
    tx.create(render.doc('candidate'), {
      schemaVersion: 1,
      episodeId: id,
      ref,
      owner,
      startedAt,
      providerOutcome: 'waiting_auth',
    });
    tx.update(root(), { renderClaim: id });
  });
  try {
    await expect(prepareRender('hetzner', hetzner, id)).rejects.toThrow('YOUTUBE_EPISODE_UNCONFIRMED');
    await db.runTransaction(async (tx) => {
      const candidate = await tx.get(render.doc('candidate'));
      tx.create(render.doc('close'), {
        schemaVersion: 1,
        episodeId: id,
        ref,
        owner,
        startedAt,
        close: { outcome: 'completed', processId: owner.processId, closedAt: startedAt, exitCode: 0, exitSignal: null },
        candidateVersion: candidate.updateTime,
        ipcAttempted: true,
      });
      tx.delete(slot);
    });
    const switched = await prepareRender('hetzner', hetzner, id);
    expect(switched).not.toBe(id);
    await expect(prepareRender('hetzner')).resolves.toBe(switched);
    await expect(prepareRender('hetzner', hetzner, id)).rejects.toThrow('YOUTUBE_EPISODE_UNCONFIRMED');
    const active = await db.runTransaction((tx) =>
      readPreparedYouTubeEpisodeInTransaction(tx, {
        firestore: db,
        ref,
        render: true,
        verifiedCallerEmail: caller.serviceAccount,
      })
    );
    expect(active.episode).toMatchObject({
      id: switched,
      ordinal: 2,
      renderTarget: 'hetzner',
      renderRuntime: hetzner,
      predecessor: { id, guestFailover: true },
    });
    expect(active.root.get('renderTarget')).toBe('moses');
    expect((await first.get()).get('renderRuntime')).toEqual(moses);
    expect((await root().collection('episodes').get()).size).toBe(2);
  } finally {
    if ((await slot.get()).get('operationId') === root().id) await slot.delete();
  }
});
