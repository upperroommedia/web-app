import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { hostResourceRequest } from '../../../apps/process-audio/src/host/resources';
import {
  prepareNativeYouTubeEpisode,
  readPreparedYouTubeEpisode,
  closeUnclaimedYouTubeEpisode,
} from '../../../apps/process-audio/src/temporal/hetzner-acquisition-episode';
import { reserveYouTubeEpisodeResources } from '../../../apps/process-audio/src/temporal/hetzner-acquisition-resources';
import {
  createYouTubeAcquisitionHostStore,
  closeYouTubeAcquisitionNativeProcess,
  YOUTUBE_ACQUISITIONS,
} from '../../../apps/process-audio/src/temporal/hetzner-acquisition-store';
import {
  runYouTubeAcquisitionProcess,
  type YouTubeNativeClose,
} from '../../../apps/process-audio/src/temporal/hetzner-acquisition-process';
import { youtubeAcquisitionId } from '../../../apps/process-audio/src/temporal/hetzner-acquisition';
import type { MediaJobRef } from '../../../apps/process-audio/src/temporal/types';
jest.mock('../../../apps/process-audio/src/host/resources', () => ({ hostResourceRequest: jest.fn() }));
// Actual owned local OS + dedicated Firestore; native root/kernel/cgroup/actor
// and Activity invocation are CONTROLLED. Never constructs a root daemon.
let app: App, db: Firestore, ref: MediaJobRef, directory: string;
const buildId = 'a'.repeat(40),
  caller = {
    buildId,
    serviceAccount: `tw-m-${'a'.repeat(20)}@urm-app-staging.iam.gserviceaccount.com`,
    instanceId: 'CONTROLLED_ACTIVITY',
  };
const owner = { buildId, bootId: randomUUID(), pidNamespace: 'pid:[1234]', processId: 7, startTicks: '100' };
const root = () => db.collection(YOUTUBE_ACQUISITIONS).doc(youtubeAcquisitionId(ref));
const gate = () => db.doc(`_testUnclaimedAuthority/${ref.jobId}`);
const current = async (tx: Transaction) => {
  if (!(await tx.get(gate())).get('allowed')) throw Error('CONTROLLED_REVOKED');
};
const prepare = (attempt = 1) =>
  prepareNativeYouTubeEpisode({
    firestore: db,
    ref,
    caller,
    invocation: {
      workflowId: 'CONTROLLED_WORKFLOW',
      runId: 'CONTROLLED_RUN',
      activityId: 'CONTROLLED_ACTIVITY',
      attempt,
    },
    assertCurrent: current,
  });
const read = () => readPreparedYouTubeEpisode({ firestore: db, ref, verifiedCallerEmail: caller.serviceAccount });
beforeAll(() => {
  if (!/^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? ''))
    throw Error('Dedicated emulator required');
  app = initializeApp({ projectId: 'urm-app-staging' }, `unclaimed-${randomUUID()}`);
  db = getFirestore(app);
});
beforeEach(async () => {
  jest.clearAllMocks();
  ref = {
    projectId: 'urm-app-staging',
    jobId: `owned-unclaimed-${randomUUID()}`,
    sermonId: 'owned-sermon',
    revision: 1,
    requestVersion: 'b'.repeat(16),
  };
  directory = await mkdtemp(join(tmpdir(), 'owned-unclaimed-'));
  await gate().create({ allowed: true });
  jest.mocked(hostResourceRequest).mockImplementation(async (id, action) => ({
    v: 1,
    id,
    peerBound: true,
    receiptHash: 'c'.repeat(64),
    state:
      action === 'reserve' ? 'reserved' : action === 'seal' ? 'drained' : action === 'release' ? 'closed' : 'enrolled',
    ...(action === 'reserve' || action === 'enroll' ? { directory: `/workspace/yt-acquisition-scratch/${id}` } : {}),
    ...(action === 'seal' || action === 'release' ? { groupAbsent: true } : {}),
  }));
});
afterEach(async () => {
  jest.restoreAllMocks();
  await db.recursiveDelete(root());
  await gate().delete();
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  await db.terminate();
  await deleteApp(app);
});
async function reserved() {
  await prepare();
  const episode = await read();
  const reservation = await reserveYouTubeEpisodeResources({
    firestore: db,
    episode,
    startSignal: new AbortController().signal,
    assertCurrent: current,
  });
  return { episode, reservation };
}
async function enrolled() {
  const state = await reserved();
  await state.reservation.enroll(owner.processId, new AbortController().signal);
  return state;
}
const fact = (): YouTubeNativeClose => ({
  processId: 7,
  exitCode: null,
  exitSignal: 'SIGTERM',
  outcome: 'failed',
  closedAt: Date.now(),
});
const host = (episodeId: string, assertEligible = current) =>
  createYouTubeAcquisitionHostStore({
    firestore: db,
    projectId: ref.projectId,
    owner,
    episodeId,
    nativeEnrollment: {
      v: 1,
      id: episodeId,
      peerBound: true,
      state: 'enrolled',
      directory: `/workspace/yt-acquisition-scratch/${episodeId}`,
      receiptHash: 'c'.repeat(64),
    },
    assertEligible,
  });
