import { proofDigest } from './temporal-release-runtime.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';

const namespace = 'temporal-staging';
const workerLabel = 'app.kubernetes.io/name';
const versionLabel = 'app.kubernetes.io/version';
const roleLabel = 'urm.temporal/role';
const roles = ['controls', 'email', 'images', 'media', 'orchestration', 'search'];
const uid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const revision = /^[1-9][0-9]*$/;
const buildId = /^[a-f0-9]{40}$/;
const containerId = /^containerd:\/\/[a-f0-9]{64}$/;
const fail = () => {
  throw new Error('TRADITIONAL_KUBERNETES_RETIREMENT_UNCONFIRMED');
};
const workers = (items) => items.filter((item) => item.metadata?.labels?.[workerLabel] === 'urm-temporal-worker');
const sorted = (items) => [...items].sort((a, b) => a.name.localeCompare(b.name));

function metadata(item) {
  const m = item?.metadata;
  if (
    m?.namespace !== namespace ||
    !uid.test(m.uid ?? '') ||
    !revision.test(m.resourceVersion ?? '') ||
    typeof m.name !== 'string'
  )
    fail();
  return m;
}

function list(report, kind, apiVersion) {
  if (
    report?.kind !== `${kind}List` ||
    report.apiVersion !== apiVersion ||
    !revision.test(report.metadata?.resourceVersion ?? '') ||
    report.metadata.continue ||
    !Array.isArray(report.items) ||
    report.items.length > 1000 ||
    report.items.some(
      (item) => (item.kind != null && item.kind !== kind) || (item.apiVersion != null && item.apiVersion !== apiVersion)
    )
  )
    fail();
  return report.items;
}

function controllingOwner(item, kind) {
  const owners = item.metadata.ownerReferences;
  if (
    !Array.isArray(owners) ||
    owners.length !== 1 ||
    owners[0].kind !== kind ||
    owners[0].apiVersion !== 'apps/v1' ||
    owners[0].controller !== true ||
    !uid.test(owners[0].uid ?? '')
  )
    fail();
  return owners[0];
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 20) fail();
  return value;
}

function grace(spec) {
  if (
    spec?.terminationGracePeriodSeconds !== 180 ||
    spec.containers?.length !== 1 ||
    spec.containers[0]?.name !== 'worker' ||
    spec.initContainers?.length ||
    spec.ephemeralContainers?.length ||
    !/@sha256:[a-f0-9]{64}$/.test(spec.containers[0].image ?? '')
  )
    fail();
  return spec.containers[0];
}

