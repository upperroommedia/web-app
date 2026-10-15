import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const project = 'demo-temporal-ci';
const config = {
  NEXT_PUBLIC_FIREBASE_DEMO_EMULATORS: 'true',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: project,
  NEXT_PUBLIC_FIREBASE_API_KEY: 'synthetic-public-browser-test-key',
  NEXT_PUBLIC_FIREBASE_APP_ID: '1:123456789:web:synthetic',
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${project}.firebaseapp.com`,
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: `${project}.appspot.com`,
  NEXT_PUBLIC_FIREBASE_IMAGES_BUCKET: `${project}-images`,
  NEXT_PUBLIC_FIREBASE_DATABASE_URL: 'http://127.0.0.1:19000?ns=demo-temporal-ci',
  NEXT_PUBLIC_FIREBASE_FUNCTIONS_REGION: 'us-central1',
  NEXT_PUBLIC_FIREBASE_FUNCTIONS_URL: 'http://127.0.0.1:5001/demo-temporal-ci/us-central1',
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT: '9100',
  NEXT_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT: '18081',
  NEXT_PUBLIC_FIREBASE_DATABASE_EMULATOR_PORT: '19000',
  NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_PORT: '19199',
  NEXT_PUBLIC_FIREBASE_FUNCTIONS_EMULATOR_PORT: '5001',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9100',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:18081',
  FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:19000',
  FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:19199',
  GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/ci-player-no-adc.json',
  METADATA_SERVER_DETECTION: 'none',
  GCE_METADATA_HOST: '127.0.0.1:9',
};
const expectedOptions = {
  projectId: project,
  apiKey: config.NEXT_PUBLIC_FIREBASE_API_KEY,
  appId: config.NEXT_PUBLIC_FIREBASE_APP_ID,
  authDomain: config.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  storageBucket: config.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  databaseURL: config.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
};
function fixture(
  overrides = {},
  { browser = false, origin = 'http://127.0.0.1:3004', existing, defaults, cookie, globals = {} } = {}
) {
  const env = { NODE_ENV: 'production', ...config, ...overrides };
  const calls = [];
  const apps = existing ? [{ options: existing }] : [];
  const cache = new Map();
  const instances = new Map();
  const context = vm.createContext({
    ...globals,
    process: { env },
    console: { log() {}, warn() {}, error() {} },
    ...(browser ? { window: { location: { origin, hostname: new URL(origin).hostname } } } : {}),
    ...(defaults === undefined ? {} : { __FIREBASE_DEFAULTS__: defaults }),
    ...(cookie === undefined ? {} : { document: { cookie } }),
  });
  const sdk = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args) => {
          calls.push({ name, args });
          if (name === 'getApps') return apps;
          if (name === 'getApp') return apps[0];
          if (name === 'initializeApp') {
            const app = { options: args[0] };
            apps.push(app);
            return app;
          }
          if (
            [
              'initializeAuth',
              'getAuth',
              'getFirestore',
              'initializeFirestore',
              'getStorage',
              'getDatabase',
              'getFunctions',
            ].includes(name)
          ) {
            const kind = name === 'initializeAuth' ? 'getAuth' : name === 'initializeFirestore' ? 'getFirestore' : name;
            const key = kind + ':' + (kind === 'getStorage' ? args[1] ?? 'default' : 'default');
            if (!instances.has(key))
              instances.set(key, { app: args[0], ...(kind === 'getAuth' ? { emulatorConfig: null } : {}) });
            return instances.get(key);
          }
          if (name === 'connectAuthEmulator') {
            const url = new URL(args[1]);
            args[0].emulatorConfig = {
              host: url.hostname,
              port: Number(url.port),
              protocol: url.protocol.slice(0, -1),
            };
          }
          return {};
        },
    }
  );
  function load(path) {
    const file = path.startsWith('/') ? path : resolve(root, path);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const localRequire = (name) => {
      if (name.startsWith('firebase/') || name.startsWith('firebase-admin/')) {
        calls.push({ name: 'SDK_LOAD', args: [name] });
        return sdk;
      }
      if (name === 'node:fs')
        return {
          readFileSync() {
            throw new Error('Unexpected credential/config file read');
          },
        };
      if (name.endsWith('firebaseAdminOwnership')) return { recordSharedFirebaseAppCreation() {} };
      if (name.startsWith('.')) return load(resolve(dirname(file), name + '.ts'));
      throw new Error('Unexpected import ' + name);
    };
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: file })(
      localRequire,
      module,
      module.exports
    );
    return module.exports;
  }
  const recreate = () => {
    apps.length = 0;
    instances.clear();
    for (const key of cache.keys()) if (!key.endsWith('/demoEmulatorMode.ts')) cache.delete(key);
  };
  return { env, calls, load, context, recreate };
}
const bases = ['apps/web/firebase', 'packages/shared/firebase'];
const initializers = bases.flatMap((base) =>
  ['firebase', 'firebaseAdmin', 'auth', 'firestore', 'storage', 'database', 'functions'].map(
    (name) => `${base}/${name}.ts`
  )
);
function rejectsBeforeSdk(overrides, options) {
  for (const path of initializers) {
    const f = fixture(overrides, options);
    assert.throws(() => f.load(path), /Firebase|Temporal/, path);
    assert.equal(f.calls.length, 0, `Invalid config loaded SDK or initialized at ${path}`);
  }
}
test('demo inventory matches the actual dedicated Firebase config, and production connects all services', () => {
  const actual = JSON.parse(readFileSync(resolve(root, 'firebase.test.json'), 'utf8')).emulators;
  for (const service of ['auth', 'firestore', 'database', 'storage', 'functions'])
    assert.equal(config[`NEXT_PUBLIC_FIREBASE_${service.toUpperCase()}_EMULATOR_PORT`], String(actual[service].port));
  for (const base of bases) {
    const f = fixture();
    for (const service of ['auth', 'firestore', 'storage', 'database', 'functions']) f.load(`${base}/${service}.ts`);
    const connections = f.calls.filter((c) => String(c.name).startsWith('connect'));
    assert.equal(connections.length, 6);
    for (const service of ['auth', 'firestore', 'database', 'storage', 'functions']) {
      const name = `connect${service[0].toUpperCase()}${service.slice(1)}Emulator`;
      const found = connections.filter((c) => c.name === name);
      assert.equal(found.length, service === 'storage' ? 2 : 1);
      for (const call of found)
        assert.deepEqual(
          call.args.slice(1),
          service === 'auth' ? [`http://127.0.0.1:${actual[service].port}`] : ['127.0.0.1', actual[service].port]
        );
    }
    assert.equal(
      f.calls.find((c) => c.name === 'initializeApp').args[0].databaseURL,
      config.NEXT_PUBLIC_FIREBASE_DATABASE_URL
    );
    assert.equal(f.load(`${base}/firebase.ts`).isDevelopment, false);
  }
});
test('every mandatory public field is required and rejects conflicting configuration before SDK loading', () => {
  for (const key of Object.keys(config).filter(
    (key) => key.startsWith('NEXT_PUBLIC_') && !key.endsWith('DEMO_EMULATORS')
  )) {
    rejectsBeforeSdk({ [key]: undefined });
    rejectsBeforeSdk({ [key]: 'wrong' });
  }
});
test('exact opt-in flag, project, endpoint and port policy rejects real or ambiguous targets before SDK loading', () => {
  for (const mode of ['development', 'test', undefined]) rejectsBeforeSdk({ NODE_ENV: mode });
  for (const flag of ['', 'false', '1', 'TRUE', ' true'])
    rejectsBeforeSdk({ NEXT_PUBLIC_FIREBASE_DEMO_EMULATORS: flag });
  for (const projectId of ['urm-app', 'urm-app-staging', 'demo-other', '', 'demo-temporal-ci '])
    rejectsBeforeSdk({ NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId });
  for (const url of [
    'https://production.firebaseio.com',
    'http://localhost:19000?ns=demo-temporal-ci',
    'http://127.0.0.1:19000?ns=urm-app',
    'http://user@127.0.0.1:19000?ns=demo-temporal-ci',
    config.NEXT_PUBLIC_FIREBASE_DATABASE_URL + '&extra=1',
  ])
    rejectsBeforeSdk({ NEXT_PUBLIC_FIREBASE_DATABASE_URL: url });
  for (const port of ['9099', '0', '65536', '09100', '9100 ', 'http://127.0.0.1:9100'])
    rejectsBeforeSdk({ NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT: port });
  rejectsBeforeSdk({ NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID: 'G-EXAMPLE' });
  rejectsBeforeSdk({ NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: 'foreign' });
  rejectsBeforeSdk({ __FIREBASE_DEFAULTS__: '{"emulatorHosts":{"auth":"remote:9100"}}' });
  rejectsBeforeSdk({}, { browser: true, cookie: '__FIREBASE_DEFAULTS__=encoded' });
  rejectsBeforeSdk({}, { defaults: { emulatorHosts: { auth: 'example.com:9100' } } });
});
test('server aliases, every Admin host, inline config and Temporal binding reject before SDK loading or file reads', () => {
  for (const key of [
    'FIREBASE_PROJECT_ID',
    'GCLOUD_PROJECT',
    'GOOGLE_CLOUD_PROJECT',
    'FIREBASE_STORAGE_BUCKET',
    'FIREBASE_IMAGES_BUCKET',
    'FIREBASE_DATABASE_URL',
    'FIREBASE_FUNCTIONS_REGION',
  ])
    rejectsBeforeSdk({ [key]: 'urm-app' });
  for (const key of [
    'FIREBASE_AUTH_EMULATOR_HOST',
    'FIRESTORE_EMULATOR_HOST',
    'FIREBASE_DATABASE_EMULATOR_HOST',
    'FIREBASE_STORAGE_EMULATOR_HOST',
  ]) {
    rejectsBeforeSdk({ [key]: undefined });
    rejectsBeforeSdk({ [key]: 'remote.example:9100' });
    rejectsBeforeSdk({ [key]: 'http://' + config[key] });
  }
  for (const value of [
    '/credential/file.json',
    '{bad',
    'null',
    '[]',
    '{"projectId":"urm-app"}',
    '{"databaseURL":"https://live.example"}',
    '{"unexpected":true}',
  ])
    rejectsBeforeSdk({ FIREBASE_CONFIG: value });
  for (const host of [
    'https://storage.googleapis.com',
    'http://localhost:19199',
    'http://127.0.0.1:9199',
    '127.0.0.1:19199',
  ])
    rejectsBeforeSdk({ STORAGE_EMULATOR_HOST: host });
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'METADATA_SERVER_DETECTION', 'GCE_METADATA_HOST']) {
    rejectsBeforeSdk({ [key]: undefined });
    rejectsBeforeSdk({ [key]: 'foreign' });
  }
  rejectsBeforeSdk({ TEMPORAL_CONNECTION_MODE: 'temporal-cloud' });
});
test('orphaned connection markers and cached Firestore reject before SDK loading', () => {
  for (const key of ['AUTH_EMULATOR_STARTED', 'DATABASE_EMULATOR_STARTED', 'FIRESTORE_EMULATOR_STARTED'])
    for (const value of ['true', 'false', '']) rejectsBeforeSdk({ [key]: value });
  for (const globals of [
    { __URM_FIRESTORE__: {} },
    { __URM_FIRESTORE_EMULATOR_CONNECTED__: true },
    { __URM_FIRESTORE_EMULATOR_CONNECTED__: false },
  ])
    rejectsBeforeSdk({}, { globals });
  const f = fixture();
  f.load('apps/web/firebase/auth.ts');
  f.load('packages/shared/firebase/auth.ts');
  assert.equal(f.calls.filter((c) => c.name === 'connectAuthEmulator').length, 1);
});
test('shared/web wrappers connect actual shared service instances once and recreated instances despite stale booleans', () => {
  const f = fixture({}, { browser: true });
  for (const base of bases)
    for (const name of ['auth', 'firestore', 'storage', 'database', 'functions']) f.load(`${base}/${name}.ts`);
  assert.equal(f.calls.filter((c) => String(c.name).startsWith('connect')).length, 6);
  f.recreate();
  f.env.AUTH_EMULATOR_STARTED = 'true';
  f.env.DATABASE_EMULATOR_STARTED = 'true';
  f.env.FIRESTORE_EMULATOR_STARTED = 'true';
  delete f.context.__URM_FIRESTORE__;
  f.context.__URM_FIRESTORE_EMULATOR_CONNECTED__ = true;
  for (const base of bases)
    for (const name of ['auth', 'firestore', 'storage', 'database', 'functions']) f.load(`${base}/${name}.ts`);
  assert.equal(f.calls.filter((c) => String(c.name).startsWith('connect')).length, 12);
});
test('unknown cached Firestore and wrong actual Auth emulator bindings cannot be reused', () => {
  const f = fixture({}, { browser: true });
  f.load('packages/shared/firebase/demoEmulatorMode.ts');
  f.context.__URM_FIRESTORE__ = { app: { options: { ...expectedOptions, projectId: 'urm-app' } } };
  f.context.__URM_FIRESTORE_EMULATOR_CONNECTED__ = true;
  assert.throws(() => f.load('apps/web/firebase/firestore.ts'), /Existing Firebase app conflicts/);
  const helper = f.load('packages/shared/firebase/demoEmulatorMode.ts');
  for (const emulatorConfig of [
    undefined,
    { host: 'example.com', port: 9100, protocol: 'http' },
    { host: '127.0.0.1', port: 9099, protocol: 'http' },
    { host: '127.0.0.1', port: 9100, protocol: 'https' },
  ])
    assert.throws(
      () =>
        helper.connectDemoFirebaseEmulator('auth', { app: { options: expectedOptions }, emulatorConfig }, () =>
          assert.fail('must not connect')
        ),
      /Auth emulator connection conflicts/
    );
  let adopted = 0;
  helper.connectDemoFirebaseEmulator(
    'auth',
    { app: { options: expectedOptions }, emulatorConfig: { host: '127.0.0.1', port: 9100, protocol: 'http' } },
    () => adopted++
  );
  assert.equal(adopted, 0);
});
test('browser origin is an exact allowlist for media and the same-artifact cold-navigation port', () => {
  for (const origin of ['http://127.0.0.1:3004', 'http://127.0.0.1:3002']) {
    const f = fixture({}, { browser: true, origin });
    f.load('apps/web/firebase/auth.ts');
    assert.equal(f.calls.filter((c) => c.name === 'connectAuthEmulator').length, 1);
    assert.ok('popupRedirectResolver' in f.calls.find((c) => c.name === 'initializeAuth').args[1]);
  }
  for (const origin of [
    'https://example.com',
    'http://localhost:3004',
    'http://127.0.0.1:3003',
    'https://127.0.0.1:3004',
  ])
    rejectsBeforeSdk({}, { browser: true, origin });
  const server = fixture();
  server.load('apps/web/firebase/auth.ts');
  assert.equal('popupRedirectResolver' in server.calls.find((c) => c.name === 'initializeAuth').args[1], false);
});
test('actual selected existing client and Admin apps must have exact demo binding', () => {
  for (const base of bases) {
    for (const kind of ['firebase', 'firebaseAdmin']) {
      for (const key of kind === 'firebase'
        ? Object.keys(expectedOptions)
        : ['projectId', 'storageBucket', 'databaseURL']) {
        const f = fixture({}, { existing: { ...expectedOptions, [key]: 'foreign' } });
        assert.throws(() => f.load(`${base}/${kind}.ts`), /Existing Firebase app conflicts/);
        assert.equal(
          f.calls.some((c) => c.name === 'initializeApp'),
          false
        );
      }
      const f = fixture({}, { existing: expectedOptions });
      f.load(`${base}/${kind}.ts`);
      assert.equal(
        f.calls.some((c) => c.name === 'initializeApp'),
        false
      );
    }
  }
});
test('source Admin wrappers initialize configured demo options without directly reading credential files', () => {
  for (const base of bases) {
    const f = fixture({
      STORAGE_EMULATOR_HOST: 'http://127.0.0.1:19199',
      FIREBASE_CONFIG: JSON.stringify({
        projectId: project,
        storageBucket: expectedOptions.storageBucket,
        databaseURL: expectedOptions.databaseURL,
      }),
    });
    f.load(`${base}/firebaseAdmin.ts`);
    const options = f.calls.find((c) => c.name === 'initializeApp').args[0];
    assert.equal(options.projectId, project);
    assert.equal(options.databaseURL, expectedOptions.databaseURL);
    assert.equal(options.storageBucket, expectedOptions.storageBucket);
  }
});
test('flag-absent production keeps real project config and does not connect any emulator', () => {
  for (const base of bases) {
    const f = fixture({
      NEXT_PUBLIC_FIREBASE_DEMO_EMULATORS: undefined,
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'urm-app',
      NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT: 'invalid',
      NEXT_PUBLIC_FIREBASE_DATABASE_URL: 'https://urm-app-default-rtdb.firebaseio.com/',
      FIREBASE_AUTH_EMULATOR_HOST: undefined,
    });
    for (const service of ['auth', 'firestore', 'storage', 'database', 'functions']) f.load(`${base}/${service}.ts`);
    assert.equal(
      f.calls.some((c) => String(c.name).startsWith('connect')),
      false
    );
    assert.equal(f.calls.find((c) => c.name === 'initializeApp').args[0].projectId, 'urm-app');
  }
});
test('BundleManager uses the verified explicit demo branch while production at127.0.0.1 would otherwise use real URLs', () => {
  const f = fixture({}, { browser: true });
  // Source is the actual complete module; dependencies are service modules plus type-only configs.
  const { BundleManager } = f.load('apps/web/utils/bundleManager.ts');
  f.context.localStorage = {
    getItem() {
      return null;
    },
  };
  const manager = BundleManager.getInstance({
    bundleType: 'test',
    functionName: 'createlatestlistbundle',
    cacheKeyPrefix: 'test',
    displayName: 'test',
  });
  assert.equal(manager.getBundleUrl(), 'http://127.0.0.1:5001/demo-temporal-ci/us-central1/createlatestlistbundle');
});

