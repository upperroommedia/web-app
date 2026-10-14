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
import * as net from 'node:net';
import * as urlApi from 'node:url';
import * as httpsApi from 'node:https';
import { execFileSync as realExecFileSync } from 'node:child_process';
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
const { OAuth2Client } = moduleApi.createRequire(require.resolve('firebase-admin/app'))('google-auth-library');
class FixtureOAuth2Client extends OAuth2Client {
  constructor() {
    super();
    this.transporter = {
      request: async (options) => {
        assert.equal(options.method, 'POST');
        assert.equal(new URL(options.url).search, '');
        assert.equal(
          options.headers.get?.('authorization') ?? options.headers.authorization,
          'Bearer emulator-only-offline-token'
        );
        return {
          data: {
            email: 'fixture@example.test',
            email_verified: true,
            sub: 'fixture',
            scope: 'openid email',
            expires_in: 3600,
          },
        };
      },
    };
  }
}
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
const platformFixture = JSON.parse(
  fs.readFileSync(new URL('./temporal-release-platform.fixture.json', import.meta.url), 'utf8')
);
const platform = {
  ...platformFixture,
  firebaseProjectId: projectId,
  workerBuildId: config.compatibilityCommit,
  workerRoles: ['orchestration', 'controls', 'media', 'email', 'images', 'search'],
  workerReplicas: 1,
  context: 'fixture-context',
  namespace: 'temporal-staging',
  connectionMode: 'temporal-cloud',
  workerHosting: 'gce-k3s',
  firebaseResources: {
    storageBucket: 'urm-app-staging.firebasestorage.app',
    imagesBucket: 'urm-app-staging-images',
    databaseUrl: `https://${projectId}-default-rtdb.firebaseio.com/`,
  },
  gce: {
    ...platformFixture.gce,
    instanceName: 'urm-temporal-staging',
    serviceAccount: `temporal-worker@${projectId}.iam.gserviceaccount.com`,
  },
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
  ['/fixture/home/.config/gcloud/application_default_credentials.json', JSON.stringify({ type: 'authorized_user' })],
  [
    '/fixture/peer.json',
    JSON.stringify({
      environment: 'production',
      deploymentState: 'planned',
      connectionMode: 'temporal-cloud',
      workerHosting: 'gce-k3s',
      firebaseProjectId: 'urm-app',
      temporalNamespace: 'urm-app.qwejt',
      cloudAccountId: 'qwejt',
      cloudProvider: 'gcp',
      cloudRegion: 'us-central1',
    }),
  ],
  ['/fixture/platform.json', JSON.stringify(platform)],
]);
const actions = [],
  commands = [],
  apps = [],
  apiEvents = [];
let currentModules,
  readinessProof,
  beforeTransaction,
  currentAction,
  rtdbFailure,
  runtimeFault,
  runtimeGitReads = 0,
  resumeOperation;
const bundleMetadata = new Map();
let bundleProof,
  bootstrapInvocations = 0;
