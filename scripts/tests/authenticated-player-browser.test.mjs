import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  emulatorPorts,
  isLoadedDotenv,
  isolatedEnvironment,
  validateEmulatorContext,
  emulatorCommand,
  PROJECT,
  SPECS,
} from './authenticated-player-browser.mjs';
const config = JSON.parse(readFileSync(new URL('../../firebase.test.json', import.meta.url), 'utf8'));
const ports = emulatorPorts(config);
test('uses actual dedicated Firebase test ports without rewriting config', () => {
  assert.deepEqual(ports, {
    auth: 9100,
    firestore: 18081,
    database: 19000,
    storage: 19199,
    functions: 5001,
    hub: 19400,
    logging: 19500,
    ui: 19401,
  });
  const env = isolatedEnvironment({}, ports);
  for (const name of ['auth', 'firestore', 'database', 'storage', 'functions'])
    assert.equal(env[`NEXT_PUBLIC_FIREBASE_${name.toUpperCase()}_EMULATOR_PORT`], String(ports[name]));
  assert.match(env.FIREBASE_CONFIG, /19000/);
});
test('inherits only execution prerequisites, never real project or credential variables', () => {
  const env = isolatedEnvironment(
    {
      PATH: '/safe/bin',
      HOME: '/safe/home',
      GCLOUD_PROJECT: 'production',
      GOOGLE_APPLICATION_CREDENTIALS: '/real/key',
      SENTRY_AUTH_TOKEN: 'secret',
      NODE_OPTIONS: '--require=unsafe',
      NEXT_PUBLIC_FIREBASE_API_KEY: 'real-key',
      GITHUB_TOKEN: 'secret',
      FIREBASE_TOKEN: 'secret',
    },
    ports
  );
  assert.equal(env.PATH, '/safe/bin');
  assert.equal(env.GCLOUD_PROJECT, PROJECT);
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, '/nonexistent/ci-player-no-adc.json');
  for (const key of ['SENTRY_AUTH_TOKEN', 'NODE_OPTIONS', 'GITHUB_TOKEN', 'FIREBASE_TOKEN'])
    assert.equal(env[key], undefined);
  assert.equal(env.METADATA_SERVER_DETECTION, 'none');
});
test('rejects foreign hosts, malformed ports, port conflicts and missing services', () => {
  for (const patch of [
    { host: 'example.com' },
    { port: 0 },
    { port: 65536 },
    { port: '9100' },
    { port: 3004 },
    { port: ports.firestore },
  ]) {
    const changed = structuredClone(config);
    Object.assign(changed.emulators.auth, patch);
    assert.throws(() => emulatorPorts(changed));
  }
  const missing = structuredClone(config);
  delete missing.emulators.storage;
  assert.throws(() => emulatorPorts(missing));
});
test('requires exact synthetic project and all actual emulator endpoints before SDK seeding', () => {
  const env = {
    GCLOUD_PROJECT: PROJECT,
    FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${ports.auth}`,
    FIRESTORE_EMULATOR_HOST: `127.0.0.1:${ports.firestore}`,
    FIREBASE_DATABASE_EMULATOR_HOST: `127.0.0.1:${ports.database}`,
    FIREBASE_STORAGE_EMULATOR_HOST: `127.0.0.1:${ports.storage}`,
  };
  validateEmulatorContext(env, ports);
  for (const key of Object.keys(env))
    assert.throws(() =>
      validateEmulatorContext({ ...env, [key]: key === 'GCLOUD_PROJECT' ? 'urm-app' : '127.0.0.1:8081' }, ports)
    );
});
test('runs owned checks serially through unchanged dedicated emulator config', () => {
  assert.deepEqual(emulatorCommand(), [
    '--dir',
    'functions',
    'exec',
    'firebase',
    'emulators:exec',
    '--project',
    PROJECT,
    '--only',
    'auth,firestore,database,storage',
    '--config',
    '../firebase.test.json',
    'node ../scripts/tests/authenticated-player-browser.mjs --inside-emulators',
  ]);
  assert.deepEqual(SPECS, [
    'tests/audio-player.spec.ts',
    'tests/audio-trimmer.spec.ts',
    'tests/player-clear-on-upload.spec.ts',
  ]);
});

test('real TypeScript media fixture limits routes and rejects foreign or malformed calls', async () => {
  const { createRequire } = await import('node:module');
  const ts = createRequire(import.meta.url)('typescript');
  const source = readFileSync(
    new URL('../../apps/web/tests/helpers/providerStatusFixture.ts', import.meta.url),
    'utf8'
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const { installMediaProviderStatusFixture } = await import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
  );
  const env = isolatedEnvironment({}, ports);
  const keys = [
    'URM_MEDIA_BROWSER_STATUS_FIXTURE',
    'GCLOUD_PROJECT',
    'PLAYWRIGHT_BASE_URL',
    'NEXT_PUBLIC_FIREBASE_FUNCTIONS_EMULATOR_PORT',
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = env[key];
    let predicate, handler;
    await installMediaProviderStatusFixture({
      route: async (p, h) => {
        predicate = p;
        handler = h;
      },
    });
    const endpoint = 'http://127.0.0.1:5001/demo-temporal-ci/us-central1/getProviderSandboxStatus';
    assert.equal(predicate(new URL(endpoint)), true);
    for (const foreign of [
      endpoint.replace('demo-temporal-ci', 'urm-app'),
      endpoint.replace('5001', '5002'),
      endpoint.replace('us-central1', 'europe-west1'),
      endpoint + '?x=1',
      endpoint.replace('getProviderSandboxStatus', 'publish'),
      endpoint.replace('127.0.0.1', 'localhost'),
      'https://us-central1-urm-app.cloudfunctions.net/getProviderSandboxStatus',
    ])
      assert.equal(predicate(new URL(foreign)), false);
    let response;
    const invoke = (
      method = 'POST',
      headers = { origin: env.PLAYWRIGHT_BASE_URL, authorization: 'Bearer synthetic-emulator-token' },
      body = { data: {} }
    ) =>
      handler({
        request: () => ({ method: () => method, headers: () => headers, postDataJSON: () => body }),
        fulfill: async (value) => {
          response = value;
        },
      });
    await invoke();
    assert.deepEqual(response.json, {
      result: {
        mode: 'blocked',
        ready: false,
        catalogReady: false,
        scenarioSelectionAllowed: false,
        reason: 'configuration-unavailable',
      },
    });
    await invoke('OPTIONS', { origin: env.PLAYWRIGHT_BASE_URL, 'access-control-request-method': 'POST' });
    assert.equal(response.status, 204);
    await assert.rejects(invoke('GET'));
    await assert.rejects(invoke('POST', { origin: 'https://foreign.example', authorization: 'Bearer test' }));
    await assert.rejects(invoke('POST', { origin: env.PLAYWRIGHT_BASE_URL }));
    await assert.rejects(invoke('POST', undefined, { data: { mutate: true } }));
    await assert.rejects(
      invoke('OPTIONS', { origin: env.PLAYWRIGHT_BASE_URL, 'access-control-request-method': 'DELETE' })
    );
    process.env.GCLOUD_PROJECT = 'urm-app';
    await assert.rejects(
      installMediaProviderStatusFixture({
        route: () => {
          throw Error('Must not install');
        },
      })
    );
    delete process.env.URM_MEDIA_BROWSER_STATUS_FIXTURE;
    await installMediaProviderStatusFixture({
      route: () => {
        throw Error('Must not install in ordinary local tests');
      },
    });
  } finally {
    for (const key of keys)
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
  }
});
test('each media spec installs the narrow fixture before any login', () => {
  for (const spec of SPECS) {
    const source = readFileSync(new URL(`../../apps/web/${spec}`, import.meta.url), 'utf8');
    assert.match(
      source,
      /test\.beforeEach\(async \(\{ page \}\) => \{\s*await installMediaProviderStatusFixture\(page\);/
    );
    assert(source.indexOf('test.beforeEach') < source.indexOf('async function loginAsDevAdmin'));
  }
});

test('rejects only loadable dotenv files, permits tracked inert templates', () => {
  for (const name of [
    '.env',
    '.env.local',
    '.env.development',
    '.env.development.local',
    '.env.production',
    '.env.production.local',
    '.env.test',
    '.env.test.local',
  ])
    assert.equal(isLoadedDotenv(name), true);
  for (const name of ['.env.template', '.env.example', '.env.defaults', 'env'])
    assert.equal(isLoadedDotenv(name), false);
});
