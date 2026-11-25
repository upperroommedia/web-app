import { checkBacklogEditQueued, readBacklogEditDelivery, transitionBacklogEdit, updateUnreservedAudioDocument } from '../src/mosesBacklogRecovery';
import { computeProcessAudioTaskId } from '@upperroom/contracts/processAudioQueue';
import { createHash } from 'node:crypto';
import type { Bucket } from '@google-cloud/storage';
import type { MosesBacklogStorage } from '../src/mosesBacklogStorage';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Database } from 'firebase-admin/database';
import { Timestamp, type DocumentSnapshot } from 'firebase-admin/firestore';
import {
  mosesBacklogDocumentFence,
  computeMosesBacklogCustody,
  computeMosesBacklogTaskId,
  MOSES_BACKLOG_FENCES_PATH,
  MOSES_BACKLOG_RELEASES,
  MOSES_BACKLOG_EDITS_PATH,
  MOSES_BACKLOG_DOCUMENT_FENCES,
  MOSES_BACKLOG_DELETIONS,
  type MosesBacklogEvidence,
  type MosesBacklogKind,
  type MosesBacklogReceipt,
  computeMosesRecoveryCustody,
  computeMosesRecoveryTaskId,
  mosesRecoveryDigest,
} from '@upperroom/contracts/mosesDeferredRecovery';
import {
  beginMosesRecovery,
  createMosesRecoveryStatusWriter,
  holdUnconfirmedMosesRecovery,
  reconcileMosesRecovery,
  recordMosesRecoveryMediaCompletion,
} from '../src/mosesDeferredRecovery';
import {
  computeProcessAudioRequestVersion,
  markProcessAudioRequestRunning,
  resumeDeferredYouTubeQueueOnStartup,
  setCloudTasksApiDepsForTesting,
} from '../src/processAudioQueueStore';
import { RecoveryReceiptUnavailable, verifyMosesRecoveryDelivery } from '../src/mosesGuestTaskIdentity';

import { sermonStatusType } from '../src/types';

const id = 'synthetic-row',
  videoId = 'aaaaaaaaaaa',
  owner = 'synthetic-delivery';
const payload = {
  id,
  youtubeUrl: 'https://www.youtube.com/watch?v=' + videoId,
  startTime: 0,
  duration: 5,
  deleteOriginal: false,
  skipTranscode: false,
};
const requestVersion = computeProcessAudioRequestVersion(payload);
const original = {
  sermonId: id,
  sourceType: 'youtube',
  currentRequestVersion: requestVersion,
  currentPayload: payload,
  deferredAt: '2026-11-01T00:00:00.000Z',
};
const deferred = {
  sermonId: id,
  requestVersion,
  payload,
  deferredAt: original.deferredAt,
  probeMode: 'cookie_provider',
  lastFailureClass: 'cookie_session_stale_or_challenged',
};
const evidence = {
  sermonId: id,
  videoId,
  requestVersion,
  requestSha256: mosesRecoveryDigest(original),
  deferredSha256: mosesRecoveryDigest(deferred),
  documentCreateTime: '11.000000001',
  documentUpdateTime: '22.000000002',
};
const custodySha256 = computeMosesRecoveryCustody(evidence);
const taskId = computeMosesRecoveryTaskId(id, requestVersion, custodySha256);
const nonce = '709477a3-f690-46f1-ba36-62d76c6948d8';
const reservation = { taskId, nonce, custodySha256, requestVersion };
const receipt = {
  ...evidence,
  ...reservation,
  schema: 1,
  kind: 'deferred_cookie',
  queuedAt: '2026-11-02T00:00:00.000Z',
  phase: 'acknowledged',
};
const job = { ...reservation, sermonId: id, videoId, payload };
const written = new Timestamp(33, 3);
const document = (processed = false, updatedAt = processed ? written : new Timestamp(22, 2)) =>
  ({
    exists: true,
    ref: { path: 'sermons/' + id },
    createTime: new Timestamp(11, 1),
    updateTime: updatedAt,
    get: () => (processed ? 'PROCESSED' : 'ERROR'),
  } as unknown as DocumentSnapshot);
const queue = 'processAudioQueues/youtube',
  receiptPath = queue + '/mosesRecoveries/' + id + '/' + requestVersion;
const deferredPath = queue + '/deferred/' + id,
  requestPath = 'processAudioRequests/' + id;