const rtdbCanaryCalls = [],
  rejectedRtdbBoundaries = [];
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
    const isBundleTransition =
      writes.some(([, key]) => key.startsWith('_control/temporalReleaseOperatorAudit-')) &&
      ['bootstrap-bundles', 'migrate-ui-identity'].includes(currentAction);
    if (isBundleTransition && runtimeFault === 'unknown-not-applied') {
      runtimeFault = 'retained';
      throw new Error('UNKNOWN_ACK_NOT_APPLIED');
    }
    for (const [operation, key, value] of writes) {
      if (operation === 'delete') {
        records.delete(key);
        versions.delete(key);
      } else {
        records.set(key, resolveTransforms(value));
        versions.set(key, { createTime: versions.get(key)?.createTime ?? native(clock), updateTime: native(clock) });
      }
    }
    if (isBundleTransition && runtimeFault === 'unknown-applied') {
      runtimeFault = 'retained';
      throw new Error('UNKNOWN_ACK_APPLIED');
    }
    return result;
  },
  terminate: async () => {},
};
let defaultCredential;
const sdk = {
  getApps: () => apps,
  applicationDefault: (agent) =>
    (defaultCredential ??= {
      googleAuth: { clientOptions: { transporterOptions: { agent } } },
      getAccessToken: async () => ({ access_token: 'emulator-only-offline-token' }),
    }),
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
let migrationTrafficReads = 0;
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
      if (currentAction === 'migrate-ui-identity' && method === 'GET') migrationTrafficReads++;
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
  else if (parsed.hostname === 'cloudresourcemanager.googleapis.com')
    result = { projectId, projectNumber: '123456789', lifecycleState: 'ACTIVE' };
  else if (parsed.hostname === 'storage.googleapis.com') {
    if (parsed.pathname.includes('/o/')) {
      const object = decodeURIComponent(parsed.pathname.split('/o/')[1]);
      result = clone(bundleMetadata.get(object));
      if (runtimeFault === 'retained-version' && !parsed.searchParams.has('generation'))
        result.generation = String(Number(result.generation) + 1);
    } else
      result = {
        name: platform.firebaseResources.storageBucket,
        projectNumber: runtimeFault === 'resource' ? '999999' : '123456789',
        metageneration: '1',
      };
  } else throw new Error('UNEXPECTED_NETWORK_' + raw);
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
function childTransport(command, args, options = {}) {
  commands.push({ command, args: [...args] });
  if (command === 'git') {
    if (args[0] === 'rev-parse') {
      runtimeGitReads++;
      return runtimeFault === 'runtime' && runtimeGitReads === 2 ? 'd'.repeat(40) : config.compatibilityCommit;
    }
    if (args[0] === 'ls-files')
      return args.includes('--others')
        ? ''
        : realExecFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }) +
            [
              'scripts/temporal-release-runtime.mjs',
              'scripts/temporal-release-runtime.test.mjs',
              'scripts/tests/temporal-release-runtime.firestore.test.mjs',
              'scripts/tests/fixtures/temporal-release-platform.fixture.json',
            ].join('\0') +
            '\0';
    if (args[0] === 'diff') return '';
    if (args[0] === 'show') {
      const name = args[1].slice(args[1].indexOf(':') + 1);
      const value = fs.readFileSync(path.join(root, name));
      const bytes =
        runtimeFault === 'operator' && name === 'scripts/temporal-release.mjs'
          ? Buffer.concat([value, Buffer.from('//uncommitted')])
          : value;
      return options.encoding ? bytes.toString(options.encoding) : bytes;
    }
    throw new Error('UNEXPECTED_GIT');
  }
  if (command === 'gcloud') {
    if (args[1] === 'list') return 'fixture@example.test';
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
  if (script === 'temporal-bootstrap-bundles.mjs') {
    bootstrapInvocations++;
    assert.equal(args[args.indexOf('--runtime-root') + 1], root.replace(/\/$/, ''));
    assert.equal(options.cwd, root.replace(/\/$/, ''));
    const boundary = currentModules.get(new URL('../../temporal-release-runtime.mjs', import.meta.url).href).namespace;
    const binding = boundary.pinReleaseCheckouts(root, root, config);
    const resourceBinding = boundary.loadReleaseResourceBinding(config);
    const resourceIdentity = {
      projectId,
      projectNumber: '123456789',
      bucket: platform.firebaseResources.storageBucket,
      metageneration: '1',
      resourceDigest: resourceBinding.resourceDigest,
    };
    return JSON.stringify({
      ...bundleProof,
      projectId,
      releaseId,
      controlRevision: records.get('_control/temporalRelease').revision,
      result: 'passed',
      operatorRuntime: {
        operatorCommit: binding.operatorCommit,
        runtimeCommit: binding.runtimeCommit,
        operatorClosureDigest: binding.operatorClosureDigest,
        resourceBinding,
        resourceIdentity,
      },
    });
  }
  if (script === 'deploy-temporal-platform.mjs') {
    assert(['preflight', 'worker-status', 'firebase-rtdb-canary'].includes(args[1]));
    if (args[1] === 'firebase-rtdb-canary') {
      const output = args[args.indexOf('--output') + 1];
      assert.deepEqual([...args].slice(1), [
        'firebase-rtdb-canary',
        '--config',
        config.platformConfig,
        '--peer',
        config.platformPeerConfig,
        '--output',
        output,
        '--apply',
      ]);
      rtdbCanaryCalls.push({ action: currentAction, failure: rtdbFailure ?? null });
      if (rtdbFailure === 'cli') throw new Error('RTDB_CANARY_CLI_FAILED');
      const proof = {
        ok: true,
        projectId,
        databaseURL: platform.firebaseResources.databaseUrl,
        serviceAccountEmail: platform.gce.serviceAccount,
        buildId: platform.workerBuildId,
        readSucceeded: true,
        noWrites: true,
        ownedSdkCleanupComplete: true,
      };
      if (rtdbFailure === 'auth') {
        proof.ok = false;
        proof.readSucceeded = false;
      }
      if (rtdbFailure === 'cleanup') proof.ownedSdkCleanupComplete = false;
      files.set(output, JSON.stringify(proof));
      return '';
    }
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
  defaultCredential = undefined;
  runtimeGitReads = 0;
  currentAction = action;
  const context = createContext({
    process: {
      argv: [
        'node',
        path.join(root, 'scripts/temporal-release.mjs'),
        action,
        '--release',
        '/fixture/release.json',
        '--apply',
        ...(resumeOperation ? ['--resume-operation', resumeOperation] : []),
      ],
      env: { HOME: '/fixture/home' },
      execPath: process.execPath,
      cwd: () => root,
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
    'node:fs': {
      ...fs,
      realpathSync: (p) => (files.has(String(p)) ? String(p) : fs.realpathSync(p)),
      readFileSync: (file, encoding) => {
        const p = String(file);
        if (files.has(p)) return encoding ? files.get(p) : Buffer.from(files.get(p));
        return fs.readFileSync(file, encoding);
      },
    },
    'node:path': path,
    'node:os': os,
    'node:crypto': crypto,
    'node:net': net,
    'node:https': httpsApi,
    'node:url': urlApi,
    'node:child_process': {
      execFileSync: childTransport,
      spawnSync: () => {
        throw new Error('UNEXPECTED_SPAWN');
      },
    },
    'node:module': {
      ...moduleApi,
      createRequire: (location) => {
        const real = moduleApi.createRequire(location);
        const shim = (id) =>
          id === 'google-auth-library'
            ? { OAuth2Client: FixtureOAuth2Client }
            : id === 'firebase-admin/app'
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
      importModuleDynamically: async (specifier) => {
        const dynamic = await load(new URL(specifier, identifier).href);
        if (dynamic.status === 'unlinked')
          await dynamic.link((name, parent) =>
            load(name.startsWith('node:') ? name : new URL(name, parent.identifier).href)
          );
        if (dynamic.status === 'linked') await dynamic.evaluate();
        return dynamic;
      },
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
    if (runtimeFault === 'retained' || runtimeFault === 'op-replaced')
      assert(records.has('_control/temporalReleaseOperation'), 'uncertain or changed operation must remain held');
    else assert(!records.has('_control/temporalReleaseOperation'), 'operation lock must be cleaned');
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
async function rejectsRtdbCanary(action, failure) {
  const beforeState = clone(records.get('_control/temporalReleaseState'));
  const beforeControl = clone(records.get('_control/temporalRelease'));
  const beforeCalls = rtdbCanaryCalls.length;
  const completedActions = actions.length;
  rtdbFailure = failure;
  try {
    await assert.rejects(run(action), failure === 'cli' ? /RTDB_CANARY_CLI_FAILED/ : /Firebase RTDB.*proof missing/);
  } finally {
    rtdbFailure = undefined;
  }
  assert.deepEqual(
    records.get('_control/temporalReleaseState'),
    beforeState,
    `${action}/${failure}: phase and checkpoint unchanged`
  );
  assert.deepEqual(
    records.get('_control/temporalRelease'),
    beforeControl,
    `${action}/${failure}: revision, ownership and admission unchanged`
  );
  assert.equal(actions.length, completedActions, 'failed capability proof cannot record a completed transition');
  assert.deepEqual(
    rtdbCanaryCalls.slice(beforeCalls),
    [{ action, failure }],
    'actual controller must launch the canary before rejecting'
  );
  assert(!records.has('_control/temporalReleaseOperation'), 'failed capability proof releases the operation lock');
  assert.equal(apps.length, 0, 'failed capability proof closes owned SDK apps');
  rejectedRtdbBoundaries.push(`${action}:${failure}`);
}
if (process.argv[2] === 'ui-identity-migration') {
  await runMigrationCases();
} else if (process.argv[2] === 'runtime-bundle') {
  await runBundleRuntimeCases();
} else {
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
  await rejectsMutation('marker missing', 'provider-usage-ready', () =>
    records.delete('_control/temporalProviderUsage')
  );
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
  for (const failure of ['cli', 'auth', 'cleanup']) await rejectsRtdbCanary('workers-ready', failure);
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
  for (const failure of ['cli', 'auth', 'cleanup']) await rejectsRtdbCanary('open', failure);
  await run('open');
  checkDomains(true);
  await run('restore-auto');
  checkDomains(true);
  assert.equal(traffic.rolloutPolicy.disabled, false);
  assert.deepEqual(records.get('_control/temporalProviderUsage'), marker);
  assert.deepEqual(versions.get('_control/temporalProviderUsage'), { createTime: markerTime, updateTime: markerTime });
  assert(
    !commands.some(
      ({ command, args }) =>
        command !== 'git' && args.some((arg) => arg.includes('temporal-backfill-provider-usage.mjs'))
    )
  );
  for (const name of [
    'temporal-release-lib.mjs',
    'temporal-compatibility-cutoff.mjs',
    'temporal-bootstrap-search.mjs',
    'temporal-apphosting-rollout.mjs',
    'temporal-provider-usage-continuity.mjs',
    'temporal-platform.mjs',
  ])
    assert(currentModules.has(new URL('../../' + name, import.meta.url).href), 'actual source module loaded: ' + name);
  assert.equal(
    [...records.values()].filter(
      (value) => value.dispatch?.workflowType === 'SearchBackfill' && value.state === 'dispatched'
    ).length,
    5
  );
  assert.deepEqual(
    rtdbCanaryCalls.filter((call) => call.failure === null).map((call) => call.action),
    ['workers-ready', 'take-ownership', 'open', 'open', 'open'],
    'workers-ready, ownership, and every open attempt must run the actual readiness helper'
  );
  console.log(
    JSON.stringify({
      rejectedBoundaries,
      rejectedRtdbBoundaries,
      rtdbCanaryCalls,
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
}

async function runBundleRuntimeCases() {
  const boundary = await import('../../temporal-release-runtime.mjs');
  config.domains = domains.slice(0, 6);
  files.set('/fixture/release.json', JSON.stringify(config));
  const seed = () => {
    records.clear();
    versions.clear();
    bundleMetadata.clear();
    records.set('_control/temporalRelease', {
      ...clone(priorControl),
      releaseId,
      revision: 11,
      admission: 'paused',
      domains: Object.fromEntries(
        domains.map((d) => [d, { owner: d === 'search' ? 'legacy' : 'temporal', admission: 'paused' }])
      ),
    });
    records.set('_control/temporalReleaseState', {
      ...clone(priorState),
      releaseId,
      mode: config.mode,
      domains: config.domains,
      compatibilityCommit: config.compatibilityCommit,
      uiCommit: config.uiCommit,
      phase: 'backend-ready',
      controlRevision: 11,
    });
    bundleProof = {
      bundleTypes: ['topics', 'subtitles', 'bible-chapters', 'sunday-homilies', 'holy-week', 'latest-list'],
      jobIds: [],
      bootstrapJobIds: [],
      artifactProofs: [],
    };
    for (const [i, type] of bundleProof.bundleTypes.entries()) {
      const jobId = 'job-' + crypto.createHash('sha256').update(type).digest('hex').slice(0, 48),
        oldId =
          'job-' +
          crypto
            .createHash('sha256')
            .update('old-' + type)
            .digest('hex')
            .slice(0, 48);
      const pointer = {
        projectId,
        jobId,
        generation: 2,
        count: i,
        storagePath: `bundles/durable/${type}/${jobId}/abc.bin`,
      };
      const key = crypto
        .createHash('sha256')
        .update(JSON.stringify([projectId, 'bundle', type, 'bundle']))
        .digest('hex');
      records.set('durableJobEntities/' + key, {
        projectId,
        entity: { type: 'bundle', id: type },
        generation: 2,
        activeJobId: jobId,
      });
      records.set('durableJobs/' + jobId, {
        projectId,
        jobId,
        kind: 'bundle.regenerate',
        entity: { type: 'bundle', id: type },
        generation: 2,
        state: 'succeeded',
      });
      records.set('durableJobs/' + oldId, {
        projectId,
        jobId: oldId,
        kind: 'bundle.regenerate',
        entity: { type: 'bundle', id: type },
        generation: 1,
        state: 'failed',
      });
      records.set('_durableBundlePointers/' + type, pointer);
      const metadata = {
        bucket: platform.firebaseResources.storageBucket,
        name: pointer.storagePath,
        contentType: 'application/octet-stream',
        metadata: { [`${type}-count`]: String(i) },
        generation: String(1000 + i),
        metageneration: '1',
        size: '100',
      };
      bundleMetadata.set(pointer.storagePath, metadata);
      bundleProof.jobIds.push(jobId);
      bundleProof.bootstrapJobIds.push(oldId);
      bundleProof.artifactProofs.push(boundary.artifactProof(type, pointer, metadata, metadata.bucket));
    }
    runtimeFault = undefined;
    resumeOperation = undefined;
    beforeTransaction = undefined;
    bootstrapInvocations = 0;
  };
  const passed = [];
  for (const fault of ['runtime', 'operator', 'resource', 'retained-version', 'pointer', 'authority', 'op-replaced']) {
    seed();
    const before = clone(records.get('_control/temporalRelease'));
    const state = clone(records.get('_control/temporalReleaseState'));
    runtimeFault = fault;
    if (['pointer', 'authority', 'op-replaced'].includes(fault)) {
      beforeTransaction = () => {
        if (!bootstrapInvocations) return;
        beforeTransaction = undefined;
        if (fault === 'pointer')
          records.set('_durableBundlePointers/topics', {
            ...records.get('_durableBundlePointers/topics'),
            generation: 3,
          });
        else if (fault === 'authority')
          records.set('_control/temporalReleaseState', { ...state, changedWithoutRevision: true });
        else
          records.set('_control/temporalReleaseOperation', {
            ...records.get('_control/temporalReleaseOperation'),
            action: 'foreign-action',
          });
      };
    }
    await assert.rejects(
      run('bootstrap-bundles'),
      /RELEASE_|BOOTSTRAP_|operation changed|revision changed|authority|retained|proof/i
    );
    assert.deepEqual(records.get('_control/temporalRelease'), before);
    assert.equal(records.get('_control/temporalReleaseState').phase, 'backend-ready');
    assert.equal([...records.keys()].filter((k) => k.startsWith('_control/temporalReleaseOperatorAudit-')).length, 0);
    if (fault !== 'op-replaced') assert(!records.has('_control/temporalReleaseOperation'));
    passed.push(fault);
  }
  for (const fault of ['unknown-applied', 'unknown-not-applied']) {
    seed();
    const originals = JSON.stringify(bundleProof.bootstrapJobIds.map((id) => records.get('durableJobs/' + id)));
    runtimeFault = fault;
    await assert.rejects(run('bootstrap-bundles'), /UNKNOWN_ACK/);
    const held = records.get('_control/temporalReleaseOperation');
    assert(held);
    resumeOperation = held.operationId;
    runtimeFault = undefined;
    await run('bootstrap-bundles');
    assert.equal(records.get('_control/temporalRelease').revision, 12);
    assert.equal(records.get('_control/temporalReleaseState').phase, 'bundles-ready');
    assert.equal(bootstrapInvocations, fault === 'unknown-applied' ? 1 : 2);
    assert.equal(JSON.stringify(bundleProof.bootstrapJobIds.map((id) => records.get('durableJobs/' + id))), originals);
    assert.equal([...records.values()].filter((v) => v.kind === 'bundle.regenerate' && v.generation === 2).length, 6);
    assert(!records.has('_control/temporalReleaseOperation'));
    passed.push(fault + '-explicit-reconcile');
    resumeOperation = undefined;
    await run('bootstrap-bundles');
    assert.equal(records.get('_control/temporalRelease').revision, 12);
  }
  console.log(
    JSON.stringify({
      result: 'passed',
      actualController: true,
      cases: passed,
      originalFailedJobsPreserved: true,
      newGenerationCreatedByController: false,
    })
  );
}

async function runMigrationCases() {
  const { rolloutIdentity } = await import('../../temporal-apphosting-rollout.mjs');
  config.domains = domains.slice(0, 6);
  files.set('/fixture/release.json', JSON.stringify(config));
  const uiConfig = { parent, releaseId, uiCommit: config.uiCommit };
  const original = rolloutIdentity(uiConfig, 1),
    next = rolloutIdentity(uiConfig);
  const passed = [];
  for (const fault of ['none', 'authority', 'op-replaced', 'unknown-applied', 'unknown-not-applied']) {
    records.clear();
    versions.clear();
    remote.clear();
    migrationTrafficReads = 0;
    apiEvents.length = 0;
    records.set('_control/temporalRelease', {
      ...clone(priorControl),
      releaseId,
      revision: 13,
      admission: 'paused',
      domains: Object.fromEntries(
        domains.map((d) => [d, { owner: d === 'search' ? 'legacy' : 'temporal', admission: 'paused' }])
      ),
    });
    records.set('_control/temporalReleaseState', {
      ...clone(priorState),
      releaseId,
      mode: config.mode,
      domains: config.domains,
      compatibilityCommit: config.compatibilityCommit,
      uiCommit: config.uiCommit,
      phase: 'ui-rollout-started',
      controlRevision: 13,
      uiRolloutIdentity: clone(original),
      uiRolloutStartedAt: 12345,
    });
    traffic.rolloutPolicy.disabled = true;
    traffic.reconciling = false;
    const before = clone(records.get('_control/temporalRelease'));
    runtimeFault = fault === 'none' ? undefined : fault;
    resumeOperation = undefined;
    beforeTransaction = undefined;
    if (['authority', 'op-replaced'].includes(fault))
      beforeTransaction = () => {
        if (migrationTrafficReads < 2) return;
        beforeTransaction = undefined;
        const key = fault === 'authority' ? '_control/temporalReleaseState' : '_control/temporalReleaseOperation';
        records.set(key, {
          ...records.get(key),
          ...(fault === 'authority' ? { changedWithoutRevision: true } : { action: 'foreign-action' }),
        });
      };
    if (fault === 'none') await run('migrate-ui-identity');
    else await assert.rejects(run('migrate-ui-identity'), /UNKNOWN_ACK|authority|operation|revision/i);
    if (fault.startsWith('unknown-')) {
      const held = records.get('_control/temporalReleaseOperation');
      assert(held);
      resumeOperation = held.operationId;
      runtimeFault = undefined;
      await run('migrate-ui-identity');
    }
    if (['authority', 'op-replaced'].includes(fault)) {
      assert.deepEqual(records.get('_control/temporalRelease'), before);
      assert.deepEqual(records.get('_control/temporalReleaseState').uiRolloutIdentity, original);
    } else {
      assert.equal(records.get('_control/temporalRelease').revision, 14);
      const state = records.get('_control/temporalReleaseState');
      assert.equal(state.phase, 'ui-rollout-started');
      assert.equal(state.uiRolloutStartedAt, 12345);
      assert.deepEqual(state.uiRolloutIdentity, next);
      assert.deepEqual(state.uiRolloutIdentityMigration.previousIdentity, original);
      const audit = records.get(state.uiRolloutIdentityMigrationAuditPath);
      assert.equal(audit.action, 'migrate-ui-identity');
      assert.deepEqual(audit.uiRolloutIdentityMigration, state.uiRolloutIdentityMigration);
      assert.equal([...records.keys()].filter((k) => k.startsWith('_control/temporalReleaseOperatorAudit-')).length, 1);
      assert(!records.has('_control/temporalReleaseOperation'));
    }
    assert(!apiEvents.some((row) => row.method !== 'GET'), 'identity migration must never write App Hosting');
    assert.equal(remote.size, 0);
    passed.push(fault);
  }
  console.log(JSON.stringify({ result: 'passed', cases: passed, noAppHostingWrites: true }));
}
