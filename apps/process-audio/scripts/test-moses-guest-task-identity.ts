import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readVerifiedMosesPilotIntentNonce } from '../src/mosesGuestTaskIdentity';
import { rememberConsumedMosesPilotNonce, scrubMosesSentryPayload } from '../src/sentryMosesPrivacy';

const origin = 'https://yt-worker.upperroommedia.org';
const audience = origin + '/process-audio';
const account = 'moses-guest-task-invoker@urm-app.iam.gserviceaccount.com';
const subject = '123456789012345678901';
const taskId = 'pa-01234567-fedcba9876543210-89abcdef';
const videoId = 'abcdefghijk';
const sermonId = 'new-pilot-sermon';
const source = { id: sermonId, type: 'YouTubeUrl', source: 'https://www.youtube.com/watch?v=' + videoId };
const env: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_AUDIO_RUNTIME_PROFILE: 'hetzner',
  PROCESS_AUDIO_RUNTIME_HOST: 'hetzner',
  PROCESS_AUDIO_RUNTIME_ENV: 'production',
  GCLOUD_PROJECT: 'urm-app',
  GOOGLE_CLOUD_PROJECT: 'urm-app',
  FIREBASE_PROJECT_ID: 'urm-app',
  PROCESS_AUDIO_PUBLIC_ORIGIN: origin,
  MOSES_GUEST_AUDIO_ENABLED: 'true',
  MOSES_GUEST_AUDIO_ORIGIN: 'https://guest.example.org',
  MOSES_GUEST_AUDIO_TOKEN: Buffer.alloc(32, 1).toString('base64url'),
  MOSES_GUEST_AUDIO_VIDEO_IDS: videoId,
  PROCESS_AUDIO_MOSES_GUEST_PILOT_SERMON_ID: sermonId,
  PROCESS_AUDIO_MOSES_GUEST_PILOT_NOT_BEFORE: new Date(Date.now() - 60_000).toISOString(),
  PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_AUDIENCE: audience,
  PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_SERVICE_ACCOUNT: account,
  PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_SUBJECT: subject,
};
const jwt = ['fixture-header', 'fixture-payload', 'fixture-signature']
  .map(part => Buffer.from(part).toString('base64url')).join('.');
const intentNonce = '83a098f7-c740-4101-b668-852212bc8b81';
const headers = {
  'x-urm-moses-pilot-intent': [intentNonce],
  authorization: ['Bearer ' + jwt],
  'x-cloudtasks-queuename': ['processaudioyoutubetask'],
  'x-cloudtasks-taskname': [taskId],
  'x-cloudtasks-taskretrycount': ['0'],
  'x-cloudtasks-taskexecutioncount': ['0'],
};
const now = Math.floor(Date.now() / 1000);
const claims = { aud: audience, iss: 'https://accounts.google.com', sub: subject, email: account, email_verified: true,
  iat: now - 60, exp: now + 3600 };

test('returns the initial delivery intent nonce only after Google verifies the token for this exact audience', async () => {
  let calls = 0;
  const result = await readVerifiedMosesPilotIntentNonce(source, headers, env, async (token, requestedAudience) => {
    assert.equal(token, jwt);
    assert.equal(requestedAudience, audience);
    calls++;
    return claims;
  });
  assert.equal(calls, 1);
  assert.equal(result, intentNonce);
});

