import { Readable } from 'node:stream';
import { uploadYouTubeObject } from '../../../apps/process-audio/src/temporal/hetzner-acquisition-upload';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { createHetznerAcquisitionRouter } from '../../../apps/process-audio/src/temporal/hetzner-acquisition-http';
import {
  createYouTubeAcquisitionHostStore,
  prepareYouTubeAcquisition,
  YOUTUBE_ACQUISITIONS,
} from '../../../apps/process-audio/src/temporal/hetzner-acquisition-store';
import { youtubeAcquisitionId } from '../../../apps/process-audio/src/temporal/hetzner-acquisition';
import { getStorage } from 'firebase-admin/storage';
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
let server: Server, origin: string;
const email = `tw-m-${'a'.repeat(20)}@urm-app-staging.iam.gserviceaccount.com`;
const call = async (method = 'GET', body?: unknown, token = 'CONTROLLED_OIDC') => {
  const response = await fetch(`${origin}/${youtubeAcquisitionId(ref)}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() };
};
beforeAll(async () => {
  for (const host of [process.env.FIRESTORE_EMULATOR_HOST, process.env.FIREBASE_AUTH_EMULATOR_HOST]) {
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host ?? '') || host?.endsWith(':9'))
      throw new Error('Dedicated emulator harness required');
  }
  app = initializeApp(
    { projectId: 'urm-app-staging', storageBucket: 'urm-app-staging.firebasestorage.app' },
    `acquisition-policy-${randomUUID()}`
  );
  db = getFirestore(app);
  auth = getAuth(app);
  // CONTROLLED signature verifier only. No claim of native Google OIDC acceptance.
  jest.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockImplementation(async (input) => {
    if (
      input.idToken !== 'CONTROLLED_OIDC' ||
      JSON.stringify(input.audience) !== JSON.stringify(['https://yt-worker-staging.upperroommedia.org'])
    )
      throw Error('CONTROLLED_PRIVATE_AUTH_ERROR');
    return {
      getPayload: () => ({
        iss: 'https://accounts.google.com',
        email_verified: true,
        sub: 'CONTROLLED_SUBJECT',
        email,
      }),
    } as never;
  });
  const http = express();
  http.use(express.json({ limit: '16kb' }));
  http.use(createHetznerAcquisitionRouter({ firestore: db, auth, bucket: getStorage(app).bucket() }));
  server = createServer(http);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Owned loopback listener missing');
  origin = `http://127.0.0.1:${address.port}`;
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
  await prepareYouTubeAcquisition({
    firestore: db,
    ref,
    caller: { buildId: 'a'.repeat(40), serviceAccount: email, instanceId: 'CONTROLLED_CLOUD_INSTANCE' },
    assertCurrent: async (transaction) => {
      const allowed = await readEligibleYouTubeAcquisition({ firestore: db, auth, transaction, ref });
      if (allowed.kind !== 'ready') throw Error('CONTROLLED_ADMISSION_DENIED');
    },
  });
});
afterEach(async () => {
  const batch = db.batch();
  for (const path of paths) batch.delete(db.doc(path));
  batch.delete(db.doc('_control/temporalRelease'));
  await batch.commit();
  await db.recursiveDelete(db.doc(`${YOUTUBE_ACQUISITIONS}/${youtubeAcquisitionId(ref)}`));
  await auth.deleteUser(uid);
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  jest.restoreAllMocks();
  await db.terminate();
  await deleteApp(app);
});

