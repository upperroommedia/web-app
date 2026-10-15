import test from 'node:test';
import { MEDIA_FIXTURE_UPLOADER } from '../../apps/web/tests/helpers/mediaFixtureIdentity.ts';
import assert from 'node:assert/strict';
import { DEV_ADMIN_EMAIL, DEV_ADMIN_PASSWORD } from '../../apps/web/context/user/devAuth.ts';
import { readFileSync } from 'node:fs';
import {
  emulatorPorts,
  loadMediaFixtureSources,
  buildMediaBackendFixture,
  cleanupMediaSeed,
  prewarmMediaRoutes,
  devAdminSeed,
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
test('each media spec installs the backend fixtures and status guard before any login', () => {
  for (const spec of SPECS) {
    const source = readFileSync(new URL(`../../apps/web/${spec}`, import.meta.url), 'utf8');
    assert.match(source, /test\.beforeEach\(async \(\{ page \}\) => \{\s*await installMediaBackendFixtures\(page\);/);
    assert.match(source, /import \{ installMediaBackendFixtures \} from '\.\/helpers\/mediaBackendFixture'/);
    assert(source.indexOf('test.beforeEach') < source.indexOf('async function loginAsDevAdmin'));
  }
  const adapter = readFileSync(new URL('../../apps/web/tests/helpers/mediaBackendFixture.ts', import.meta.url), 'utf8');
  assert.match(
    adapter,
    /export async function installMediaBackendFixtures\(page: Page\): Promise<void> \{\s*await installMediaProviderStatusFixture\(page\);/
  );
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

test('seeds the real emulator dev-login fixture without duplicating its credentials', () => {
  assert.deepEqual(devAdminSeed(), {
    uid: 'ci-player-admin',
    email: DEV_ADMIN_EMAIL,
    password: DEV_ADMIN_PASSWORD,
    emailVerified: true,
  });
  const source = readFileSync(new URL('./authenticated-player-browser.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes(DEV_ADMIN_EMAIL), false);
  assert.equal(source.includes(DEV_ADMIN_PASSWORD), false);
  assert.match(source, /await auth\.createUser\(devAdminSeed\(\)\)/);
});

test('actual six bundle configs and directory mapper load without initializing a browser Firebase app', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../../functions/package.json', import.meta.url));
  const { configs, toDirectoryUser } = loadMediaFixtureSources(require);
  assert.deepEqual(
    configs.map((config) => [config.functionName, config.namedQuery]),
    [
      ['createtopicbundle', 'latest-topics-query'],
      ['createsubtitlebundle', 'latest-subtitles-query'],
      ['createbiblechapterbundle', 'latest-bible-chapters-query'],
      ['createsundayhomilybundle', 'latest-sunday-homilies-query'],
      ['createholyweekbundle', 'latest-holy-week-query'],
      ['createlatestlistbundle', 'latest-list-query'],
    ]
  );
  assert.equal(
    Object.keys(require.cache).some((path) => path.endsWith('/apps/web/firebase/firebase.ts')),
    false
  );
  const user = toDirectoryUser({
    uid: MEDIA_FIXTURE_UPLOADER.uid,
    email: MEDIA_FIXTURE_UPLOADER.email,
    metadata: {},
    providerData: [],
    customClaims: { role: MEDIA_FIXTURE_UPLOADER.role },
    emailVerified: true,
  });
  assert.equal(user.uid, MEDIA_FIXTURE_UPLOADER.uid);
  assert.equal(user.role, MEDIA_FIXTURE_UPLOADER.role);
  assert.equal(user.refreshToken, '');
});

test('actual producer JSON roundtrip passes the actual parser with shared directory identity and query metadata', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../../functions/package.json', import.meta.url));
  const { configs, toDirectoryUser, parseMediaBackendFixture } = loadMediaFixtureSources(require);
  const events = [];
  const app = { options: { projectId: PROJECT } };
  let record;
  const auth = {
    app,
    createUser: async (value) => {
      events.push(['user', value.uid]);
      record = { ...value, metadata: {}, providerData: [] };
    },
    setCustomUserClaims: async (uid, claims) => {
      events.push(['claims', uid, claims]);
      assert.equal(uid, record.uid);
      record.customClaims = claims;
    },
    getUser: async (uid) => {
      assert.equal(uid, record.uid);
      return record;
    },
  };
  const db = {
    projectId: PROJECT,
    collection: (name) => {
      const operations = [['collection', name]];
      const query = {
        where: (...args) => {
          operations.push(['where', ...args]);
          return query;
        },
        orderBy: (field) => {
          operations.push(['orderBy', field]);
          return query;
        },
        get: async () => {
          events.push(operations);
          return { size: 0, readTime: { toMillis: () => 123456 } };
        },
      };
      return query;
    },
    bundle: (id) => ({
      add: (name, snapshot) => {
        events.push(['bundle', id, name, snapshot.size]);
        return { build: () => Buffer.from('SDK-builder-test-result') };
      },
    }),
  };
  const database = { app, ref: (path) => ({ set: async (value) => events.push(['metadata', path, value]) }) };
  const fixture = await buildMediaBackendFixture({ db, auth, database, configs, toDirectoryUser });
  const parsedFixture = parseMediaBackendFixture(JSON.parse(JSON.stringify(fixture)));
  assert.equal(parsedFixture.users[0].uid, MEDIA_FIXTURE_UPLOADER.uid);
  assert.equal(parsedFixture.users[0].email, MEDIA_FIXTURE_UPLOADER.email);
  assert.equal(parsedFixture.users[0].displayName, MEDIA_FIXTURE_UPLOADER.displayName);
  assert.equal(parsedFixture.users[0].role, MEDIA_FIXTURE_UPLOADER.role);
  assert.equal(fixture.projectId, PROJECT);
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(Object.keys(fixture.bundles).length, 6);
  assert.equal(fixture.users[0].uid, record.uid);
  assert.deepEqual(
    events.filter((e) => e[0]?.[0] === 'collection'),
    configs.map((c) => [
      ['collection', c.collectionName],
      ...(c.whereConditions ?? []).map((w) => ['where', w.field, w.operator, w.value]),
      ...(c.orderByField ? [['orderBy', c.orderByField]] : []),
    ])
  );
  for (const c of configs) {
    assert.equal(fixture.bundles[c.functionName].namedQuery, c.namedQuery);
    assert(events.some((e) => e[0] === 'metadata' && e[1] === c.metadataDocPath && e[2].lastUpdated === 123456));
  }
  await assert.rejects(
    buildMediaBackendFixture({ db: { ...db, projectId: 'urm-app' }, auth, database, configs, toDirectoryUser }),
    /Demo Firestore/
  );
  await assert.rejects(
    buildMediaBackendFixture({
      db,
      auth: { ...auth, app: { options: { projectId: 'urm-app' } } },
      database,
      configs,
      toDirectoryUser,
    }),
    /Demo Auth/
  );
  await assert.rejects(
    buildMediaBackendFixture({
      db,
      auth,
      database: { ...database, app: { options: { projectId: 'urm-app' } } },
      configs,
      toDirectoryUser,
    }),
    /Demo RTDB/
  );
  const tooLarge = { ...db, bundle: () => ({ add: () => ({ build: () => Buffer.alloc(1024 * 1024 + 1) }) }) };
  await assert.rejects(
    buildMediaBackendFixture({ db: tooLarge, auth, database, configs, toDirectoryUser }),
    /oversized/
  );
});

test('seed teardown tries every owned SDK even on seed and cleanup failures', async () => {
  const seed = new Error('seed failed'),
    close = new Error('Firestore close failed'),
    order = [];
  await assert.rejects(
    cleanupMediaSeed(
      {
        terminate: async () => {
          order.push('firestore');
          throw close;
        },
      },
      { goOffline: () => order.push('database') },
      { name: 'owned' },
      async (app) => {
        assert.equal(app.name, 'owned');
        order.push('app');
      },
      seed
    ),
    (error) => error instanceof AggregateError && error.errors[0] === seed && error.errors[1] === close
  );
  assert.deepEqual(order, ['firestore', 'database', 'app']);
});

test('prewarms only fixed demo media pages and fails on compilation errors', async () => {
  const urls = [];
  await prewarmMediaRoutes('http://127.0.0.1:3004', async (url, options) => {
    urls.push(url);
    assert.equal(options.redirect, 'error');
    return { ok: true, body: { cancel: async () => {} } };
  });
  assert.deepEqual(urls, [
    'http://127.0.0.1:3004/login',
    'http://127.0.0.1:3004/',
    'http://127.0.0.1:3004/admin/sermons',
  ]);
  await assert.rejects(prewarmMediaRoutes('https://production.example'), /Expected values/);
  await assert.rejects(
    prewarmMediaRoutes('http://127.0.0.1:3004', async () => ({
      ok: false,
      status: 500,
      body: { cancel: async () => {} },
    })),
    /did not compile/
  );
});

test('CI checks the actual producer/parser contract once before application regression tests', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/temporal-application-validation.yml', import.meta.url),
    'utf8'
  );
  const command = 'node --test scripts/tests/authenticated-player-browser.test.mjs';
  assert.equal(workflow.split(command).length - 1, 1);
  const position = workflow.indexOf(command);
  assert(position > workflow.indexOf('name: Validate every kit on genuine Linux native production startup'));
  assert(position < workflow.indexOf('name: Validate application regressions, admission, rules and SDK compatibility'));
  assert.match(workflow, /id: media_browser/);
  assert.match(workflow, /failure\(\) && steps\.media_browser\.outcome == 'failure'/);
});
