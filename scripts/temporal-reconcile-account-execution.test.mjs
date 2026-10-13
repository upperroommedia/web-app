import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  verifyPodTermination,
  validateRecoveryScope,
  validateOperator,
  reconcileAccountExecution,
  createKubernetesReader,
  parseRecoveryArguments,
} from './temporal-reconcile-account-execution.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const config = {
  environment: 'staging',
  firebaseProjectId: 'urm-app-staging',
  temporalNamespace: 'urm-app-staging',
  namespace: 'temporal-staging',
  context: 'private-staging',
  clusterUid: 'cluster-uid',
};
const worker = {
  instanceId: 'worker-process',
  buildId: 'a'.repeat(40),
  podUid: 'pod-uid',
  podName: 'worker-pod',
  namespace: config.namespace,
  clusterId: config.clusterUid,
  nodeUid: 'node-uid',
  nodeName: 'worker-node',
  containerIds: [`containerd://${'b'.repeat(64)}`],
};
const operator = {
  google: { subject: 'immutable-google-sub', email: 'operator@example.test' },
  kubernetes: { username: 'operator@example.test', uid: 'kube-user', groups: ['system:authenticated'] },
};
function observation() {
  return {
    cluster: { metadata: { name: 'kube-system', uid: config.clusterUid } },
    namespace: { metadata: { name: config.namespace, uid: 'namespace-uid' } },
    pod: {
      metadata: {
        name: worker.podName,
        uid: worker.podUid,
        namespace: config.namespace,
        resourceVersion: '100',
        labels: { 'app.kubernetes.io/name': 'urm-temporal-worker', 'app.kubernetes.io/version': worker.buildId },
      },
      spec: {
        nodeName: worker.nodeName,
        containers: [
          {
            name: 'worker',
            image: `ghcr.io/upperroommedia/worker@sha256:${'c'.repeat(64)}`,
            env: [
              { name: 'TEMPORAL_BUILD_ID', value: worker.buildId },
              { name: 'FIREBASE_PROJECT_ID', value: config.firebaseProjectId },
              { name: 'TEMPORAL_NAMESPACE', value: config.temporalNamespace },
            ],
          },
        ],
      },
      status: {
        phase: 'Failed',
        containerStatuses: [
          {
            name: 'worker',
            containerID: worker.containerIds[0],
            state: { terminated: { finishedAt: '2026-10-12T12:00:00Z', exitCode: 137 } },
          },
        ],
      },
    },
    node: {
      metadata: { name: worker.nodeName, uid: worker.nodeUid, resourceVersion: '200' },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    },
    runningPods: { kind: 'PodList', items: [] },
  };
}
function fixture() {
  const execution = {
    workflowId: 'account:job',
    runId: 'run-1',
    activityId: '3',
    activityType: 'applyAccountClaims',
    scheduledAt: 100,
    attempt: 1,
    runStartedAtNanos: '1000000000',
    temporalNamespace: config.temporalNamespace,
    worker,
  };
  const entity = { type: 'user', id: 'target-user' };
  const resourcePath = `_durableAccountClaimResources/${hash(`${config.firebaseProjectId}:target-user`)}`;
  const map = new Map([
    [
      resourcePath,
      {
        projectId: config.firebaseProjectId,
        uid: 'target-user',
        jobId: 'job',
        state: 'started',
        transport: 'single_shot_identity_toolkit',
        claims: { role: 'editor', temporalAccountClaimJobId: 'job' },
        execution,
      },
    ],
    [
      'durableJobs/job',
      {
        projectId: config.firebaseProjectId,
        jobId: 'job',
        workflowId: execution.workflowId,
        generation: 1,
        kind: 'role.resolve',
        entity,
      },
    ],
    [
      'durableJobIntents/job',
      { projectId: config.firebaseProjectId, jobId: 'job', generation: 1, kind: 'role.resolve', entity },
    ],
    ['durableJobEntities/entity', { projectId: config.firebaseProjectId, generation: 1, activeJobId: 'job', entity }],
  ]);
  const writes = [];
  const snapshot = (path) => ({ exists: map.has(path), data: () => structuredClone(map.get(path)) });
  const ref = (path) => ({ id: path.split('/').at(-1), path, get: async () => snapshot(path) });
  const firestore = {
    collection: (collection) => ({ doc: (id) => ref(`${collection}/${id}`) }),
    doc: ref,
    async runTransaction(callback) {
      const reads = new Map(),
        pending = [];
      const tx = {
        get: async (target) => {
          reads.set(target.path, JSON.stringify(map.get(target.path)));
          return snapshot(target.path);
        },
        create: (target, value) => {
          assert.ok(!map.has(target.path));
          pending.push([target.path, structuredClone(value)]);
        },
      };
      const result = await callback(tx);
      for (const [path, value] of reads)
        if (JSON.stringify(map.get(path)) !== value) throw new Error('Transaction raced with a newer record');
      for (const [path, value] of pending) {
        map.set(path, value);
        writes.push([path, value]);
      }
      return result;
    },
  };
  return {
    map,
    writes,
    resourcePath,
    firestore,
    options: {
      firestore,
      config,
      uid: 'target-user',
      jobId: 'job',
      kubernetes: { observe: async () => observation() },
      operator,
      now: () => 10000,
    },
    helpers: { drainKey: () => 'proof', entityKey: () => 'entity' },
  };
}

