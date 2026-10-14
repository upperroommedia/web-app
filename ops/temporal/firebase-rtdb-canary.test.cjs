'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const {
  runCanary,
  optionsFromEnvironment,
  MAX_DURATION_MS,
  READ_PATH,
  EXPECTED_SCOPES,
  metadataText,
} = require('./firebase-rtdb-canary.cjs');

const config = (projectId = 'urm-app-staging') => ({
  projectId,
  databaseURL: `https://${projectId}-default-rtdb.firebaseio.com/`,
  expectedServiceAccount: `temporal-worker@${projectId}.iam.gserviceaccount.com`,
  expectedScopes: [...EXPECTED_SCOPES],
  buildId: 'a'.repeat(40),
});
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function fixture(options = config()) {
  const calls = [];
  const foreignApp = { name: '[DEFAULT]' };
  const ownedApp = { name: undefined };
  let signal;
  const credential = {
    async isComputeEngineCredential() {
      calls.push('compute');
      return true;
    },
    async getServiceAccountEmail() {
      calls.push('adc-email');
      return options.expectedServiceAccount;
    },
  };
  const database = {
    ref(path) {
      calls.push(['ref', path]);
      return {
        async get() {
          calls.push('get');
          return {
            val() {
              throw new Error('Private data must never be inspected');
            },
          };
        },
      };
    },
    goOffline() {
      calls.push('offline');
    },
  };
  const sdk = {
    applicationDefault() {
      calls.push('adc');
      return credential;
    },
    initializeApp(appOptions, name) {
      calls.push(['initialize', appOptions, name]);
      ownedApp.name = name;
      return ownedApp;
    },
    getDatabase(app) {
      assert.equal(app, ownedApp);
      calls.push('database');
      return database;
    },
    async deleteApp(app) {
      assert.equal(app, ownedApp);
      assert.notEqual(app, foreignApp);
      calls.push('delete');
    },
    getApps() {
      throw new Error('Foreign app inventory must never be touched');
    },
  };
  const deps = {
    env: {},
    randomUUID: () => 'owned-unique-id',
    loadSdk() {
      calls.push('load-sdk');
      return sdk;
    },
    async metadataText(path, currentSignal) {
      signal = currentSignal;
      calls.push(['metadata', path]);
      if (path === 'project/project-id') return options.projectId;
      if (path.endsWith('/email')) return `${options.expectedServiceAccount}\n`;
      return [...EXPECTED_SCOPES].reverse().join('\n') + '\n';
    },
  };
  return {
    options,
    calls,
    credential,
    database,
    sdk,
    deps,
    ownedApp,
    foreignApp,
    get signal() {
      return signal;
    },
  };
}
function fakeClock() {
  let now = 0,
    next = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) {
      const id = next++;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      await flush();
    },
    get elapsed() {
      return now;
    },
  };
}

for (const project of ['urm-app', 'urm-app-staging'])
  test(`${project}: real SDK boundary uses exact selected resources, no data inspection, and owned-app cleanup`, async () => {
    const f = fixture(config(project));
    const result = await runCanary(f.options, f.deps);
    assert.deepEqual(result, {
      ok: true,
      projectId: project,
      databaseURL: f.options.databaseURL,
      serviceAccountEmail: f.options.expectedServiceAccount,
      buildId: f.options.buildId,
      readSucceeded: true,
      noWrites: true,
      ownedSdkCleanupComplete: true,
    });
    const init = f.calls.find((call) => Array.isArray(call) && call[0] === 'initialize');
    assert.deepEqual(init[1], { projectId: project, databaseURL: f.options.databaseURL, credential: f.credential });
    assert.equal(init[2], 'temporal-rtdb-canary-owned-unique-id');
    assert.deepEqual(
      f.calls.filter((call) => Array.isArray(call) && call[0] === 'ref'),
      [['ref', READ_PATH]]
    );
    assert.equal(READ_PATH, 'bundle-metadata');
    assert.deepEqual(f.calls.slice(-3), ['get', 'offline', 'delete']);
    assert.equal(f.signal.aborted, true);
  });

