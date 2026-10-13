#!/usr/bin/env node
// Rendering is deliberately offline; every remote mutation is in the deploy script.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const versions = JSON.parse(await readFile(resolve(root, 'ops/temporal/versions.json'), 'utf8'));
const expectedProjects = { staging: 'urm-app-staging', production: 'urm-app' };
const dns = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const k8sName = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const reviewedFirebaseResources = Object.freeze({
  'urm-app-staging': {
    storageBucket: 'urm-app-staging.firebasestorage.app',
    imagesBucket: 'urm-app-staging-images',
    databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com/',
  },
  'urm-app': {
    storageBucket: 'urm-app.appspot.com',
    imagesBucket: 'urm-app-images',
    databaseUrl: 'https://urm-app-default-rtdb.firebaseio.com/',
  },
});
const normalizedDatabaseUrl = (value) => {
  try {
    return new URL(value).href;
  } catch {
    return undefined;
  }
};
export function firebaseResourceEnvironment(c) {
  const resources = c.firebaseResources,
    approved = reviewedFirebaseResources[c.firebaseProjectId];
  if (
    !resources ||
    !approved ||
    Object.keys(resources).some((key) => !['storageBucket', 'imagesBucket', 'databaseUrl'].includes(key)) ||
    resources.storageBucket !== approved.storageBucket ||
    resources.imagesBucket !== approved.imagesBucket ||
    typeof resources.databaseUrl !== 'string' ||
    normalizedDatabaseUrl(resources.databaseUrl) !== approved.databaseUrl
  )
    throw new Error(
      'Explicit reviewed Firebase storage, images and RTDB resources must match the exact authorized project bindings'
    );
  return {
    FIREBASE_PROJECT_ID: c.firebaseProjectId,
    GOOGLE_CLOUD_PROJECT: c.firebaseProjectId,
    GCLOUD_PROJECT: c.firebaseProjectId,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: c.firebaseProjectId,
    FIREBASE_STORAGE_BUCKET: resources.storageBucket,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: resources.storageBucket,
    FIREBASE_IMAGES_BUCKET: resources.imagesBucket,
    NEXT_PUBLIC_FIREBASE_IMAGES_BUCKET: resources.imagesBucket,
    FIREBASE_DATABASE_URL: approved.databaseUrl,
    NEXT_PUBLIC_FIREBASE_DATABASE_URL: approved.databaseUrl,
    FIREBASE_CONFIG: JSON.stringify({
      projectId: c.firebaseProjectId,
      storageBucket: resources.storageBucket,
      databaseURL: approved.databaseUrl,
    }),
  };
}
export function assertFirebaseRuntimeSecretResources(c, secret) {
  const expected = firebaseResourceEnvironment(c);
  for (const [name, value] of Object.entries(expected)) {
    if (!Object.hasOwn(secret.data ?? {}, name)) continue;
    const actual = Buffer.from(secret.data[name], 'base64').toString('utf8').trim();
    if (name === 'FIREBASE_CONFIG') {
      let object;
      try {
        object = JSON.parse(actual);
      } catch {
        throw new Error('Runtime Secret Firebase configuration contradicts the reviewed resource descriptor');
      }
      const config = JSON.parse(value);
      if (
        !object ||
        typeof object !== 'object' ||
        Array.isArray(object) ||
        object.projectId !== config.projectId ||
        object.storageBucket !== config.storageBucket ||
        typeof object.databaseURL !== 'string' ||
        normalizedDatabaseUrl(object.databaseURL) !== config.databaseURL
      )
        throw new Error('Runtime Secret Firebase configuration contradicts the reviewed resource descriptor');
    } else if ((name.endsWith('DATABASE_URL') ? normalizedDatabaseUrl(actual) : actual) !== value)
      throw new Error(`Runtime Secret ${name} contradicts the reviewed Firebase resource descriptor`);
  }
}

export function validateInitialSchemaBootstrap(source, backups, tableCounts, now = Date.now()) {
  if (!source?.metadata?.uid || !/^\d+$/.test(source.status?.systemID ?? '') || !source.status?.currentPrimary)
    throw new Error('Initial bootstrap requires a verified current PostgreSQL physical identity');
  if (!['temporal', 'temporal_visibility'].every((db) => tableCounts[db] === 0))
    throw new Error('Initial bootstrap refuses any existing application schema/tables');
  const created = Date.parse(source.metadata.creationTimestamp);
  const completed = backups.some(
    (b) =>
      b.spec?.cluster?.name === 'temporal-postgres' &&
      b.spec?.method === 'plugin' &&
      b.spec?.pluginConfiguration?.name === 'barman-cloud.cloudnative-pg.io' &&
      b.status?.phase === 'completed' &&
      Date.parse(b.metadata?.creationTimestamp) >= created &&
      Number.isFinite(Date.parse(b.status?.stoppedAt)) &&
      Date.parse(b.status.stoppedAt) <= now &&
      now - Date.parse(b.status.stoppedAt) < 172800000
  );
  if (!completed)
    throw new Error(
      'Initial empty-schema bootstrap requires completed recent physical backup of current PostgreSQL cluster'
    );
}
export function validateBackupEvidence(c, evidence) {
  const proofs = evidence.schemaProofs;
  if (
    !Array.isArray(proofs) ||
    !['temporal', 'temporal_visibility'].every((db) =>
      proofs.some(
        (p) =>
          p.database === db &&
          p.version === (db === 'temporal' ? '1.19' : '1.14') &&
          Number.isInteger(p.tableCount) &&
          p.tableCount >= (db === 'temporal' ? 11 : 3)
      )
    )
  )
    throw new Error('Restore evidence lacks actual pinned Temporal schema proof');
  if (
    !Array.isArray(evidence.witnessProofs) ||
    !['temporal', 'temporal_visibility'].every((db) =>
      evidence.witnessProofs.some((p) => p.database === db && p.includedBefore === true && p.excludedAfter === true)
    ) ||
    !evidence.witnessIds?.before ||
    !evidence.witnessIds?.after ||
    evidence.witnessIds.before === evidence.witnessIds.after
  )
    throw new Error('Restore evidence must prove actual pre-target inclusion and post-target exclusion');
  const source = evidence.archiveSource;
  const target = Date.parse(source?.targetTime);
  if (
    !source?.sourceClusterUid ||
    !/^\d+$/.test(source.sourceSystemId ?? '') ||
    source.archiveDestination !== c.backupDestination ||
    source.archiveEndpoint !== c.backupEndpoint ||
    !Number.isFinite(target) ||
    target >= Date.now() ||
    !source.sourceBackup ||
    Date.parse(source.sourceBackupCompletedAt) >= target ||
    !Number.isFinite(Date.parse(source.sourceBackupCompletedAt)) ||
    evidence.recoveryProof?.targetReached !== true ||
    !Number.isFinite(Date.parse(evidence.recoveryProof.firstExcludedTransactionTime)) ||
    Date.parse(evidence.recoveryProof.firstExcludedTransactionTime) < target
  )
    throw new Error('Restore evidence does not prove archive identity and requested PITR boundary');
  return evidence;
}
export function validateCloudEvidence(c, evidence, { requireRecovery = false, now = Date.now() } = {}) {
  const age = now - Date.parse(evidence?.verifiedAt);
  if (
    evidence?.schemaVersion !== 1 ||
    evidence.connectionMode !== 'temporal-cloud' ||
    evidence.projectId !== c.firebaseProjectId ||
    evidence.accountId !== c.cloudAccountId ||
    evidence.namespace !== c.temporalNamespace ||
    evidence.provider !== 'gcp' ||
    evidence.region !== 'us-central1' ||
    JSON.stringify(evidence.replicaRegions) !== JSON.stringify(c.cloudReplicaRegions) ||
    evidence.highAvailabilityEnabled !== c.cloudReplicaRegions.length > 0 ||
    evidence.address !== c.cloudAddress ||
    evidence.namespaceState !== 'ACTIVE' ||
    evidence.tlsVerified !== true ||
    evidence.namespaceAccessVerified !== true ||
    evidence.runtimePermission !== 'Write' ||
    evidence.runtimeServiceAccountScope !== c.temporalNamespace ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 86400000
  )
    throw new Error('Fresh Cloud namespace, regional TLS and scoped runtime identity proof required');
  if (
    requireRecovery &&
    (evidence.recovery?.result !== 'passed' ||
      evidence.recovery.workerBuildId !== c.workerBuildId ||
      evidence.recovery.clusterUid !== c.clusterUid ||
      !evidence.recovery.workflowId ||
      !evidence.recovery.runId ||
      evidence.recovery.workerRestarted !== true ||
      evidence.recovery.resumedOriginalExecution !== true ||
      evidence.recovery.sideEffectsDisabled !== true)
  )
    throw new Error(
      'Cloud readiness requires actual isolated worker restart/resume evidence for this image and cluster'
    );
  return evidence;
}

