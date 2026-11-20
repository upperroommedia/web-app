import { createNativeYouTubeAuthorization } from '../../../apps/process-audio/src/temporal/hetzner-acquisition-authorization';
import * as nativeIdentity from '../../../apps/process-audio/src/temporal/hetzner-acquisition-identity';
import { Readable } from 'node:stream';
import { uploadYouTubeObject } from '../../../apps/process-audio/src/temporal/hetzner-acquisition-upload';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { createHetznerAcquisitionRouter } from '../../../apps/process-audio/src/temporal/hetzner-acquisition-http';
import {
  createYouTubeAcquisitionHostStore,
  closeYouTubeAcquisitionNativeProcess,
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
const originalRelease = process.env.SENTRY_RELEASE;
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
  process.env.SENTRY_RELEASE = `process-audio-hetzner@staging-${'b'.repeat(40)}`;
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
  http.use(
    createHetznerAcquisitionRouter({ firestore: db, auth, bucket: getStorage(app).bucket(), renderEnabled: false })
  );
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
  if (originalRelease === undefined) delete process.env.SENTRY_RELEASE;
  else process.env.SENTRY_RELEASE = originalRelease;
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

async function settleSyntheticSource(close = true) {
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
  if (close) await closeSyntheticParent();
  return artifact;
}
async function closeSyntheticParent(outcome: 'completed' | 'failed' = 'completed') {
  // CONTROLLED parent death evidence; native persistence/HTTP consumers are real.
  const original = await db.doc(`${YOUTUBE_ACQUISITIONS}/${youtubeAcquisitionId(ref)}`).get();
  const owner = original.get('owner');
  await closeYouTubeAcquisitionNativeProcess({
    firestore: db,
    ref,
    owner,
    startedAt: original.get('startedAt'),
    fact: {
      processId: owner.processId,
      exitCode: outcome === 'completed' ? 0 : 1,
      exitSignal: null,
      outcome,
      closedAt: Date.now(),
    },
  });
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

test('canonical inert-child claim denies late actual actor read without committing running ownership', async () => {
  const owner = {
    bootId: randomUUID(),
    pidNamespace: 'pid:[1234]',
    processId: 7,
    startTicks: '100',
    buildId: 'b'.repeat(40),
  };
  const inspect = jest.spyOn(nativeIdentity, 'inspectNativeYouTubeProcess').mockResolvedValue(owner);
  const original = auth.getUser.bind(auth);
  const late = jest.spyOn(auth, 'getUser').mockImplementation(async (actor) => {
    await new Promise((resolve) => setTimeout(resolve, 5100));
    return original(actor);
  });
  const document = db.doc(`${YOUTUBE_ACQUISITIONS}/${youtubeAcquisitionId(ref)}`),
    before = await document.get();
  try {
    const authorize = createNativeYouTubeAuthorization({
      firestore: db,
      auth,
      ref,
      buildId: owner.buildId,
      verifiedCallerEmail: email,
    });
    await expect(authorize(owner.processId, new AbortController().signal)).rejects.toThrow(
      'YOUTUBE_ACQUISITION_AUTHORITY_UNAVAILABLE'
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await document.get();
    expect(after.get('status')).toBe('prepared');
    expect(after.updateTime!.isEqual(before.updateTime!)).toBe(true);
  } finally {
    late.mockRestore();
    inspect.mockRestore();
  }
});

test('helper source settlement alone remains running until original parent CLOSE is atomically confirmed', async () => {
  const artifact = await settleSyntheticSource(false);
  try {
    expect(await call()).toEqual({ status: 200, body: { status: 'running', operationId: youtubeAcquisitionId(ref) } });
    await closeSyntheticParent();
    expect((await call()).body.status).toBe('ready');
    const parent = db.doc(`${YOUTUBE_ACQUISITIONS}/${youtubeAcquisitionId(ref)}`);
    const saved = parent.collection('nativeClose').doc('original');
    const prior = await saved.get();
    await saved.update({ closedAt: prior.get('closedAt') + 1 });
    await saved.update({ closedAt: prior.get('closedAt') });
    expect((await call()).status).toBe(503);
  } finally {
    await getStorage(app).bucket().file(artifact.path).delete({ ignoreNotFound: true });
  }
});
test('nonzero helper termination never converts an existing uploaded source into adoption authority', async () => {
  const artifact = await settleSyntheticSource(false);
  try {
    await closeSyntheticParent('failed');
    expect((await call()).status).toBe(503);
  } finally {
    await getStorage(app).bucket().file(artifact.path).delete({ ignoreNotFound: true });
  }
});
test('committed parent CLOSE ACK loss reconciles GET-only without rewriting original death facts', async () => {
  const artifact = await settleSyntheticSource(false);
  const run = db.runTransaction.bind(db);
  let writes = 0;
  const spy = jest.spyOn(db, 'runTransaction').mockImplementation((async (
    ...args: Parameters<typeof db.runTransaction>
  ) => {
    writes++;
    await run(...args);
    throw Error('CONTROLLED_CLOSE_ACK_LOSS');
  }) as typeof db.runTransaction);
  try {
    await closeSyntheticParent();
    expect(writes).toBe(1);
    spy.mockRestore();
    expect((await call()).body.status).toBe('ready');
  } finally {
    spy.mockRestore();
    await getStorage(app).bucket().file(artifact.path).delete({ ignoreNotFound: true });
  }
});

test('parent close refuses a changed original claim timestamp without writing any death record', async () => {
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
    assertEligible: async () => undefined,
  });
  await host.claim(ref, email);
  const parent = db.doc(`${YOUTUBE_ACQUISITIONS}/${youtubeAcquisitionId(ref)}`);
  const original = await parent.get();
  await parent.update({ startedAt: original.get('startedAt') + 1 });
  await expect(
    closeYouTubeAcquisitionNativeProcess({
      firestore: db,
      ref,
      owner: original.get('owner'),
      startedAt: original.get('startedAt'),
      fact: { processId: 7, exitCode: 0, exitSignal: null, outcome: 'completed', closedAt: Date.now() + 1 },
    })
  ).rejects.toThrow('YOUTUBE_ACQUISITION_OWNERSHIP');
  expect((await parent.collection('nativeClose').doc('original').get()).exists).toBe(false);
  expect((await parent.get()).get('nativeClose')).toBeUndefined();
});

test('actual HTTP and SAME-object source consumer select successor execution rather than original retry history', async () => {
  const {
    prepareNativeYouTubeEpisode,
    readPreparedYouTubeEpisode,
    recordYouTubeEpisodeResource,
    recordReleasedYouTubeEpisode,
  } = await import('../../../apps/process-audio/src/temporal/hetzner-acquisition-episode');
  const { consumeAcquiredYouTubeSource } = await import(
    '../../../apps/process-audio/src/temporal/acquired-youtube-source'
  );
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = db.doc(`${YOUTUBE_ACQUISITIONS}/${youtubeAcquisitionId(ref)}`);
  // Replace only this test's never-launched fixture, not a production delegation.
  await root.delete();
  const assertCurrent = async (transaction: import('firebase-admin/firestore').Transaction) => {
    if ((await readEligibleYouTubeAcquisition({ firestore: db, auth, transaction, ref })).kind !== 'ready')
      throw Error('CONTROLLED_DENIED');
  };
  const begin = async (attempt: number) => {
    await prepareNativeYouTubeEpisode({
      firestore: db,
      ref,
      caller: { buildId: 'a'.repeat(40), serviceAccount: email, instanceId: 'CONTROLLED_CLOUD_INSTANCE' },
      invocation: {
        workflowId: 'CONTROLLED_WORKFLOW',
        runId: 'CONTROLLED_RUN',
        activityId: 'CONTROLLED_ACTIVITY',
        attempt,
      },
      assertCurrent,
    });
    const episode = await readPreparedYouTubeEpisode({ firestore: db, ref, verifiedCallerEmail: email });
    const proof = (state: 'reserved' | 'enrolled') => ({
      v: 1 as const,
      id: episode.id,
      peerBound: true as const,
      state,
      directory: `/workspace/yt-acquisition-scratch/${episode.id}`,
      receiptHash: 'c'.repeat(64),
    });
    for (const phase of ['reserved', 'enrolled'] as const)
      await recordYouTubeEpisodeResource({ firestore: db, episode, proof: proof(phase), phase, assertCurrent });
    const owner = {
      bootId: randomUUID(),
      buildId: 'a'.repeat(40),
      pidNamespace: 'pid:[1234]',
      processId: 7 + attempt,
      startTicks: String(100 * attempt),
    };
    const store = createYouTubeAcquisitionHostStore({
      firestore: db,
      projectId: ref.projectId,
      owner,
      episodeId: episode.id,
      nativeEnrollment: proof('enrolled'),
      assertEligible: assertCurrent,
    });
    const startedAt = Date.now();
    expect(await store.claim(ref, email, startedAt)).toEqual({ launch: true });
    return { episode, owner, store, startedAt };
  };
  const finish = async (execution: Awaited<ReturnType<typeof begin>>) => {
    const proof = {
      v: 1 as const,
      id: execution.episode.id,
      peerBound: true as const,
      state: 'drained' as const,
      groupAbsent: true as const,
      receiptHash: 'd'.repeat(64),
    };
    await closeYouTubeAcquisitionNativeProcess({
      firestore: db,
      ref,
      owner: execution.owner,
      startedAt: execution.startedAt,
      fact: {
        processId: execution.owner.processId,
        exitCode: 0,
        exitSignal: null,
        outcome: 'completed',
        closedAt: Date.now(),
      },
      episode: { id: execution.episode.id, proof },
    });
    await recordReleasedYouTubeEpisode({
      firestore: db,
      episode: execution.episode,
      proof: { ...proof, state: 'closed' },
    });
  };
  const first = await begin(1);
  await first.store.settle(ref, { kind: 'retryable' }, async () => undefined, {
    attemptedModes: ['public_provider'],
    requiresAuthenticationRecovery: false,
  });
  await finish(first);
  expect(await call()).toEqual({ status: 200, body: { status: 'retryable', operationId: youtubeAcquisitionId(ref) } });
  const originalClose = await root.collection('nativeClose').doc('original').get();
  const next = await begin(2);
  const artifact = await uploadYouTubeObject({
    journal: next.store.upload(ref, randomUUID()),
    signal: new AbortController().signal,
    start: async () => ({
      output: Readable.from([Buffer.alloc(128, 42)]),
      completion: Promise.resolve('succeeded'),
      drain: async () => undefined,
    }),
  });
  const directory = await mkdtemp(join(tmpdir(), 'owned-successor-adoption-'));
  try {
    await next.store.settle(ref, { kind: 'source', artifact }, async () => undefined);
    await finish(next);
    expect(await call()).toEqual({
      status: 200,
      body: { status: 'ready', operationId: youtubeAcquisitionId(ref), artifact },
    });
    const adopt = await consumeAcquiredYouTubeSource({
      db,
      bucket: getStorage(app).bucket(),
      ref,
      source: artifact,
      destination: join(directory, 'source.bin'),
      signal: new AbortController().signal,
      assertCurrent,
    });
    await adopt(1); // CONTROLLED measured duration; actual Storage bytes/CRC/generation and native adoption transaction.
    expect((await db.doc(paths[0]).get()).get('artifacts.source')).toEqual({
      path: artifact.path,
      generation: artifact.generation,
      duration: 1,
    });
    expect((await root.get()).get('owner')).toEqual(first.owner);
    expect(
      (await root.collection('nativeClose').doc('original').get()).updateTime?.isEqual(originalClose.updateTime!)
    ).toBe(true);
  } finally {
    await getStorage(app).bucket().file(artifact.path).delete({ ignoreNotFound: true });
    await rm(directory, { recursive: true, force: true });
    const { MEDIA_ARTIFACTS, mediaArtifactId } = await import('@upperroom/orchestration/media-artifacts');
    await db.recursiveDelete(db.doc(`${MEDIA_ARTIFACTS}/${mediaArtifactId(ref.projectId, artifact.path)}`));
  }
});

test('an unclaimed-closure link is never advertised as missing launchable work', async () => {
  // Negative readback fixture only. No claimed owner or valid cleanup is invented.
  await db
    .doc(`${YOUTUBE_ACQUISITIONS}/${youtubeAcquisitionId(ref)}`)
    .update({ unclaimedClose: { CONTROLLED_NEGATIVE_ONLY: true } });
  expect(await call()).toEqual({ status: 503, body: { error: 'Acquisition readback is unavailable.' } });
});

test('render and recovery routes deny work when staging activation is disabled', async () => {
  const operationId = youtubeAcquisitionId(ref);
  const attemptId = randomUUID();
  for (const suffix of [`render/${attemptId}`, `render/authentication/${attemptId}`]) {
    const response = await fetch(`${origin}/${operationId}/${suffix}`, {
      method: 'POST',
      headers: { authorization: 'Bearer CONTROLLED_OIDC', 'content-type': 'application/json' },
      body: JSON.stringify({ operationId, ref }),
      signal: AbortSignal.timeout(10000),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Unavailable.' });
  }
  expect((await db.doc('temporalYouTubeRenderHosts/staging').get()).exists).toBe(false);
});