test('complete helper typechecks with real Node declarations and the server ES2022 library without DOM', () => {
  const helper = resolve(root, 'packages/shared/firebase/demoEmulatorMode.ts');
  const nodeTypes = dirname(dirname(require.resolve('@types/node/package.json')));
  const serverConfig = JSON.parse(readFileSync(resolve(root, 'apps/process-audio/tsconfig.json'), 'utf8'));
  assert.deepEqual(serverConfig.compilerOptions.lib, ['ES2022']);
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    lib: ['lib.es2022.d.ts'],
    types: ['node'],
    typeRoots: [nodeTypes],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    noImplicitReturns: true,
    noUnusedLocals: true,
  };
  const compile = (extraSource = '') => {
    const host = ts.createCompilerHost(options);
    const original = host.readFile;
    host.readFile = (file) => {
      const source = original(file);
      return file === helper && source !== undefined ? source + extraSource : source;
    };
    host.writeFile = () => assert.fail('No-emit typecheck must not write generated output');
    const program = ts.createProgram([helper], options, host);
    assert.equal(
      program.getSourceFiles().some((file) => /lib\.dom(?:\.iterable)?\.d\.ts$/.test(file.fileName)),
      false
    );
    assert.ok(program.getSourceFiles().some((file) => file.fileName.includes('/@types/node/')));
    program.emit();
    return ts.getPreEmitDiagnostics(program);
  };
  assert.deepEqual(
    compile().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    []
  );
  // This control proves the same compiler would catch the exact accidental DOM dependency.
  const control = compile('\nexport const forbiddenBrowserGlobals = window.location.origin + document.cookie;\n');
  for (const name of ['window', 'document'])
    assert.ok(
      control.some(
        (diagnostic) =>
          [2304, 2584].includes(diagnostic.code) &&
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').includes(`'${name}'`)
      )
    );
});