const cpuMillis = (value = '0') => {
  if (!/^(?:\d+(?:\.\d+)?|\d+m)$/.test(String(value))) throw new Error('Unsupported Kubernetes CPU quantity');
  return String(value).endsWith('m') ? Number(String(value).slice(0, -1)) : Number(value) * 1000;
};
const memoryBytes = (value = '0') => {
  const match = /^(\d+(?:\.\d+)?)([KMGT]i|[KMGT])?$/.exec(String(value));
  if (!match) throw new Error('Unsupported Kubernetes memory quantity');
  return (
    Number(match[1]) *
    ({ Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4 }[
      match[2]
    ] ?? 1)
  );
};
export function validateSingleHostCapacity(c, node, pods, workerManifest) {
  const active = pods.filter((pod) => !['Succeeded', 'Failed'].includes(pod.status?.phase));
  const demand = { cpu: 0, memory: 0 };
  const add = (pod, copies = 1) => {
    const regular = pod.containers ?? [];
    const init = pod.initContainers ?? [];
    for (const [resource, parse] of [
      ['cpu', cpuMillis],
      ['memory', memoryBytes],
    ]) {
      const sum = regular.reduce((total, container) => total + parse(container.resources?.requests?.[resource]), 0);
      const largestInit = Math.max(0, ...init.map((container) => parse(container.resources?.requests?.[resource])));
      demand[resource] += copies * (Math.max(sum, largestInit) + parse(pod.overhead?.[resource]));
    }
  };
  for (const pod of active) add(pod.spec);
  for (const deployment of workerManifest.items.filter((item) => item.kind === 'Deployment')) {
    const labels = deployment.spec.selector.matchLabels;
    const existing = active.filter((pod) =>
      Object.entries(labels).every(([key, value]) => pod.metadata.labels?.[key] === value)
    ).length;
    add(deployment.spec.template.spec, Math.max(0, deployment.spec.replicas - existing));
  }
  if (
    demand.cpu > cpuMillis(node.status?.allocatable?.cpu) ||
    demand.memory > memoryBytes(node.status?.allocatable?.memory)
  )
    throw new Error(
      'Single-host capacity cannot fit retained workers plus this version; drain the old version or explicitly resize the same VM before deployment'
    );
  return demand;
}

export function validateSingleHostMedia(c, proof, now = Date.now()) {
  const age = now - Date.parse(proof?.verifiedAt);
  if (
    proof?.schemaVersion !== 1 ||
    proof.projectId !== c.firebaseProjectId ||
    proof.instanceId !== c.gce.instanceId ||
    proof.clusterUid !== c.clusterUid ||
    proof.mountPoint !== c.gce.mediaMount ||
    proof.filesystem !== 'ext4' ||
    !proof.device ||
    !Number.isSafeInteger(proof.totalBytes) ||
    proof.totalBytes < c.gce.mediaRequiredCapacityGiB * 2 ** 30 ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 86400000
  )
    throw new Error('Actual dedicated mounted media filesystem must cover the reviewed single-host scratch quota');
  return proof;
}

export function validateGceInstance(c, instance) {
  const vm = c.gce;
  if (
    String(instance.id) !== vm.instanceId ||
    instance.name !== vm.instanceName ||
    instance.status !== 'RUNNING' ||
    !instance.selfLink?.includes(`/projects/${c.firebaseProjectId}/`) ||
    !instance.zone?.endsWith(`/${vm.zone}`) ||
    !instance.machineType?.endsWith(`/${vm.machineType}`) ||
    instance.serviceAccounts?.length !== 1 ||
    instance.serviceAccounts[0].email !== vm.serviceAccount ||
    !instance.serviceAccounts[0].scopes?.includes('https://www.googleapis.com/auth/cloud-platform') ||
    instance.networkInterfaces?.[0]?.networkIP !== vm.privateIp
  )
    throw new Error(
      'Actual VM must match reviewed instance/project/zone, private IP and attached keyless project identity'
    );
  return instance;
}

export function validateGkeCluster(c, cluster) {
  const g = c.gke;
  const pool = cluster.nodePools?.find((pool) => pool.name === g.nodePoolName);
  if (
    cluster.name !== g.clusterName ||
    cluster.location !== 'us-central1' ||
    !cluster.selfLink?.includes(`/projects/${c.firebaseProjectId}/`) ||
    cluster.workloadIdentityConfig?.workloadPool !== g.workloadPool ||
    cluster.networkConfig?.datapathProvider !== 'ADVANCED_DATAPATH' ||
    cluster.privateClusterConfig?.enablePrivateNodes !== true ||
    cluster.secretManagerConfig?.enabled !== true ||
    cluster.secretManagerConfig?.rotationConfig?.enabled !== true ||
    cluster.secretManagerConfig?.rotationConfig?.rotationInterval !== '120s' ||
    !pool ||
    pool.config?.workloadMetadataConfig?.mode !== 'GKE_METADATA' ||
    pool.config?.serviceAccount !== g.nodeServiceAccount ||
    pool.autoscaling?.enabled !== true ||
    pool.autoscaling.totalMinNodeCount !== g.minNodes ||
    pool.autoscaling.totalMaxNodeCount !== g.maxNodes ||
    !g.nodeLocations.every((zone) => pool.locations?.includes(zone))
  )
    throw new Error(
      'Actual GKE cluster must match the reviewed project, private Dataplane V2, WIF node pool and regional capacity'
    );
  return cluster;
}

