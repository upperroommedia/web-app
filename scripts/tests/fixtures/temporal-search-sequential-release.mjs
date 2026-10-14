// Executes the actual sequential controller with real local modules/validators.
// Only SDK, filesystem, REST and child-process transports are in memory.
import assert from 'node:assert/strict';
import { SourceTextModule, SyntheticModule, createContext, runInContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as moduleApi from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as urlApi from 'node:url';
import { PROVIDER_USAGE_SCAN_GROUPS } from '../../temporal-backfill-provider-usage.mjs';
const root = urlApi.fileURLToPath(new URL('../../../', import.meta.url));
const require = moduleApi.createRequire(new URL('../../../package.json', import.meta.url));
require('ts-node').register({ project: path.join(root, 'functions/tsconfig.json'), transpileOnly: true });
require('tsconfig-paths').register({
  baseUrl: path.join(root, 'functions'),
  paths: {
    '@upperroom/contracts/*': ['../packages/contracts/*'],
    '@upperroom/shared/*': ['../packages/shared/*'],
    '@upperroom/orchestration/*': ['../packages/orchestration/src/*'],
  },
});
const { Timestamp } = require('firebase-admin/firestore');
const { createDurableJobStore } = require(path.join(root, 'packages/orchestration/src/job-store.ts'));
const projectId = 'urm-app-staging',
  oldReleaseId = 'a801c079-a832-4bfa-a526-ec385e49d27f';
const releaseId = 'f6ea4660-779e-4162-947c-5376238cdf9a';
const domains = ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'];
let clock = Date.parse('2026-10-15T12:00:00Z');
const native = (ms) => Timestamp.fromMillis(ms);
const oldCutoff = native(clock - 86400000),
  markerTime = native(clock - 7200000);
const clone = (value) =>
  value instanceof Timestamp
    ? new Timestamp(value.seconds, value.nanoseconds)
    : Array.isArray(value)
    ? Array.from(value, clone)
    : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]))
    : value;
const stable = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]])
        )
      : v
  );
const sha = (value) => crypto.createHash('sha256').update(stable(value)).digest('hex');
const config = {
  environment: 'staging',
  mode: 'initial-cutover',
  legacyExecutionGraceSeconds: 3600,
  providerUsageBackfillTimeoutMs: 1800000,
  projectId,
  backendId: 'web-staging',
  location: 'us-central1',
  releaseId,
  compatibilityCommit: 'a'.repeat(40),
  uiCommit: 'b'.repeat(40),
  domains: ['search'],
  platformConfig: '/fixture/platform.json',
  platformPeerConfig: '/fixture/peer.json',
  databaseUrl: `https://${projectId}-default-rtdb.firebaseio.com`,
  mailCollection: 'mail',
  legacyQueues: ['processaudiofiletask', 'processaudioyoutubetask'],
  additionalLegacyQueues: [],
  compatibilityEvidence: '/fixture/compat.json',
  backendEvidence: '/fixture/backend.json',
  smokeEvidence: '/fixture/smoke.json',
  searchSettingsEvidence: '/fixture/settings.json',
};
const platform = {
  firebaseProjectId: projectId,
  workerBuildId: config.compatibilityCommit,
  workerRoles: ['orchestration', 'controls', 'media', 'email', 'images', 'search'],
  workerReplicas: 1,
  context: 'fixture-context',
  namespace: 'temporal-staging',
  connectionMode: 'temporal-cloud',
  cloudAccountId: 'qwejt',
  cloudProvider: 'gcp',
  cloudRegion: 'us-central1',
  temporalNamespace: `${projectId}.qwejt`,
  cloudAddress: `${projectId}.qwejt.tmprl.cloud:7233`,
};
const priorControl = {
  schemaVersion: 1,
  revision: 20,
  releaseId: oldReleaseId,
  admission: 'open',
  legacyAdmissionCutoff: oldCutoff,
  domains: Object.fromEntries(
    domains.map((d) => [
      d,
      { owner: d === 'search' ? 'legacy' : 'temporal', admission: d === 'search' ? 'paused' : 'open' },
    ])
  ),
};
const marker = {
  schemaVersion: 1,
  projectId,
  status: 'ready',
  releaseId: oldReleaseId,
  controlRevision: 5,
  epoch: '99ef4e7e-fadf-4830-b631-68a82a20d82d',
  groups: PROVIDER_USAGE_SCAN_GROUPS,
  groupIndex: PROVIDER_USAGE_SCAN_GROUPS.length,
  cursor: null,
  documentCount: 12,
  edgeCount: 8,
  completedAtMillis: clock - 7200000,
};
const priorState = {
  releaseId: oldReleaseId,
  mode: 'initial-cutover',
  domains: domains.slice(0, 6),
  phase: 'complete',
  controlRevision: 20,
  compatibilityCommit: 'c'.repeat(40),
  uiCommit: 'd'.repeat(40),
  maximumLegacyExecutionSeconds: 540,
  legacySettlingGraceSeconds: 3600,
  legacySettlingCutoff: oldCutoff,
  compatibilityVerifiedAt: oldCutoff,
  providerUsageEpoch: marker.epoch,
  providerUsageBackfillRevision: 5,
  providerUsageVerifiedAt: clock - 7200000,
};
const records = new Map([
  ['_control/temporalRelease', clone(priorControl)],
  ['_control/temporalReleaseState', clone(priorState)],
  ['_control/temporalProviderUsage', clone(marker)],
]);
const versions = new Map([['_control/temporalProviderUsage', { createTime: markerTime, updateTime: markerTime }]]);
const files = new Map([
  ['/fixture/release.json', JSON.stringify(config)],
  ['/fixture/platform.json', JSON.stringify(platform)],
]);
const actions = [],
  commands = [],
  apps = [],
  apiEvents = [];
