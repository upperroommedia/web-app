'use strict';

// One-shot serving-read proof. This is deliberately separate from health polling.
const { randomUUID } = require('node:crypto');
const MAX_DURATION_MS = 20_000;
const CLEANUP_RESERVE_MS = 2_000;
const READ_PATH = 'bundle-metadata';
const METADATA_ROOT = 'http://169.254.169.254/computeMetadata/v1/';
const EXPECTED_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/userinfo.email',
]);
const DATABASES = Object.freeze({
  'urm-app': 'https://urm-app-default-rtdb.firebaseio.com/',
  'urm-app-staging': 'https://urm-app-staging-default-rtdb.firebaseio.com/',
});
const OVERRIDES = Object.freeze([
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
  'GCE_METADATA_HOST',
  'GCE_METADATA_IP',
  'GCE_METADATA_ROOT',
  'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIRESTORE_EMULATOR_HOST',
]);
class CanaryError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new CanaryError(code);
};
function reviewedScopes(scopes) {
  return (
    Array.isArray(scopes) &&
    scopes.length === EXPECTED_SCOPES.length &&
    new Set(scopes).size === EXPECTED_SCOPES.length &&
    scopes.every((scope) => typeof scope === 'string' && EXPECTED_SCOPES.includes(scope))
  );
}
function validateOptions(options, env) {
  if (!options || !Object.hasOwn(DATABASES, options.projectId)) fail('CANARY_INVALID_CONFIG');
  let databaseURL;
  try {
    databaseURL = new URL(options.databaseURL).href;
  } catch {
    fail('CANARY_INVALID_CONFIG');
  }
  if (
    databaseURL !== DATABASES[options.projectId] ||
    typeof options.expectedServiceAccount !== 'string' ||
    !new RegExp(`^[a-z][a-z0-9-]{4,28}[a-z0-9]@${options.projectId}\\.iam\\.gserviceaccount\\.com$`).test(
      options.expectedServiceAccount
    ) ||
    typeof options.buildId !== 'string' ||
    !/^[a-f0-9]{40}$/.test(options.buildId) ||
    !reviewedScopes(options.expectedScopes) ||
    OVERRIDES.some((name) => env[name] !== undefined)
  )
    fail('CANARY_INVALID_CONFIG');
  return { ...options, databaseURL };
}
function optionsFromEnvironment(env) {
  let expectedScopes;
  try {
    expectedScopes = JSON.parse(env.TEMPORAL_EXPECTED_METADATA_SCOPES_JSON);
  } catch {
    fail('CANARY_INVALID_CONFIG');
  }
  return validateOptions(
    {
      projectId: env.FIREBASE_PROJECT_ID,
      databaseURL: env.FIREBASE_DATABASE_URL,
      expectedServiceAccount: env.TEMPORAL_EXPECTED_GOOGLE_SERVICE_ACCOUNT,
      expectedScopes,
      buildId: env.TEMPORAL_BUILD_ID,
    },
    env
  );
}
async function metadataText(resource, signal, fetchRequest = fetch) {
  const response = await fetchRequest(`${METADATA_ROOT}${resource}`, {
    method: 'GET',
    headers: { 'Metadata-Flavor': 'Google' },
    signal,
    redirect: 'error',
  });
  if (!response.ok || response.headers.get('metadata-flavor') !== 'Google' || !response.body)
    fail('CANARY_METADATA_FAILED');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 8192) fail('CANARY_METADATA_FAILED');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString('utf8');
}
function loadSdk() {
  const { applicationDefault, initializeApp, deleteApp } = require('firebase-admin/app');
  const { getDatabase } = require('firebase-admin/database');
  return { applicationDefault, initializeApp, deleteApp, getDatabase };
}