export function kubernetesApiEgress(c) {
  return c.kubernetesApiEndpoints.map(({ cidr, port }) => ({
    to: [{ ipBlock: { cidr } }],
    ports: [{ port, protocol: 'TCP' }],
  }));
}
export function validateConfig(config, peer) {
  const cloud = config.connectionMode === 'temporal-cloud';
  if (config.dispatcherEnabled !== undefined && typeof config.dispatcherEnabled !== 'boolean')
    throw new Error('dispatcherEnabled must be an explicit boolean when supplied');
  if (config.deploymentState === 'planned')
    throw new Error('A planned peer identity cannot be used as an actual deployment target');
  if (config.connectionMode !== undefined && !['self-hosted', 'temporal-cloud'].includes(config.connectionMode))
    throw new Error('Unknown Temporal connection mode');
  const required = [
    'context',
    'clusterUid',
    'namespace',
    'temporalNamespace',
    'firebaseProjectId',
    ...(cloud
      ? ['cloudAccountId', 'cloudProvider', 'cloudRegion', 'cloudAddress', 'cloudEvidence']
      : ['privateApiHost', 'postgresHost', 'postgresServerName', 'postgresCidr', 'backupEvidence']),
    'workerImage',
    'workerBuildId',
    'workerDeploymentName',
  ];
  if (!expectedProjects[config.environment]) throw new Error('environment must be staging or production');
  for (const key of required) {
    if (typeof config[key] !== 'string' || !config[key].trim() || /REQUIRED|PLACEHOLDER|EXAMPLE/.test(config[key])) {
      throw new Error(`Missing concrete ${key}`);
    }
    if (/[\r\n\0]/.test(config[key])) throw new Error(`Invalid ${key}`);
  }
  if (config.firebaseProjectId !== expectedProjects[config.environment])
    throw new Error('Firebase project/environment mismatch');
  if (!cloud && config.temporalNamespace !== config.firebaseProjectId)
    throw new Error('Temporal namespace must equal the Firebase project identity');
  for (const key of ['namespace', ...(cloud ? [] : ['temporalNamespace']), 'workerDeploymentName']) {
    if (!k8sName.test(config[key]) || config[key].length > 63) throw new Error(`Invalid ${key}`);
  }
  if (cloud) {
    firebaseResourceEnvironment(config);
    if (
      config.cloudAccountId !== 'qwejt' ||
      config.cloudProvider !== 'gcp' ||
      config.cloudRegion !== 'us-central1' ||
      !['us-central1.gcp.api.temporal.io:7233', `${config.temporalNamespace}.tmprl.cloud:7233`].includes(
        config.cloudAddress
      ) ||
      config.temporalNamespace !== `${config.firebaseProjectId}.${config.cloudAccountId}`
    )
      throw new Error('Temporal Cloud namespace/account must match Firebase and GCP us-central1');
    if (
      !Array.isArray(config.cloudReplicaRegions) ||
      config.cloudReplicaRegions.length > 1 ||
      config.cloudReplicaRegions.some((region) => region !== 'us-east4') ||
      (config.environment === 'staging' && config.cloudReplicaRegions.length)
    )
      throw new Error('Cloud replica descriptor must explicitly declare no replica or production GCP us-east4');
    if (config.cloudReplicaRegions.length && config.cloudAddress !== `${config.temporalNamespace}.tmprl.cloud:7233`)
      throw new Error('Cloud HA requires the exact account-bound namespace endpoint for managed DNS failover');
    if (config.workerHosting === 'gke') {
      const g = config.gke;
      if (
        config.workerHosting !== 'gke' ||
        !g ||
        g.clusterName !== `urm-temporal-${config.environment}` ||
        g.location !== 'us-central1' ||
        g.workloadPool !== `${config.firebaseProjectId}.svc.id.goog` ||
        g.dataplane !== 'ADVANCED_DATAPATH' ||
        g.firebaseAuthentication !== 'workload-identity' ||
        g.nodePoolName !== 'temporal-workers' ||
        g.operatorServiceAccount !== `temporal-operator@${config.firebaseProjectId}.iam.gserviceaccount.com` ||
        g.secretManagerRotationInterval !== '120s' ||
        g.nodeServiceAccount !== `temporal-nodes@${config.firebaseProjectId}.iam.gserviceaccount.com` ||
        g.minNodes !== 3 ||
        !Number.isInteger(g.maxNodes) ||
        g.maxNodes < 6 ||
        g.maxNodes > 12 ||
        !Array.isArray(g.nodeLocations) ||
        g.nodeLocations.length !== 3 ||
        new Set(g.nodeLocations).size !== 3 ||
        !['us-central1-a', 'us-central1-b', 'us-central1-c'].every((zone) => g.nodeLocations.includes(zone)) ||
        !g.workerServiceAccounts ||
        Object.keys(g.workerServiceAccounts).length !== config.workerRoles?.length ||
        config.workerRoles.some(
          (role) =>
            g.workerServiceAccounts[role] !== `temporal-${role}@${config.firebaseProjectId}.iam.gserviceaccount.com`
        )
      )
        throw new Error(
          'Cloud workers require explicit project-bound keyless GKE identities, private Dataplane V2 and reviewed regional node pool'
        );
    } else if (config.workerHosting === 'gce-k3s') {
      if (config.cloudReplicaRegions.length)
        throw new Error(
          'Simple Cloud hosting is explicitly single-region; replicated failover is outside this selected mode'
        );
      const vm = config.gce;
      if (
        !vm ||
        vm.instanceName !== `urm-temporal-${config.environment}` ||
        !/^\d+$/.test(vm.instanceId ?? '') ||
        vm.zone !== 'us-central1-a' ||
        vm.machineType !== 'e2-standard-4' ||
        vm.serviceAccount !== `temporal-worker@${config.firebaseProjectId}.iam.gserviceaccount.com` ||
        !/^10\./.test(vm.privateIp ?? '') ||
        !isIP(vm.privateIp) ||
        vm.mediaMount !== '/var/lib/urm-temporal/media' ||
        !Number.isSafeInteger(vm.mediaDiskGiB) ||
        vm.mediaDiskGiB < 400 ||
        vm.mediaRequiredCapacityGiB !== 400 ||
        typeof vm.mediaFilesystemEvidence !== 'string' ||
        /REQUIRED|PLACEHOLDER/.test(vm.mediaFilesystemEvidence) ||
        config.workerReplicas !== 1 ||
        config.media?.concurrency !== 1 ||
        config.media?.storageClass !== 'temporal-media-local'
      )
        throw new Error(
          'Simple Cloud workers require one reviewed single-node GCE VM, attached project identity and bounded media capacity'
        );
    } else throw new Error('Cloud worker hosting must be explicit gce-k3s or optional gke');
    if (
      [
        'apiKey',
        'cloudApiKey',
        'postgresHost',
        'postgresServerName',
        'postgresCidr',
        'backupEvidence',
        'backupDestination',
        'databaseMode',
        'historyShards',
        'privateApiHost',
      ].some((key) => config[key] !== undefined)
    )
      throw new Error('Cloud descriptors must not contain raw keys or self-hosted database/server/PITR settings');
  } else {
    for (const key of ['privateApiHost', 'postgresHost', 'postgresServerName']) {
      if (!dns.test(config[key]) || isIP(config[key]))
        throw new Error(`${key} must be private DNS with a matching TLS SAN`);
    }
    const [databaseNetwork, prefix] = config.postgresCidr.split('/');
    if (
      !isIP(databaseNetwork) ||
      !/^\d+$/.test(prefix ?? '') ||
      Number(prefix) < 16 ||
      Number(prefix) > 32 ||
      !(
        databaseNetwork.startsWith('10.') ||
        databaseNetwork.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(databaseNetwork)
      )
    ) {
      throw new Error('postgresCidr must be a scoped private IPv4 CIDR (/16 through /32)');
    }
  }
  if (
    !Array.isArray(config.kubernetesApiEndpoints) ||
    !config.kubernetesApiEndpoints.length ||
    !(cloud && config.workerHosting === 'gke' ? [443] : [443, 6443]).every((port) =>
      config.kubernetesApiEndpoints.some((e) => e.port === port)
    ) ||
    config.kubernetesApiEndpoints.some(
      (e) =>
        !e ||
        ![443, 6443].includes(e.port) ||
        !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(e.cidr ?? '') ||
        !isIP((e.cidr ?? '').split('/')[0]) ||
        !e.cidr.endsWith('/32')
    )
  )
    throw new Error('Exact private Kubernetes service443 and API endpoint6443 /32 addresses are required');
  if (
    !Array.isArray(config.workerIdentityNodeNames) ||
    config.workerIdentityNodeNames.length < (cloud && config.workerHosting === 'gce-k3s' ? 1 : 3) ||
    config.workerIdentityNodeNames.some((n) => !k8sName.test(n))
  )
    throw new Error('Reviewed worker identity Node GET allowlist must contain all private nodes');
  if (
    !cloud &&
    (!Number.isInteger(config.historyShards) ||
      config.historyShards < 128 ||
      config.historyShards > 4096 ||
      (config.historyShards & (config.historyShards - 1)) !== 0)
  )
    throw new Error('historyShards must be a power of two from128 through4096');
  if (!/^([1-9]|[12]\d|30)d$/.test(config.retention)) throw new Error('retention must be 1d through30d');
  if (
    !Array.isArray(config.imagePullSecrets) ||
    config.imagePullSecrets.some((n) => typeof n !== 'string' || !k8sName.test(n) || /REQUIRED|PLACEHOLDER/.test(n))
  )
    throw new Error(
      'Explicit registry pull Secret names required (reviewed empty array only for public/preloaded image)'
    );
  if (!/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(config.workerImage))
    throw new Error('workerImage must use an immutable sha256 digest');
  if (!/^[a-f0-9]{40}$/.test(config.workerBuildId))
    throw new Error('workerBuildId must be the full immutable git commit');
  if (
    !Number.isInteger(config.workerReplicas) ||
    config.workerReplicas < (cloud && config.workerHosting === 'gce-k3s' ? 1 : 2) ||
    config.workerReplicas > 20
  )
    throw new Error('workerReplicas must be2 through20');
  if (
    !Array.isArray(config.workerRoles) ||
    !config.workerRoles.includes('orchestration') ||
    !config.workerRoles.includes('controls') ||
    !config.workerRoles.length ||
    new Set(config.workerRoles).size !== config.workerRoles.length ||
    config.workerRoles.some(
      (role) => !['orchestration', 'controls', 'media', 'email', 'images', 'search'].includes(role)
    )
  )
    throw new Error('workerRoles must explicitly include orchestration and known domain roles without duplicates');
  if (config.workerRoles.includes('email')) {
    const e = config.emailEgress;
    if (
      !e ||
      e.schemaVersion !== 1 ||
      !['smtp', 'sendgrid'].includes(e.provider) ||
      !dns.test(e.hostname ?? '') ||
      /REQUIRED|PLACEHOLDER/.test(e.hostname) ||
      isIP(e.hostname) ||
      !['implicit', 'starttls'].includes(e.tls) ||
      !Array.isArray(e.addresses) ||
      !e.addresses.length ||
      e.addresses.some((a) => !isIP(a) || ['0.0.0.0', '::'].includes(a))
    )
      throw new Error('Email requires explicit provider/TLS hostname and reviewed literal endpoint IPs');
    if (
      e.oauthTokenEgress &&
      (!['accounts.google.com', 'oauth2.googleapis.com'].includes(e.oauthTokenEgress.hostname) ||
        e.oauthTokenEgress.port !== 443 ||
        !Array.isArray(e.oauthTokenEgress.addresses) ||
        !e.oauthTokenEgress.addresses.length ||
        e.oauthTokenEgress.addresses.some((a) => !isIP(a)))
    )
      throw new Error('OAuth email token exchange requires reviewed Google HTTPS hostname and literal IPs');
    if (e.provider === 'smtp' && ![465, 587].includes(e.port))
      throw new Error('SMTP allows only reviewed TLS465 or STARTTLS587');
    if (e.provider === 'smtp' && (e.port === 465) !== (e.tls === 'implicit'))
      throw new Error('SMTP TLS mode must match465 implicit or587 STARTTLS');
    if (e.provider === 'sendgrid' && (e.hostname !== 'api.sendgrid.com' || e.port !== 443 || e.tls !== 'implicit'))
      throw new Error('SendGrid API descriptor must match actual pinned HTTPS transport');
  }
  if (config.workerRoles.includes('media')) {
    const m = config.media;
    if (!m || !Number.isInteger(m.concurrency) || m.concurrency < 1 || m.concurrency > 4)
      throw new Error('media.concurrency must explicitly bound native jobs to1 through4');
    if (m.sourceLimitGiB !== 20 || !Number.isInteger(m.outputLimitGiB) || m.outputLimitGiB < 20)
      throw new Error('Media limits must cover the20GiB admission contract');
    if (
      !Number.isInteger(m.workspaceGiB) ||
      m.workspaceGiB < m.sourceLimitGiB + 2 * m.outputLimitGiB + 4 ||
      !Number.isInteger(m.headroomGiB) ||
      m.headroomGiB < 16
    )
      throw new Error('Media workspace must cover source, two outputs, bumpers and16GiB disk headroom');
    if (
      !/^[1-9]\d*Gi$/.test(m.scratchStorage ?? '') ||
      Number(m.scratchStorage.slice(0, -2)) < m.concurrency * m.workspaceGiB + m.headroomGiB
    )
      throw new Error('Media scratch quota cannot support all concurrent reservations');
    if (
      !Number.isInteger(m.retainedVersions) ||
      m.retainedVersions < 2 ||
      m.retainedVersions > 10 ||
      !/^[1-9]\d*Gi$/.test(m.storageBudget ?? '') ||
      Number(m.storageBudget.slice(0, -2)) <
        Number(m.scratchStorage.slice(0, -2)) * (config.workerReplicas + 1) * m.retainedVersions
    )
      throw new Error('Media CSI budget must support retained worker versions plus release surge');
    if (m.storageClass === config.storageClass)
      throw new Error('Media requires a separate CSI storage-class profile for scoped quota');
    if (!k8sName.test(m.storageClass ?? '') || /REQUIRED|PLACEHOLDER/.test(m.storageClass))
      throw new Error('Media scratch requires a concrete quota-enforced CSI storage class');
  }
  if (!Number.isInteger(config.workerPort) || config.workerPort < 1024 || config.workerPort > 65535)
    throw new Error('Invalid workerPort');
  if (
    !Array.isArray(config.applicationEgressCidrs) ||
    !config.applicationEgressCidrs.length ||
    config.applicationEgressCidrs.some(
      (c) =>
        typeof c !== 'string' ||
        !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(c) ||
        !isIP(c.split('/')[0]) ||
        Number(c.split('/')[1]) > 32
    )
  ) {
    throw new Error('applicationEgressCidrs must explicitly permit provider HTTPS or an approved egress gateway');
  }
  if (!peer || peer.environment === config.environment)
    throw new Error('A descriptor for the other environment is required');
  if (
    cloud &&
    (peer.connectionMode !== 'temporal-cloud' ||
      peer.cloudAccountId !== config.cloudAccountId ||
      peer.cloudProvider !== 'gcp' ||
      peer.cloudRegion !== 'us-central1' ||
      peer.firebaseProjectId !== expectedProjects[peer.environment] ||
      peer.temporalNamespace !== `${expectedProjects[peer.environment]}.${config.cloudAccountId}`)
  )
    throw new Error('Peer Cloud descriptor must prove the other trusted project namespace');
  const plannedPeer = cloud && peer.deploymentState === 'planned';
  if (plannedPeer) {
    const allowed = [
      'environment',
      'deploymentState',
      'connectionMode',
      'firebaseProjectId',
      'temporalNamespace',
      'cloudAccountId',
      'cloudProvider',
      'cloudRegion',
      'workerHosting',
    ];
    if (Object.keys(peer).some((key) => !allowed.includes(key)) || peer.workerHosting !== config.workerHosting)
      throw new Error(
        'Planned peer declares only its trusted project/namespace identity, never fake infrastructure or evidence'
      );
  }
  for (const key of plannedPeer
    ? ['temporalNamespace']
    : ['context', 'clusterUid', ...(cloud ? ['temporalNamespace'] : ['privateApiHost', 'postgresHost'])]) {
    if (
      typeof peer[key] !== 'string' ||
      !peer[key].trim() ||
      /REQUIRED|PLACEHOLDER/.test(peer[key]) ||
      peer[key] === config[key]
    ) {
      throw new Error(`Environments must have distinct concrete ${key}`);
    }
  }
  if (!cloud && !['self-hosted', 'existing-ha'].includes(config.databaseMode))
    throw new Error('databaseMode must be self-hosted or existing-ha');
  if (config.databaseMode === 'self-hosted') {
    if (!config.storageClass || !k8sName.test(config.storageClass))
      throw new Error('A production persistent storageClass is required');
    if (!/^([5-9]\d|[1-9]\d{2,})Gi$/.test(config.databaseStorage))
      throw new Error('databaseStorage must be at least50Gi');
    if (
      !/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/.+/.test(config.backupDestination) ||
      /REQUIRED|PLACEHOLDER/.test(config.backupDestination) ||
      config.backupDestination === peer.backupDestination
    )
      throw new Error('Distinct concrete off-host S3 backup destinations are required');
    if (!/^https:\/\//.test(config.backupEndpoint ?? '') || /REQUIRED|PLACEHOLDER/.test(config.backupEndpoint))
      throw new Error('backupEndpoint must use concrete verified HTTPS');
    if (config.postgresHost !== `temporal-postgres-rw.${config.namespace}.svc.cluster.local`)
      throw new Error('self-hosted postgresHost must address the generated CNPG primary service');
  }
  return config;
}

const spread = (labels) => [
  {
    maxSkew: 1,
    topologyKey: 'kubernetes.io/hostname',
    whenUnsatisfiable: 'DoNotSchedule',
    labelSelector: { matchLabels: labels },
  },
];
const security = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ['ALL'] },
  runAsNonRoot: true,
  seccompProfile: { type: 'RuntimeDefault' },
};
export function renderPlatform(c) {
  const serviceName = 'temporal';
  const database = (name) => ({
    sql: {
      createDatabase: false,
      manageSchema: false,
      pluginName: 'postgres12',
      driverName: 'postgres12',
      databaseName: name,
      connectAddr: `${c.postgresHost}:5432`,
      connectProtocol: 'tcp',
      user: 'temporal',
      existingSecret: 'temporal-database',
      secretKey: 'password',
      maxConns: 20,
      maxIdleConns: 10,
      maxConnLifetime: '30m',
      tls: {
        enabled: true,
        caFile: '/etc/temporal/database-ca/ca.crt',
        serverName: c.postgresServerName,
        enableHostVerification: true,
      },
    },
  });
  const roles = {};
  for (const component of ['frontend', 'history', 'matching', 'worker']) {
    roles[component] = {
      replicaCount: 3,
      podDisruptionBudget: { minAvailable: 2 },
      topologySpreadConstraints: spread({
        'app.kubernetes.io/name': serviceName,
        'app.kubernetes.io/instance': serviceName,
        'app.kubernetes.io/component': component,
      }),
      containerSecurityContext: security,
    };
  }
  const values = {
    fullnameOverride: serviceName,
    serviceAccount: { create: true, name: 'temporal-server' },
    server: {
      replicaCount: 3,
      image: { repository: 'temporalio/server', tag: `${versions.server}@${versions.serverDigest}` },
      resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { memory: '2Gi' } },
      deploymentStrategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      minReadySeconds: 20,
      terminationGracePeriodSeconds: 90,
      additionalVolumes: [{ name: 'database-ca', secret: { secretName: 'temporal-database-ca' } }],
      additionalVolumeMounts: [{ name: 'database-ca', mountPath: '/etc/temporal/database-ca', readOnly: true }],
      tls: {
        internode: {
          enabled: true,
          secretName: 'temporal-internode-tls',
          requireClientAuth: true,
          serverName: c.privateApiHost,
        },
        frontend: {
          enabled: true,
          secretName: 'temporal-frontend-tls',
          requireClientAuth: true,
          serverName: c.privateApiHost,
        },
      },
      config: {
        logLevel: 'info',
        tls: {
          refreshInterval: '1m',
          expirationChecks: { warningWindow: '168h', errorWindow: '24h', checkInterval: '1h' },
        },
        persistence: {
          numHistoryShards: c.historyShards,
          defaultStore: 'default',
          visibilityStore: 'visibility',
          datastores: { default: database('temporal'), visibility: database('temporal_visibility') },
        },
        namespaces: { create: false },
      },
      ...roles,
      'internal-frontend': { enabled: false },
      dynamicConfig: {
        'frontend.globalNamespaceRPS': [
          { value: c.environment === 'production' ? 500 : 100, constraints: { namespace: c.temporalNamespace } },
        ],
      },
    },
    // No shell-bearing admin deployment is left running after setup jobs.
    admintools: {
      enabled: false,
      image: { repository: 'temporalio/admin-tools', tag: `${versions.server}@${versions.adminToolsDigest}` },
      useExternalFrontend: true,
    },
    schema: { backoffLimit: 1, activeDeadlineSeconds: 900 },
    web: {
      enabled: true,
      replicaCount: 2,
      image: { repository: 'temporalio/ui', tag: `${versions.ui}@${versions.uiDigest}` },
      service: { type: 'ClusterIP' },
      ingress: { enabled: false },
      tls: { enabled: true, secretName: 'temporal-ui-tls', serverName: c.privateApiHost, enableHostVerification: true },
      containerSecurityContext: security,
      resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '512Mi' } },
      podDisruptionBudget: { minAvailable: 1 },
      topologySpreadConstraints: spread({
        'app.kubernetes.io/name': 'temporal',
        'app.kubernetes.io/instance': 'temporal',
        'app.kubernetes.io/component': 'web',
      }),
    },
  };
  const appLabels = { 'app.kubernetes.io/name': 'urm-temporal-worker', 'app.kubernetes.io/version': c.workerBuildId };
  const workerName = `urm-worker-${c.workerBuildId.slice(0, 20)}`;
  const worker = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: workerName, namespace: c.namespace, labels: appLabels },
    spec: {
      replicas: c.workerReplicas,
      revisionHistoryLimit: 3,
      minReadySeconds: 15,
      progressDeadlineSeconds: 600,
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      selector: { matchLabels: appLabels },
      template: {
        metadata: { labels: appLabels },
        spec: {
          automountServiceAccountToken: false,
          imagePullSecrets: c.imagePullSecrets.map((name) => ({ name })),
          terminationGracePeriodSeconds: 180,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
          topologySpreadConstraints: spread(appLabels),
          containers: [
            {
              name: 'worker',
              image: c.workerImage,
              securityContext: { ...security, readOnlyRootFilesystem: true },
              ports: [
                { name: 'health', containerPort: c.workerPort },
                { name: 'metrics', containerPort: 9464 },
              ],
              startupProbe: { httpGet: { path: '/healthz', port: 'health' }, periodSeconds: 5, failureThreshold: 60 },
              livenessProbe: { httpGet: { path: '/healthz', port: 'health' }, periodSeconds: 15 },
              readinessProbe: { httpGet: { path: '/readyz', port: 'health' }, periodSeconds: 5, failureThreshold: 3 },
              resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { memory: '2Gi' } },
              env: Object.entries({
                TEMPORAL_ADDRESS: `temporal-frontend.${c.namespace}.svc.cluster.local:7233`,
                TEMPORAL_TLS_SERVER_NAME: c.privateApiHost,
                TEMPORAL_NAMESPACE: c.temporalNamespace,
                TEMPORAL_TLS_CA_FILE: '/run/temporal-tls/ca.crt',
                TEMPORAL_TLS_CERT_FILE: '/run/temporal-tls/tls.crt',
                TEMPORAL_TLS_KEY_FILE: '/run/temporal-tls/tls.key',
                TEMPORAL_DEPLOYMENT_NAME: c.workerDeploymentName,
                TEMPORAL_BUILD_ID: c.workerBuildId,
                FIREBASE_PROJECT_ID: c.firebaseProjectId,
                PORT: String(c.workerPort),
                GOOGLE_APPLICATION_CREDENTIALS: '/run/firebase/service-account.json',
                TEMPORAL_METRICS_ADDRESS: '0.0.0.0:9464',
                NODE_OPTIONS: '--max-old-space-size=1536',
              }).map(([name, value]) => ({ name, value })),
              envFrom: [{ secretRef: { name: 'temporal-worker-runtime' } }],
              volumeMounts: [
                { name: 'tls', mountPath: '/run/temporal-tls', readOnly: true },
                { name: 'firebase', mountPath: '/run/firebase', readOnly: true },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            },
          ],
          volumes: [
            { name: 'tls', secret: { secretName: 'temporal-worker-tls', defaultMode: 288 } },
            { name: 'firebase', secret: { secretName: 'temporal-firebase', defaultMode: 288 } },
            { name: 'tmp', emptyDir: { sizeLimit: '256Mi' } },
          ],
        },
      },
    },
  };
  const pdb = {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: { name: workerName, namespace: c.namespace },
    spec: { minAvailable: 1, selector: { matchLabels: appLabels } },
  };
  const temporalPeers = { podSelector: { matchLabels: { 'app.kubernetes.io/name': 'temporal' } } };
  const workerPeers = { podSelector: { matchLabels: { 'app.kubernetes.io/name': 'urm-temporal-worker' } } };
  const operatorPeers = { podSelector: { matchLabels: { 'urm.temporal/operator': 'true' } } };
  const dnsEgress = {
    to: [
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
      },
    ],
    ports: [
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ],
  };
  const policy = (name, spec) => ({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name, namespace: c.namespace },
    spec,
  });
  const network = {
    apiVersion: 'v1',
    kind: 'List',
    items: [
      policy('default-deny', { podSelector: {}, policyTypes: ['Ingress', 'Egress'] }),
      policy('temporal-server', {
        podSelector: temporalPeers.podSelector,
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          {
            from: [temporalPeers],
            ports: [6933, 6934, 6935, 6939, 7233, 7234, 7235, 7239, 8080].map((port) => ({ port, protocol: 'TCP' })),
          },
          { from: [workerPeers, operatorPeers], ports: [{ port: 7233, protocol: 'TCP' }] },
          {
            from: [{ namespaceSelector: { matchLabels: { 'urm.temporal/monitoring': 'true' } } }],
            ports: [{ port: 9090, protocol: 'TCP' }],
          },
        ],
        egress: [
          dnsEgress,
          {
            to: [temporalPeers],
            ports: [6933, 6934, 6935, 6939, 7233, 7234, 7235, 7239].map((port) => ({ port, protocol: 'TCP' })),
          },
          {
            to: [
              { ipBlock: { cidr: c.postgresCidr } },
              ...(c.databaseMode === 'self-hosted'
                ? [{ podSelector: { matchLabels: { 'cnpg.io/cluster': 'temporal-postgres' } } }]
                : []),
            ],
            ports: [{ port: 5432, protocol: 'TCP' }],
          },
        ],
      }),
      policy('application-worker', {
        podSelector: workerPeers.podSelector,
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          {
            from: [{ namespaceSelector: { matchLabels: { 'urm.temporal/monitoring': 'true' } } }],
            ports: [{ port: 9464, protocol: 'TCP' }],
          },
        ],
        egress: [
          dnsEgress,
          { to: [temporalPeers], ports: [{ port: 7233, protocol: 'TCP' }] },
          {
            to: c.applicationEgressCidrs.map((cidr) => ({ ipBlock: { cidr } })),
            ports: [{ port: 443, protocol: 'TCP' }],
          },
        ],
      }),
      policy('operator-jobs', {
        podSelector: operatorPeers.podSelector,
        policyTypes: ['Ingress', 'Egress'],
        ingress: [],
        egress: [
          dnsEgress,
          { to: [temporalPeers], ports: [{ port: 7233, protocol: 'TCP' }] },
          {
            to: [
              { ipBlock: { cidr: c.postgresCidr } },
              ...(c.databaseMode === 'self-hosted'
                ? [{ podSelector: { matchLabels: { 'cnpg.io/cluster': 'temporal-postgres' } } }]
                : []),
            ],
            ports: [{ port: 5432, protocol: 'TCP' }],
          },
        ],
      }),
    ],
  };
  const workerItems = [];
  for (const role of c.workerRoles) {
    const deployment = structuredClone(worker),
      budget = structuredClone(pdb);
    const roleName = `urm-worker-${role}-${c.workerBuildId.slice(0, 20)}`;
    deployment.metadata.name = roleName;
    budget.metadata.name = roleName;
    for (const labels of [
      deployment.metadata.labels,
      deployment.spec.selector.matchLabels,
      deployment.spec.template.metadata.labels,
      deployment.spec.template.spec.topologySpreadConstraints[0].labelSelector.matchLabels,
      budget.spec.selector.matchLabels,
    ])
      labels['urm.temporal/role'] = role;
    const container = deployment.spec.template.spec.containers[0];
    container.env.push(
      { name: 'TEMPORAL_TASK_QUEUES', value: `urm-${role}` },
      { name: 'TEMPORAL_DISPATCHER_ENABLED', value: String(role === 'orchestration' && c.dispatcherEnabled !== false) }
    );
    container.envFrom = [{ secretRef: { name: `temporal-worker-${role}-runtime` } }];
    deployment.spec.template.spec.volumes.find(
      (volume) => volume.name === 'firebase'
    ).secret.secretName = `temporal-firebase-${role}`;
    if (role === 'controls') container.env.push({ name: 'TEMPORAL_CONTROLS_CONCURRENCY', value: '10' });
    if (role === 'email') {
      container.env.push({ name: 'EMAIL_EGRESS_DESCRIPTOR_PATH', value: '/run/email/egress.json' });
      container.volumeMounts.push({ name: 'email-egress', mountPath: '/run/email', readOnly: true });
      deployment.spec.template.spec.volumes.push({
        name: 'email-egress',
        configMap: { name: 'temporal-email-egress' },
      });
    }
    if (role === 'orchestration') {
      const pod = deployment.spec.template.spec;
      pod.serviceAccountName = 'temporal-worker-orchestration';
      container.env.push(
        { name: 'TEMPORAL_CLUSTER_ID', value: c.clusterUid },
        ...Object.entries({
          TEMPORAL_WORKER_POD_NAME: 'metadata.name',
          TEMPORAL_WORKER_POD_UID: 'metadata.uid',
          TEMPORAL_WORKER_POD_NAMESPACE: 'metadata.namespace',
          TEMPORAL_WORKER_NODE_NAME: 'spec.nodeName',
        }).map(([name, fieldPath]) => ({ name, valueFrom: { fieldRef: { fieldPath } } }))
      );
      container.volumeMounts.push({
        name: 'kubernetes-identity',
        mountPath: '/var/run/secrets/kubernetes.io/serviceaccount',
        readOnly: true,
      });
      pod.volumes.push({
        name: 'kubernetes-identity',
        projected: {
          defaultMode: 288,
          sources: [
            { serviceAccountToken: { path: 'token', expirationSeconds: 3600 } },
            { configMap: { name: 'kube-root-ca.crt', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
            { downwardAPI: { items: [{ path: 'namespace', fieldRef: { fieldPath: 'metadata.namespace' } }] } },
          ],
        },
      });
    }
    if (role === 'media') {
      const m = c.media;
      container.resources = {
        requests: { cpu: '2', memory: '2Gi', 'ephemeral-storage': '1Gi' },
        limits: { memory: '4Gi', 'ephemeral-storage': '2Gi' },
      };
      container.env.push(
        ...Object.entries({
          TEMPORAL_MEDIA_CONCURRENCY: String(m.concurrency),
          TEMPORAL_MEDIA_MAX_SOURCE_BYTES: String(m.sourceLimitGiB * 2 ** 30),
          TEMPORAL_MEDIA_MAX_OUTPUT_BYTES: String(m.outputLimitGiB * 2 ** 30),
          TEMPORAL_MEDIA_WORKSPACE_MAX_BYTES: String(m.workspaceGiB * 2 ** 30),
          TEMPORAL_MEDIA_DISK_HEADROOM_BYTES: String(m.headroomGiB * 2 ** 30),
          TMPDIR: '/tmp',
        }).map(([name, value]) => ({ name, value }))
      );
      const pod = deployment.spec.template.spec;
      pod.securityContext.fsGroupChangePolicy = 'OnRootMismatch';
      const index = pod.volumes.findIndex((v) => v.name === 'tmp');
      pod.volumes[index] = {
        name: 'tmp',
        ephemeral: {
          volumeClaimTemplate: {
            metadata: { labels: { 'urm.temporal/role': 'media', 'urm.temporal/scratch': 'true' } },
            spec: {
              accessModes: ['ReadWriteOnce'],
              storageClassName: m.storageClass,
              resources: { requests: { storage: m.scratchStorage } },
            },
          },
        },
      };
    }
    if (role === 'search') {
      container.env.push({ name: 'TEMPORAL_SEARCH_CONFIG_FILE', value: '/run/search/instances.json' });
      container.volumeMounts.push({ name: 'search', mountPath: '/run/search', readOnly: true });
      deployment.spec.template.spec.volumes.push({
        name: 'search',
        secret: { secretName: 'temporal-search-config', defaultMode: 288 },
      });
    }
    workerItems.push(deployment, budget);
  }
  if (c.workerRoles.includes('email')) {
    workerItems.push({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'temporal-email-egress', namespace: c.namespace },
      data: { 'egress.json': JSON.stringify(c.emailEgress) },
    });
    network.items.push({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'email-reviewed-provider', namespace: c.namespace },
      spec: {
        podSelector: { matchLabels: { 'app.kubernetes.io/name': 'urm-temporal-worker', 'urm.temporal/role': 'email' } },
        policyTypes: ['Egress'],
        egress: [
          {
            to: c.emailEgress.addresses.map((ip) => ({ ipBlock: { cidr: `${ip}/${isIP(ip) === 4 ? 32 : 128}` } })),
            ports: [{ port: c.emailEgress.port, protocol: 'TCP' }],
          },
        ],
      },
    });
  }
  if (c.emailEgress?.oauthTokenEgress) {
    const emailPolicy = network.items.find((p) => p.metadata.name === 'email-reviewed-provider');
    emailPolicy.spec.egress.push({
      to: c.emailEgress.oauthTokenEgress.addresses.map((ip) => ({
        ipBlock: { cidr: `${ip}/${isIP(ip) === 4 ? 32 : 128}` },
      })),
      ports: [{ port: 443, protocol: 'TCP' }],
    });
  }
  workerItems.push(
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: 'temporal-worker-orchestration', namespace: c.namespace },
      automountServiceAccountToken: false,
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: 'temporal-worker-identity', namespace: c.namespace },
      rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get'] }],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: 'temporal-worker-identity', namespace: c.namespace },
      subjects: [{ kind: 'ServiceAccount', name: 'temporal-worker-orchestration', namespace: c.namespace }],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'temporal-worker-identity' },
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name: `${c.namespace}-worker-node-identity` },
      rules: [
        { apiGroups: [''], resources: ['nodes'], resourceNames: c.workerIdentityNodeNames, verbs: ['get'] },
        { apiGroups: [''], resources: ['namespaces'], resourceNames: ['kube-system'], verbs: ['get'] },
      ],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: `${c.namespace}-worker-node-identity` },
      subjects: [{ kind: 'ServiceAccount', name: 'temporal-worker-orchestration', namespace: c.namespace }],
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'ClusterRole',
        name: `${c.namespace}-worker-node-identity`,
      },
    }
  );
  network.items.push({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'orchestration-private-api', namespace: c.namespace },
    spec: {
      podSelector: {
        matchLabels: { 'app.kubernetes.io/name': 'urm-temporal-worker', 'urm.temporal/role': 'orchestration' },
      },
      policyTypes: ['Egress'],
      egress: kubernetesApiEgress(c),
    },
  });
  if (c.workerRoles.includes('media'))
    workerItems.push({
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata: { name: 'temporal-media-scratch', namespace: c.namespace },
      spec: {
        hard: { [`${c.media.storageClass}.storageclass.storage.k8s.io/requests.storage`]: c.media.storageBudget },
      },
    });
  if (c.connectionMode === 'temporal-cloud') {
    for (const deployment of workerItems.filter((item) => item.kind === 'Deployment')) {
      const pod = deployment.spec.template.spec;
      const container = pod.containers[0];
      container.env = container.env.filter(
        ({ name }) =>
          !name.startsWith('TEMPORAL_TLS_') &&
          !['TEMPORAL_ADDRESS', 'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_PROJECT_ID'].includes(name)
      );
      container.env.push(
        ...Object.entries({
          TEMPORAL_CONNECTION_MODE: 'temporal-cloud',
          TEMPORAL_CLOUD_ACCOUNT_ID: c.cloudAccountId,
          TEMPORAL_CLOUD_PROVIDER: c.cloudProvider,
          TEMPORAL_CLOUD_REGION: c.cloudRegion,
          TEMPORAL_ADDRESS: c.cloudAddress,
          TEMPORAL_API_KEY_FILE: '/run/temporal-cloud/api-key',
          ...firebaseResourceEnvironment(c),
        }).map(([name, value]) => ({ name, value }))
      );
      container.volumeMounts = container.volumeMounts.filter((mount) => !['tls', 'firebase'].includes(mount.name));
      const role = deployment.metadata.labels['urm.temporal/role'];
      pod.serviceAccountName = `temporal-worker-${role}`;
      if (c.workerHosting === 'gke')
        pod.nodeSelector = {
          'cloud.google.com/gke-nodepool': c.gke.nodePoolName,
          'iam.gke.io/gke-metadata-server-enabled': 'true',
        };
      container.volumeMounts.push({ name: 'temporal-cloud', mountPath: '/run/temporal-cloud', readOnly: true });
      pod.volumes = pod.volumes.filter((volume) => !['tls', 'firebase'].includes(volume.name));
      pod.volumes.push(
        c.workerHosting === 'gke'
          ? {
              name: 'temporal-cloud',
              csi: {
                driver: 'secrets-store-gke.csi.k8s.io',
                readOnly: true,
                volumeAttributes: { secretProviderClass: 'temporal-worker-api-key' },
              },
            }
          : { name: 'temporal-cloud', secret: { secretName: 'temporal-worker-api-key', defaultMode: 288 } }
      );
      if (role === 'media' && c.workerHosting === 'gce-k3s') {
        container.resources.requests.cpu = '1';
        container.resources.limits.cpu = '2';
      }
    }
    if (c.workerHosting === 'gce-k3s')
      for (const role of c.workerRoles.filter((role) => role !== 'orchestration'))
        workerItems.push({
          apiVersion: 'v1',
          kind: 'ServiceAccount',
          metadata: { name: `temporal-worker-${role}`, namespace: c.namespace },
          automountServiceAccountToken: false,
        });
    if (c.workerHosting === 'gke') {
      for (const role of c.workerRoles) {
        const name = `temporal-worker-${role}`;
        const account = workerItems.find((item) => item.kind === 'ServiceAccount' && item.metadata.name === name);
        const annotations = { 'iam.gke.io/gcp-service-account': c.gke.workerServiceAccounts[role] };
        if (account) account.metadata.annotations = annotations;
        else
          workerItems.push({
            apiVersion: 'v1',
            kind: 'ServiceAccount',
            metadata: { name, namespace: c.namespace, annotations },
            automountServiceAccountToken: false,
          });
      }
      workerItems.push({
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: {
          name: 'temporal-platform-operator',
          namespace: c.namespace,
          annotations: { 'iam.gke.io/gcp-service-account': c.gke.operatorServiceAccount },
        },
        automountServiceAccountToken: false,
      });
      for (const [name, secretName] of [
        ['temporal-worker-api-key', 'TEMPORAL_WORKER_API_KEY'],
        ['temporal-operator-api-key', 'TEMPORAL_OPERATOR_API_KEY'],
      ]) {
        workerItems.push({
          apiVersion: 'secrets-store.csi.x-k8s.io/v1',
          kind: 'SecretProviderClass',
          metadata: { name, namespace: c.namespace },
          spec: {
            provider: 'gke',
            parameters: {
              secrets: `- resourceName: "projects/${c.firebaseProjectId}/secrets/${secretName}/versions/latest"\n  path: "api-key"\n`,
            },
          },
        });
      }
    }
    network.items = network.items.filter((policy) => !['temporal-server'].includes(policy.metadata.name));
    network.items
      .find((policy) => policy.metadata.name === 'application-worker')
      .spec.egress.push({
        to: [{ ipBlock: { cidr: '169.254.169.254/32' } }],
        ports: [{ port: 80, protocol: 'TCP' }, ...(c.workerHosting === 'gke' ? [{ port: 8080, protocol: 'TCP' }] : [])],
      });
    for (const policy of network.items.filter((policy) =>
      ['application-worker', 'operator-jobs'].includes(policy.metadata.name)
    )) {
      policy.spec.egress = policy.spec.egress.filter(
        (rule) => !rule.ports.some(({ port }) => [7233, 5432].includes(port))
      );
      // Namespace DNS supports managed HA failover; TLS authenticates its fixed trusted hostname.
      policy.spec.egress.push({
        to: c.applicationEgressCidrs.map((cidr) => ({ ipBlock: { cidr } })),
        ports: [{ port: 7233, protocol: 'TCP' }],
      });
    }
  }
  return {
    ...(c.connectionMode === 'temporal-cloud' ? {} : { values }),
    worker: { apiVersion: 'v1', kind: 'List', items: workerItems },
    network,
    ...(c.connectionMode === 'temporal-cloud' ? {} : { certificates: certificateManifests(c) }),
    monitoring:
      c.connectionMode === 'temporal-cloud'
        ? { scrape_configs: monitoringConfig(c).scrape_configs.filter((job) => job.job_name === 'temporal-sdk-worker') }
        : monitoringConfig(c),
    ...(c.databaseMode === 'self-hosted' ? { database: databaseCluster(c) } : {}),
  };
}

