import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceTraditionalKubernetesWatch,
  confirmTraditionalKubernetesRetired,
  observeTraditionalKubernetes,
  traditionalScalePatch,
} from './temporal-traditional-kubernetes.mjs';
import { bindTraditionalKubernetesTransport } from './temporal-traditional-kubernetes-transport.mjs';
import { retireTraditionalWorkers } from './temporal-retire-traditional-workers.mjs';

const makeUid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const build = 'a'.repeat(40);
const authority = { clusterUid: makeUid(1), nodeUid: makeUid(2), nodeName: 'private-node', builds: [build] };
const labels = {
  'app.kubernetes.io/name': 'urm-temporal-worker',
  'app.kubernetes.io/version': build,
  'urm.temporal/role': 'media',
};
const name = `urm-worker-media-${build.slice(0, 20)}`;
const image = `registry.invalid/worker@sha256:${'b'.repeat(64)}`;
const containerID = `containerd://${'c'.repeat(64)}`;
const imageID = image;
const podSpec = { terminationGracePeriodSeconds: 180, containers: [{ name: 'worker', image }] };
const ns = 'temporal-staging';
const meta = (uid, name) => ({ name, namespace: ns, uid: makeUid(uid), resourceVersion: '10', labels });
const owner = (kind, metadata) => ({
  apiVersion: 'apps/v1',
  kind,
  name: metadata.name,
  uid: metadata.uid,
  controller: true,
});
const versions = { Deployment: 'apps/v1', ReplicaSet: 'apps/v1', HorizontalPodAutoscaler: 'autoscaling/v2' };
const list = (kind, items) => ({
  kind: `${kind}List`,
  apiVersion: versions[kind] ?? 'v1',
  metadata: { resourceVersion: '10' },
  items,
});
const counts = (n) => ({ replicas: n, readyReplicas: n, availableReplicas: n, updatedReplicas: n });

function fixture() {
  const deployment = {
    kind: 'Deployment',
    metadata: { ...meta(3, name), generation: 1 },
    spec: { replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: podSpec } },
    status: { observedGeneration: 1, ...counts(1) },
  };
  const replica = {
    kind: 'ReplicaSet',
    metadata: {
      ...meta(4, `${name}-replica`),
      generation: 1,
      ownerReferences: [owner('Deployment', deployment.metadata)],
    },
    spec: { replicas: 1 },
    status: { observedGeneration: 1, ...counts(1) },
  };
  const pod = {
    kind: 'Pod',
    metadata: { ...meta(5, `${name}-replica-pod`), ownerReferences: [owner('ReplicaSet', replica.metadata)] },
    spec: { ...podSpec, nodeName: authority.nodeName },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [
        { name: 'worker', containerID, imageID, ready: true, restartCount: 0, state: { running: {} } },
      ],
    },
  };
  const pods = list('Pod', [pod]);
  const autoscalers = list('HorizontalPodAutoscaler', []);
  const lease = {
    kind: 'Lease',
    apiVersion: 'coordination.k8s.io/v1',
    metadata: {
      namespace: 'kube-node-lease',
      name: authority.nodeName,
      ownerReferences: [{ kind: 'Node', name: authority.nodeName, uid: authority.nodeUid }],
    },
    spec: { holderIdentity: authority.nodeName, renewTime: new Date().toISOString() },
  };
  const responses = {
    'kube-system': {
      kind: 'Namespace',
      apiVersion: 'v1',
      metadata: { name: 'kube-system', uid: authority.clusterUid },
      status: { phase: 'Active' },
    },
    nodes: list('Node', [
      {
        kind: 'Node',
        metadata: { uid: authority.nodeUid, name: authority.nodeName },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      },
    ]),
    deployments: list('Deployment', [deployment]),
    replicasets: list('ReplicaSet', [replica]),
    pods,
    horizontalpodautoscalers: autoscalers,
    [authority.nodeName]: lease,
  };
  return {
    deployment,
    replica,
    pod,
    pods,
    autoscalers,
    lease,
    before: () => observeTraditionalKubernetes((path) => responses[path.split('/').at(-1)], authority),
    read: (path) => responses[path.split('/').at(-1)],
    zero: () => {
      for (const item of [deployment, replica]) {
        item.metadata.generation++;
        item.spec.replicas = 0;
        item.status = { observedGeneration: item.metadata.generation, ...counts(0) };
      }
      pods.items = [];
      pods.metadata.resourceVersion = '14';
    },
  };
}