function fixture() {
  const store: Record<string, any> = {};
  let beforeTransaction: ((path: string) => void) | undefined;
  const read = (key: string) => key.split('/').reduce((value, part) => value?.[part], store) ?? null;
  const write = (key: string, value: any) => {
    const path = key.split('/');
    const last = path.pop()!;
    const parent = path.reduce((obj, key) => (obj[key] ??= {}), store);
    if (value === null) delete parent[last];
    else parent[last] = structuredClone(value);
  };
  const snapshot = (value: any) => ({
    val: () => structuredClone(value),
    exists: () => value != null,
    child: (key: string) => snapshot(key.split('/').reduce((row, part) => row?.[part], value) ?? null),
  });
  const db = {
    ref: (key: string) => ({
      get: async () => snapshot(read(key)),
      set: async (value) => write(key, value),
      remove: async () => write(key, null),
      transaction: async (fn) => {
        beforeTransaction?.(key);
        const next = fn(structuredClone(read(key)));
        if (next !== undefined) write(key, next);
        return { committed: next !== undefined, snapshot: snapshot(read(key)) };
      },
    }),
  } as unknown as Database;
  write(requestPath, original);
  write(receiptPath, receipt);
  write(deferredPath, { ...deferred, mosesRecoveryReservation: reservation });
  write(queue + '/state', { deferredYouTubeTaskCount: 1, probeStatus: 'waiting_for_auth_required_request' });
  write('processAudioLocks/' + id, { requestId: owner });
  return {
    db,
    read,
    write,
    hook(fn?: typeof beforeTransaction) {
      beforeTransaction = fn;
    },
  };
}

test('one verified delivery consumes authority, retains historical rows, and resumes terminal settlement without a second acquisition', async () => {
  const { db, read, write, hook } = fixture();
  assert.equal(await reconcileMosesRecovery(db, job, owner, async () => document()), 'ready');
  await beginMosesRecovery(db, job, owner, document());
  assert.deepEqual(read(requestPath), original);
  assert.deepEqual(read(deferredPath), { ...deferred, mosesRecoveryReservation: reservation });
  await assert.rejects(beginMosesRecovery(db, job, owner, document()));
  await assert.rejects(reconcileMosesRecovery(db, job, owner, async () => document()));
  await recordMosesRecoveryMediaCompletion(db, job, owner, 'public_provider', true, written);
  hook((path) => {
    if (path === queue) throw new Error('simulated queue transaction loss');
  });
  await assert.rejects(reconcileMosesRecovery(db, job, owner, async () => document(true)));
  assert.equal(read(requestPath).lastCompletedRequestVersion, requestVersion);
  assert.equal(read(queue + '/state').deferredYouTubeTaskCount, 1);
  hook();
  assert.equal(await reconcileMosesRecovery(db, job, 'retry', async () => document(true)), 'completed');
  assert.equal(read(queue + '/state').deferredYouTubeTaskCount, 0);
  assert.equal(read(deferredPath), null);
  assert.equal(read(receiptPath).proof.mosesVerified, true);
  assert.equal(read(receiptPath).originalDeferred.lastFailureClass, deferred.lastFailureClass);
  assert.equal(await reconcileMosesRecovery(db, job, 'duplicate', async () => document(true)), 'completed');
  assert.equal(read(queue + '/state').deferredYouTubeTaskCount, 0);
  write(requestPath, { ...original, currentRequestVersion: 'new' });
  await assert.rejects(reconcileMosesRecovery(db, { ...job, nonce: 'other' }, owner, async () => document()));
});

test('receipt, payload, lock, document generation and both row digests independently gate first acquisition', async () => {
  for (const tamper of [
    (f: ReturnType<typeof fixture>) => f.write(receiptPath + '/nonce', 'other'),
    (f: ReturnType<typeof fixture>) => f.write(receiptPath + '/phase', 'sending'),
    (f: ReturnType<typeof fixture>) => f.write(receiptPath + '/extra', true),
    (f: ReturnType<typeof fixture>) => f.write(deferredPath + '/lastFailureClass', 'other'),
    (f: ReturnType<typeof fixture>) => f.write(deferredPath + '/mosesRecoveryReservation/taskId', 'other'),
    (f: ReturnType<typeof fixture>) => f.write(requestPath + '/updatedAt', 'other'),
    (f: ReturnType<typeof fixture>) => f.write('processAudioLocks/' + id + '/requestId', 'other'),
    (f: ReturnType<typeof fixture>) => f.write(queue + '/state/probeTaskSermonId', id),
  ]) {
    const f = fixture();
    tamper(f);
    await assert.rejects(beginMosesRecovery(f.db, job, owner, document()));
    assert.ok(f.read(deferredPath));
    assert.equal(f.read(receiptPath).owner, undefined);
  }
  const f = fixture();
  await assert.rejects(beginMosesRecovery(f.db, job, owner, document(false, new Timestamp(22, 3))));
  await assert.rejects(beginMosesRecovery(f.db, { ...job, payload: { ...payload, duration: 6 } }, owner, document()));
  await beginMosesRecovery(f.db, job, owner, document());
  await holdUnconfirmedMosesRecovery(f.db, job, owner);
  assert.equal(f.read(receiptPath).outcome, 'review_required');
  assert.equal(f.read(queue + '/state').deferredYouTubeTaskCount, 1);
  assert.deepEqual(f.read(requestPath), original);
  await assert.rejects(recordMosesRecoveryMediaCompletion(f.db, job, owner, 'public_provider', true, written));
  await assert.rejects(reconcileMosesRecovery(f.db, job, owner, async () => document()));
});

