// Executes the actual controller with in-memory SDK/API boundaries, never credentials/network.
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import * as url from 'node:url';
import * as continuity from '../../temporal-provider-usage-continuity.mjs';
import { createReleaseFirebaseResources, runWithCleanup } from '../../temporal-release-resources.mjs';
const scenario = process.argv[2];
const events = [],
  apps = [];
const projectId = 'urm-app-staging',
  databaseURL = 'https://urm-app-staging-default-rtdb.firebaseio.com';
const config = {
  projectId,
  databaseUrl: databaseURL,
  environment: 'staging',
  mode: 'durable-upgrade',
  domains: ['media'],
  releaseId: 'a801c079-a832-4bfa-a526-ec385e49d27f',
  compatibilityCommit: 'a'.repeat(40),
  uiCommit: 'b'.repeat(40),
  location: 'us-central1',
  backendId: 'web-staging',
};
const records = new Map([
  [
    '_control/temporalRelease',
    {
      schemaVersion: 1,
      releaseId: config.releaseId,
      revision: 7,
      admission: 'open',
      domains: { media: { owner: 'temporal', admission: 'open' } },
    },
  ],
  ['_control/temporalReleaseState', { ...config, controlRevision: 7, phase: 'backend-ready' }],
]);
let socket,
  transactions = 0;
const snap = (key) => ({ exists: records.has(key), data: () => structuredClone(records.get(key)) });
const firestore = {
  doc: (key) => ({
    path: key,
    get: async () => {
      if (scenario.startsWith('action-failure')) throw new Error('ORIGINAL_ACTION_FAILURE');
      return snap(key);
    },
  }),
  runTransaction: async (callback) => {
    transactions++;
    if (scenario === 'claim-failure' && transactions === 1) throw new Error('ORIGINAL_CLAIM_FAILURE');
    const writes = [];
    const result = await callback({
      get: async (ref) => {
        if (
          scenario.includes('lock-failure') &&
          records.has('_control/temporalReleaseOperation') &&
          ((scenario.startsWith('action-failure') && transactions === 2) || transactions === 3)
        )
          throw new Error('LOCK_CLEANUP_FAILURE');
        return snap(ref.path);
      },
      create: (ref, data) => writes.push(() => records.set(ref.path, structuredClone(data))),
      update: (ref, data) =>
        writes.push(() => records.set(ref.path, { ...records.get(ref.path), ...structuredClone(data) })),
      delete: (ref) =>
        writes.push(() => {
          events.push('lock-delete');
          records.delete(ref.path);
        }),
    });
    writes.forEach((write) => write());
    return result;
  },
  terminate: async () => {
    events.push('firestore-terminate');
  },
};
const fixtureCredential = {};
const sdk = {
  getApps: () => apps,
  applicationDefault: () => {
    events.push('credential');
    return fixtureCredential;
  },
  initializeApp: (options, name) => {
    const app = { options, name };
    apps.push(app);
    events.push('initialize');
    return app;
  },
  getFirestore: () => {
    events.push('firestore');
    return firestore;
  },
  getDatabase: () => {
    events.push('database');
    socket = setInterval(() => {}, 1000);
    return {
      goOffline: async () => {
        events.push('database-offline');
        clearInterval(socket);
        if (scenario === 'sdk-failure' || scenario === 'action-failure-sdk-failure')
          throw new Error('SDK_OFFLINE_FAILURE');
      },
    };
  },
  deleteApp: async (app) => {
    events.push('app-delete');
    apps.splice(apps.indexOf(app), 1);
  },
  serverTimestamp: () => 'mock-server-timestamp',
};
const sourceUrl = new URL('../../temporal-release.mjs', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const bindings = new Map();
for (const [, names, id] of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g))
  bindings.set(id, [
    ...new Set([
      ...(bindings.get(id) ?? []),
      ...names
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    ]),
  ]);