let currentModules, readinessProof, beforeTransaction;
const rejectedBoundaries = [];
let sdkClone = clone;
const lookup = (value, field) => field.split('.').reduce((a, k) => a?.[k], value);
const snapshot = (key, values = records) => ({
  id: key.split('/').at(-1),
  ref: doc(key),
  exists: values.has(key),
  data: () => sdkClone(values.get(key)),
  get: (field) => sdkClone(lookup(values.get(key), field)),
  readTime: native(clock),
  createTime: versions.get(key)?.createTime ?? markerTime,
  updateTime: versions.get(key)?.updateTime ?? markerTime,
});
function doc(key) {
  return { path: key, id: key.split('/').at(-1), get: async () => snapshot(key) };
}
function query(collection, filters = [], limit = Infinity, cursor) {
  return {
    collection,
    filters,
    limitValue: limit,
    cursor,
    where: (field, op, value) => query(collection, [...filters, { field, op, value }], limit, cursor),
    limit: (value) => query(collection, filters, value, cursor),
    orderBy: () => query(collection, filters, limit, cursor),
    select: () => query(collection, filters, limit, cursor),
    startAfter: (value) => query(collection, filters, limit, value),
    get: async () => querySnapshot({ collection, filters, limitValue: limit, cursor }),
    count: () => ({
      get: async () => ({
        data: () => ({ count: querySnapshot({ collection, filters, limitValue: limit, cursor }).size }),
      }),
    }),
  };
}
function querySnapshot(q, values = records) {
  const rows = [...values]
    .filter(
      ([key, value]) =>
        key.startsWith(q.collection + '/') &&
        key.split('/').length === q.collection.split('/').length + 1 &&
        q.filters.every(({ field, op, value: expected }) => {
          const actual = lookup(value, field);
          if (op === '==') return actual === expected;
          if (op === 'in') return expected.includes(actual);
          if (op === 'not-in') return actual !== undefined && !expected.includes(actual);
          throw new Error('UNEXPECTED_QUERY_OPERATOR_' + op);
        })
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([key]) => !q.cursor || key > (q.cursor.ref?.path ?? q.cursor.path ?? q.cursor))
    .slice(0, q.limitValue);
  return { size: rows.length, empty: rows.length === 0, docs: rows.map(([key]) => snapshot(key, values)) };
}
const resolveTransforms = (value) =>
  value === '__SERVER_TIMESTAMP__'
    ? native(clock)
    : value instanceof Timestamp
    ? clone(value)
    : Array.isArray(value)
    ? Array.from(value, resolveTransforms)
    : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTransforms(v)]))
    : value;