test('accepts exact preserved terminated pod plus live runtime absence, without inferring remote completion', () => {
  const result = verifyPodTermination(config, worker, observation());
  assert.equal(result.podUid, worker.podUid);
  assert.equal(result.instanceId, worker.instanceId);
});
for (const [label, mutate] of [
  ['wrong cluster', (value) => (value.cluster.metadata.uid = 'other')],
  ['deleted pod', (value) => delete value.pod],
  ['recreated pod same name', (value) => (value.pod.metadata.uid = 'new')],
  ['live pod', (value) => (value.pod.status.phase = 'Running')],
  ['unknown pod', (value) => (value.pod.status.phase = 'Unknown')],
  ['recreated node', (value) => (value.node.metadata.uid = 'new-node')],
  ['unavailable node', (value) => (value.node.status.conditions[0].status = 'Unknown')],
  ['pending namespace deletion', (value) => (value.namespace.metadata.deletionTimestamp = 'now')],
  [
    'running original container',
    (value) => (value.pod.status.containerStatuses[0].state = { running: { startedAt: 'now' } }),
  ],
  ['missing container evidence', (value) => (value.pod.status.containerStatuses = [])],
  [
    'restarted process same pod',
    (value) => (value.pod.status.containerStatuses[0].containerID = `containerd://${'d'.repeat(64)}`),
  ],
  ['still running on kubelet', (value) => (value.runningPods.items = [{ metadata: { uid: worker.podUid } }])],
  ['malformed live inventory', (value) => (value.runningPods = { items: [] })],
  ['mismatched build', (value) => (value.pod.metadata.labels['app.kubernetes.io/version'] = 'd'.repeat(40))],
  ['wrong project', (value) => (value.pod.spec.containers[0].env[1].value = 'urm-app')],
  ['wrong Temporal namespace', (value) => (value.pod.spec.containers[0].env[2].value = 'urm-app')],
  ['mutable image', (value) => (value.pod.spec.containers[0].image = 'ghcr.io/example:latest')],
  [
    'active ephemeral container',
    (value) => {
      value.pod.spec.ephemeralContainers = [{ name: 'debug' }];
      value.pod.status.ephemeralContainerStatuses = [
        { name: 'debug', containerID: `containerd://${'e'.repeat(64)}`, state: { running: {} } },
      ];
    },
  ],
])
  test(`rejects ${label}`, () => {
    const value = observation();
    mutate(value);
    assert.throws(() => verifyPodTermination(config, worker, value));
  });

test('project isolation and missing verified operator identities fail closed', () => {
  assert.throws(() => validateRecoveryScope({ ...config, firebaseProjectId: 'urm-app' }));
  assert.throws(() => validateOperator({ ...operator, google: { email: 'unverified@example.test' } }));
  assert.throws(() => validateOperator({ ...operator, kubernetes: { username: 'system:anonymous' } }));
  assert.throws(() => verifyPodTermination(config, { ...worker, containerIds: [] }, observation()));
});

test('preview performs no database writes', async () => {
  const f = fixture();
  const result = await reconcileAccountExecution(f.options, f.helpers);
  assert.equal(result.applied, false);
  assert.equal(result.remoteRpcCompletionProven, false);
  assert.deepEqual(f.writes, []);
});

test('apply atomically writes only an identity-bound private witness and audit', async () => {
  const f = fixture();
  const before = structuredClone(f.map.get(f.resourcePath));
  const result = await reconcileAccountExecution({ ...f.options, apply: true }, f.helpers);
  assert.equal(result.applied, true);
  assert.equal(result.remoteRpcCompletionProven, false);
  assert.equal(f.writes.length, 2);
  const proof = f.map.get('durableActivityDrains/proof');
  assert.equal(proof.source, 'operator_verified_pod_termination');
  assert.deepEqual(proof.execution, before.execution);
  assert.equal(proof.operatorUid, 'google:immutable-google-sub');
  assert.equal(proof.attestation.temporalNamespace, config.temporalNamespace);
  assert.deepEqual(f.map.get(f.resourcePath), before);
  assert.equal(f.map.get(proof.evidenceReference).frozenClaimsDigest.length, 64);
  assert.equal(JSON.stringify(f.writes).includes('synthetic-token'), false);
});