test('authenticated probe skips a reserved row in selection and if a reservation arrives under the sermon claim', async () => {
  let calls = 0;
  setCloudTasksApiDepsForTesting({
    authFactory: async () => ({ getAccessToken: async () => 'fixture' }),
    fetchImpl: async () => {
      calls++;
      return new Response('{}', { status: 200 });
    },
  });
  try {
    for (const raced of [false, true]) {
      const f = fixture();
      if (raced) {
        f.write(deferredPath + '/mosesRecoveryReservation', null);
        f.hook((path) => {
          if (path === 'processAudioQueueClaims/' + id)
            f.write(deferredPath + '/mosesRecoveryReservation', reservation);
        });
      }
      const result = await resumeDeferredYouTubeQueueOnStartup({
        database: f.db,
        authenticatedRecoveryGeneration: 'fixture',
      });
      assert.equal(result.resumed, false);
      assert.deepEqual(f.read(deferredPath).mosesRecoveryReservation, reservation);
      assert.equal(f.read(queue + '/state').deferredYouTubeTaskCount, 1);
    }
    assert.equal(calls, 0);
  } finally {
    setCloudTasksApiDepsForTesting(null);
  }
});

test('exact dedicated OIDC accepts named retry delivery only for the selected project and pinned source', async () => {
  const audience = 'https://yt-worker.upperroommedia.org/process-audio';
  const email = 'moses-guest-task-invoker@urm-app.iam.gserviceaccount.com';
  const sub = '123456789012345678901';
  const env = {
    NODE_ENV: 'production',
    PROCESS_AUDIO_RUNTIME_ENV: 'production',
    PROCESS_AUDIO_RUNTIME_PROFILE: 'hetzner',
    PROCESS_AUDIO_RUNTIME_HOST: 'hetzner',
    FIREBASE_PROJECT_ID: 'urm-app',
    GOOGLE_CLOUD_PROJECT: 'urm-app',
    GCLOUD_PROJECT: 'urm-app',
    PROCESS_AUDIO_PUBLIC_ORIGIN: 'https://yt-worker.upperroommedia.org',
    PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_AUDIENCE: audience,
    PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_SERVICE_ACCOUNT: email,
    PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_SUBJECT: sub,
    MOSES_GUEST_AUDIO_ENABLED: 'true',
    MOSES_GUEST_AUDIO_ORIGIN: 'https://fixture.test',
    MOSES_GUEST_AUDIO_TOKEN: Buffer.alloc(32).toString('base64url'),
    MOSES_GUEST_AUDIO_VIDEO_IDS: videoId,
    PROCESS_AUDIO_MOSES_RECOVERY_ENABLED: 'true',
    PROCESS_AUDIO_MOSES_RECOVERY_SERMON_ID: id,
    PROCESS_AUDIO_MOSES_RECOVERY_VIDEO_ID: videoId,
    PROCESS_AUDIO_MOSES_RECOVERY_REQUEST_VERSION: requestVersion,
    PROCESS_AUDIO_MOSES_RECOVERY_CUSTODY_SHA256: custodySha256,
  };
  const headers = {
    authorization: ['Bearer AA.AA.AA'],
    'x-cloudtasks-taskname': [taskId],
    'x-cloudtasks-queuename': ['processaudioyoutubetask'],
    'x-cloudtasks-taskretrycount': ['2'],
    'x-cloudtasks-taskexecutioncount': ['1'],
    'x-urm-moses-pilot-intent': [nonce],
  };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    aud: audience,
    iss: 'https://accounts.google.com',
    sub,
    email,
    email_verified: true,
    iat: now - 5,
    exp: now + 30,
  };
  const body = { data: payload };
  assert.deepEqual(await verifyMosesRecoveryDelivery(body, headers, env, async () => claims), job);
  assert.equal(
    await verifyMosesRecoveryDelivery(
      body,
      headers,
      { ...env, PROCESS_AUDIO_MOSES_RECOVERY_ENABLED: '' },
      async () => claims
    ),
    undefined
  );
  assert.equal(
    await verifyMosesRecoveryDelivery(body, headers, env, async () => ({ ...claims, sub: 'wrong' })),
    undefined
  );
  assert.equal(
    await verifyMosesRecoveryDelivery(
      body,
      { ...headers, 'x-cloudtasks-taskname': [taskId, taskId] },
      env,
      async () => claims
    ),
    undefined
  );
  const backlog = backlogFixture('missing_admission');
  const backlogHeaders = { ...headers, 'x-cloudtasks-taskname': [backlog.delivery.taskId] };
  const scoped = {
    ...env,
    PROCESS_AUDIO_MOSES_RECOVERY_REQUEST_VERSION: backlog.r.requestVersion,
    PROCESS_AUDIO_MOSES_RECOVERY_CUSTODY_SHA256: backlog.r.custodySha256,
    PROCESS_AUDIO_MOSES_RECOVERY_KIND: backlog.r.kind,
    PROCESS_AUDIO_MOSES_BACKLOG_RELEASE_SHA: backlog.r.releaseSha,
    SENTRY_RELEASE: 'process-audio-hetzner@production-' + backlog.r.releaseSha,
  };
  assert.deepEqual(
    await verifyMosesRecoveryDelivery({ data: backlog.target }, backlogHeaders, scoped, async () => claims),
    backlog.delivery
  );
  assert.equal(
    await verifyMosesRecoveryDelivery(
      { data: backlog.target },
      backlogHeaders,
      { ...scoped, SENTRY_RELEASE: 'other' },
      async () => claims
    ),
    undefined
  );
  assert.equal(
    await verifyMosesRecoveryDelivery({ data: backlog.target }, headers, scoped, async () => claims),
    undefined
  );
  const cohort = (rows: unknown[]) => Buffer.from(JSON.stringify({ schema: 1, rows })).toString('base64url');
  const member = { ref: 'row-01', kind: 'missing_admission', sermonId: id, videoId };
  const cohortEnv = { ...scoped, PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL: cohort([member]) };
  let reads = 0;
  const read = async (path: string) => {
    reads++;
    assert.equal(path, backlog.fencePath);
    return backlog.r;
  };
  const deliver = (runtime = cohortEnv, verify = async () => claims) =>
    verifyMosesRecoveryDelivery({ data: backlog.target }, backlogHeaders, runtime, verify, read);
  assert.equal(await deliver(cohortEnv, async () => ({ ...claims, email: 'wrong' })), undefined);
  assert.equal(await deliver({ ...cohortEnv, PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL: 'bad' }), undefined);
  assert.equal(await deliver({ ...cohortEnv, PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL:
    cohort([{ ...member, sermonId: 'other' }]) }), undefined);
  assert.equal(reads, 0, 'no native reads before cohort selection and dedicated task authentication');
  assert.deepEqual(await deliver(), backlog.delivery);
  assert.equal(reads, 1);
  const deliverNative = (native: unknown) => verifyMosesRecoveryDelivery(
    { data: backlog.target }, backlogHeaders, cohortEnv, async () => claims, async () => native);
  assert.equal(await deliverNative({ ...backlog.r, nonce: 'other' }), undefined);
  assert.equal(await deliverNative({ ...backlog.r, custodySha256: 'd'.repeat(64) }), undefined);
  assert.equal(await deliverNative({ ...backlog.r, payload: { ...backlog.target, duration: 9 } }), undefined);
  assert.equal(await deliverNative({ ...backlog.r, requestVersion: 'a'.repeat(16) }), undefined);
  await assert.rejects(deliverNative(null), RecoveryReceiptUnavailable);
  await assert.rejects(deliverNative({ ...backlog.r, phase: 'sending' }), RecoveryReceiptUnavailable);
  const deferredEnv = { ...cohortEnv, PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL: cohort([
    { ref: 'row-02', kind: 'deferred_cookie', sermonId: id, videoId, requestVersion },
  ]) };
  assert.deepEqual(await verifyMosesRecoveryDelivery(body, headers, deferredEnv, async () => claims, async path => {
    assert.equal(path, receiptPath);
    return receipt;
  }), job);
  const extra = { ...body, extra: true };
  assert.equal(await verifyMosesRecoveryDelivery(extra, headers, env, async () => claims), undefined);
});