test('staging inventory joins deployment, replica set and original container; scale plan changes only replicas', async () => {
  const f = fixture();
  const proof = await f.before();
  assert.equal(proof.pods[0].containerId, containerID);
  assert.equal(proof.pods[0].deploymentUid, proof.deployments[0].uid);
  assert.equal(proof.podResourceVersion, '10');
  assert.deepEqual(traditionalScalePatch(proof.deployments[0]), [
    { op: 'test', path: '/metadata/uid', value: makeUid(3) },
    { op: 'test', path: '/metadata/resourceVersion', value: '10' },
    { op: 'test', path: '/spec/replicas', value: 1 },
    { op: 'replace', path: '/spec/replicas', value: 0 },
  ]);
});

test('retirement requires each original worker clean exit under native grace plus verified final controller state', async () => {
  const f = fixture();
  const before = await f.before();
  const attemptedAt = Date.now();
  const graceful = structuredClone(f.pod);
  graceful.metadata.resourceVersion = '11';
  graceful.metadata.deletionTimestamp = new Date(attemptedAt + 180000).toISOString();
  graceful.metadata.deletionGracePeriodSeconds = 180;
  const terminal = structuredClone(graceful);
  terminal.metadata.resourceVersion = '12';
  terminal.status.phase = 'Succeeded';
  terminal.status.containerStatuses[0].state = {
    terminated: { exitCode: 0, containerID, finishedAt: new Date(attemptedAt).toISOString() },
  };
  const watch = [
    { type: 'MODIFIED', object: graceful },
    { type: 'MODIFIED', object: terminal },
    { type: 'DELETED', object: { ...terminal, metadata: { ...terminal.metadata, resourceVersion: '13' } } },
    { type: 'BOOKMARK', object: { metadata: { resourceVersion: '14' } } },
  ];
  f.zero();
  const after = await f.before();
  const run = (changes) => confirmTraditionalKubernetesRetired({ before, attemptedAt, after, watch, ...changes });
  assert.deepEqual(run().exited, [[f.pod.metadata.uid, attemptedAt]]);
  const progress = advanceTraditionalKubernetesWatch({ before, attemptedAt, watch: watch.slice(0, 2) });
  const resumed = advanceTraditionalKubernetesWatch({ before, attemptedAt, progress, watch: watch.slice(2) });
  assert.deepEqual(
    confirmTraditionalKubernetesRetired({ before, attemptedAt, after, progress: resumed }).exited,
    run().exited
  );
  assert.throws(() => run({ watch: [] }), /RETIREMENT_UNCONFIRMED/);
  assert.throws(
    () =>
      run({
        watch: [watch[2], watch[3]].map(({ type, object }) => ({
          type,
          object: { ...object, metadata: { ...object.metadata, deletionGracePeriodSeconds: 0 } },
        })),
      }),
    /RETIREMENT_UNCONFIRMED/
  );
  assert.throws(
    () => run({ watch: [watch[0], { type: 'ERROR', object: { code: 410 } }, ...watch.slice(1)] }),
    /RETIREMENT_UNCONFIRMED/
  );
  assert.throws(
    () =>
      run({
        watch: [
          watch[0],
          { type: 'ADDED', object: { ...graceful, metadata: { ...graceful.metadata, uid: makeUid(9) } } },
          ...watch.slice(1),
        ],
      }),
    /RETIREMENT_UNCONFIRMED/
  );
  assert.throws(
    () => run({ after: { ...after, deployments: [{ ...after.deployments[0], templateSHA256: 'd'.repeat(64) }] } }),
    /RETIREMENT_UNCONFIRMED/
  );
  assert.throws(() => run({ watch: watch.slice(0, 3) }), /RETIREMENT_UNCONFIRMED/);
});

