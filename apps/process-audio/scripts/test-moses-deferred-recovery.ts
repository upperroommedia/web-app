import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Database } from 'firebase-admin/database';
import { Timestamp, type DocumentSnapshot } from 'firebase-admin/firestore';
import {
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
  resumeDeferredYouTubeQueueOnStartup,
  setCloudTasksApiDepsForTesting,
} from '../src/processAudioQueueStore';
import { verifyMosesRecoveryDelivery } from '../src/mosesGuestTaskIdentity';

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