test('missing, mismatched or ambiguous task metadata and authorization bypass verification', async () => {
  const cases: Array<[keyof typeof headers, string[] | undefined]> = [];
  for (const name of Object.keys(headers) as Array<keyof typeof headers>) {
    cases.push([name, undefined], [name, [...headers[name], ...headers[name]]]);
  }
  cases.push(
    ['x-urm-moses-pilot-intent', ['']],
    ['x-urm-moses-pilot-intent', [intentNonce + ' ']],
    ['x-urm-moses-pilot-intent', [intentNonce.toUpperCase()]],
    ['x-urm-moses-pilot-intent', [intentNonce.replace('-4101-', '-5101-')]],
    ['x-urm-moses-pilot-intent', [intentNonce.replace('-b668-', '-c668-')]],
    ['x-urm-moses-pilot-intent', [intentNonce + ',' + intentNonce]],
    ['x-cloudtasks-queuename', ['processaudiofiletask']],
    ['x-cloudtasks-taskname', ['projects/urm-app/locations/us-central1/queues/processaudioyoutubetask/tasks/' + taskId]],
    ['x-cloudtasks-taskname', [taskId + ' ']],
    ['x-cloudtasks-taskname', [taskId.replace('89abcdef', '89abcdeG')]],
    ['x-cloudtasks-taskretrycount', ['1']],
    ['x-cloudtasks-taskexecutioncount', ['1']],
    ['x-cloudtasks-taskexecutioncount', ['00']],
    ['x-cloudtasks-taskretrycount', ['0, 0']],
    ['authorization', ['bearer ' + jwt]],
    ['authorization', ['Bearer  ' + jwt]],
    ['authorization', ['Bearer aa.bb']],
    ['authorization', ['Bearer AA=.AA.AA']],
    ['authorization', ['Bearer AB.AA.AA']],
    ['authorization', ['Bearer AA..AA']],
    ['authorization', ['Bearer ' + jwt + ',Bearer ' + jwt]],
    ['authorization', ['Bearer ' + 'A'.repeat(8192) + '.AA.AA']]
  );
  let calls = 0;
  for (const [key, value] of cases) {
    const result = await readVerifiedMosesPilotIntentNonce(source, { ...headers, [key]: value }, env, async () => {
      calls++;
      return claims;
    });
    assert.equal(result, undefined, key);
  }
  assert.equal(calls, 0);
});

test('a file source, excluded video, disabled client or wrong deployment bypasses verification', async () => {
  let calls = 0;
  const verify = async () => { calls++; return claims; };
  const overrides: NodeJS.ProcessEnv[] = [
    { NODE_ENV: 'test' },
    { PROCESS_AUDIO_RUNTIME_PROFILE: undefined },
    { PROCESS_AUDIO_RUNTIME_HOST: 'cloud-run' },
    { PROCESS_AUDIO_RUNTIME_ENV: 'staging' },
    { GCLOUD_PROJECT: 'urm-app-staging' },
    { GOOGLE_CLOUD_PROJECT: undefined },
    { FIREBASE_PROJECT_ID: 'urm-app-staging' },
    { FIREBASE_DATABASE_EMULATOR_HOST: 'localhost:9000' },
    { FIRESTORE_EMULATOR_HOST: 'localhost:8080' },
    { PROCESS_AUDIO_PUBLIC_ORIGIN: origin + '/' },
    { PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_AUDIENCE: origin },
    { PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_SERVICE_ACCOUNT: 'other@urm-app.iam.gserviceaccount.com' },
    { PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_SUBJECT: '1' },
    { PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_SUBJECT: subject + ' ' },
    { PROCESS_AUDIO_MOSES_GUEST_PILOT_SERMON_ID: undefined },
    { PROCESS_AUDIO_MOSES_GUEST_PILOT_SERMON_ID: 'another-sermon' },
    { PROCESS_AUDIO_MOSES_GUEST_PILOT_NOT_BEFORE: undefined },
    { PROCESS_AUDIO_MOSES_GUEST_PILOT_NOT_BEFORE: 'Invalid date' },
    { PROCESS_AUDIO_MOSES_GUEST_PILOT_NOT_BEFORE: '2020-02-30T00:00:00.000Z' },
    { PROCESS_AUDIO_MOSES_GUEST_PILOT_NOT_BEFORE: '2020-01-01T00:00:00Z' },
    { PROCESS_AUDIO_MOSES_GUEST_PILOT_NOT_BEFORE: new Date(Date.now() + 600_000).toISOString() },
    { MOSES_GUEST_AUDIO_ENABLED: undefined },
    { MOSES_GUEST_AUDIO_ENABLED: 'TRUE' },
    { MOSES_GUEST_AUDIO_TOKEN: undefined },
    { MOSES_GUEST_AUDIO_VIDEO_IDS: 'zzzzzzzzzzz' },
    { MOSES_GUEST_AUDIO_VIDEO_IDS: videoId + ',zzzzzzzzzzz' },
    { MOSES_GUEST_AUDIO_VIDEO_IDS: ' ' + videoId },
    { MOSES_GUEST_AUDIO_VIDEO_IDS: undefined },
  ];
  for (const override of overrides) {
    assert.equal(await readVerifiedMosesPilotIntentNonce(source, headers, { ...env, ...override }, verify), undefined,
      Object.keys(override)[0]);
  }
  for (const candidate of [{ ...source, type: 'StorageFilePath' }, { ...source, source: 'https://example.org' }]) {
    assert.equal(await readVerifiedMosesPilotIntentNonce(candidate, headers, env, verify), undefined);
  }
  for (const id of ['', 'sermons/subpath', 'a'.repeat(129)]) {
    assert.equal(await readVerifiedMosesPilotIntentNonce({ ...source, id }, headers,
      { ...env, PROCESS_AUDIO_MOSES_GUEST_PILOT_SERMON_ID: id }, verify), undefined);
  }
  const invalidTask = 'a'.repeat(taskId.length);
  assert.equal(await readVerifiedMosesPilotIntentNonce(source, { ...headers, 'x-cloudtasks-taskname': [invalidTask] },
    env, verify), undefined);
  assert.equal(calls, 0);
});