test('actual original ChildProcess closes without IPC; unclaimed fence and physical release never create owner/birth/retry authority', async () => {
  const { episode, reservation } = await reserved();
  const helperPath = join(directory, 'inert.cjs');
  await writeFile(
    helperPath,
    "process.once('message', () => require('node:fs').writeFileSync(" +
      JSON.stringify(join(directory, 'bad-ipc')) +
      ", 'bad')); setInterval(()=>{},1000);"
  );
  await expect(
    runYouTubeAcquisitionProcess({
      helperPath,
      directory,
      ref,
      episodeId: episode.id,
      signal: reservation.signal,
      authorize: async (pid) => {
        await reservation.enroll(pid, new AbortController().signal);
        return false;
      },
      onNativeClose: async (closed, boundary) => {
        expect(boundary).toEqual({ ipcAttempted: false });
        expect(Object.isFrozen(boundary)).toBe(true);
        expect(() => process.kill(-closed.processId, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
        const proof = await reservation.sealAfterNativeClose();
        await closeUnclaimedYouTubeEpisode({ firestore: db, episode, proof, fact: closed, boundary });
      },
    })
  ).resolves.toBe('failed');
  await reservation.releaseAfterNativeDrain();
  await expect(access(join(directory, 'bad-ipc'))).rejects.toThrow();
  const saved = await root().get();
  expect(saved.get('unclaimedClose.ipcAttempted')).toBe(false);
  expect(saved.get('status')).toBe('prepared');
  expect(saved.get('owner')).toBeUndefined();
  expect((await root().collection('episodes').doc(episode.id).collection('facts').doc('birth').get()).exists).toBe(
    false
  );
  expect((await root().collection('nativeClose').doc('original').get()).exists).toBe(false);
  expect((await root().collection('episodes').doc(episode.id).collection('facts').doc('released').get()).exists).toBe(
    true
  );
  expect(await host(episode.id).claim(ref, caller.serviceAccount)).toEqual({ launch: false });
  await expect(read()).rejects.toThrow();
  await expect(prepare()).rejects.toThrow();
  await expect(prepare(2)).rejects.toThrow();
  expect((await root().collection('episodes').get()).size).toBe(1);
});
test('racing real claim and unclaimed closure cannot both commit authority', async () => {
  const { episode, reservation } = await enrolled();
  let began!: () => void, resume!: () => void;
  const waiting = new Promise<void>((resolve) => {
    began = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const startedAt = Date.now();
  const claiming = host(episode.id, async (tx) => {
    await current(tx);
    began();
    await resumed;
  }).claim(ref, caller.serviceAccount, startedAt);
  const claimed = claiming.then(
    () => true,
    () => false
  );
  await waiting;
  const proof = await reservation.sealAfterNativeClose(),
    closed = fact();
  const closing = closeUnclaimedYouTubeEpisode({
    firestore: db,
    episode,
    proof,
    fact: closed,
    boundary: { ipcAttempted: false },
  }).then(
    () => true,
    () => false
  );
  // Native Firestore pessimistic lock arbitration chooses the winner; do not
  // assert that a later transaction must preempt an older read lock.
  await new Promise((resolve) => setTimeout(resolve, 25));
  resume();
  const [claimWon, closeWon] = await Promise.all([claimed, closing]);
  expect(claimWon && closeWon).toBe(false);
  const saved = await root().get(),
    birth = await root().collection('episodes').doc(episode.id).collection('facts').doc('birth').get();
  if (closeWon) {
    expect(saved.get('owner')).toBeUndefined();
    expect(birth.exists).toBe(false);
    await reservation.releaseAfterNativeDrain();
    expect(await host(episode.id).claim(ref, caller.serviceAccount)).toEqual({ launch: false });
  } else if (claimWon) {
    expect(saved.get('unclaimedClose')).toBeUndefined();
    expect(birth.exists).toBe(true);
    await closeYouTubeAcquisitionNativeProcess({
      firestore: db,
      ref,
      owner,
      startedAt,
      fact: closed,
      episode: { id: episode.id, proof },
    });
    await reservation.releaseAfterNativeDrain();
  } else {
    expect(saved.get('owner')).toBeUndefined();
    expect(saved.get('unclaimedClose')).toBeUndefined();
    await expect(reservation.releaseAfterNativeDrain()).rejects.toThrow();
  }
});
test('committed unknown claim is NEVER unclaimed; only exact original owned closure may release', async () => {
  const { episode, reservation } = await enrolled();
  const actual = db.runTransaction.bind(db),
    startedAt = Date.now();
  jest.spyOn(db, 'runTransaction').mockImplementationOnce(async (run, options) => {
    await actual(run, options);
    throw Error('CONTROLLED_COMMITTED_CLAIM_ACK_LOSS');
  });
  await expect(host(episode.id).claim(ref, caller.serviceAccount, startedAt)).rejects.toThrow(
    'CONTROLLED_COMMITTED_CLAIM_ACK_LOSS'
  );
  jest.restoreAllMocks();
  const proof = await reservation.sealAfterNativeClose(),
    closed = fact();
  await expect(
    closeUnclaimedYouTubeEpisode({ firestore: db, episode, proof, fact: closed, boundary: { ipcAttempted: false } })
  ).rejects.toThrow();
  expect((await root().get()).get('unclaimedClose')).toBeUndefined();
  await expect(reservation.releaseAfterNativeDrain()).rejects.toThrow();
  await closeYouTubeAcquisitionNativeProcess({
    firestore: db,
    ref,
    owner,
    startedAt,
    fact: closed,
    episode: { id: episode.id, proof },
  });
  await reservation.releaseAfterNativeDrain();
  expect((await root().get()).get('owner')).toEqual(owner);
});
test('committed unclaimed closure ACK loss reconciles exact immutable GETs without resending the mutation', async () => {
  const { episode, reservation } = await enrolled(),
    proof = await reservation.sealAfterNativeClose();
  const actual = db.runTransaction.bind(db);
  let updates = 0;
  jest.spyOn(db, 'runTransaction').mockImplementationOnce(async (run, options) => {
    await actual(async (tx) => {
      const update = tx.update.bind(tx);
      jest.spyOn(tx, 'update').mockImplementation((...args: Parameters<typeof update>) => {
        updates++;
        return update(...args);
      });
      return run(tx);
    }, options);
    throw Error('CONTROLLED_COMMITTED_CLOSE_ACK_LOSS');
  });
  await closeUnclaimedYouTubeEpisode({
    firestore: db,
    episode,
    proof,
    fact: fact(),
    boundary: { ipcAttempted: false },
  });
  expect(updates).toBe(1);
  jest.restoreAllMocks();
  await reservation.releaseAfterNativeDrain();
});
test('attempted IPC and rewritten closure cannot become unclaimed release or launch authority', async () => {
  const { episode, reservation } = await enrolled(),
    proof = await reservation.sealAfterNativeClose();
  await expect(
    closeUnclaimedYouTubeEpisode({ firestore: db, episode, proof, fact: fact(), boundary: { ipcAttempted: true } })
  ).rejects.toThrow();
  await closeUnclaimedYouTubeEpisode({
    firestore: db,
    episode,
    proof,
    fact: fact(),
    boundary: { ipcAttempted: false },
  });
  const doc = root().collection('unclaimedClose').doc('original'),
    original = (await doc.get()).data()!;
  await doc.update({ 'fact.closedAt': original.fact.closedAt + 1 });
  await doc.set(original);
  await expect(reservation.releaseAfterNativeDrain()).rejects.toThrow();
  expect(jest.mocked(hostResourceRequest).mock.calls.some((call) => call[1] === 'release')).toBe(false);
});

test('known unclaimed cleanup uses no renewed actor permission while missing enrollment retains the scope', async () => {
  const { episode, reservation } = await reserved();
  const proof = await reservation.sealAfterNativeClose(); // CONTROLLED negative root response only.
  await expect(
    closeUnclaimedYouTubeEpisode({ firestore: db, episode, proof, fact: fact(), boundary: { ipcAttempted: false } })
  ).rejects.toThrow();
  await expect(reservation.releaseAfterNativeDrain()).rejects.toThrow();
  expect(jest.mocked(hostResourceRequest).mock.calls.some((call) => call[1] === 'release')).toBe(false);
});
test('current actor revocation cannot block authoritative cleanup or authorize a new native claim', async () => {
  const { episode, reservation } = await enrolled(),
    proof = await reservation.sealAfterNativeClose();
  await gate().update({ allowed: false });
  await closeUnclaimedYouTubeEpisode({
    firestore: db,
    episode,
    proof,
    fact: fact(),
    boundary: { ipcAttempted: false },
  });
  await reservation.releaseAfterNativeDrain();
  await expect(host(episode.id).claim(ref, caller.serviceAccount)).rejects.toThrow('CONTROLLED_REVOKED');
  await expect(prepare(2)).rejects.toThrow();
  expect((await root().collection('episodes').get()).size).toBe(1);
});