function project({ reports, authority }) {
  const { clusterUid, nodeUid, nodeName, builds } = authority;
  const cluster = reports['kube-system'];
  const nodeItems = list(reports.nodes, 'Node', 'v1');
  const node = nodeItems[0];
  if (
    cluster?.kind !== 'Namespace' ||
    cluster.apiVersion !== 'v1' ||
    cluster.metadata?.name !== 'kube-system' ||
    cluster.metadata?.uid !== clusterUid ||
    cluster.status?.phase !== 'Active' ||
    nodeItems.length !== 1 ||
    node.metadata?.uid !== nodeUid ||
    node.metadata?.name !== nodeName ||
    node.metadata.deletionTimestamp ||
    node.spec?.unschedulable ||
    node.status?.conditions?.filter((item) => item.type === 'Ready' && item.status === 'True').length !== 1
  )
    fail();
  const lease = reports.lease;
  const renewedAt = Date.parse(lease?.spec?.renewTime ?? '');
  const owner = lease?.metadata?.ownerReferences;
  if (
    lease?.kind !== 'Lease' ||
    lease.apiVersion !== 'coordination.k8s.io/v1' ||
    lease.metadata?.namespace !== 'kube-node-lease' ||
    lease.metadata.name !== nodeName ||
    !Array.isArray(owner) ||
    owner.length !== 1 ||
    owner[0].kind !== 'Node' ||
    owner[0].name !== nodeName ||
    owner[0].uid !== nodeUid ||
    lease.spec?.holderIdentity !== nodeName ||
    !Number.isFinite(renewedAt) ||
    renewedAt > Date.now() + 5000 ||
    Date.now() - renewedAt > 30000
  )
    fail();
  const allowed = new Set(builds);
  const deployments = workers(list(reports.deployments, 'Deployment', 'apps/v1')).map((item) => {
    const m = metadata(item);
    const labels = m.labels;
    const build = labels[versionLabel],
      role = labels[roleLabel];
    if (
      !allowed.has(build) ||
      !roles.includes(role) ||
      m.name !== serverlessResourceNames(build, role).poolName ||
      m.deletionTimestamp ||
      m.ownerReferences?.length ||
      !Number.isSafeInteger(m.generation) ||
      m.generation < 1 ||
      item.status?.observedGeneration !== m.generation ||
      Object.keys(item.spec?.selector?.matchLabels ?? {}).length !== 3 ||
      item.spec.selector.matchExpressions?.length ||
      [workerLabel, versionLabel, roleLabel].some((k) => labels[k] !== item.spec.selector.matchLabels[k]) ||
      [workerLabel, versionLabel, roleLabel].some((k) => labels[k] !== item.spec.template?.metadata?.labels?.[k])
    )
      fail();
    const image = grace(item.spec.template.spec).image;
    const desired = count(item.spec.replicas);
    if (
      ['replicas', 'readyReplicas', 'availableReplicas', 'updatedReplicas'].some(
        (k) => (item.status[k] ?? 0) !== desired
      ) ||
      (item.status.terminatingReplicas ?? 0) !== 0 ||
      (item.status.unavailableReplicas ?? 0) !== 0
    )
      fail();
    return {
      name: m.name,
      uid: m.uid,
      resourceVersion: m.resourceVersion,
      generation: m.generation,
      build,
      role,
      desired,
      image,
      templateSHA256: proofDigest(item.spec.template),
    };
  });
  const deployByUid = new Map(deployments.map((item) => [item.uid, item]));
  const deployNames = new Set(deployments.map((item) => item.name));
  if (
    !deployments.length ||
    deployByUid.size !== deployments.length ||
    deployNames.size !== deployments.length ||
    builds.some((build) => !deployments.some((item) => item.build === build))
  )
    fail();
  if (
    list(reports.autoscalers, 'HorizontalPodAutoscaler', 'autoscaling/v2').some((item) =>
      deployNames.has(item.spec?.scaleTargetRef?.name)
    )
  )
    fail();

  const replicas = list(reports.replicas, 'ReplicaSet', 'apps/v1').filter(
    (item) =>
      item.metadata?.labels?.[workerLabel] === 'urm-temporal-worker' ||
      item.metadata?.ownerReferences?.some((owner) => deployByUid.has(owner.uid))
  );
  const replicaRows = replicas.map((item) => {
    const m = metadata(item),
      owner = controllingOwner(item, 'Deployment'),
      parent = deployByUid.get(owner.uid);
    if (
      !parent ||
      parent.name !== owner.name ||
      m.labels?.[versionLabel] !== parent.build ||
      m.labels?.[roleLabel] !== parent.role ||
      m.deletionTimestamp ||
      item.status?.observedGeneration !== m.generation
    )
      fail();
    const desired = count(item.spec?.replicas);
    if (
      ['replicas', 'readyReplicas', 'availableReplicas'].some((k) => (item.status[k] ?? 0) !== desired) ||
      (item.status.terminatingReplicas ?? 0) !== 0
    )
      fail();
    return { name: m.name, uid: m.uid, deploymentUid: owner.uid, desired };
  });
  const replicasByUid = new Map(replicaRows.map((item) => [item.uid, item]));
  if (
    replicasByUid.size !== replicaRows.length ||
    deployments.some(
      (item) =>
        replicaRows.filter((r) => r.deploymentUid === item.uid).reduce((n, r) => n + r.desired, 0) !== item.desired
    )
  )
    fail();

  const pods = list(reports.pods, 'Pod', 'v1').filter(
    (item) =>
      item.metadata?.labels?.[workerLabel] === 'urm-temporal-worker' ||
      item.metadata?.ownerReferences?.some((owner) => replicasByUid.has(owner.uid))
  );
  const podRows = pods.map((item) => {
    const m = metadata(item),
      owner = controllingOwner(item, 'ReplicaSet'),
      parent = replicasByUid.get(owner.uid);
    if (
      !parent ||
      parent.name !== owner.name ||
      m.deletionTimestamp ||
      item.spec?.nodeName !== nodeName ||
      item.status?.phase !== 'Running' ||
      item.status.containerStatuses?.length !== 1 ||
      !item.status.conditions?.some((row) => row.type === 'Ready' && row.status === 'True')
    )
      fail();
    const deployment = deployByUid.get(parent.deploymentUid),
      spec = grace(item.spec);
    const status = item.status.containerStatuses[0];
    if (
      spec.image !== deployment.image ||
      m.labels?.[roleLabel] !== deployment.role ||
      m.labels?.[versionLabel] !== deployment.build ||
      status.name !== 'worker' ||
      !status.ready ||
      !status.state?.running ||
      !containerId.test(status.containerID ?? '') ||
      !status.imageID ||
      !Number.isSafeInteger(status.restartCount) ||
      status.restartCount < 0
    )
      fail();
    return {
      name: m.name,
      uid: m.uid,
      replicaUid: parent.uid,
      deploymentUid: deployment.uid,
      containerId: status.containerID,
      restartCount: status.restartCount,
      imageId: status.imageID,
    };
  });
  if (
    new Set(podRows.map((item) => item.uid)).size !== podRows.length ||
    new Set(podRows.map((item) => item.containerId)).size !== podRows.length ||
    replicaRows.some((item) => podRows.filter((pod) => pod.replicaUid === item.uid).length !== item.desired)
  )
    fail();
  return {
    clusterUid,
    nodeUid,
    nodeName,
    builds: [...builds].sort(),
    deployments: sorted(deployments),
    replicaSets: sorted(replicaRows),
    pods: sorted(podRows),
  };
}