const fakeProcess = {
  argv: ['node', sourceUrl.pathname, 'pause', '--release', '/fixture/release.json', '--apply'],
  env: {},
  exitCode: scenario === 'existing-nonzero' ? 9 : undefined,
  exit: () => {
    throw new Error('UNEXPECTED_PROCESS_EXIT');
  },
};
const context = createContext({
  process: fakeProcess,
  console: { log: () => events.push('checkpoint-output'), error: () => events.push('secondary-error') },
  URL,
  Buffer,
  AbortSignal,
  structuredClone,
  setTimeout,
  clearTimeout,
  fetch: () => {
    throw new Error('UNEXPECTED_NETWORK');
  },
});
const imports = {
  './temporal-provider-usage-continuity.mjs': continuity,
  'node:fs/promises': {
    readFile: async () => JSON.stringify(config),
    writeFile: async () => {},
    mkdtemp: () => {
      throw new Error('UNEXPECTED_TEMP');
    },
    rm: async () => {},
  },
  'node:os': os,
  'node:path': path,
  'node:url': url,
  'node:crypto': crypto,
  'node:child_process': {
    execFileSync: () => {
      throw new Error('UNEXPECTED_COMMAND');
    },
  },
  './temporal-release-resources.mjs': { runWithCleanup },
  './temporal-release-runtime.mjs': {
    pinReleaseCheckouts: () => ({
      operatorRoot: '/fixture',
      runtimeRoot: '/fixture',
      operatorCommit: config.compatibilityCommit,
      runtimeCommit: config.compatibilityCommit,
      operatorClosureDigest: 'fixture',
      runtimePins: {},
    }),
    loadReleaseResourceBinding: () => ({ resources: { databaseUrl: databaseURL } }),
    verifyReleaseResourceIdentity: async () => ({ projectId }),
    verifyReleaseOperator: async () => ({ email: 'fixture@example.test' }),
    prepareLocalReleaseADC: () => ({
      credential: fixtureCredential,
      close: () => {},
      adcType: 'authorized_user',
      sdkCredentialImplementationSHA256: 'fixture',
    }),
    assertReleaseRuntimeSource: async () => {},
    hash: () => 'fixture-hash',
    proofDigest: (value) => JSON.stringify(value),
    nativeSnapshotProof: (snapshot) => ({ data: snapshot.data() }),
    assertNativeSnapshot: () => {},
  },
  './temporal-release-lib.mjs': {
    validateReleaseConfig: (value) => value,
    validateControl: (value) => value,
    CONTROL_PATH: '_control/temporalRelease',
    firebaseAdmin: () => createReleaseFirebaseResources(projectId, databaseURL, sdk),
    RELEASE_DOMAINS: ['media'],
  },
  './temporal-compatibility-cutoff.mjs': { hasCompatibilitySettlingCheckpoint: () => false },
  './temporal-bootstrap-search.mjs': { requiresSearchBootstrap: () => false },
};
const module = new SourceTextModule(source, {
  context,
  identifier: sourceUrl.href,
  initializeImportMeta: (meta) => {
    meta.url = sourceUrl.href;
  },
  importModuleDynamically: () => {
    throw new Error('UNEXPECTED_DYNAMIC_IMPORT');
  },
});
await module.link((id) => {
  const values = imports[id] ?? {};
  const names = bindings.get(id);
  return new SyntheticModule(
    names,
    function () {
      for (const name of names)
        this.setExport(
          name,
          values[name] ??
            (() => {
              throw new Error(`UNEXPECTED_BOUNDARY_${id}_${name}`);
            })
        );
    },
    { context }
  );
});
let failure;
try {
  await module.evaluate();
} catch (error) {
  failure = error.message;
}
console.log(
  JSON.stringify({
    scenario,
    events,
    failure,
    lockAbsent: !records.has('_control/temporalReleaseOperation'),
    remainingApps: apps.length,
    phase: records.get('_control/temporalReleaseState').phase,
  })
);
process.exitCode = failure ? 7 : fakeProcess.exitCode;
