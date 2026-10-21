import * as nativeTime from '../../../apps/process-audio/src/temporal/system-time';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';
import {
  prepareNativeYouTubeEpisode,
  readPreparedYouTubeEpisode,
  recordYouTubeEpisodeResource,
  recordReleasedYouTubeEpisode,
  recordNativeYouTubeArchiveWait,
} from '../../../apps/process-audio/src/temporal/hetzner-acquisition-episode';
import {
  createYouTubeAcquisitionHostStore,
  closeYouTubeAcquisitionNativeProcess,
  YOUTUBE_ACQUISITIONS,
} from '../../../apps/process-audio/src/temporal/hetzner-acquisition-store';
import { youtubeAcquisitionId } from '../../../apps/process-audio/src/temporal/hetzner-acquisition';
import {
  MEDIA_ARCHIVE_RETRY_DELAYS,
  type MediaJobRef,
  type MediaArchiveWait,
} from '../../../apps/process-audio/src/temporal/types';
let app: App, db: Firestore, ref: MediaJobRef;
// Actual dedicated Firestore source stores/native stamps. Activity identities,
// actor gate, Cloud/root/process/drain facts and positive due-time clock CONTROLLED.
const buildId = 'a'.repeat(40),
  caller = {
    buildId,
    serviceAccount: `tw-m-${'a'.repeat(20)}@urm-app-staging.iam.gserviceaccount.com`,
    instanceId: 'CONTROLLED_ACTIVITY',
  };
const invocation = {
  workflowId: 'CONTROLLED_WORKFLOW',
  runId: 'CONTROLLED_RUN',
  activityId: 'acquire-first',
  attempt: 1,
};
const owner = { buildId, bootId: randomUUID(), pidNamespace: 'pid:[1234]', processId: 7, startTicks: '100' };
const root = () => db.collection(YOUTUBE_ACQUISITIONS).doc(youtubeAcquisitionId(ref));
const gate = () => db.doc(`_testArchiveAuthority/${ref.jobId}`);
const current = async (tx: Transaction) => {
  if (!(await tx.get(gate())).get('allowed')) throw Error('CONTROLLED_REVOKED');
};
const prepare = (native = invocation, archiveResume?: MediaArchiveWait) =>
  prepareNativeYouTubeEpisode({
    firestore: db,
    ref,
    caller,
    invocation: native,
    archiveResume,
    assertCurrent: current,
  });
const read = () => readPreparedYouTubeEpisode({ firestore: db, ref, verifiedCallerEmail: caller.serviceAccount });
const archiveEvidence = {
  attemptedModes: ['public_provider' as const],
  requiresAuthenticationRecovery: false,
  guestFailureClass: 'post_live_archive_not_ready',
};
beforeAll(() => {
  if (!/^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? ''))
    throw Error('Dedicated emulator required');
  app = initializeApp({ projectId: 'urm-app-staging' }, `archive-${randomUUID()}`);
  db = getFirestore(app);
});
beforeEach(async () => {
  ref = {
    projectId: 'urm-app-staging',
    jobId: `owned-archive-${randomUUID()}`,
    sermonId: 'owned-sermon',
    revision: 1,
    requestVersion: 'b'.repeat(16),
  };
  await gate().create({ allowed: true });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await db.recursiveDelete(root());
  await gate().delete();
});
afterAll(async () => {
  await db.terminate();
  await deleteApp(app);
});
async function running(native = invocation, resume?: MediaArchiveWait) {
  await prepare(native, resume);
  const episode = await read();
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
  const processOwner = { ...owner, processId: 7 + episode.ordinal, startTicks: String(100 * episode.ordinal) };
  const store = createYouTubeAcquisitionHostStore({
    firestore: db,
    projectId: ref.projectId,
    owner: processOwner,
    episodeId: episode.id,
    nativeEnrollment: {
      v: 1,
      id: episode.id,
      state: 'enrolled',
      peerBound: true,
      directory: `/workspace/yt-acquisition-scratch/${episode.id}`,
      receiptHash: 'c'.repeat(64),
    },
    assertEligible: current,
  });
  const startedAt = nativeTime.mediaWallTime();
  expect(await store.claim(ref, caller.serviceAccount, startedAt)).toEqual({ launch: true });
  return { episode, store, processOwner, startedAt };
}
async function close(state: Awaited<ReturnType<typeof running>>) {
  const proof = {
    v: 1 as const,
    id: state.episode.id,
    state: 'drained' as const,
    peerBound: true as const,
    groupAbsent: true as const,
    receiptHash: 'd'.repeat(64),
  };
  await closeYouTubeAcquisitionNativeProcess({
    firestore: db,
    ref,
    owner: state.processOwner,
    startedAt: state.startedAt,
    fact: {
      processId: state.processOwner.processId,
      exitCode: 0,
      exitSignal: null,
      outcome: 'completed',
      closedAt: nativeTime.mediaWallTime(),
    },
    episode: { id: state.episode.id, proof },
  });
  await recordReleasedYouTubeEpisode({ firestore: db, episode: state.episode, proof: { ...proof, state: 'closed' } });
}
async function archived() {
  const state = await running();
  await state.store.settle(ref, { kind: 'waiting_archive' }, async () => undefined, archiveEvidence);
  await close(state);
  return state;
}
function wait(attempt = 1): MediaArchiveWait {
  const scheduledAt = Date.now();
  return {
    attempt,
    scheduledAt,
    dueAt: scheduledAt + MEDIA_ARCHIVE_RETRY_DELAYS[Math.min(attempt - 1, MEDIA_ARCHIVE_RETRY_DELAYS.length - 1)],
  };
}
const record = (value: MediaArchiveWait, projection = { ...invocation, activityId: 'projection-archive' }) =>
  recordNativeYouTubeArchiveWait({
    firestore: db,
    ref,
    wait: value,
    sourceBuildId: buildId,
    invocation: projection,
    assertCurrent: current,
  });