/**
 * Read the exact existing cluster. Each resource list must be a complete
 * Kubernetes API list. Bind the later Pod watch to the final native cursor.
 */
export async function observeTraditionalKubernetes(read, authority) {
  if (
    !uid.test(authority?.clusterUid ?? '') ||
    !uid.test(authority.nodeUid ?? '') ||
    !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(authority.nodeName ?? '') ||
    !Array.isArray(authority.builds) ||
    !authority.builds.length ||
    authority.builds.length > 10 ||
    new Set(authority.builds).size !== authority.builds.length ||
    authority.builds.some((build) => !buildId.test(build))
  )
    fail();
  const signals = [
    ['kube-system', '/api/v1/namespaces/kube-system'],
    ['nodes', '/api/v1/nodes'],
    ['lease', `/apis/coordination.k8s.io/v1/namespaces/kube-node-lease/leases/${authority.nodeName}`],
    ['deployments', `/apis/apps/v1/namespaces/${namespace}/deployments`],
    ['replicas', `/apis/apps/v1/namespaces/${namespace}/replicasets`],
    ['pods', `/api/v1/namespaces/${namespace}/pods`],
    ['autoscalers', `/apis/autoscaling/v2/namespaces/${namespace}/horizontalpodautoscalers`],
  ];
  async function scan() {
    const reports = Object.fromEntries(await Promise.all(signals.map(async ([key, path]) => [key, await read(path)])));
    return { projection: project({ reports, authority }), podResourceVersion: reports.pods.metadata.resourceVersion };
  }
  const before = await scan(),
    after = await scan();
  const digest = proofDigest(after.projection);
  if (proofDigest(before.projection) !== digest) fail();
  return { ...after.projection, digest, podResourceVersion: after.podResourceVersion, observedAt: Date.now() };
}

export function traditionalScalePatch(deployment) {
  if (
    !uid.test(deployment?.uid ?? '') ||
    !revision.test(deployment.resourceVersion ?? '') ||
    count(deployment.desired) < 1
  )
    fail();
  return [
    { op: 'test', path: '/metadata/uid', value: deployment.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: deployment.resourceVersion },
    { op: 'test', path: '/spec/replicas', value: deployment.desired },
    { op: 'replace', path: '/spec/replicas', value: 0 },
  ];
}

/** Consume a complete native watch response and retain only per-Pod exit facts.
 * A reconnect resumes from this exact persisted cursor, including after EOF. */