test('recovery status updates preserve publishing fields and reject a concurrent document replacement', async () => {
  const initialTime = new Timestamp(11, 1);
  const ownTime = new Timestamp(12, 2);
  let actual = initialTime;
  const fields = { 'status.subsplash': 'PUBLISHED', 'status.audioStatus': 'ERROR' };
  const ref = {
    update: async (patch: Record<string, unknown>, precondition: { lastUpdateTime: Timestamp }) => {
      if (!precondition.lastUpdateTime.isEqual(actual)) throw new Error('source changed');
      Object.assign(fields, patch);
      actual = ownTime;
      return { writeTime: ownTime };
    },
  } as unknown as Parameters<typeof createMosesRecoveryStatusWriter>[0];
  const write = createMosesRecoveryStatusWriter(ref, initialTime);
  await write(sermonStatusType.PROCESSING, 'Getting Data');
  await write(sermonStatusType.PROCESSING, 'Downloading YouTube Audio');
  assert.equal(fields['status.subsplash'], 'PUBLISHED');
  actual = new Timestamp(13, 3);
  await assert.rejects(write(sermonStatusType.PROCESSED, undefined, 5), /source changed/);
  assert.equal(fields['status.audioStatus'], 'PROCESSING');
});

function backlogFixture(kind: MosesBacklogKind) {
  const f = fixture();
  const name = 'urm-app.appspot.com';
  const releaseSha = 'c'.repeat(40);
  const bumperGenerations = {
    intro: { path: 'intros/test_intro.mp3', generation: '301' },
    outro: { path: 'outros/test_outro.mp3', generation: '302' },
  };
  const link = (path: string) =>
    'https://firebasestorage.googleapis.com/v0/b/' + name + '/o/' + encodeURIComponent(path) + '?alt=media';
  const target = {
    ...payload,
    introUrl: link(bumperGenerations.intro.path),
    outroUrl: link(bumperGenerations.outro.path),
  };
  const version = computeProcessAudioRequestVersion(target);
  const priorRequest =
    kind === 'failed_request'
      ? {
          sourceType: 'youtube',
          sermonId: id,
          currentPayload: target,
          currentRequestVersion: version,
          queuedTaskId: 'pa-aaaaaaaa-' + version + '-cccccccc',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }
      : null;
  const e: MosesBacklogEvidence = {
    schema: 2,
    kind,
    sermonId: id,
    videoId,
    requestVersion: version,
    requestSha256: mosesRecoveryDigest(priorRequest),
    ...(priorRequest && { priorTaskId: priorRequest.queuedTaskId }),
    documentCreateTime: evidence.documentCreateTime,
    documentUpdateTime: evidence.documentUpdateTime,
    payload: target,
    releaseSha,
    bumperGenerations,
  };
  const custody = computeMosesBacklogCustody(e);
  const task = computeMosesBacklogTaskId(kind, id, version, custody);
  const delivery = {
    sermonId: id,
    videoId,
    requestVersion: version,
    payload: target,
    taskId: task,
    nonce,
    custodySha256: custody,
    backlog: { kind, releaseSha },
  };
  const raw = Buffer.from('signed synthetic envelope');
  const r: MosesBacklogReceipt = {
    ...e,
    fencedAt: '2026-01-01T02:00:00.000Z',
    queuedAt: '2026-01-01T03:00:00.000Z',
    nonce,
    custodySha256: custody,
    taskId: task,
    phase: 'acknowledged',
    witness: {
      generation: '307',
      sha256: createHash('sha256').update(raw).digest('hex'),
      observedAt: '2026-01-01T02:15:00.000Z',
      releaseSha,
    },
  };
  const fencePath = MOSES_BACKLOG_FENCES_PATH + '/' + id;
  f.write(fencePath, r);
  f.write(deferredPath, null);
  f.write(requestPath, priorRequest);
  f.write('processAudioLocks/' + id, null);
  let mirror: unknown = mosesBacklogDocumentFence(r);
  let deletion = false;
  let liveEpoch: Timestamp | undefined = new Timestamp(11, 1);
  const doc = (processed = false) => {
    const fields: Record<string, unknown> = {
      'status.audioStatus': processed ? 'PROCESSED' : kind === 'failed_request' ? 'ERROR' : 'PENDING',
      'status.subsplash': 'NOT_UPLOADED',
      'status.soundCloud': 'NOT_UPLOADED',
      youtubeUrl: target.youtubeUrl,
      sourceStartTime: target.startTime,
      trimDurationSeconds: target.duration,
    };
    const result = {
      ...document(processed),
      exists: liveEpoch !== undefined,
      createTime: liveEpoch,
      get: (key: string) => fields[key],
      ref: {
        id,
        path: 'sermons/' + id,
        firestore: {
          collection: () => ({ doc: () => ({}) }),
          runTransaction: async (fn) =>
            fn({ getAll: async () => [result, { exists: mirror !== null, data: () => mirror }, { exists: deletion }] }),
        },
      },
    };
    return result as unknown as DocumentSnapshot;
  };
  const objects = new Map<string, any>();
  for (const pin of Object.values(bumperGenerations))
    objects.set(pin.path, { bucket: name, name: pin.path, generation: pin.generation });
  const witnessPath = '_ops/moses-backlog-drain/' + id + '/' + nonce + '.json';
  objects.set(witnessPath, { bucket: name, name: witnessPath, generation: '307', size: String(raw.length) });
  const downloads: Array<[string, string]> = [];
  const bucket = {
    name,
    file(path: string, options?: { generation: string }) {
      return {
        name: path,
        bucket: { name },
        metadata: objects.get(path),
        exists: async () => [objects.has(path)],
        getMetadata: async () => [objects.get(path)],
        download: async () => {
          assert.equal(options?.generation, objects.get(path)?.generation);
          downloads.push([path, options!.generation]);
          return [raw];
        },
      };
    },
  } as unknown as Bucket;
  return {
    ...f,
    target,
    delivery,
    r,
    priorRequest,
    fencePath,
    objects,
    bucket,
    downloads,
    doc,
    witnessPath,
    sourceDeleted(marker: boolean, epoch?: Timestamp) { deletion = marker; liveEpoch = epoch; },
    mirror(value: unknown) {
      mirror = value;
    },
    upload(storage: MosesBacklogStorage, path: string, generation: string) {
      const opts = storage.uploadOptions(path, {
        contentType: 'audio/mpeg',
        metadata: { metadata: { other: 'existing' } },
      });
      assert.deepEqual(opts.preconditionOpts, { ifGenerationMatch: 0 });
      assert.equal(opts.metadata!.metadata!.other, 'existing');
      objects.set(path, {
        name: path,
        bucket: name,
        generation,
        size: '4000',
        metadata: opts.metadata!.metadata,
        contentType: 'audio/mpeg',
      });
      storage.recordUpload(bucket.file(path));
    },
  };
}