test('verification errors, missing claims, and mismatched or expired identities fall back', async () => {
  const overrides: Partial<typeof claims>[] = [
    { iss: 'https://example.org' },
    { sub: '123456789012345678902' },
    { aud: audience + '/' },
    { email: 'other@urm-app.iam.gserviceaccount.com' },
    { email: undefined },
    { email_verified: false },
    { iat: now + 1000 },
    { iat: NaN },
    { exp: now },
  ];
  for (const override of overrides) {
    assert.equal(await readVerifiedMosesPilotIntentNonce(source, headers, env, async () => ({ ...claims, ...override })),
      undefined, Object.keys(override)[0]);
  }
  assert.equal(await readVerifiedMosesPilotIntentNonce(source, headers, env, async () => undefined), undefined);
  assert.equal(await readVerifiedMosesPilotIntentNonce(source, headers, env, async () => {
    throw new Error('Verification failed');
  }), undefined);
});

test('Sentry omits private HTTP headers, affected frame locals and duplicate credentials across payload shapes', () => {
  const guestBearer = Buffer.alloc(32, 9).toString('base64url');
  const identityToken = 'synthetic-oidc-token-used-only-in-this-fixture';
  const event = {
    request: { headers: { 'X-UrM-Moses-Pilot-Intent': intentNonce, authorization: 'Bearer ' + identityToken, host: 'worker' } },
    spans: [{ data: { 'http.request.header.x_urm_moses_pilot_intent': intentNonce, status: 200 } }],
    exception: { values: [{ stacktrace: { frames: [{ filename: 'index.js', vars: { alias: intentNonce.slice(0, 16) } }] } }] },
    extra: { rawHeaders: ['Host', 'worker', 'X-URM-Moses-Pilot-Intent', intentNonce] },
    message: ['cleanup', intentNonce, guestBearer, identityToken].join(' '),
  };
  const clean = scrubMosesSentryPayload(event, guestBearer);
  assert.deepEqual(clean.request.headers, { host: 'worker' });
  assert.deepEqual(clean.extra.rawHeaders, ['Host', 'worker']);
  assert.deepEqual(clean.spans[0].data, { status: 200 });
  assert.deepEqual(clean.exception.values[0].stacktrace.frames[0], { filename: 'index.js' });
  assert.equal(clean.message, 'cleanup [Filtered] [Filtered] [Filtered]');
  assert.equal(event.request.headers['X-UrM-Moses-Pilot-Intent'], intentNonce);
  assert.equal(JSON.stringify(clean).includes(intentNonce.slice(0, 16)), false);

  const streamedSpan = { attributes: {
    'http.request.header.x_urm_moses_pilot_intent': { type: 'string', value: intentNonce },
    'http.method': { type: 'string', value: 'POST' },
  } };
  assert.deepEqual(scrubMosesSentryPayload(streamedSpan, guestBearer).attributes, {
    'http.method': { type: 'string', value: 'POST' },
  });
});

test('standalone Sentry batches mask the consumed nonce and guest bearer while preserving unrelated IDs and locals', () => {
  const guestBearer = Buffer.alloc(32, 3).toString('base64url');
  const requestId = '203adb62-125d-47c6-ba56-f2f28655ff9c';
  rememberConsumedMosesPilotNonce(intentNonce);
  const log = { items: [{ body: 'failure ' + intentNonce, attributes: { detail: 'Bearer ' + guestBearer, requestId } }] };
  assert.deepEqual(scrubMosesSentryPayload(log, guestBearer), {
    items: [{ body: 'failure [Filtered]', attributes: { detail: 'Bearer [Filtered]', requestId } }],
  });
  const regular = { exception: { values: [{ stacktrace: { frames: [{ filename: 'worker.js', vars: { requestId } }] } }] } };
  assert.deepEqual(scrubMosesSentryPayload(regular, guestBearer), regular);
});