export function monitoringConfig(c) {
  const discovery = [{ role: 'pod', namespaces: { names: [c.namespace] } }];
  const relabel = [
    { source_labels: ['__meta_kubernetes_pod_phase'], regex: 'Running', action: 'keep' },
    { target_label: 'platform', replacement: 'urm-temporal' },
    { target_label: 'environment', replacement: c.environment },
    { source_labels: ['__meta_kubernetes_pod_name'], target_label: 'pod' },
    { source_labels: ['__meta_kubernetes_namespace'], target_label: 'kubernetes_namespace' },
  ];
  return {
    scrape_configs: [
      {
        job_name: 'temporal-server',
        scrape_interval: '30s',
        kubernetes_sd_configs: discovery,
        relabel_configs: [
          ...relabel,
          {
            source_labels: ['__meta_kubernetes_pod_label_app_kubernetes_io_component'],
            regex: 'frontend|history|matching|worker',
            action: 'keep',
          },
          { source_labels: ['__meta_kubernetes_pod_container_port_number'], regex: '9090', action: 'keep' },
          { source_labels: ['__meta_kubernetes_pod_label_app_kubernetes_io_component'], target_label: 'component' },
        ],
      },
      {
        job_name: 'temporal-sdk-worker',
        scrape_interval: '30s',
        kubernetes_sd_configs: discovery,
        relabel_configs: [
          ...relabel,
          {
            source_labels: ['__meta_kubernetes_pod_label_app_kubernetes_io_name'],
            regex: 'urm-temporal-worker',
            action: 'keep',
          },
          { source_labels: ['__meta_kubernetes_pod_container_port_number'], regex: '9464', action: 'keep' },
          { source_labels: ['__meta_kubernetes_pod_label_urm_temporal_role'], target_label: 'role' },
          { source_labels: ['__meta_kubernetes_pod_label_app_kubernetes_io_version'], target_label: 'build_id' },
        ],
      },
      {
        job_name: 'temporal-postgres',
        scrape_interval: '30s',
        kubernetes_sd_configs: discovery,
        relabel_configs: [
          ...relabel,
          {
            source_labels: ['__meta_kubernetes_pod_label_cnpg_io_cluster'],
            regex: 'temporal-postgres',
            action: 'keep',
          },
          { source_labels: ['__meta_kubernetes_pod_container_port_number'], regex: '9187', action: 'keep' },
        ],
      },
    ],
  };
}

