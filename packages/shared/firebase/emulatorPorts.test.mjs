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
function fixture(environment = {}, development = true) {
  const env = { NODE_ENV: development ? 'development' : 'production', ...environment },
    calls = [];
  const app = { options: { projectId: 'demo-urm' } };
  const config = {
    getFirebaseProjectId: () => 'demo-urm',
    getFirebaseAuthDomain: () => 'demo-urm.firebaseapp.com',
    getFirebaseStorageBucket: () => 'demo-urm.appspot.com',
    getFirebaseImagesBucket: () => 'demo-urm-images',
    getFirebaseDatabaseUrl: () => 'https://real-database.example',
    getFirebaseFunctionsRegion: () => 'us-central1',
  };
  let ports;
  function load(path) {
    const module = { exports: {} };
    const sdk = new Proxy(
      {},
      {
        get:
          (_, key) =>
          (...args) => {
            calls.push({ name: key, args });
            if (key === 'getApps') return [];
            if (key === 'initializeApp' || key === 'getApp') return app;
            return {};
          },
      }
    );
    const localRequire = (name) => {
      if (name.endsWith('/emulatorPorts') || name === './emulatorPorts') return ports;
      if (name === './firebase') return { __esModule: true, default: app, isDevelopment: development };
      if (name.includes('firebaseProjectConfig')) return config;
      if (name === './firebaseAdminOwnership') return { recordSharedFirebaseAppCreation() {} };
      if (name.startsWith('firebase/') || name.startsWith('firebase-admin/')) return sdk;
      if (name === 'node:fs')
        return {
          readFileSync() {
            throw new Error('Unexpected file read');
          },
        };
      throw new Error('Unexpected dependency: ' + name);
    };
    const code = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(code, {
      module,
      exports: module.exports,
      require: localRequire,
      process: { env },
      console: { log() {}, warn() {} },
    });
    return module.exports;
  }
  ports = load('packages/shared/firebase/emulatorPorts.ts');
  return { env, calls, load, ports };
}
const services = { auth: 9099, firestore: 8081, database: 9000, storage: 9199, functions: 5001 };
const testEmulators = JSON.parse(readFileSync(resolve(root, 'firebase.test.json'), 'utf8')).emulators;
const dedicated = Object.fromEntries(Object.keys(services).map((service) => [service, testEmulators[service].port]));
const publicEnv = Object.fromEntries(
  Object.entries(dedicated).map(([key, value]) => [
    `NEXT_PUBLIC_FIREBASE_${key.toUpperCase()}_EMULATOR_PORT`,
    String(value),
  ])
);
test('ordinary dev defaults and dedicated test overrides resolve exact ports', () => {
  for (const [service, port] of Object.entries(services))
    assert.equal(fixture().ports.getFirebaseEmulatorPort(service), port);
  for (const [service, port] of Object.entries(dedicated))
    assert.equal(fixture(publicEnv).ports.getFirebaseEmulatorPort(service), port);
});
for (const value of ['', '0', '65536', '-1', '1.5', '1e3', ' 9100', '9100 ', 'localhost:9100', 'NaN']) {
  test(`invalid explicit emulator port ${JSON.stringify(value)} rejects`, () => {
    const f = fixture({ NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT: value });
    assert.throws(() => f.ports.getFirebaseEmulatorPort('auth'), /Invalid NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT/);
  });
}
test('valid boundary ports are accepted', () => {
  for (const value of ['1', '65535'])
    assert.equal(
      fixture({ NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT: value }).ports.getFirebaseEmulatorPort('auth'),
      Number(value)
    );
});
for (const base of ['apps/web/firebase', 'packages/shared/firebase']) {
  test(`${base}: actual client modules connect each dedicated loopback endpoint`, () => {
    const f = fixture(publicEnv);
    for (const service of Object.keys(services)) f.load(`${base}/${service}.ts`);
    const connections = f.calls.filter((call) => String(call.name).startsWith('connect'));
    assert.equal(connections.length, 6); // Default and image Storage instances both connect.
    for (const [service, port] of Object.entries(dedicated)) {
      const name = `connect${service[0].toUpperCase()}${service.slice(1)}Emulator`;
      const matches = connections.filter((call) => call.name === name);
      assert.equal(matches.length, service === 'storage' ? 2 : 1);
      for (const call of matches)
        assert.deepEqual(call.args.slice(1), service === 'auth' ? [`http://127.0.0.1:${port}`] : ['127.0.0.1', port]);
    }
  });
  test(`${base}: actual Firebase init RTDB URL agrees with configured database endpoint`, () => {
    const f = fixture(publicEnv);
    f.load(`${base}/firebase.ts`);
    assert.equal(
      f.calls.find((c) => c.name === 'initializeApp').args[0].databaseURL,
      'http://127.0.0.1:19000/?ns=demo-urm-default-rtdb'
    );
  });
  test(`${base}: Admin preserves emulator exec endpoints and supplies configured dev default only when absent`, () => {
    const f = fixture({
      ...publicEnv,
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9100',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:18081',
    });
    f.load(`${base}/firebaseAdmin.ts`);
    assert.equal(f.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9100');
    assert.equal(f.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:18081');
    const defaults = fixture(publicEnv);
    defaults.load(`${base}/firebaseAdmin.ts`);
    assert.equal(defaults.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9100');
  });
  test(`${base}: production ignores emulator port overrides and preserves real database config`, () => {
    const f = fixture({ NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT: 'invalid' }, false);
    for (const service of Object.keys(services)) f.load(`${base}/${service}.ts`);
    f.load(`${base}/firebase.ts`);
    f.load(`${base}/firebaseAdmin.ts`);
    assert.equal(f.calls.filter((call) => String(call.name).startsWith('connect')).length, 0);
    assert.equal(
      f.calls
        .filter((c) => c.name === 'initializeApp')
        .every((c) => c.args[0].databaseURL === 'https://real-database.example'),
      true
    );
    assert.equal(f.env.FIREBASE_AUTH_EMULATOR_HOST, undefined);
  });
}