test('both historical backlog categories keep the fence and complete against create-only, generation-bound outputs', async () => {
  for (const kind of ['failed_request', 'missing_admission'] as const) {
    const f = backlogFixture(kind);
    assert.equal(
      await markProcessAudioRequestRunning({
        database: f.db,
        payload: f.target,
        taskId: 'unrelated',
        requestId: 'stale',
      }),
      'stale'
    );
    assert.deepEqual(f.read(requestPath), f.priorRequest);
    assert.equal(await reconcileMosesRecovery(f.db, f.delivery, owner, async () => f.doc(), f.bucket), 'ready');
    f.write('processAudioLocks/' + id, { requestId: owner });
    const storage = await beginMosesRecovery(f.db, f.delivery, owner, f.doc(), f.bucket);
    assert.ok(storage);
    await assert.rejects(beginMosesRecovery(f.db, f.delivery, owner, f.doc(), f.bucket));
    const processed = 'processed-sermons/' + id,
      final = 'intro-outro-sermons/' + id;
    f.upload(storage, processed, '401');
    await storage.downloadInputs('/unused-test-destination', new Set());
    assert.ok(f.downloads.some(([path, generation]) => path === processed && generation === '401'));
    assert.ok(f.downloads.some(([path, generation]) => path === 'intros/test_intro.mp3' && generation === '301'));
    f.upload(storage, final, '402');
    const outputs = await storage.verifyCurrent();
    await recordMosesRecoveryMediaCompletion(f.db, f.delivery, owner, 'public_provider', true, written, outputs);
    f.objects.get(final).generation = '403';
    await assert.rejects(reconcileMosesRecovery(f.db, f.delivery, owner, async () => f.doc(true), f.bucket));
    assert.deepEqual(f.read(requestPath), f.priorRequest);
    f.objects.get(final).generation = '402';
    assert.equal(await reconcileMosesRecovery(f.db, f.delivery, owner, async () => f.doc(true), f.bucket), 'completed');
    assert.deepEqual(f.read(f.fencePath).proof.outputs, outputs);
    assert.equal(f.read(f.fencePath).outcome, 'completed');
    assert.equal(f.read(requestPath).lastCompletedRequestVersion, f.r.requestVersion);
    assert.equal(f.read(queue + '/state').deferredYouTubeTaskCount, 1, 'unrelated native queue count preserved');
    const terminal = structuredClone(f.read(f.fencePath));
    f.sourceDeleted(false);
    await assert.rejects(reconcileMosesRecovery(f.db, f.delivery, owner, async () => f.doc(true), f.bucket));
    f.sourceDeleted(false, new Timestamp(12, 1));
    await assert.rejects(reconcileMosesRecovery(f.db, f.delivery, owner, async () => f.doc(true), f.bucket));
    f.sourceDeleted(true, new Timestamp(11, 1));
    await assert.rejects(reconcileMosesRecovery(f.db, f.delivery, owner, async () => f.doc(true), f.bucket));
    assert.deepEqual(f.read(f.fencePath), terminal);
  }
});