export function certificateManifests(c) {
  const issuer = {
    apiVersion: 'cert-manager.io/v1',
    kind: 'Issuer',
    metadata: { name: 'temporal-private-ca', namespace: c.namespace },
    spec: { ca: { secretName: 'temporal-root-ca' } },
  };
  const items = [issuer];
  for (const name of ['internode', 'frontend', 'worker', 'operator', 'ui', 'database-server']) {
    const server = ['internode', 'frontend', 'database-server'].includes(name);
    items.push({
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: { name: `temporal-${name}`, namespace: c.namespace },
      spec: {
        secretName: `temporal-${name}-tls`,
        duration: '2160h',
        renewBefore: '720h',
        privateKey: { algorithm: 'ECDSA', size: 256, rotationPolicy: 'Always' },
        issuerRef: { name: 'temporal-private-ca', kind: 'Issuer' },
        commonName: server
          ? name === 'database-server'
            ? c.postgresServerName
            : c.privateApiHost
          : `urm-${c.environment}-${name}`,
        ...(server ? { dnsNames: [name === 'database-server' ? c.postgresServerName : c.privateApiHost] } : {}),
        usages: server ? ['server auth', 'client auth'] : ['client auth'],
      },
    });
  }
  return { apiVersion: 'v1', kind: 'List', items };
}