test('success cannot be reported before deleteApp completes', async () => {
  const f = fixture();
  let finishCleanup,
    settled = false;
  f.sdk.deleteApp = async (app) => {
    assert.equal(app, f.ownedApp);
    f.calls.push('delete');
    await new Promise((resolve) => {
      finishCleanup = resolve;
    });
  };
  const pending = runCanary(f.options, f.deps).then((value) => {
    settled = true;
    return value;
  });
  await flush();
  assert.equal(settled, false);
  assert.deepEqual(f.calls.slice(-2), ['offline', 'delete']);
  finishCleanup();
  assert.equal((await pending).ownedSdkCleanupComplete, true);
});

for (const code of ['PERMISSION_DENIED', 'INVALID_AUTH_TOKEN', 'NETWORK_ERROR'])
  test(`${code} cannot pass; sensitive SDK errors are sanitized and cleanup still runs`, async () => {
    const f = fixture();
    f.database.ref = () => ({
      get: async () => {
        throw new Error(`${code}: token=PRIVATE_TOKEN data=PRIVATE_DATA`);
      },
    });
    await assert.rejects(runCanary(f.options, f.deps), (error) => {
      assert.equal(error.code, 'CANARY_READ_FAILED');
      assert.doesNotMatch(error.message, /PRIVATE|token=|data=/);
      return true;
    });
    assert.deepEqual(f.calls.slice(-2), ['offline', 'delete']);
  });

test('SDK database initialization failure deletes only the newly owned app', async () => {
  const f = fixture();
  f.sdk.getDatabase = () => {
    throw new Error('private SDK failure');
  };
  await assert.rejects(runCanary(f.options, f.deps), { code: 'CANARY_SDK_FAILED' });
  assert.equal(f.calls.at(-1), 'delete');
  assert.equal(f.calls.includes('offline'), false);
});
test('an app collision or foreign/default return is never adopted or deleted', async () => {
  const f = fixture();
  f.sdk.initializeApp = () => f.foreignApp;
  await assert.rejects(runCanary(f.options, f.deps), { code: 'CANARY_SDK_FAILED' });
  assert.equal(f.calls.includes('database'), false);
  assert.equal(f.calls.includes('delete'), false);
});
test('goOffline failure cannot pass and still attempts owned-app deletion', async () => {
  const f = fixture();
  f.database.goOffline = () => {
    f.calls.push('offline');
    throw new Error('private');
  };
  await assert.rejects(runCanary(f.options, f.deps), { code: 'CANARY_CLEANUP_FAILED' });
  assert.equal(f.calls.at(-1), 'delete');
});
test('deleteApp failure cannot pass', async () => {
  const f = fixture();
  f.sdk.deleteApp = async () => {
    throw new Error('private credentials');
  };
  await assert.rejects(runCanary(f.options, f.deps), { code: 'CANARY_CLEANUP_FAILED' });
});

test('a hanging authenticated read times out, aborts metadata, and cleans up inside the overall twenty-second bound', async () => {
  const f = fixture(),
    clock = fakeClock();
  f.database.ref = () => ({ get: () => new Promise(() => {}) });
  const result = runCanary(f.options, { ...f.deps, ...clock }).catch((error) => error);
  await flush();
  await clock.advance(18_000);
  assert.equal((await result).code, 'CANARY_TIMEOUT');
  assert.deepEqual(f.calls.slice(-2), ['offline', 'delete']);
  assert.equal(f.signal.aborted, true);
  assert.ok(clock.elapsed <= MAX_DURATION_MS);
});
test('a hanging teardown times out and never returns a success proof', async () => {
  const f = fixture(),
    clock = fakeClock();
  f.sdk.deleteApp = () => new Promise(() => {});
  const result = runCanary(f.options, { ...f.deps, ...clock }).catch((error) => error);
  await flush();
  await clock.advance(MAX_DURATION_MS);
  assert.equal((await result).code, 'CANARY_CLEANUP_FAILED');
  assert.equal(clock.elapsed, 20_000);
});