test('missing or changed forward evidence, outputs, mirror, and prior request fail closed before consumption', async () => {
  for (const change of [
    (f: ReturnType<typeof backlogFixture>) => f.write(f.fencePath + '/witness', null),
    (f: ReturnType<typeof backlogFixture>) => f.write(f.fencePath + '/witness/sha256', '0'.repeat(64)),
    (f: ReturnType<typeof backlogFixture>) => f.write(f.fencePath + '/phase', 'sending'),
    (f: ReturnType<typeof backlogFixture>) => f.objects.set('processed-sermons/' + id, { generation: '900' }),
    (f: ReturnType<typeof backlogFixture>) => (f.objects.get('intros/test_intro.mp3').generation = '304'),
    (f: ReturnType<typeof backlogFixture>) => f.sourceDeleted(true, new Timestamp(11, 1)),
    (f: ReturnType<typeof backlogFixture>) => f.sourceDeleted(false),
    (f: ReturnType<typeof backlogFixture>) => f.mirror(null),
    (f: ReturnType<typeof backlogFixture>) => f.mirror({ nonce: 'wrong' }),
    (f: ReturnType<typeof backlogFixture>) => f.write(requestPath, { currentPayload: f.target }),
    (f: ReturnType<typeof backlogFixture>) => f.write(deferredPath, { sermonId: id }),
  ]) {
    const f = backlogFixture('missing_admission');
    change(f);
    await assert.rejects(reconcileMosesRecovery(f.db, f.delivery, owner, async () => f.doc(), f.bucket));
    assert.equal(f.read(f.fencePath).owner, undefined);
  }
});

