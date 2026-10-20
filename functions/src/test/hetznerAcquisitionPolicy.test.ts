import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { durableEntityKey } from '@upperroom/orchestration/job-store';
import { computeProcessAudioRequestVersion } from '@upperroom/contracts/processAudioQueue';
import { readEligibleYouTubeAcquisition } from '../../../apps/process-audio/src/temporal/hetzner-acquisition-policy';
import type { MediaJobRef } from '../../../apps/process-audio/src/temporal/types';
let app: App, db: Firestore, auth: Auth, ref: MediaJobRef, uid: string;
let paths: string[];
const input = () => ({
  id: ref.sermonId,
  youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  startTime: 0,
  duration: 30,
});
const read = () =>
  db.runTransaction((transaction) => readEligibleYouTubeAcquisition({ firestore: db, auth, transaction, ref }));
beforeAll(() => {
  for (const host of [process.env.FIRESTORE_EMULATOR_HOST, process.env.FIREBASE_AUTH_EMULATOR_HOST]) {
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host ?? '') || host?.endsWith(':9'))
      throw new Error('Dedicated emulator harness required');
  }
  app = initializeApp({ projectId: 'urm-app-staging' }, `acquisition-policy-${randomUUID()}`);
  db = getFirestore(app);
  auth = getAuth(app);
});
beforeEach(async () => {
  uid = `yt-owner-${randomUUID()}`;
  const sermonId = `yt-sermon-${randomUUID()}`;
  const payload = {
    id: sermonId,
    youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    startTime: 0,
    duration: 30,
  };
  ref = {
    projectId: 'urm-app-staging',
    jobId: `audio-${randomUUID()}`,
    sermonId,
    revision: 2,
    requestVersion: computeProcessAudioRequestVersion(payload),
  };
  await auth.createUser({ uid });
  await auth.setCustomUserClaims(uid, { role: 'uploader' });
  const entity = { type: 'sermon' as const, id: sermonId };
  paths = [
    `temporalMediaRequests/${ref.jobId}`,
    `temporalMediaState/${sermonId}`,
    `sermons/${sermonId}`,
    `durableJobs/${ref.jobId}`,
    `durableJobIntents/${ref.jobId}`,
    `durableJobEntities/${durableEntityKey(ref.projectId, entity, 'audio.process')}`,
  ];
  const batch = db.batch();
  batch.set(db.doc(paths[0]), { ref, payload, sources: {} });
  batch.set(db.doc(paths[1]), { owner: 'temporal', ref });
  batch.set(db.doc(paths[2]), { uploaderId: uid });
  batch.set(db.doc(paths[3]), {
    projectId: ref.projectId,
    jobId: ref.jobId,
    kind: 'audio.process',
    entity,
    generation: 2,
    requestedBy: uid,
    state: 'running',
  });
  batch.set(db.doc(paths[4]), {
    projectId: ref.projectId,
    jobId: ref.jobId,
    kind: 'audio.process',
    entity,
    generation: 2,
    actorUid: uid,
    payload: { mediaRequestId: ref.jobId },
  });
  batch.set(db.doc(paths[5]), {
    projectId: ref.projectId,
    entity,
    scope: 'audio',
    generation: 2,
    activeJobId: ref.jobId,
  });
  batch.set(db.doc('_control/temporalRelease'), {
    schemaVersion: 1,
    revision: 1,
    admission: 'open',
    domains: { media: { owner: 'temporal', admission: 'open' } },
  });
  await batch.commit();
});
afterEach(async () => {
  const batch = db.batch();
  for (const path of paths) batch.delete(db.doc(path));
  batch.delete(db.doc('_control/temporalRelease'));
  await batch.commit();
  await auth.deleteUser(uid);
});
afterAll(async () => {
  await db.terminate();
  await deleteApp(app);
});
test('reads the admitted private YouTube input using real current actor and generation records', async () => {
  const result = await read();
  expect(result).toMatchObject({ kind: 'ready', payload: input() });
});
test.each([
  [0, { 'payload.youtubeUrl': 'https://private.invalid/source?token=SECRET' }],
  [0, { 'ref.revision': 3 }],
  [3, { projectId: 'urm-app' }],
  [3, { kind: 'upload.create' }],
  [3, { 'entity.id': 'foreign' }],
  [3, { requestedBy: 'foreign' }],
  [3, { generation: 3 }],
  [4, { 'entity.id': 'foreign' }],
  [4, { 'payload.mediaRequestId': 'foreign' }],
  [5, { generation: 3 }],
  [5, { scope: 'publishing' }],
  [5, { 'entity.id': 'foreign' }],
  [5, { activeJobId: 'foreign' }],
  [1, { deletionParentRef: { jobId: 'delete-current' } }],
  [3, { state: 'failed' }],
])('rejects corrupt/stale binding without exposing private diagnostics: %j', async (index, patch) => {
  await db.doc(paths[Number(index)]).update(patch);
  await expect(read()).rejects.toThrow(/^YOUTUBE_ACQUISITION_INELIGIBLE$/);
});
test.each(['viewer', 'uploader-disabled', 'removed-owner'])(
  'live permission revocation stops acquisition: %s',
  async (mode) => {
    if (mode === 'viewer') await auth.setCustomUserClaims(uid, { role: 'viewer' });
    if (mode === 'uploader-disabled') await auth.updateUser(uid, { disabled: true });
    if (mode === 'removed-owner') await db.doc(paths[2]).update({ uploaderId: 'other' });
    await expect(read()).rejects.toThrow('YOUTUBE_ACQUISITION_INELIGIBLE');
  }
);
test.each(['cancel_requested', 'cancelled', 'succeeded', 'superseded'])(
  'canonical terminal state reports bounded outcome: %s',
  async (state) => {
    await db.doc(paths[3]).update({ state });
    await expect(read()).resolves.toEqual({
      kind: state === 'succeeded' ? 'completed' : state === 'superseded' ? 'superseded' : 'cancelled',
    });
  }
);
test('missing sermon and changed current media reference never launch stale work', async () => {
  await db.doc(paths[1]).update({ 'ref.jobId': 'replacement' });
  await expect(read()).resolves.toEqual({ kind: 'superseded' });
  await db.doc(paths[2]).delete();
  await expect(read()).resolves.toEqual({ kind: 'deleted' });
});
test('an already attached immutable source is reused without another acquisition', async () => {
  const artifact = {
    path: `workflow-audio/${ref.sermonId}/${ref.requestVersion}/source-existing.m4a`,
    generation: '123',
    duration: 40,
  };
  await db.doc(paths[0]).update({ 'artifacts.source': artifact });
  await expect(read()).resolves.toEqual({ kind: 'source', artifact });
});

test('an admitted continuation survives a pause but cannot cross release ownership transfer', async () => {
  await db.doc('_control/temporalRelease').update({ admission: 'paused', 'domains.media.admission': 'paused' });
  await expect(read()).resolves.toMatchObject({ kind: 'ready' });
  await db.doc('_control/temporalRelease').update({ 'domains.media.owner': 'legacy' });
  await expect(read()).rejects.toThrow('YOUTUBE_ACQUISITION_INELIGIBLE');
});
test('missing release control fails closed rather than using an earlier prepared delegation', async () => {
  await db.doc('_control/temporalRelease').delete();
  await expect(read()).rejects.toThrow('YOUTUBE_ACQUISITION_INELIGIBLE');
});