async function runCanary(input, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const schedule = dependencies.setTimeout ?? setTimeout;
  const unschedule = dependencies.clearTimeout ?? clearTimeout;
  const started = now();
  const finalDeadline = started + MAX_DURATION_MS;
  const workDeadline = finalDeadline - CLEANUP_RESERVE_MS;
  const config = validateOptions(input, dependencies.env ?? process.env);
  const abort = new AbortController();
  const metadata = dependencies.metadataText ?? metadataText;
  const bounded = async (operation, deadline) => {
    if (now() >= deadline) fail('CANARY_TIMEOUT');
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = schedule(() => reject(new CanaryError('CANARY_TIMEOUT')), deadline - now());
        }),
      ]);
    } finally {
      unschedule(timer);
    }
  };
  let app;
  let database;
  let sdk;
  let error;
  let phase = 'CANARY_METADATA_FAILED';
  try {
    const [project, email, scopes] = await bounded(
      () =>
        Promise.all([
          metadata('project/project-id', abort.signal),
          metadata('instance/service-accounts/default/email', abort.signal),
          metadata('instance/service-accounts/default/scopes', abort.signal),
        ]),
      workDeadline
    );
    if (
      typeof project !== 'string' ||
      project.trim() !== config.projectId ||
      typeof email !== 'string' ||
      email.trim() !== config.expectedServiceAccount ||
      typeof scopes !== 'string' ||
      !reviewedScopes(scopes.trim().split(/\r?\n/))
    )
      fail('CANARY_IDENTITY_MISMATCH');

    phase = 'CANARY_ADC_FAILED';
    sdk = (dependencies.loadSdk ?? loadSdk)();
    const credential = sdk.applicationDefault();
    // These capabilities are present in the pinned Admin SDK's ADC implementation.
    // They are not part of its general Credential interface: fail closed if an
    // upgrade or alternate credential cannot prove metadata Compute identity.
    if (
      typeof credential.isComputeEngineCredential !== 'function' ||
      typeof credential.getServiceAccountEmail !== 'function'
    )
      fail('CANARY_ADC_UNSUPPORTED');
    if (
      (await bounded(() => credential.isComputeEngineCredential(), workDeadline)) !== true ||
      (await bounded(() => credential.getServiceAccountEmail(), workDeadline)) !== config.expectedServiceAccount
    )
      fail('CANARY_IDENTITY_MISMATCH');

    phase = 'CANARY_SDK_FAILED';
    const name = `temporal-rtdb-canary-${(dependencies.randomUUID ?? randomUUID)()}`;
    const created = sdk.initializeApp(
      { projectId: config.projectId, databaseURL: config.databaseURL, credential },
      name
    );
    // Never adopt or clean up a default/foreign app.
    if (created?.name !== name) fail('CANARY_SDK_FAILED');
    app = created;
    database = sdk.getDatabase(app);
    phase = 'CANARY_READ_FAILED';
    // A fresh, uniquely named app has no previously populated RTDB cache. get()
    // therefore has to complete its initial server read; snapshot data is ignored.
    await bounded(() => database.ref(READ_PATH).get(), workDeadline);
  } catch (caught) {
    error = caught instanceof CanaryError ? caught : new CanaryError(phase);
  } finally {
    abort.abort();
    if (database) {
      try {
        database.goOffline();
      } catch {
        error = new CanaryError('CANARY_CLEANUP_FAILED');
      }
    }
    if (app) {
      try {
        // Attempt deletion even if the work/connection shutdown exhausted time.
        const deletion = Promise.resolve(sdk.deleteApp(app));
        deletion.catch(() => {}); // A deadline must not leave an unhandled SDK error.
        await bounded(() => deletion, finalDeadline);
      } catch {
        error = new CanaryError('CANARY_CLEANUP_FAILED');
      }
    }
  }
  if (error) throw error;
  return {
    ok: true,
    projectId: config.projectId,
    databaseURL: config.databaseURL,
    serviceAccountEmail: config.expectedServiceAccount,
    buildId: config.buildId,
    readSucceeded: true,
    noWrites: true,
    ownedSdkCleanupComplete: true,
  };
}

async function runCli() {
  // SDK diagnostics are not a proof surface and can contain private error details.
  // This affects only this standalone canary process, never an importing worker.
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = () => {};
  const watchdog = setTimeout(() => {
    process.stderr.write('{"ok":false,"code":"CANARY_TIMEOUT"}\n');
    process.exit(1); // Last resort only: deadline/SDK teardown did not release handles.
  }, MAX_DURATION_MS);
  watchdog.unref();
  try {
    const result = await runCanary(optionsFromEnvironment(process.env));
    clearTimeout(watchdog);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, code: error instanceof CanaryError ? error.code : 'CANARY_FAILED' })}\n`
    );
    process.exitCode = 1;
    // Keep the unref'ed watchdog armed for a timed-out SDK operation that still
    // owns handles. Ordinary failures exit naturally after owned-app cleanup.
  }
}
module.exports = {
  runCli,
  runCanary,
  optionsFromEnvironment,
  MAX_DURATION_MS,
  READ_PATH,
  EXPECTED_SCOPES,
  CanaryError,
  metadataText,
};
if (require.main === module) void runCli();