// Temporal CLI1.9.1 deliberately emits formatted JSON, not the raw gRPC response.
// https://github.com/temporalio/cli/blob/v1.9.1/internal/temporalcli/commands.worker.deployment.go
export function assertWorkerRouting(report, c) {
  const info = report.workerDeploymentInfo ?? report;
  const routing = info.routingConfig;
  const current = routing?.currentDeploymentVersion;
  const deployment = current?.deploymentName ?? routing?.currentVersionDeploymentName;
  const build = current?.buildId ?? routing?.currentVersionBuildID;
  if (
    deployment !== c.workerDeploymentName ||
    build !== c.workerBuildId ||
    Number(routing?.rampingVersionPercentage ?? 0) !== 0 ||
    routing?.rampingVersionBuildID ||
    routing?.rampingDeploymentVersion?.buildId
  )
    throw new Error('Reviewed worker must be current with no ramp before cutover');
}
export function assertWorkerQueues(report, c) {
  const info = report.workerDeploymentVersionInfo ?? report;
  const version = info.deploymentVersion ?? { deploymentName: info.deploymentName, buildId: info.BuildID };
  if (version.deploymentName !== c.workerDeploymentName || version.buildId !== c.workerBuildId)
    throw new Error('Queue registration report belongs to another immutable worker version');
  const queues = report.versionTaskQueues ?? info.taskQueuesInfos ?? [];
  const type = (t) =>
    t === 'activity' || t === 'TASK_QUEUE_TYPE_ACTIVITY' || t === 2
      ? 'activity'
      : t === 'workflow' || t === 'TASK_QUEUE_TYPE_WORKFLOW' || t === 1
      ? 'workflow'
      : undefined;
  for (const role of c.workerRoles) {
    if (!queues.some((q) => q.name === `urm-${role}` && type(q.type ?? q.taskQueueType) === 'activity'))
      throw new Error(`Missing native activity queue urm-${role}`);
    if (
      role === 'orchestration' &&
      !queues.some((q) => q.name === 'urm-orchestration' && type(q.type ?? q.taskQueueType) === 'workflow')
    )
      throw new Error('Missing native orchestration workflow poller');
  }
}
export function assertDrained(report, c) {
  const info = report.workerDeploymentVersionInfo ?? report;
  const version = info.deploymentVersion ?? { deploymentName: info.deploymentName, buildId: info.BuildID };
  const status = info.drainageInfo?.status ?? info.drainageInfo?.drainageStatus;
  // Nil protobuf timestamps are rendered as Unix epoch by this CLI's AsTime conversion.
  const absentTime = (value) =>
    value === undefined ||
    value === null ||
    value === '' ||
    ['1970-01-01T00:00:00Z', '0001-01-01T00:00:00Z'].includes(value);
  if (
    version.deploymentName !== c.workerDeploymentName ||
    version.buildId !== c.workerBuildId ||
    !['VERSION_DRAINAGE_STATUS_DRAINED', 'drained'].includes(status) ||
    !absentTime(info.currentSinceTime) ||
    !absentTime(info.rampingSinceTime) ||
    Number(info.rampPercentage ?? 0) !== 0
  )
    throw new Error('Live Temporal report must prove exact version DRAINED and neither current nor ramping');
}