test('real loopback GET reads actual prepared delegation without writes or process authority', async () => {
  const doc = db.doc(`${YOUTUBE_ACQUISITIONS}/${youtubeAcquisitionId(ref)}`),
    before = await doc.get();
  expect(await call()).toEqual({ status: 200, body: { status: 'missing', operationId: youtubeAcquisitionId(ref) } });
  const after = await doc.get();
  expect(after.updateTime!.isEqual(before.updateTime!)).toBe(true);
  expect(after.data()).toEqual(before.data());
});
test('authenticated POST is still denied and cannot claim or create work', async () => {
  const doc = db.doc(`${YOUTUBE_ACQUISITIONS}/${youtubeAcquisitionId(ref)}`),
    before = await doc.get();
  expect((await call('POST', { operationId: youtubeAcquisitionId(ref), ref })).status).toBe(503);
  expect((await doc.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
  expect((await doc.collection('uploads').get()).empty).toBe(true);
});
test.each(['token', 'role', 'owner', 'prepared-caller'])(
  'untrusted or revoked %s cannot read private operation',
  async (mode) => {
    if (mode === 'role') await auth.setCustomUserClaims(uid, { role: 'guest' });
    if (mode === 'owner') await db.doc(`sermons/${ref.sermonId}`).update({ uploaderId: 'CONTROLLED_FOREIGN' });
    if (mode === 'prepared-caller')
      await db
        .doc(`${YOUTUBE_ACQUISITIONS}/${youtubeAcquisitionId(ref)}`)
        .update({ 'preparedBy.serviceAccount': `tw-m-${'b'.repeat(20)}@urm-app-staging.iam.gserviceaccount.com` });
    const result = await call('GET', undefined, mode === 'token' ? 'CONTROLLED_WRONG' : undefined);
    expect(result).toEqual({ status: 503, body: { error: 'Acquisition readback is unavailable.' } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|https:|token|youtubeUrl|requestedBy/);
  }
);
test('final native actor read settling after original deadline cannot produce success', async () => {
  const original = auth.getUser.bind(auth);
  let calls = 0;
  const spy = jest.spyOn(auth, 'getUser').mockImplementation(async (uid) => {
    if (++calls === 2) await new Promise((resolve) => setTimeout(resolve, 5100));
    return original(uid);
  });
  try {
    expect((await call()).status).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    spy.mockRestore();
  }
});
test.each(['cancel_requested', 'cancelled', 'succeeded', 'superseded'])(
  'canonical %s disposition fences stale prepared host status',
  async (state) => {
    await db.doc(`durableJobs/${ref.jobId}`).update({ state });
    expect(await call()).toEqual({ status: 503, body: { error: 'Acquisition readback is unavailable.' } });
  }
);

async function settleSyntheticSource() {
  const host = createYouTubeAcquisitionHostStore({
    firestore: db,
    projectId: ref.projectId,
    owner: {
      bootId: randomUUID(),
      pidNamespace: 'pid:[1234]',
      processId: 7,
      startTicks: '100',
      buildId: 'a'.repeat(40),
    },
    assertEligible: async (transaction) => {
      if ((await readEligibleYouTubeAcquisition({ firestore: db, auth, transaction, ref })).kind !== 'ready')
        throw Error('CONTROLLED_HOST_DENIED');
    },
  });
  expect((await host.claim(ref, email)).launch).toBe(true);
  const artifact = await uploadYouTubeObject({
    journal: host.upload(ref, randomUUID()),
    signal: new AbortController().signal,
    start: async () => ({
      output: Readable.from([Buffer.alloc(128, 42)]),
      completion: Promise.resolve('succeeded'),
      drain: async () => undefined,
    }),
  });
  await host.settle(ref, { kind: 'source', artifact }, async () => undefined);
  return artifact;
}
test('actual native settled-source metadata is returned only while canonical authority remains ready', async () => {
  const artifact = await settleSyntheticSource();
  try {
    expect(await call()).toEqual({
      status: 200,
      body: { status: 'ready', operationId: youtubeAcquisitionId(ref), artifact },
    });
    await db.doc(`durableJobs/${ref.jobId}`).update({ state: 'cancel_requested' });
    expect((await call()).status).toBe(503);
    await db.doc(`durableJobs/${ref.jobId}`).update({ state: 'running' });
    await db.doc(`sermons/${ref.sermonId}`).delete();
    expect((await call()).status).toBe(503);
  } finally {
    await getStorage(app).bucket().file(artifact.path).delete({ ignoreNotFound: true });
  }
});
test('second native actor read detects revocation after initial inspection', async () => {
  const original = auth.getUser.bind(auth);
  let calls = 0;
  const spy = jest.spyOn(auth, 'getUser').mockImplementation(async (actor) => {
    if (++calls === 2) await auth.setCustomUserClaims(uid, { role: 'guest' });
    return original(actor);
  });
  try {
    expect((await call()).status).toBe(503);
  } finally {
    spy.mockRestore();
  }
});