const resumedInvocation = { ...invocation, activityId: 'acquire-archive-next' };

test('archive resume followed by known task_retry uses SAME native Activity attempt2 without consuming another archive wait', async () => {
  await archived();
  const value = wait();
  await record(value);
  jest.spyOn(nativeTime, 'mediaWallTime').mockReturnValue(value.dueAt);
  const next = await running(resumedInvocation, value);
  await next.store.settle(ref, { kind: 'retryable' }, async () => undefined, {
    attemptedModes: ['public_provider'],
    requiresAuthenticationRecovery: false,
  });
  await close(next);
  await prepare({ ...resumedInvocation, attempt: 2 }, value);
  const retry = await read();
  expect(retry.ordinal).toBe(3);
  expect(retry.archiveAttempt).toBe(1);
  expect(retry.predecessor?.archiveWaitHash).toBeUndefined();
});

test('archive successor needs exact authorized wait and due time; elapsed time cannot repair a missing marker', async () => {
  const first = await archived(),
    value = wait();
  await record(value);
  await expect(prepare(resumedInvocation, value)).rejects.toThrow();
  await expect(prepare(resumedInvocation, { ...value, dueAt: value.dueAt - 1 })).rejects.toThrow();
  const auth = root().collection('episodes').doc(first.episode.id).collection('facts').doc('archiveWaitAuthorized');
  await auth.delete();
  jest.spyOn(nativeTime, 'mediaWallTime').mockReturnValue(value.dueAt);
  await expect(prepare(resumedInvocation, value)).rejects.toThrow();
  expect((await root().collection('episodes').get()).size).toBe(1);
});
test('unknown original wait intent ACK cannot create or backfill archive authorization', async () => {
  const first = await archived(),
    value = wait(),
    actual = db.runTransaction.bind(db);
  jest.spyOn(db, 'runTransaction').mockImplementationOnce(async (run, options) => {
    await actual(run, options);
    throw Error('CONTROLLED_WAIT_INTENT_ACK_LOSS');
  });
  await expect(record(value)).rejects.toThrow('CONTROLLED_WAIT_INTENT_ACK_LOSS');
  jest.restoreAllMocks();
  const facts = root().collection('episodes').doc(first.episode.id).collection('facts');
  expect((await facts.doc('archiveWait').get()).exists).toBe(true);
  expect((await facts.doc('archiveWaitAuthorized').get()).exists).toBe(false);
  await expect(record(value, { ...invocation, activityId: 'projection-archive', attempt: 2 })).rejects.toThrow();
  jest.spyOn(nativeTime, 'mediaWallTime').mockReturnValue(value.dueAt);
  await expect(prepare(resumedInvocation, value)).rejects.toThrow();
  expect((await root().collection('episodes').get()).size).toBe(1);
});
test('projection retry retains exact wait/time/stamps and current actor; wrong native projection or renewed due time denies', async () => {
  const first = await archived(),
    value = wait();
  await record(value);
  const doc = root().collection('episodes').doc(first.episode.id).collection('facts').doc('archiveWait'),
    before = await doc.get();
  await record(value, { ...invocation, activityId: 'projection-archive', attempt: 2 });
  expect((await doc.get()).updateTime?.isEqual(before.updateTime!)).toBe(true);
  await expect(record(value, { ...invocation, activityId: 'foreign-projection' })).rejects.toThrow();
  await expect(record({ ...value, scheduledAt: value.scheduledAt + 1, dueAt: value.dueAt + 1 })).rejects.toThrow();
  await gate().update({ allowed: false });
  await expect(record(value)).rejects.toThrow('CONTROLLED_REVOKED');
});
test.each(['archiveWait', 'archiveWaitAuthorized'])(
  'successor rechecks original %s data AND native stamps after creation',
  async (name) => {
    const first = await archived(),
      value = wait();
    await record(value);
    jest.spyOn(nativeTime, 'mediaWallTime').mockReturnValue(value.dueAt);
    await prepare(resumedInvocation, value);
    expect((await read()).archiveAttempt).toBe(1);
    const doc = root().collection('episodes').doc(first.episode.id).collection('facts').doc(name),
      original = (await doc.get()).data()!;
    await doc.update({ changed: true });
    await doc.set(original);
    await expect(read()).rejects.toThrow();
  }
);
test('archive wait cannot be projected from a sealed but unreleased predecessor', async () => {
  const first = await running();
  await first.store.settle(ref, { kind: 'waiting_archive' }, async () => undefined, archiveEvidence);
  await expect(record(wait())).rejects.toThrow();
  expect(
    (await root().collection('episodes').doc(first.episode.id).collection('facts').doc('archiveWait').get()).exists
  ).toBe(false);
});
test('later native SDK attempt observes an already settled archive original without another producer', async () => {
  const first = await archived();
  await prepare({ ...invocation, attempt: 2 });
  expect((await root().get()).get('preparedEpisode')).toBe(first.episode.id);
  expect((await root().collection('episodes').get()).size).toBe(1);
});

test('source-fixed delay/attempt bound and exact original Run forbid arbitrary short waits or continuation adoption', async () => {
  await archived();
  const value = wait();
  await expect(record({ ...value, dueAt: value.scheduledAt + 1 })).rejects.toThrow();
  await expect(record(wait(13))).rejects.toThrow();
  await record(value);
  jest.spyOn(nativeTime, 'mediaWallTime').mockReturnValue(value.dueAt);
  await expect(prepare({ ...resumedInvocation, runId: 'CONTINUED_RUN' }, value)).rejects.toThrow();
  expect((await root().collection('episodes').get()).size).toBe(1);
});