export function schemaJob(c, mode = 'upgrade') {
  if (c.connectionMode === 'temporal-cloud') throw new Error('Cloud schema operations are managed by Temporal');
  if (!['bootstrap', 'upgrade'].includes(mode)) throw new Error('Schema mode must be bootstrap or upgrade');
  // Bootstrap is a separate explicit operator action on an empty database, never part of normal deploy.
  const command =
    'set -eu\n' +
    ['temporal', 'temporal_visibility']
      .map((database) => {
        const schema = database === 'temporal' ? 'temporal' : 'visibility';
        const common = `temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_HOST" -p 5432 -u temporal --db ${database} --tls --tls-ca-file /run/database-ca/ca.crt`;
        return (
          (mode === 'bootstrap' ? `${common} setup-schema -v 0.0\n` : '') +
          `${common} update-schema -d /etc/temporal/schema/postgresql/v12/${schema}/versioned`
        );
      })
      .join('\n');
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { generateName: `temporal-schema-${mode}-`, namespace: c.namespace },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 900,
      ttlSecondsAfterFinished: 86400,
      template: {
        metadata: { labels: { 'urm.temporal/operator': 'true' } },
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: 'Never',
          securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 },
          containers: [
            {
              name: 'schema',
              image: `temporalio/admin-tools:${versions.server}@${versions.adminToolsDigest}`,
              securityContext: security,
              command: ['/bin/sh', '-c', command],
              env: [
                { name: 'POSTGRES_HOST', value: c.postgresHost },
                { name: 'SQL_TLS_SERVER_NAME', value: c.postgresServerName },
                { name: 'SQL_PASSWORD', valueFrom: { secretKeyRef: { name: 'temporal-database', key: 'password' } } },
              ],
              resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '512Mi' } },
              volumeMounts: [{ name: 'database-ca', mountPath: '/run/database-ca', readOnly: true }],
            },
          ],
          volumes: [{ name: 'database-ca', secret: { secretName: 'temporal-database-ca' } }],
        },
      },
    },
  };
}