const firestore = {
  doc,
  collection: (name) => ({ ...query(name), doc: (id) => doc(name + '/' + id) }),
  runTransaction: async (callback) => {
    beforeTransaction?.();
    const values = new Map([...records].map(([key, value]) => [key, clone(value)])),
      writes = [];
    let wrote = false;
    const tx = {
      get: async (ref) => {
        assert.equal(wrote, false, 'all reads precede transaction writes');
        return ref.collection ? querySnapshot(ref, values) : snapshot(ref.path, values);
      },
      create: (ref, value) => {
        assert(!values.has(ref.path));
        wrote = true;
        writes.push(['set', ref.path, value]);
      },
      set: (ref, value) => {
        wrote = true;
        writes.push(['set', ref.path, value]);
      },
      update: (ref, value) => {
        assert(values.has(ref.path));
        wrote = true;
        writes.push(['set', ref.path, { ...values.get(ref.path), ...value }]);
      },
      delete: (ref) => {
        wrote = true;
        writes.push(['delete', ref.path]);
      },
    };
    const result = await callback(tx);
    for (const [operation, key, value] of writes) {
      if (operation === 'delete') {
        records.delete(key);
        versions.delete(key);
      } else {
        records.set(key, resolveTransforms(value));
        versions.set(key, { createTime: versions.get(key)?.createTime ?? native(clock), updateTime: native(clock) });
      }
    }
    return result;
  },
  terminate: async () => {},
};
const sdk = {
  getApps: () => apps,
  applicationDefault: () => ({}),
  initializeApp: (options, name) => {
    const app = { options, name };
    apps.push(app);
    return app;
  },
  deleteApp: async (app) => apps.splice(apps.indexOf(app), 1),
  getFirestore: () => firestore,
  getDatabase: () => ({ ref: () => ({ get: async () => ({ val: () => null }) }), goOffline: async () => {} }),
  FieldValue: { serverTimestamp: () => '__SERVER_TIMESTAMP__' },
  Timestamp,
};
const parent = `projects/${projectId}/locations/us-central1/backends/web-staging`;
let traffic = {
  etag: 'fixture-etag',
  rolloutPolicy: { disabled: false, codebaseBranch: 'staging' },
  current: { splits: [{ build: parent + '/builds/previous', percent: 100 }] },
  reconciling: false,
};
const remote = new Map();
async function fetchTransport(raw, options = {}) {
  const parsed = new URL(raw),
    method = options.method ?? 'GET',
    body = options.body ? JSON.parse(options.body) : undefined;
  apiEvents.push({ method, path: parsed.pathname });
  let result,
    status = 200;
  if (parsed.hostname === 'firebaseapphosting.googleapis.com') {
    const resource = parsed.pathname.replace(/^\/v1beta\//, '');
    if (resource === parent + '/traffic') {
      if (method === 'PATCH') {
        traffic = { ...traffic, rolloutPolicy: { ...traffic.rolloutPolicy, ...body.rolloutPolicy } };
        result = { done: true };
      } else result = traffic;
    } else if (resource === parent + '/rollouts' && method === 'GET')
      result = { rollouts: [...remote.values()].filter((v) => v.name?.includes('/rollouts/')) };
    else if (resource === parent + '/builds' && method === 'POST') {
      const name = parent + '/builds/' + parsed.searchParams.get('buildId');
      remote.set(name, { name, state: 'READY', source: body.source });
      result = { done: true };
    } else if (resource === parent + '/rollouts' && method === 'POST') {
      const name = parent + '/rollouts/' + parsed.searchParams.get('rolloutId');
      remote.set(name, { name, build: body.build, state: 'SUCCEEDED', reconciling: false });
      traffic.current = { splits: [{ build: body.build, percent: 100 }] };
      result = { done: true };
    } else if (remote.has(resource)) result = remote.get(resource);
    else {
      status = 404;
      result = {};
    }
  } else if (parsed.hostname === 'cloudfunctions.googleapis.com') {
    const control = records.get('_control/temporalRelease');
    result = {
      functions: [
        {
          name: `projects/${projectId}/locations/us-central1/functions/kit-sermons-index-executeIndexOperation`,
          state: 'ACTIVE',
          environment: 'GEN_2',
          serviceConfig: {
            timeoutSeconds: 540,
            environmentVariables: {
              ...Object.fromEntries(
                domains.map((d) => ['TASK_ORCHESTRATOR_' + d.toUpperCase(), control.domains[d].owner])
              ),
              TEMPORAL_RELEASE_COMMIT: config.compatibilityCommit,
            },
          },
        },
      ],
    };
  } else if (parsed.hostname === 'cloudtasks.googleapis.com')
    result = parsed.pathname.endsWith('/tasks') ? { tasks: [] } : { queues: [] };
  else throw new Error('UNEXPECTED_NETWORK_' + raw);
  return { ok: status === 200, status, json: async () => clone(result) };
}
function bootstrapTransport(args) {
  const arg = (flag) => args[args.indexOf(flag) + 1];
  const options = {
    projectId: arg('--project'),
    releaseId: arg('--release-id'),
    commit: arg('--commit'),
    controlRevision: Number(arg('--control-revision')),
    operationId: arg('--operation-id'),
  };
  const bootstrap = currentModules.get(new URL('../../temporal-bootstrap-search.mjs', import.meta.url).href).namespace;
  const schema = currentModules.get(new URL('../../algolia-staging-search-schema.mjs', import.meta.url).href).namespace;
  const updates = schema.stagingSearchSettingsPlan({
    projectId,
    appId: '2VZFOFLFHE',
    indexNames: schema.STAGING_SEARCH_INSTANCES.map((i) => i.indexName),
  });
  const settings = {
    projectId,
    appId: '2VZFOFLFHE',
    mode: 'apply',
    usersPolicy: 'empty-private',
    updates,
    tasks: updates.map((p, i) => ({ indexName: p.indexName, taskID: i + 1, completed: true })),
    verifiedAt: new Date(clock).toISOString(),
  };
  files.set(config.searchSettingsEvidence, JSON.stringify(settings));
  bootstrap.validateSearchSettingsReceipt(settings, clock);
  const store = createDurableJobStore({ firestore, projectId });
  const proofs = schema.STAGING_SEARCH_INSTANCES.map((instance) => {
    const identity = bootstrap.searchBootstrapIdentity(options, instance.instanceId);
    const writes = [];
    const tx = {
      create: (ref, value) => {
        assert(!records.has(ref.path));
        writes.push([ref.path, value]);
      },
      set: (ref, value) => writes.push([ref.path, value]),
    };
    const job = store.createInTransaction(tx, {
      ...identity,
      kind: 'search.backfill',
      actorUid: 'system:search',
      generation: 1,
      createdAt: clock,
      dispatch: {
        ref: identity.ref,
        workflowId: `search:${projectId}:${identity.ref.jobId}`,
        workflowType: 'SearchBackfill',
        taskQueue: 'urm-search',
        startArgs: { ref: identity.ref },
      },
    });
    for (const [key, value] of writes) records.set(key, clone(value));
    records.set('durableJobs/' + job.jobId, { ...clone(job), state: 'succeeded', revision: 2, result: { count: 0 } });
    const outbox = records.get('durableJobOutbox/' + job.jobId);
    records.set('durableJobOutbox/' + job.jobId, { ...outbox, state: 'dispatched', acknowledgedAt: clock });
    const proof = {
      job: records.get('durableJobs/' + job.jobId),
      entity: records.get('durableJobEntities/' + bootstrap.searchBootstrapEntityKey(options, instance.instanceId)),
      intent: records.get('durableJobIntents/' + job.jobId),
    };
    assert.equal(bootstrap.validateSearchBootstrapProof(proof, options, instance.instanceId), true);
    return proof;
  });
  readinessProof = {
    schemaVersion: 1,
    result: 'passed',
    projectId,
    appId: '2VZFOFLFHE',
    releaseId,
    commit: config.compatibilityCommit,
    controlRevision: options.controlRevision,
    instanceIds: schema.STAGING_SEARCH_INSTANCES.map((i) => i.instanceId),
    jobIds: proofs.map((p) => p.job.jobId),
    generations: proofs.map((p) => p.job.generation),
    counts: proofs.map((p) => p.job.result.count),
    settingsReceiptCanonicalSha256: sha(settings),
    verifiedAt: new Date(clock).toISOString(),
  };
  return JSON.stringify(readinessProof);
}
function childTransport(command, args) {
  commands.push({ command, args: [...args] });
  if (command === 'gcloud') {
    assert.deepEqual([...args], ['auth', 'print-access-token']);
    return 'fixture-token';
  }
  if (command === 'kubectl') {
    assert(args.includes(platform.context));
    assert(args.some((arg) => arg.includes(platform.workerBuildId)));
    return JSON.stringify({
      items: platform.workerRoles.map((role) => ({
        metadata: { labels: { 'urm.temporal/role': role } },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
        spec: { containers: [{ name: 'worker', env: [{ name: 'TEMPORAL_DISPATCHER_ENABLED', value: 'true' }] }] },
      })),
    });
  }
  const script = path.basename(args[0] ?? '');
  if (script === 'temporal-backfill-provider-usage.mjs') throw new Error('UNEXPECTED_LEGACY_PROVIDER_BACKFILL');
  if (script === 'temporal-bootstrap-search.mjs') return bootstrapTransport(args);
  if (script === 'deploy-temporal-platform.mjs') {
    assert(['preflight', 'worker-status'].includes(args[1]));
    if (args[1] === 'worker-status')
      files.set(
        args[args.indexOf('--output') + 1],
        JSON.stringify({ projectId, buildId: platform.workerBuildId, current: true, allQueuesRegistered: true })
      );
    return '';
  }
  throw new Error('UNEXPECTED_COMMAND_' + command + '_' + script);
}
async function run(action) {
  const context = createContext({
    process: {
      argv: [
        'node',
        path.join(root, 'scripts/temporal-release.mjs'),
        action,
        '--release',
        '/fixture/release.json',
        '--apply',
      ],
      env: {},
      execPath: process.execPath,
    },
    console: { log: () => {}, error: () => {} },
    URL,
    Buffer,
    AbortSignal,
    structuredClone: clone,
    setTimeout,
    clearTimeout,
    fetch: fetchTransport,
    Date: class extends Date {
      static now() {
        return clock;
      }
    },
  });
  context.fixtureTimestamp = Timestamp;
  sdkClone = runInContext(
    `(function copy(value) { return value instanceof fixtureTimestamp ? value : Array.isArray(value) ? Array.from(value,copy) : value && typeof value==='object' ? Object.fromEntries(Object.entries(value).map(([key,child])=>[key,copy(child)])) : value; })`,
    context
  );
  const cache = new Map();
  currentModules = cache;
  const read = async (file, encoding) => {
    const key = file instanceof URL ? urlApi.fileURLToPath(file) : String(file);
    if (files.has(key)) return encoding ? files.get(key) : Buffer.from(files.get(key));
    assert(key.startsWith(root), 'unexpected file read: ' + key);
    return readFile(file, encoding);
  };
  const synthetic = (id, exports) => {
    const mod = new SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      },
      { context, identifier: id }
    );
    return mod;
  };
  const nodeModules = {
    'node:fs/promises': {
      ...fsPromises,
      readFile: read,
      writeFile: async (file, value) => files.set(String(file), String(value)),
      mkdtemp: async (prefix) => prefix + 'fixture',
      rm: async () => {},
    },
    'node:fs': fs,
    'node:path': path,
    'node:os': os,
    'node:crypto': crypto,
    'node:url': urlApi,
    'node:child_process': { execFileSync: childTransport },
    'node:module': {
      ...moduleApi,
      createRequire: (location) => {
        const real = moduleApi.createRequire(location);
        const shim = (id) =>
          id === 'firebase-admin/app'
            ? sdk
            : id === 'firebase-admin/firestore'
            ? { Timestamp, FieldValue: sdk.FieldValue, getFirestore: sdk.getFirestore }
            : id === 'firebase-admin/database'
            ? { getDatabase: sdk.getDatabase }
            : real(id);
        shim.resolve = real.resolve;
        return shim;
      },
    },
  };
  async function load(identifier) {
    if (cache.has(identifier)) return cache.get(identifier);
    if (identifier.startsWith('node:')) {
      assert(nodeModules[identifier], 'Unexpected native import ' + identifier);
      const mod = synthetic(identifier, nodeModules[identifier]);
      cache.set(identifier, mod);
      return mod;
    }
    const text = fs.readFileSync(new URL(identifier), 'utf8');
    const mod = new SourceTextModule(text, {
      context,
      identifier,
      initializeImportMeta: (meta) => (meta.url = identifier),
      importModuleDynamically: (specifier) => load(new URL(specifier, identifier).href),
    });
    cache.set(identifier, mod);
    return mod;
  }
  const controller = await load(new URL('../../temporal-release.mjs', import.meta.url).href);
  await controller.link((specifier, referencingModule) =>
    load(specifier.startsWith('node:') ? specifier : new URL(specifier, referencingModule.identifier).href)
  );
  try {
    await controller.evaluate();
    actions.push({
      action,
      phase: records.get('_control/temporalReleaseState').phase,
      revision: records.get('_control/temporalRelease').revision,
    });
  } finally {
    assert(!records.has('_control/temporalReleaseOperation'), 'operation lock must be cleaned');
    assert.equal(apps.length, 0, 'owned SDK app must be closed');
  }
}
function checkDomains(open = false) {
  const control = records.get('_control/temporalRelease');
  for (const domain of domains.slice(0, 6))
    assert.deepEqual(control.domains[domain], { owner: 'temporal', admission: 'open' });
  assert.equal(
    control.domains.search.owner,
    actions.some(({ action }) => action === 'take-ownership') ? 'temporal' : 'legacy'
  );
  assert.equal(control.domains.search.admission, open ? 'open' : 'paused');
  assert.equal(control.admission, open ? 'open' : 'paused');
}
function evidence(file, extra) {
  files.set(
    file,
    JSON.stringify({
      projectId,
      releaseId,
      controlRevision: records.get('_control/temporalRelease').revision,
      result: 'passed',
      verifiedAt: new Date(clock).toISOString(),
      ...extra,
    })
  );
}
async function rejectsMutation(label, action, mutate, insideTransaction = false) {
  const savedRecords = new Map([...records].map(([key, value]) => [key, clone(value)]));
  const savedVersions = new Map([...versions].map(([key, value]) => [key, clone(value)]));
  const beforeState = clone(records.get('_control/temporalReleaseState'));
  const revision = records.get('_control/temporalRelease').revision;
  let mutatedMarker;
  const apply = () => {
    mutate();
    mutatedMarker = clone(records.get('_control/temporalProviderUsage'));
  };
  if (insideTransaction)
    beforeTransaction = () => {
      if (records.get('_control/temporalReleaseOperation')?.action === action) {
        beforeTransaction = undefined;
        apply();
      }
    };
  else apply();
  await assert.rejects(
    run(action),
    /continuity|Provider reference index|SEARCH_BOOTSTRAP_OTHER_WORK_NOT_DRAINED/i,
    label
  );
  assert.equal(beforeTransaction, undefined, 'final transaction boundary must actually be exercised');
  assert.deepEqual(records.get('_control/temporalReleaseState'), beforeState, label + ': checkpoint unchanged');
  assert.equal(records.get('_control/temporalRelease').revision, revision, label + ': revision unchanged');
  assert.deepEqual(
    records.get('_control/temporalProviderUsage'),
    mutatedMarker,
    label + ': no marker replacement or relabelling'
  );
  records.clear();
  for (const pair of savedRecords) records.set(...pair);
  versions.clear();
  for (const pair of savedVersions) versions.set(...pair);
  rejectedBoundaries.push(label);
}
await run('freeze-ui');
checkDomains();
assert.equal(
  records.get('_control/temporalRelease').legacyAdmissionCutoff,
  undefined,
  'old native cutoff must not be reused'
);
assert.deepEqual(
  records.get('_control/temporalReleaseHistory-' + oldReleaseId),
  priorState,
  'predecessor state is preserved exactly'
);
evidence(config.compatibilityEvidence, {
  commit: config.compatibilityCommit,
  legacyAdmissionPauseVerified: true,
  legacyAdmissionLeaseFencingVerified: true,
  oldBrowserWritePauseVerified: true,
  allSourcesDeployed: true,
});
await run('compatibility-ready');
checkDomains();
const cutoff = records.get('_control/temporalRelease').legacyAdmissionCutoff;
assert(cutoff instanceof Timestamp);
assert.notEqual(cutoff.seconds, oldCutoff.seconds);
assert.equal(cutoff.toMillis(), clock);
await assert.rejects(run('drain'), /full maximum legacy execution duration/);
checkDomains();
clock += 3600000;
await run('drain');
checkDomains();
await rejectsMutation('marker body changed', 'provider-usage-ready', () =>
  records.set('_control/temporalProviderUsage', { ...clone(marker), edgeCount: marker.edgeCount + 1 })
);
await rejectsMutation('marker missing', 'provider-usage-ready', () => records.delete('_control/temporalProviderUsage'));
await rejectsMutation(
  'archived predecessor changed',
  'provider-usage-ready',
  () => (records.get('_control/temporalReleaseHistory-' + oldReleaseId).providerUsageEpoch = 'foreign-epoch')
);
await rejectsMutation(
  'first six owner drift',
  'provider-usage-ready',
  () => (records.get('_control/temporalRelease').domains.media.owner = 'legacy')
);
await rejectsMutation('unfinished non-search job', 'provider-usage-ready', () =>
  records.set('durableJobs/unrelated', { projectId, jobId: 'unrelated', kind: 'sermon.publish', state: 'running' })
);
await run('provider-usage-ready');
checkDomains();
assert.deepEqual(
  records.get('_control/temporalProviderUsage'),
  marker,
  'provider body and origin release stay unchanged'
);
assert.deepEqual(
  versions.get('_control/temporalProviderUsage'),
  { createTime: markerTime, updateTime: markerTime },
  'provider native snapshot identity stays unchanged'
);
assert.equal(records.get('_control/temporalReleaseState').providerUsageEpoch, marker.epoch);
await run('pause');
checkDomains();
assert.equal(records.get('_control/temporalReleaseState').pausedFrom, 'provider-usage-ready');
await run('resume');
checkDomains();
assert.equal(records.get('_control/temporalReleaseState').phase, 'provider-usage-ready');
await run('workers-ready');
checkDomains();
await run('take-ownership');
checkDomains();
assert.equal(records.get('_control/temporalRelease').domains.search.owner, 'temporal');
evidence(config.backendEvidence, {
  commit: config.compatibilityCommit,
  allSourcesDeployed: true,
  runtimeServicesDeployed: true,
  facadeOwnershipVerified: true,
});
await run('backend-ready');
checkDomains();
await run('bootstrap-search');
checkDomains();
await run('rollout-ui');
checkDomains();
evidence(config.smokeEvidence, {
  uiCommit: config.uiCommit,
  backendOwnershipVerified: true,
  workerReady: true,
  oldBrowserWritesDenied: true,
  scope: 'preopen-readonly-and-existing-jobs',
  readonlySmokePassed: true,
  claimsFreshWriteE2E: false,
});
await rejectsMutation(
  'epoch changed at open transaction',
  'open',
  () => (records.get('_control/temporalProviderUsage').epoch = 'foreign-epoch'),
  true
);
await rejectsMutation(
  'status changed at open transaction',
  'open',
  () => (records.get('_control/temporalProviderUsage').status = 'building'),
  true
);
await run('open');
checkDomains(true);
await run('restore-auto');
checkDomains(true);
assert.equal(traffic.rolloutPolicy.disabled, false);
assert.deepEqual(records.get('_control/temporalProviderUsage'), marker);
assert.deepEqual(versions.get('_control/temporalProviderUsage'), { createTime: markerTime, updateTime: markerTime });
assert(!commands.some(({ args }) => args.some((arg) => arg.includes('temporal-backfill-provider-usage.mjs'))));
for (const name of [
  'temporal-release-lib.mjs',
  'temporal-compatibility-cutoff.mjs',
  'temporal-bootstrap-search.mjs',
  'temporal-apphosting-rollout.mjs',
  'temporal-provider-usage-continuity.mjs',
])
  assert(currentModules.has(new URL('../../' + name, import.meta.url).href), 'actual source module loaded: ' + name);
assert.equal(
  [...records.values()].filter(
    (value) => value.dispatch?.workflowType === 'SearchBackfill' && value.state === 'dispatched'
  ).length,
  5
);
console.log(
  JSON.stringify({
    rejectedBoundaries,
    providerTamperingRejected: true,
    actualValidators: true,
    phase: records.get('_control/temporalReleaseState').phase,
    actions,
    providerEpoch: marker.epoch,
    providerOriginRelease: marker.releaseId,
    providerBodyUnchanged: true,
    providerNativeIdentityUnchanged: true,
    freshCutoff: true,
    earlyDrainRejected: true,
    otherSixPreserved: true,
    legacyBackfillInvoked: false,
    jobCount: [...records.keys()].filter((p) => p.startsWith('durableJobs/')).length,
    apiCalls: apiEvents.length,
  })
);
