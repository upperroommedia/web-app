import test from 'node:test';
import { MEDIA_FIXTURE_ADMIN, MEDIA_FIXTURE_UPLOADER } from '../../apps/web/tests/helpers/mediaFixtureIdentity.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  emulatorPorts,
  loadMediaFixtureSources,
  buildMediaBackendFixture,
  cleanupMediaSeed,
  seedMediaAdmin,
  buildProduction,
  productionConfiguration,
  recordProductionBuild,
  verifyProductionBuild,
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
    assert.doesNotMatch(source, /Dev Login|loginAsDevAdmin/);
    assert.match(source, /loginAsMediaBrowserAdmin/);
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

test('imports only the exact linked Google administrator and verifies actual identity and claims', async () => {
  const { uid, email, displayName, role, providerUid, providerId } = MEDIA_FIXTURE_ADMIN;
  const actual = {
    uid,
    email,
    displayName,
    emailVerified: true,
    disabled: false,
    customClaims: { role },
    providerData: [{ uid: providerUid, providerId, email, displayName }],
  };
  let imported;
  const auth = {
    app: { options: { projectId: PROJECT } },
    importUsers: async (users) => {
      imported = users;
      return { successCount: 1, failureCount: 0, errors: [] };
    },
    getUser: async (id) => {
      assert.equal(id, uid);
      return actual;
    },
  };
  await seedMediaAdmin(auth);
  assert.deepEqual(imported, [
    { uid, email, displayName, emailVerified: true, providerData: actual.providerData, customClaims: { role } },
  ]);
  assert.equal('password' in imported[0], false);
  for (const patch of [
    { uid: 'foreign' },
    { email: 'foreign@example.test' },
    { disabled: true },
    { customClaims: { role: 'uploader' } },
    { providerData: [] },
    { providerData: [{ ...actual.providerData[0], uid: 'foreign' }] },
  ])
    await assert.rejects(seedMediaAdmin({ ...auth, getUser: async () => ({ ...actual, ...patch }) }));
  await assert.rejects(seedMediaAdmin({ ...auth, app: { options: { projectId: 'urm-app' } } }));
  await assert.rejects(
    seedMediaAdmin({ ...auth, importUsers: async () => ({ successCount: 0, failureCount: 1, errors: [{}] }) })
  );
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

test('production artifact binds actual built bytes, BUILD_ID and exact compile/runtime demo configuration', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'urm-media-build-proof-'));
  const env = isolatedEnvironment({}, ports);
  try {
    for (const path of [
      'apps/web/.next/static/chunk.js',
      'apps/web/.next/server/pages-manifest.json',
      'apps/web/.next/standalone/apps/web/server.js',
      'apps/web/.next/standalone/apps/web/.next/BUILD_ID',
      'apps/web/.next/standalone/apps/web/.next/server/pages-manifest.json',
      'apps/web/.next/standalone/apps/web/.next/static/chunk.js',
      'apps/web/.next/standalone/apps/web/public/icon.png',
      'apps/web/.next/required-server-files.json',
      'apps/web/.next/BUILD_ID',
    ]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(
        join(root, path),
        path.endsWith('BUILD_ID') ? 'test-build' : path.endsWith('.json') ? '{}' : 'built-content'
      );
    }
    await assert.rejects(verifyProductionBuild(root, env), /ENOENT/);
    await recordProductionBuild(root, env);
    await verifyProductionBuild(root, env);
    for (const patch of [
      { NODE_ENV: 'development' },
      { NEXT_PUBLIC_FIREBASE_DEMO_EMULATORS: 'false' },
      { NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'urm-app' },
      { NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT: '9099' },
      { FIREBASE_AUTH_EMULATOR_HOST: 'example.com:9100' },
    ]) {
      assert.throws(() => productionConfiguration({ ...env, ...patch }));
      await assert.rejects(verifyProductionBuild(root, { ...env, ...patch }));
    }
    await writeFile(join(root, 'apps/web/.next/static/chunk.js'), 'tampered');
    await assert.rejects(verifyProductionBuild(root, env), /output changed/);
    await writeFile(join(root, 'apps/web/.next/static/chunk.js'), 'built-content');
    await writeFile(join(root, 'apps/web/.next/BUILD_ID'), 'other-build');
    await assert.rejects(verifyProductionBuild(root, env), /BUILD_ID changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('CI builds once before real media checks and reuses production artifact for cold navigation', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/temporal-application-validation.yml', import.meta.url),
    'utf8'
  );
  const source = readFileSync(new URL('./authenticated-player-browser.mjs', import.meta.url), 'utf8');
  assert.equal(workflow.split('authenticated-player-browser.mjs --build-production').length - 1, 1);
  assert.equal(workflow.split('authenticated-player-browser.mjs --cold-navigation').length - 1, 1);
  assert(workflow.indexOf('--build-production') < workflow.indexOf('id: media_browser'));
  const guards =
    'node --test packages/shared/firebase/emulatorPorts.test.mjs packages/shared/firebase/demoEmulatorMode.test.mjs';
  assert.equal(workflow.split(guards).length - 1, 1);
  assert(workflow.indexOf(guards) < workflow.indexOf('--build-production'));
  assert(
    workflow.indexOf('node --test scripts/tests/authenticated-player-browser.test.mjs') <
      workflow.indexOf('--build-production')
  );
  assert.doesNotMatch(source, /run', 'dev'|prewarmMediaRoutes|DEV_ADMIN_PASSWORD/);
  assert.match(source, /Browser helper exposed as HTTP route/);
});

test('owned production command preserves failures and settles detached children on interrupt', async () => {
  const { spawnSync } = await import('node:child_process');
  const harness = new URL('./authenticated-player-browser.mjs', import.meta.url).href;
  const program = `import assert from 'node:assert/strict';
    import {runOwnedBuild} from ${JSON.stringify(harness)};
    await assert.rejects(runOwnedBuild(process.env,['-e','process.exitCode=23'],process.execPath),/23/);
    const timer=setTimeout(()=>process.kill(process.pid,'SIGTERM'),150);
    try { await assert.rejects(runOwnedBuild(process.env,['-e','setInterval(()=>{},1000)'],process.execPath),/interrupted/); }
    finally {clearTimeout(timer);}
    assert.equal(process.listenerCount('SIGTERM'),0);
    assert.equal(process.listenerCount('SIGINT'),0);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('failed production compilation leaves no completed artifact receipt and is not reused', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'urm-media-build-failure-'));
  const env = isolatedEnvironment({}, ports);
  try {
    await mkdir(join(root, 'apps/web/.next'), { recursive: true });
    await writeFile(join(root, 'apps/web/.next/media-browser-build.json'), 'stale-success');
    const error = new Error('real compilation failed');
    await assert.rejects(
      buildProduction(env, root, async () => {
        await mkdir(join(root, 'apps/web/.next'), { recursive: true });
        await writeFile(join(root, 'apps/web/.next/partial-chunk.js'), 'partial');
        throw error;
      }),
      (e) => e === error
    );
    await assert.rejects(readFile(join(root, 'apps/web/.next/media-browser-build.json')), /ENOENT/);
    await assert.rejects(verifyProductionBuild(root, env), /ENOENT/);
    assert.equal(await readFile(join(root, 'apps/web/.next/partial-chunk.js'), 'utf8'), 'partial');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