export function advanceTraditionalKubernetesWatch({ before, attemptedAt, progress, watch }) {
  if (
    !Number.isSafeInteger(attemptedAt) ||
    attemptedAt < before.observedAt ||
    !revision.test(before.podResourceVersion ?? '') ||
    !Array.isArray(watch) ||
    watch.length > 10000
  )
    fail();
  const originals = new Map(before.pods.map((pod) => [pod.uid, pod]));
  const initial = progress ?? { beforeSHA256: before.digest, podResourceVersion: before.podResourceVersion, pods: {} };
  if (
    initial.beforeSHA256 !== before.digest ||
    !revision.test(initial.podResourceVersion ?? '') ||
    BigInt(initial.podResourceVersion) < BigInt(before.podResourceVersion) ||
    !initial.pods ||
    typeof initial.pods !== 'object' ||
    Array.isArray(initial.pods)
  )
    fail();
  const pods = new Map(Object.entries(initial.pods));
  for (const [key, state] of pods) {
    if (
      !originals.has(key) ||
      !state ||
      !['graceful', 'terminated', 'removed'].includes(state.stage) ||
      (state.stage === 'graceful'
        ? state.finishedAt !== null
        : !Number.isSafeInteger(state.finishedAt) || state.finishedAt < attemptedAt)
    )
      fail();
  }
  let watchRevision = BigInt(initial.podResourceVersion);
  for (const event of watch) {
    const pod = event?.object;
    const rawRev = pod?.metadata?.resourceVersion;
    if (
      !['ADDED', 'MODIFIED', 'DELETED', 'BOOKMARK'].includes(event?.type) ||
      !revision.test(rawRev ?? '') ||
      BigInt(rawRev) < watchRevision
    )
      fail();
    watchRevision = BigInt(rawRev);
    if (event.type === 'BOOKMARK') continue;
    const original = originals.get(pod.metadata.uid);
    if (!original && pod.metadata.labels?.[workerLabel] !== 'urm-temporal-worker') continue;
    let state = pods.get(original?.uid);
    if (!original || event.type === 'ADDED' || state?.stage === 'removed') fail();
    if (
      (pod.kind != null && pod.kind !== 'Pod') ||
      (pod.apiVersion != null && pod.apiVersion !== 'v1') ||
      metadata(pod).name !== original.name ||
      controllingOwner(pod, 'ReplicaSet').uid !== original.replicaUid ||
      pod.spec?.nodeName !== before.nodeName
    )
      fail();
    const gracePeriod = pod.metadata.deletionGracePeriodSeconds;
    if (
      !state &&
      pod.metadata.deletionTimestamp &&
      Number.isSafeInteger(gracePeriod) &&
      gracePeriod > 0 &&
      gracePeriod <= 180
    )
      state = { stage: 'graceful', finishedAt: null };
    const worker = pod.status?.containerStatuses;
    if (
      worker?.length !== 1 ||
      worker[0].name !== 'worker' ||
      worker[0].restartCount !== original.restartCount ||
      worker[0].containerID !== original.containerId ||
      worker[0].imageID !== original.imageId
    )
      fail();
    const stopped = worker[0].state?.terminated;
    if (stopped) {
      const finishedAt = Date.parse(stopped.finishedAt ?? '');
      if (
        pod.status.phase !== 'Succeeded' ||
        !state ||
        stopped.exitCode !== 0 ||
        Number(stopped.signal ?? 0) !== 0 ||
        stopped.containerID !== original.containerId ||
        !Number.isSafeInteger(finishedAt) ||
        finishedAt < attemptedAt ||
        (state.stage === 'terminated' && state.finishedAt !== finishedAt)
      )
        fail();
      state = { stage: 'terminated', finishedAt };
    } else if (state?.stage === 'terminated') fail();
    if (event.type === 'DELETED') {
      if (state?.stage !== 'terminated') fail();
      state = { ...state, stage: 'removed' };
    }
    if (state) pods.set(original.uid, state);
  }
  return {
    beforeSHA256: before.digest,
    podResourceVersion: String(watchRevision),
    pods: Object.fromEntries([...pods].sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** An empty Pod List or DELETED alone can also result from forced deletion.
 * The continuous Pod watch must show each original container exit cleanly. */
export function confirmTraditionalKubernetesRetired({ before, after, attemptedAt, watch, progress }) {
  if (
    before.clusterUid !== after.clusterUid ||
    before.nodeUid !== after.nodeUid ||
    before.nodeName !== after.nodeName ||
    proofDigest(before.builds) !== proofDigest(after.builds) ||
    !Number.isSafeInteger(attemptedAt) ||
    attemptedAt < before.observedAt ||
    after.observedAt < attemptedAt ||
    after.observedAt > Date.now() ||
    Date.now() - after.observedAt > 30000 ||
    before.deployments.length !== after.deployments.length ||
    after.pods.length ||
    after.replicaSets.some((replica) => replica.desired !== 0) ||
    (watch === undefined) === (progress === undefined)
  )
    fail();
  for (const original of before.deployments) {
    const current = after.deployments.find((row) => row.uid === original.uid);
    if (
      !current ||
      current.name !== original.name ||
      current.templateSHA256 !== original.templateSHA256 ||
      current.desired !== 0 ||
      current.generation !== original.generation + Number(original.desired > 0)
    )
      fail();
  }

  const state = advanceTraditionalKubernetesWatch({ before, attemptedAt, progress, watch: watch ?? [] });
  const exits = Object.entries(state.pods);
  if (
    exits.length !== before.pods.length ||
    exits.some(([, row]) => row.stage !== 'removed' || row.finishedAt > after.observedAt) ||
    !revision.test(after.podResourceVersion ?? '') ||
    BigInt(state.podResourceVersion) < BigInt(after.podResourceVersion)
  )
    fail();
  return {
    beforeSHA256: before.digest,
    afterSHA256: after.digest,
    observedAt: after.observedAt,
    podResourceVersion: state.podResourceVersion,
    exited: exits.map(([key, row]) => [key, row.finishedAt]),
  };
}