for (const [label, mutate] of [
  ['frozen claims changed', (f) => (f.map.get(f.resourcePath).claims.role = 'admin')],
  ['resource applied concurrently', (f) => (f.map.get(f.resourcePath).state = 'applied')],
  ['job generation superseded', (f) => (f.map.get('durableJobEntities/entity').generation = 2)],
  ['different account instance', (f) => (f.map.get(f.resourcePath).execution.worker.instanceId = 'replacement')],
])
  test(`atomic fence rejects ${label}`, async () => {
    const f = fixture();
    let observations = 0;
    f.options.kubernetes.observe = async () => {
      if (++observations === 1) mutate(f);
      return observation();
    };
    await assert.rejects(reconcileAccountExecution({ ...f.options, apply: true }, f.helpers));
    assert.equal(f.writes.length, 0);
  });

test('node or pod evidence changes during the transaction are rejected', async () => {
  const f = fixture();
  let count = 0;
  f.options.kubernetes.observe = async () => {
    const result = observation();
    if (++count === 2) result.pod.metadata.resourceVersion = '101';
    return result;
  };
  await assert.rejects(
    reconcileAccountExecution({ ...f.options, apply: true }, f.helpers),
    /Kubernetes evidence changed/
  );
  assert.equal(f.writes.length, 0);
});

test('a completion witness is never overwritten', async () => {
  const f = fixture();
  f.map.set('durableActivityDrains/proof', { source: 'worker_settled' });
  await assert.rejects(reconcileAccountExecution({ ...f.options, apply: true }, f.helpers), /already exists/);
  assert.equal(f.writes.length, 0);
});

test('live kubelet errors and missing pod objects are errors, never termination evidence', async () => {
  const f = fixture();
  f.options.kubernetes.observe = async () => {
    throw new Error('NotFound');
  };
  await assert.rejects(reconcileAccountExecution({ ...f.options, apply: true }, f.helpers), /NotFound/);
  assert.equal(f.writes.length, 0);
});

test('reader uses pinned context, authenticated whoami and node proxy without shell interpolation', async () => {
  const calls = [];
  const execute = (command, args, options) => {
    calls.push([command, args, options]);
    return JSON.stringify(args.includes('whoami') ? { status: { userInfo: operator.kubernetes } } : {});
  };
  const reader = createKubernetesReader(config, execute);
  assert.deepEqual(reader.whoami(), operator.kubernetes);
  await reader.observe(worker);
  assert.equal(calls.length, 6);
  assert.ok(
    calls.every(
      ([command, args, options]) =>
        command === 'kubectl' && args[0] === '--context' && args[1] === config.context && options.timeout === 20000
    )
  );
  assert.ok(calls.at(-1)[1].includes(`/api/v1/nodes/${worker.nodeName}/proxy/runningpods/`));
});

function sessionFixture() {
  const f = fixture();
  const resource = f.map.get(f.resourcePath);
  const operationId = '123e4567-e89b-42d3-a456-426614174000';
  Object.assign(resource, {
    state: 'applied',
    sessionState: 'started',
    sessionTransport: 'single_shot_identity_toolkit',
    sessionOperationId: operationId,
    sessionCutoffSeconds: '1791766123',
    sessionClaims: { ...resource.claims, temporalAccountSessionOperationId: operationId },
    sessionExecution: {
      ...resource.execution,
      activityId: '7',
      activityType: 'revokeAccountSessions',
      scheduledAt: 200,
    },
  });
  f.options.phase = 'sessions';
  f.helpers.drainKey = (_project, _job, execution) => `proof-${execution.activityId}`;
  return f;
}

test('session preview selects only the original session SDK execution and never writes', async () => {
  const f = sessionFixture();
  const result = await reconcileAccountExecution(f.options, f.helpers);
  assert.equal(result.phase, 'sessions');
  assert.equal(result.proofId, 'proof-7');
  assert.equal(result.remoteRpcCompletionProven, false);
  assert.deepEqual(f.writes, []);
});