test('metadata or ADC failures before app ownership do not touch foreign apps', async () => {
  const f = fixture();
  f.deps.metadataText = async () => {
    throw new Error('private');
  };
  await assert.rejects(runCanary(f.options, f.deps), { code: 'CANARY_METADATA_FAILED' });
  assert.equal(f.calls.includes('load-sdk'), false);
  assert.equal(f.calls.includes('delete'), false);
});
for (const mismatch of ['project', 'email', 'scopes'])
  test(`metadata ${mismatch} mismatch blocks SDK creation`, async () => {
    const f = fixture(),
      original = f.deps.metadataText;
    f.deps.metadataText = async (path, signal) => {
      if (mismatch === 'project' && path === 'project/project-id') return 'urm-app';
      if (mismatch === 'email' && path.endsWith('/email')) return 'wrong@urm-app-staging.iam.gserviceaccount.com';
      if (mismatch === 'scopes' && path.endsWith('/scopes')) return EXPECTED_SCOPES.slice(0, 2).join('\n');
      return original(path, signal);
    };
    await assert.rejects(runCanary(f.options, f.deps), { code: 'CANARY_IDENTITY_MISMATCH' });
    assert.equal(f.calls.includes('load-sdk'), false);
  });
for (const kind of ['missing-capability', 'file-credential', 'wrong-adc-email', 'adc-error'])
  test(`${kind} cannot substitute another ADC identity`, async () => {
    const f = fixture();
    if (kind === 'missing-capability') delete f.credential.isComputeEngineCredential;
    if (kind === 'file-credential') f.credential.isComputeEngineCredential = async () => false;
    if (kind === 'wrong-adc-email') f.credential.getServiceAccountEmail = async () => 'other@example.com';
    if (kind === 'adc-error')
      f.credential.isComputeEngineCredential = async () => {
        throw new Error('private token');
      };
    await assert.rejects(runCanary(f.options, f.deps));
    assert.equal(f.calls.includes('database'), false);
    assert.equal(
      f.calls.some((call) => Array.isArray(call) && call[0] === 'initialize'),
      false
    );
  });

for (const patch of [
  { projectId: 'other-project' },
  { databaseURL: 'https://urm-app-default-rtdb.firebaseio.com/' },
  { databaseURL: 'http://127.0.0.1:9000/' },
  { databaseURL: 'https://urm-app-staging-default-rtdb.firebaseio.com/path' },
  { expectedServiceAccount: 'temporal-worker@urm-app.iam.gserviceaccount.com' },
  { expectedScopes: undefined },
  { expectedScopes: [] },
  { expectedScopes: [...EXPECTED_SCOPES, EXPECTED_SCOPES[0]] },
  { expectedScopes: ['https://www.googleapis.com/auth/cloud-platform'] },
  { expectedScopes: [...EXPECTED_SCOPES.slice(0, 2), 'https://www.googleapis.com/auth/userinfo.profile'] },
  { buildId: 'draft-build' },
])
  test(`invalid target/policy config fails before metadata: ${JSON.stringify(patch)}`, async () => {
    const f = fixture();
    await assert.rejects(runCanary({ ...f.options, ...patch }, f.deps), { code: 'CANARY_INVALID_CONFIG' });
    assert.deepEqual(f.calls, []);
  });
for (const variable of [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
  'GCE_METADATA_HOST',
  'FIREBASE_DATABASE_EMULATOR_HOST',
])
  test(`${variable} override is rejected`, async () => {
    const f = fixture();
    f.deps.env = { [variable]: 'private-value' };
    await assert.rejects(runCanary(f.options, f.deps), { code: 'CANARY_INVALID_CONFIG' });
    assert.deepEqual(f.calls, []);
  });

test('environment contract requires trusted build, identity, database, and the reviewed policy JSON', () => {
  const c = config();
  const env = {
    FIREBASE_PROJECT_ID: c.projectId,
    FIREBASE_DATABASE_URL: c.databaseURL,
    TEMPORAL_EXPECTED_GOOGLE_SERVICE_ACCOUNT: c.expectedServiceAccount,
    TEMPORAL_EXPECTED_METADATA_SCOPES_JSON: JSON.stringify(c.expectedScopes),
    TEMPORAL_BUILD_ID: c.buildId,
  };
  assert.deepEqual(optionsFromEnvironment(env), c);
  for (const scopes of [undefined, '{broken', '{}', 'null'])
    assert.throws(() => optionsFromEnvironment({ ...env, TEMPORAL_EXPECTED_METADATA_SCOPES_JSON: scopes }), {
      code: 'CANARY_INVALID_CONFIG',
    });
});
test('the fixed CJS policy mirrors the validated platform three-scope policy', async () => {
  const { GCE_FIREBASE_ADC_SCOPES } = await import('../../scripts/temporal-platform.mjs');
  assert.deepEqual([...EXPECTED_SCOPES], [...GCE_FIREBASE_ADC_SCOPES]);
});
test('standalone invalid invocation is bounded, nonzero, and emits only safe failure JSON', () => {
  const result = spawnSync(process.execPath, [require.resolve('./firebase-rtdb-canary.cjs')], {
    env: { PATH: process.env.PATH, TEMPORAL_EXPECTED_METADATA_SCOPES_JSON: 'PRIVATE_INVALID_VALUE' },
    timeout: 3000,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, code: 'CANARY_INVALID_CONFIG' });
  assert.doesNotMatch(result.stderr, /PRIVATE|access_token|credential/);
});