test('ordinary Firestore writer checks the native mirror in the same transaction as the status write', async () => {
  let present = false;
  let writes = 0;
  const db = {
    collection: () => ({ doc: () => 'mirror' }),
    runTransaction: async (fn) =>
      fn({
        get: async (key) => {
          assert.equal(key, 'mirror');
          return { exists: present };
        },
        update: () => {
          writes++;
        },
      }),
  };
  const doc = { id, firestore: db } as unknown as Parameters<typeof updateUnreservedAudioDocument>[0];
  await updateUnreservedAudioDocument(doc, { status: 'fixture' });
  present = true;
  await assert.rejects(updateUnreservedAudioDocument(doc, { status: 'fixture' }));
  assert.equal(writes, 1);
});


test('terminal edit requires its private named grant and exact ACK, then only its running owner can settle', async () => {
  const f = backlogFixture('missing_admission');
  f.write('processAudioLocks/' + id, { requestId: owner });
  const storage = await beginMosesRecovery(f.db, f.delivery, owner, f.doc(), f.bucket);
  assert.ok(storage);
  f.upload(storage, 'processed-sermons/' + id, '401');
  f.upload(storage, 'intro-outro-sermons/' + id, '402');
  await recordMosesRecoveryMediaCompletion(f.db, f.delivery, owner, 'public_provider', true, written, await storage.verifyCurrent());
  await reconcileMosesRecovery(f.db, f.delivery, owner, async () => f.doc(true), f.bucket);
  f.write('processAudioLocks/' + id, null);
  const terminal = structuredClone(f.read(f.fencePath));
  const original = f.read(requestPath);
  const edited = { ...f.target, duration: f.target.duration + 1 };
  const version = computeProcessAudioRequestVersion(edited);
  const payloadSha256 = mosesRecoveryDigest(edited);
  const previousRequestSha256 = mosesRecoveryDigest(original);
  const name = computeProcessAudioTaskId(id, version, terminal.custodySha256 + previousRequestSha256 + payloadSha256);
  const head = { taskId: name, requestVersion: version, previousRequestSha256, payloadSha256, phase: 'acknowledged' };
  const binding = { schema: 1, sermonId: id, custodySha256: terminal.custodySha256, authorizedAt: terminal.proof.completedAt, authorizedUid: 'editor' };
  const release = { ...binding, terminalRequestVersion: f.r.requestVersion, firstEditRequestVersion: version,
    completedRequestSha256: previousRequestSha256, terminalTaskId: f.r.taskId };
  const grant = { ...binding, taskId: name, requestVersion: version, payloadSha256, nonce };
  const docs = new Map<string, unknown>([
    [MOSES_BACKLOG_DOCUMENT_FENCES + '/' + id, mosesBacklogDocumentFence(f.r)],
    [MOSES_BACKLOG_RELEASES + '/' + id, release],
    [MOSES_BACKLOG_RELEASES + '/' + id + '/tasks/' + name, grant],
  ]);
  const collection = (path: string) => ({ doc: (key: string) => ({
    get: async () => ({ data: () => docs.get(path + '/' + key), createTime: written }),
    collection: (child: string) => collection(path + '/' + key + '/' + child),
  }) });
  const ref = { id, firestore: { collection, runTransaction: async (fn) => fn({
    getAll: async () => [f.doc(true), { exists: true, data: () => docs.get(MOSES_BACKLOG_DOCUMENT_FENCES + '/' + id) },
      { exists: docs.has(MOSES_BACKLOG_DELETIONS + '/' + id) }],
  }) } } as unknown as Parameters<typeof readBacklogEditDelivery>[1];
  const headers = { 'x-urm-moses-pilot-intent': [nonce], 'x-cloudtasks-taskname': [name], 'x-cloudtasks-queuename': ['processaudioyoutubetask'] };
  const env = { NODE_ENV: 'production', FIREBASE_PROJECT_ID: 'urm-app', PROCESS_AUDIO_RUNTIME_ENV: 'production',
    PROCESS_AUDIO_RUNTIME_HOST: 'hetzner', PROCESS_AUDIO_RUNTIME_PROFILE: 'hetzner' };
  const deliver = (body = edited, h = headers) => readBacklogEditDelivery(f.db, ref, { data: body }, h, env);
  assert.equal(await deliver(edited, { ...headers, 'x-urm-moses-pilot-intent': ['00000000-0000-4000-8000-000000000000'] }), undefined);
  assert.equal(await deliver(f.target), undefined);
  assert.equal(await deliver(edited, { ...headers, 'x-cloudtasks-taskname': [f.r.taskId] }), undefined);
  f.write(f.fencePath + '/outcome', 'review_required');
  assert.equal(await deliver(), undefined);
  f.write(f.fencePath, terminal);
  const edit = await deliver();
  assert.ok(edit && edit !== 'settled');
  assert.equal(edit.pendingWriteTime, written);
  f.write(requestPath, { ...original, currentPayload: edited, currentRequestVersion: version, queuedTaskId: name });
  f.write(MOSES_BACKLOG_EDITS_PATH + '/' + id, { ...head, phase: 'sending' });
  await assert.rejects(checkBacklogEditQueued(f.db, edit));
  f.write(MOSES_BACKLOG_EDITS_PATH + '/' + id, head);
  await checkBacklogEditQueued(f.db, edit);
  assert.equal(await markProcessAudioRequestRunning({ database: f.db, payload: edited, taskId: name, requestId: 'manual' }), 'stale');
  f.write('processAudioLocks/' + id, { requestId: owner });
  await transitionBacklogEdit(f.db, edit, owner, 'start');
  await assert.rejects(transitionBacklogEdit(f.db, edit, owner, 'start'));
  await assert.rejects(transitionBacklogEdit(f.db, edit, 'wrong', 'complete'));
  await transitionBacklogEdit(f.db, edit, owner, 'complete', 'public_provider');
  assert.equal(f.read(requestPath).lastCompletedRequestVersion, version);
  assert.equal(f.read(requestPath).queuedTaskId, undefined);
  assert.deepEqual(f.read(f.fencePath), terminal);
  assert.equal(await deliver(), 'settled');
  docs.set(MOSES_BACKLOG_DELETIONS + '/' + id, { disposition: 'held_source_deleted' });
  await assert.rejects(deliver());
  await assert.rejects(transitionBacklogEdit(f.db, edit, owner, 'complete'));
});