test('native watch transport resumes the durable cursor and exposes no terminal proof on EOF or compaction', async () => {
  const before = await fixture().before();
  const attemptedAt = Date.now();
  const requests = [];
  const transport = bindTraditionalKubernetesTransport(async (path) => {
    requests.push(new URL(path, 'https://kube.invalid').searchParams);
    if (requests.length === 1)
      return JSON.stringify({ type: 'BOOKMARK', object: { metadata: { resourceVersion: '11' } } }) + '\n';
    if (requests.length === 2) return '';
    return JSON.stringify({ type: 'ERROR', object: { code: 410 } }) + '\n';
  });
  const first = await transport.watch({ before, attemptedAt });
  const second = await transport.watch({ before, attemptedAt, progress: first });
  assert.deepEqual(first, second);
  assert.equal(requests[0].get('resourceVersion'), '10');
  assert.equal(requests[1].get('resourceVersion'), '11');
  assert.equal(requests[1].get('watch'), 'true');
  assert.deepEqual(second.pods, {});
  await assert.rejects(transport.watch({ before, attemptedAt, progress: second }), /RETIREMENT_UNCONFIRMED/);
  await assert.rejects(transport.read('/api/v1/secrets'), /TRANSPORT_UNCONFIRMED/);
});

test('native inventory rejects independent scaling, unknown owners and incomplete pagination', async () => {
  const reject = (f) => assert.rejects(f.before(), /RETIREMENT_UNCONFIRMED/);
  const hpa = fixture();
  hpa.autoscalers.items = [{ kind: 'HorizontalPodAutoscaler', spec: { scaleTargetRef: { name } } }];
  await reject(hpa);
  const orphan = fixture();
  orphan.pod.metadata.ownerReferences[0].uid = makeUid(99);
  await reject(orphan);
  const partial = fixture();
  partial.pods.metadata.continue = 'opaque';
  await reject(partial);
  const staleNode = fixture();
  staleNode.lease.spec.renewTime = new Date(Date.now() - 31000).toISOString();
  await reject(staleNode);
});

test('retirement controller leaves one durable attempt per Deployment after an unknown scale ACK', async () => {
  const f = fixture();
  let saved;
  let updates = 0;
  const args = {
    authority,
    releaseId: makeUid(10),
    operationId: makeUid(11),
    bindingDigest: 'a'.repeat(64),
    save: async (state) => {
      saved = state;
    },
    authorizeMutation: async () => {},
    observeProtection: async () => ({
      observedAt: Date.now(),
      protectionSHA256: 'b'.repeat(64),
      temporalSHA256: 'c'.repeat(64),
    }),
    transport: {
      read: async (path) => f.read(path),
      readDeployment: async () => ({ ...f.deployment, apiVersion: 'apps/v1' }),
      scaleOriginalToZero: async () => {
        assert.equal(saved.stage, 'retiring');
        assert.equal(Object.keys(saved.attempts).length, 1);
        updates++;
        throw new Error('unknown acknowledgement');
      },
      watch: async ({ before, attemptedAt, progress }) => {
        if (progress.podResourceVersion === '14') return progress;
        const terminal = structuredClone(f.pod);
        terminal.metadata.resourceVersion = '12';
        terminal.metadata.deletionGracePeriodSeconds = 180;
        terminal.metadata.deletionTimestamp = new Date(attemptedAt + 180000).toISOString();
        terminal.status.phase = 'Succeeded';
        terminal.status.containerStatuses[0].state = {
          terminated: { exitCode: 0, containerID, finishedAt: new Date(attemptedAt).toISOString() },
        };
        return advanceTraditionalKubernetesWatch({
          before,
          attemptedAt,
          progress,
          watch: [
            { type: 'MODIFIED', object: terminal },
            { type: 'DELETED', object: { ...terminal, metadata: { ...terminal.metadata, resourceVersion: '13' } } },
            { type: 'BOOKMARK', object: { metadata: { resourceVersion: '14' } } },
          ],
        });
      },
    },
  };
  await assert.rejects(retireTraditionalWorkers(args), /RETIREMENT_UNCONFIRMED/);
  await assert.rejects(retireTraditionalWorkers({ ...args, saved }), /RETIREMENT_UNCONFIRMED/);
  f.zero();
  assert.equal((await retireTraditionalWorkers({ ...args, saved })).stage, 'completed');
  assert.equal(updates, 1);
});