test('session apply preserves the entire receipt and atomically attests only session caller quiescence', async () => {
  const f = sessionFixture(),
    before = structuredClone(f.map.get(f.resourcePath));
  f.map.set('durableActivityDrains/proof-3', { source: 'worker_settled' });
  const result = await reconcileAccountExecution({ ...f.options, apply: true }, f.helpers);
  const proof = f.map.get('durableActivityDrains/proof-7');
  assert.deepEqual(proof.execution, before.sessionExecution);
  assert.equal(proof.attestation.remoteRpcCompletionProven, false);
  const audit = f.map.get(result.evidenceReference);
  assert.equal(audit.phase, 'sessions');
  assert.equal(audit.sessionOperationId, before.sessionOperationId);
  assert.equal(audit.sessionCutoffSeconds, before.sessionCutoffSeconds);
  const sortedClaims = Object.fromEntries(Object.entries(before.sessionClaims).sort(([a], [b]) => a.localeCompare(b)));
  assert.equal(audit.frozenClaimsDigest, hash(JSON.stringify(sortedClaims)));
  assert.equal('sessionClaims' in audit, false);
  assert.deepEqual(f.map.get(f.resourcePath), before);
  assert.equal(f.writes.length, 2);
});

for (const [label, mutate] of [
  ['claims still started', (resource) => (resource.state = 'started')],
  ['session already applied', (resource) => (resource.sessionState = 'applied')],
  ['legacy session transport', (resource) => delete resource.sessionTransport],
  ['missing session execution', (resource) => delete resource.sessionExecution],
  ['claims activity used for sessions', (resource) => (resource.sessionExecution = resource.execution)],
  ['missing SDK run epoch', (resource) => delete resource.sessionExecution.runStartedAtNanos],
  ['missing unique operation', (resource) => delete resource.sessionOperationId],
  [
    'mismatched operation marker',
    (resource) => (resource.sessionClaims.temporalAccountSessionOperationId = 'different'),
  ],
  ['unmarked legacy payload', (resource) => delete resource.sessionClaims.temporalAccountSessionOperationId],
  ['invalid frozen cutoff', (resource) => (resource.sessionCutoffSeconds = 'Infinity')],
  ['unsafe frozen cutoff', (resource) => (resource.sessionCutoffSeconds = '9999999999999999')],
])
  test(`session verification rejects ${label} without writes`, async () => {
    const f = sessionFixture();
    mutate(f.map.get(f.resourcePath));
    await assert.rejects(reconcileAccountExecution({ ...f.options, apply: true }, f.helpers));
    assert.deepEqual(f.writes, []);
  });

for (const [label, mutate] of [
  ['full frozen payload', (resource) => (resource.sessionClaims.role = 'admin')],
  [
    'unique operation ID',
    (resource) => {
      resource.sessionOperationId = '223e4567-e89b-42d3-a456-426614174000';
      resource.sessionClaims.temporalAccountSessionOperationId = resource.sessionOperationId;
    },
  ],
  ['frozen cutoff', (resource) => (resource.sessionCutoffSeconds = '1791766124')],
  ['session execution epoch', (resource) => (resource.sessionExecution.runId = 'replacement')],
])
  test(`session transaction rejects concurrent change to ${label}`, async () => {
    const f = sessionFixture();
    let count = 0;
    f.options.kubernetes.observe = async () => {
      if (++count === 1) mutate(f.map.get(f.resourcePath));
      return observation();
    };
    await assert.rejects(reconcileAccountExecution({ ...f.options, apply: true }, f.helpers));
    assert.deepEqual(f.writes, []);
  });

test('session witness is not replaceable and wrong phase never selects an alternate execution', async () => {
  const f = sessionFixture();
  f.map.set('durableActivityDrains/proof-7', { source: 'worker_settled' });
  await assert.rejects(reconcileAccountExecution({ ...f.options, apply: true }, f.helpers), /already exists/);
  await assert.rejects(reconcileAccountExecution({ ...f.options, phase: 'claims', apply: true }, f.helpers));
  await assert.rejects(reconcileAccountExecution({ ...f.options, phase: 'other' }, f.helpers), /Phase/);
  assert.deepEqual(f.writes, []);
});

test('CLI parses explicit phase and rejects malformed arguments before any authenticated access', () => {
  const required = ['--config', '/secure/config.json', '--uid', 'target-user', '--job', 'job'];
  assert.equal(parseRecoveryArguments(required).phase, 'claims');
  assert.deepEqual(parseRecoveryArguments([...required, '--phase', 'sessions', '--apply']).phase, 'sessions');
  assert.equal(parseRecoveryArguments([...required, '--apply']).apply, true);
  for (const suffix of [
    ['--phase', 'unknown'],
    ['--phase'],
    ['--phase', 'sessions', '--phase', 'claims'],
    ['--apply', '--apply'],
    ['--operator', 'pretend'],
  ])
    assert.throws(() => parseRecoveryArguments([...required, ...suffix]));
  assert.throws(() => parseRecoveryArguments(['--uid', 'target-user']));
});