export function databaseCluster(c) {
  const objectStore = {
    apiVersion: 'barmancloud.cnpg.io/v1',
    kind: 'ObjectStore',
    metadata: { name: 'temporal-backups', namespace: c.namespace },
    spec: {
      retentionPolicy: '30d',
      configuration: {
        destinationPath: c.backupDestination,
        endpointURL: c.backupEndpoint,
        s3Credentials: {
          accessKeyId: { name: 'temporal-backup-objectstore', key: 'ACCESS_KEY_ID' },
          secretAccessKey: { name: 'temporal-backup-objectstore', key: 'ACCESS_SECRET_KEY' },
        },
        wal: { compression: 'gzip', maxParallel: 2 },
        data: { compression: 'gzip', jobs: 2 },
      },
    },
  };
  const cluster = {
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Cluster',
    metadata: { name: 'temporal-postgres', namespace: c.namespace },
    spec: {
      instances: 3,
      inheritedMetadata: { labels: { 'urm.temporal/database-network': 'temporal-postgres' } },
      imageName: versions.postgresImage,
      enableSuperuserAccess: false,
      storage: { size: c.databaseStorage, storageClass: c.storageClass },
      walStorage: { size: '20Gi', storageClass: c.storageClass },
      resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { memory: '4Gi' } },
      affinity: { enablePodAntiAffinity: true, podAntiAffinityType: 'required', topologyKey: 'kubernetes.io/hostname' },
      certificates: { serverTLSSecret: 'temporal-database-server-tls', serverCASecret: 'temporal-database-ca' },
      postgresql: {
        parameters: { max_connections: '300', shared_buffers: '256MB', archive_timeout: '60s', log_statement: 'none' },
        synchronous: { method: 'any', number: 1, dataDurability: 'required' },
      },
      bootstrap: {
        initdb: {
          database: 'temporal',
          owner: 'temporal',
          secret: { name: 'temporal-database' },
          encoding: 'UTF8',
          dataChecksums: true,
        },
      },
      plugins: [
        {
          name: 'barman-cloud.cloudnative-pg.io',
          isWALArchiver: true,
          parameters: { barmanObjectName: 'temporal-backups' },
        },
      ],
      monitoring: { enablePodMonitor: false },
    },
  };
  const visibility = {
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Database',
    metadata: { name: 'temporal-visibility', namespace: c.namespace },
    spec: { name: 'temporal_visibility', owner: 'temporal', cluster: { name: 'temporal-postgres' }, ensure: 'present' },
  };
  const scheduled = {
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'ScheduledBackup',
    metadata: { name: 'temporal-nightly', namespace: c.namespace },
    spec: {
      schedule: '0 0 2 * * *',
      backupOwnerReference: 'self',
      immediate: true,
      cluster: { name: 'temporal-postgres' },
      method: 'plugin',
      pluginConfiguration: { name: 'barman-cloud.cloudnative-pg.io' },
    },
  };
  const policy = databaseNetworkPolicy(c);
  return { apiVersion: 'v1', kind: 'List', items: [objectStore, cluster, visibility, scheduled, policy] };
}

export function emailCanary(c, script) {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { generateName: 'temporal-email-canary-', namespace: c.namespace },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 120,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'urm-temporal-worker', 'urm.temporal/role': 'email' } },
        spec: {
          automountServiceAccountToken: false,
          imagePullSecrets: c.imagePullSecrets.map((name) => ({ name })),
          restartPolicy: 'Never',
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
          containers: [
            {
              name: 'canary',
              image: c.workerImage,
              command: ['node', '-e', script],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '256Mi' } },
              envFrom: [{ secretRef: { name: 'temporal-worker-email-runtime' } }],
              env: [
                { name: 'EMAIL_EGRESS_DESCRIPTOR_PATH', value: '/run/email/egress.json' },
                { name: 'FIREBASE_PROJECT_ID', value: c.firebaseProjectId },
                { name: 'TEMPORAL_BUILD_ID', value: c.workerBuildId },
              ],
              volumeMounts: [{ name: 'email-egress', mountPath: '/run/email', readOnly: true }],
            },
          ],
          volumes: [{ name: 'email-egress', configMap: { name: 'temporal-email-egress' } }],
        },
      },
    },
  };
}

export function databaseApiCanary(c, namespace, clusterName, pod, script) {
  const labels = { 'urm.temporal/database-network': clusterName };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { generateName: 'temporal-database-api-canary-', namespace },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 120,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels },
        spec: {
          serviceAccountName: clusterName,
          imagePullSecrets: c.imagePullSecrets.map((name) => ({ name })),
          automountServiceAccountToken: true,
          restartPolicy: 'Never',
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
          containers: [
            {
              name: 'canary',
              image: c.workerImage,
              command: ['node', '-e', script],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '256Mi' } },
              env: Object.entries({
                CANARY_NAMESPACE: namespace,
                CANARY_POD_NAME: pod.metadata.name,
                CANARY_POD_UID: pod.metadata.uid,
                CANARY_ENDPOINTS: JSON.stringify(c.kubernetesApiEndpoints),
              }).map(([name, value]) => ({ name, value })),
            },
          ],
        },
      },
    },
  };
}

export function databaseNetworkPolicy(c, namespace = c.namespace, clusterName = 'temporal-postgres') {
  const policy = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: clusterName, namespace },
    spec: {
      podSelector: { matchLabels: { 'urm.temporal/database-network': clusterName } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        {
          from: [
            { podSelector: { matchLabels: { 'cnpg.io/cluster': clusterName } } },
            { podSelector: { matchLabels: { 'app.kubernetes.io/name': 'temporal' } } },
            { podSelector: { matchLabels: { 'urm.temporal/operator': 'true' } } },
          ],
          ports: [{ port: 5432, protocol: 'TCP' }],
        },
        {
          from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'cnpg-system' } } }],
          ports: [{ port: 8000, protocol: 'TCP' }],
        },
        {
          from: [{ namespaceSelector: { matchLabels: { 'urm.temporal/monitoring': 'true' } } }],
          ports: [{ port: 9187, protocol: 'TCP' }],
        },
      ],
      egress: [
        ...kubernetesApiEgress(c),
        {
          to: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
              podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
            },
          ],
          ports: [
            { port: 53, protocol: 'UDP' },
            { port: 53, protocol: 'TCP' },
          ],
        },
        {
          to: [{ podSelector: { matchLabels: { 'cnpg.io/cluster': clusterName } } }],
          ports: [{ port: 5432, protocol: 'TCP' }],
        },
        {
          to: c.applicationEgressCidrs.map((cidr) => ({ ipBlock: { cidr } })),
          ports: [{ port: 443, protocol: 'TCP' }],
        },
      ],
    },
  };
  return policy;
}

export function renderOperatorJob(config, name, command, fallback) {
  const escaped = (arg) => `'${arg.replaceAll("'", "'\\''")}'`;
  const cli = (args) =>
    [
      'temporal',
      '--disable-config-file',
      ...(config.connectionMode === 'temporal-cloud'
        ? ['--address', config.cloudAddress, '--namespace', config.temporalNamespace, '--tls']
        : [
            '--disable-config-env',
            '--address',
            `temporal-frontend.${config.namespace}.svc.cluster.local:7233`,
            '--namespace',
            config.temporalNamespace,
            '--tls-ca-path',
            '/run/tls/ca.crt',
            '--tls-cert-path',
            '/run/tls/tls.crt',
            '--tls-key-path',
            '/run/tls/tls.key',
            '--tls-server-name',
            config.privateApiHost,
          ]),
      ...args,
    ]
      .map(escaped)
      .join(' ');
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { generateName: `temporal-${name}-`, namespace: config.namespace },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 300,
      ttlSecondsAfterFinished: 86400,
      template: {
        metadata: { labels: { 'urm.temporal/operator': 'true' } },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          ...(config.connectionMode === 'temporal-cloud' && config.workerHosting === 'gke'
            ? {
                serviceAccountName: 'temporal-platform-operator',
                nodeSelector: {
                  'cloud.google.com/gke-nodepool': config.gke.nodePoolName,
                  'iam.gke.io/gke-metadata-server-enabled': 'true',
                },
              }
            : {}),
          securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 },
          containers: [
            {
              name: 'operator',
              image: versions.cliImage,
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] },
                seccompProfile: { type: 'RuntimeDefault' },
              },
              resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '512Mi' } },
              command: [
                '/bin/sh',
                '-c',
                `${
                  config.connectionMode === 'temporal-cloud'
                    ? 'export TEMPORAL_API_KEY="$(cat /run/tls/api-key)"; '
                    : ''
                }${fallback ? `${cli(command)} >/dev/null 2>&1 || ${cli(fallback)}` : cli(command)}`,
              ],
              volumeMounts: [{ name: 'tls', mountPath: '/run/tls', readOnly: true }],
            },
          ],
          volumes: [
            config.connectionMode === 'temporal-cloud' && config.workerHosting === 'gke'
              ? {
                  name: 'tls',
                  csi: {
                    driver: 'secrets-store-gke.csi.k8s.io',
                    readOnly: true,
                    volumeAttributes: { secretProviderClass: 'temporal-operator-api-key' },
                  },
                }
              : {
                  name: 'tls',
                  secret: {
                    secretName:
                      config.connectionMode === 'temporal-cloud'
                        ? 'temporal-operator-api-key'
                        : 'temporal-operator-tls',
                    defaultMode: 288,
                  },
                },
          ],
        },
      },
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2);
    const flags = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
    if (!['render', 'validate'].includes(action) || !flags['--config'] || !flags['--peer'])
      throw new Error(
        'Usage: temporal-platform.mjs render|validate --config PATH --peer PATH [--output DIR] [--schema-mode bootstrap|upgrade]'
      );
    const c = validateConfig(
      JSON.parse(await readFile(flags['--config'], 'utf8')),
      JSON.parse(await readFile(flags['--peer'], 'utf8'))
    );
    if (action === 'render') {
      if (!flags['--output']) throw new Error('--output is required');
      await mkdir(flags['--output'], { recursive: true });
      if (c.connectionMode === 'temporal-cloud') {
        for (const filename of ['values.json', 'schema.json', 'certificates.json', 'database.json']) {
          try {
            await readFile(resolve(flags['--output'], filename));
          } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
          }
          throw new Error('Cloud rendering requires an output directory without stale self-hosted artifacts');
        }
      }
      for (const [name, data] of Object.entries({
        ...renderPlatform(c),
        ...(c.connectionMode === 'temporal-cloud' ? {} : { schema: schemaJob(c, flags['--schema-mode'] ?? 'upgrade') }),
      })) {
        await writeFile(resolve(flags['--output'], `${name}.json`), JSON.stringify(data, null, 2) + '\n', {
          mode: 0o600,
        });
      }
    }
    console.log(`Temporal ${c.environment} configuration validated${action === 'render' ? ' and rendered' : ''}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