test('production metadata transport uses only fixed link-local GET endpoints with the Google metadata handshake', async () => {
  const abort = new AbortController();
  const text = await metadataText('project/project-id', abort.signal, async (url, options) => {
    assert.equal(url, 'http://169.254.169.254/computeMetadata/v1/project/project-id');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['Metadata-Flavor'], 'Google');
    assert.equal(options.redirect, 'error');
    assert.equal(options.signal, abort.signal);
    return new Response('urm-app-staging', { headers: { 'Metadata-Flavor': 'Google' } });
  });
  assert.equal(text, 'urm-app-staging');
});
for (const response of [
  () => new Response('PRIVATE_FAILURE', { status: 403, headers: { 'Metadata-Flavor': 'Google' } }),
  () => new Response('untrusted identity'),
  () => new Response('x'.repeat(8193), { headers: { 'Metadata-Flavor': 'Google' } }),
])
  test('production metadata transport rejects denied, unsigned, or oversized metadata', async () => {
    await assert.rejects(
      metadataText('project/project-id', new AbortController().signal, async () => response()),
      { code: 'CANARY_METADATA_FAILED' }
    );
  });
test('metadata hang cannot initialize an app or escape the work deadline', async () => {
  const f = fixture(),
    clock = fakeClock();
  let signal;
  f.deps.metadataText = (_path, currentSignal) => {
    signal = currentSignal;
    return new Promise(() => {});
  };
  const result = runCanary(f.options, { ...f.deps, ...clock }).catch((error) => error);
  await flush();
  await clock.advance(18_000);
  assert.equal((await result).code, 'CANARY_TIMEOUT');
  assert.equal(signal.aborted, true);
  assert.equal(f.calls.includes('load-sdk'), false);
});
test('cleanup still attempts deletion if connection shutdown consumes the final deadline', async () => {
  const f = fixture(),
    clock = fakeClock();
  f.database.goOffline = () => {
    f.calls.push('offline');
    void clock.advance(MAX_DURATION_MS);
  };
  const result = await runCanary(f.options, { ...f.deps, ...clock }).catch((error) => error);
  assert.equal(result.code, 'CANARY_CLEANUP_FAILED');
  assert.equal(f.calls.at(-1), 'delete');
});

test('node-e trusted source embedding explicitly invokes the exported CLI and cannot silently succeed', () => {
  const source = readFileSync(require.resolve('./firebase-rtdb-canary.cjs'), 'utf8');
  const env = { PATH: process.env.PATH, TEMPORAL_EXPECTED_METADATA_SCOPES_JSON: 'PRIVATE_INVALID_VALUE' };
  // A plain embedded module must be inert; imports may not initialize credentials.
  const inert = spawnSync(process.execPath, ['-e', source], { env, timeout: 3000, encoding: 'utf8' });
  assert.equal(inert.status, 0);
  assert.equal(inert.stdout, '');
  assert.equal(inert.stderr, '');
  // The renderer's explicit entry point must actually execute CLI validation.
  const invoked = spawnSync(process.execPath, ['-e', `${source}\nvoid module.exports.runCli();`], {
    env,
    timeout: 3000,
    encoding: 'utf8',
  });
  assert.equal(invoked.status, 1);
  assert.equal(invoked.stdout, '');
  assert.deepEqual(JSON.parse(invoked.stderr), { ok: false, code: 'CANARY_INVALID_CONFIG' });
  assert.doesNotMatch(invoked.stderr, /PRIVATE|access_token|credential/);
});
