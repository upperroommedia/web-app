import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateConfig,
  validateCloudEvidence,
  validateGkeCluster,
  validateGceInstance,
  validateSingleHostCapacity,
  validateSingleHostMedia,
  renderOperatorJob,
  waitPlatformJob,
  platformOperatorCommands,
  firebaseResourceEnvironment,
  assertFirebaseRuntimeSecretResources,
  renderPlatform,
  schemaJob,
  certificateManifests,
  emailCanary,
  databaseApiCanary,
  assertDrained,
  assertWorkerRouting,
  assertWorkerQueues,
  validateBackupEvidence,
  validateInitialSchemaBootstrap,
} from './temporal-platform.mjs';

const config = {
  environment: 'staging',
  context: 'private-staging',
  clusterUid: 'cluster-staging',
  namespace: 'temporal-staging',
  temporalNamespace: 'urm-app-staging',
  firebaseProjectId: 'urm-app-staging',
  privateApiHost: 'temporal.staging.internal',
  postgresHost: 'temporal-postgres-rw.temporal-staging.svc.cluster.local',
  postgresServerName: 'temporal-postgres-rw.temporal-staging.svc.cluster.local',
  postgresCidr: '10.42.0.0/16',
  applicationEgressCidrs: ['0.0.0.0/0'],
  historyShards: 512,
  retention: '7d',
  backupEvidence: '/secure/restore.json',
  imagePullSecrets: [],
  workerImage: `ghcr.io/upperroommedia/temporal-worker@sha256:${'a'.repeat(64)}`,
  workerBuildId: 'b'.repeat(40),
  workerDeploymentName: 'urm-worker-staging',
  workerReplicas: 2,
  workerRoles: ['orchestration', 'controls', 'media', 'email', 'images', 'search'],
  workerPort: 8080,
  emailEgress: {
    schemaVersion: 1,
    provider: 'smtp',
    hostname: 'smtp.example.org',
    port: 465,
    tls: 'implicit',
    addresses: ['64.233.179.109'],
  },
  kubernetesApiEndpoints: [
    { cidr: '10.43.0.1/32', port: 443 },
    { cidr: '10.0.0.1/32', port: 6443 },
  ],
  workerIdentityNodeNames: ['node-1', 'node-2', 'node-3'],
  media: {
    concurrency: 2,
    sourceLimitGiB: 20,
    outputLimitGiB: 20,
    workspaceGiB: 64,
    headroomGiB: 16,
    scratchStorage: '160Gi',
    retainedVersions: 2,
    storageBudget: '960Gi',
    storageClass: 'quota-csi',
  },
  databaseMode: 'self-hosted',
  storageClass: 'durable-csi',
  databaseStorage: '100Gi',
  backupDestination: 's3://offsite-staging/temporal/',
  backupEndpoint: 'https://backups.example.org',
};
const peer = {
  ...config,
  environment: 'production',
  context: 'private-production',
  clusterUid: 'cluster-production',
  privateApiHost: 'temporal.production.internal',
  postgresHost: 'temporal-postgres-rw.temporal-production.svc.cluster.local',
  backupDestination: 's3://offsite-production/temporal/',
};

test('concrete physically separated environment descriptors validate', () =>
  assert.equal(validateConfig(config, peer), config));
for (const [field, value] of [
  ['context', 'REQUIRED'],
  ['firebaseProjectId', 'urm-app'],
  ['postgresCidr', '0.0.0.0/0'],
  ['historyShards', 4],
  ['workerImage', 'ghcr.io/example:latest'],
  ['workerBuildId', 'main'],
  ['workerReplicas', 1],
  ['applicationEgressCidrs', []],
  ['backupEndpoint', 'http://objectstore'],
  ['databaseStorage', '10Gi'],
  ['storageClass', ''],
]) {
  test(`unsafe ${field} fails closed`, () => assert.throws(() => validateConfig({ ...config, [field]: value }, peer)));
}
for (const field of ['context', 'clusterUid', 'privateApiHost', 'postgresHost', 'backupDestination']) {
  test(`stage/prod cannot share ${field}`, () =>
    assert.throws(() => validateConfig(config, { ...peer, [field]: config[field] })));
}
test('server disables public services and auto schema changes; mTLS verifies both stores', () => {
  const { values } = renderPlatform(config);
  assert.equal(values.server.tls.frontend.requireClientAuth, true);
  assert.equal(values.server.tls.internode.requireClientAuth, true);
  assert.equal(values.server['internal-frontend'].enabled, false);
  assert.equal(values.web.ingress.enabled, false);
  assert.equal(values.web.service.type, 'ClusterIP');
  for (const store of Object.values(values.server.config.persistence.datastores)) {
    assert.equal(store.sql.manageSchema, false);
    assert.equal(store.sql.createDatabase, false);
    assert.equal(store.sql.tls.enableHostVerification, true);
    assert.equal(store.sql.tls.enabled, true);
    assert.equal(store.sql.existingSecret, 'temporal-database');
    assert.equal(store.sql.password, undefined);
  }
  for (const role of ['frontend', 'history', 'matching', 'worker']) {
    assert.equal(values.server[role].replicaCount, 3);
    assert.equal(values.server[role].podDisruptionBudget.minAvailable, 2);
    assert.equal(values.server[role].topologySpreadConstraints[0].whenUnsatisfiable, 'DoNotSchedule');
  }
});
test('immutable worker versions coexist and runtime credentials stay in secrets', () => {
  const old = renderPlatform(config).worker.items[0];
  const next = renderPlatform({ ...config, workerBuildId: 'c'.repeat(40) }).worker.items[0];
  assert.notEqual(old.metadata.name, next.metadata.name);
  const pod = old.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.containers[0].readinessProbe.httpGet.path, '/readyz');
  assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.equal(pod.containers[0].env.find((e) => e.name === 'TEMPORAL_BUILD_ID').value, config.workerBuildId);
  assert.equal(pod.containers[0].env.find((e) => e.name === 'FIREBASE_PROJECT_ID').value, 'urm-app-staging');
});
test('database has quorum, independent persistent volumes, checksums, continuous WAL, and scheduled base backups', () => {
  const { items } = renderPlatform(config).database;
  const db = items.find((i) => i.kind === 'Cluster').spec;
  assert.equal(db.instances, 3);
  assert.equal(db.affinity.podAntiAffinityType, 'required');
  assert.equal(db.storage.size, '100Gi');
  assert.equal(db.walStorage.size, '20Gi');
  assert.equal(db.postgresql.synchronous.dataDurability, 'required');
  assert.equal(db.postgresql.synchronous.number, 1);
  assert.equal(db.postgresql.parameters.archive_timeout, '60s');
  assert.equal(db.plugins[0].isWALArchiver, true);
  assert.equal(items.find((i) => i.kind === 'Database').spec.name, 'temporal_visibility');
  assert.equal(items.find((i) => i.kind === 'ScheduledBackup').spec.method, 'plugin');
});
test('migration updates both schemas and does not quietly reinitialize existing stores', () => {
  const command = schemaJob(config).spec.template.spec.containers[0].command[2];
  assert.match(command, /--db temporal [^\n]* update-schema/);
  assert.match(command, /--db temporal_visibility [^\n]* update-schema/);
  assert.doesNotMatch(command, /setup-schema|--quiet|create/);
  assert.match(schemaJob(config, 'bootstrap').spec.template.spec.containers[0].command[2], /setup-schema -v 0.0/);
  assert.equal(schemaJob(config).spec.backoffLimit, 0);
});
test('private CA issues short-lived distinct workload certificates and rotates keys', () => {
  const certificates = certificateManifests(config).items.filter((i) => i.kind === 'Certificate');
  assert.equal(certificates.length, 6);
  for (const cert of certificates) assert.equal(cert.spec.privateKey.rotationPolicy, 'Always');
  const worker = certificates.find((i) => i.metadata.name === 'temporal-worker');
  assert.deepEqual(worker.spec.usages, ['client auth']);
  assert.equal(worker.spec.dnsNames, undefined);
});
test('default deny keeps workers away from database and UI while allowing provider HTTPS', () => {
  const policies = renderPlatform(config).network.items;
  assert.deepEqual(policies.find((p) => p.metadata.name === 'default-deny').spec.policyTypes, ['Ingress', 'Egress']);
  const worker = policies.find((p) => p.metadata.name === 'application-worker').spec;
  assert.deepEqual(worker.ingress[0].ports, [{ port: 9464, protocol: 'TCP' }]);
  assert.equal(worker.ingress[0].from[0].namespaceSelector.matchLabels['urm.temporal/monitoring'], 'true');
  const ports = worker.egress.flatMap((r) => r.ports.map((p) => p.port));
  assert.ok(ports.includes(443));
  assert.ok(ports.includes(7233));
  assert.ok(!ports.includes(5432));
  assert.ok(!ports.includes(8080));
});
test('only exact live drained worker may be retired', () => {
  const info = {
    deploymentVersion: { deploymentName: config.workerDeploymentName, buildId: config.workerBuildId },
    drainageInfo: { status: 'VERSION_DRAINAGE_STATUS_DRAINED' },
  };
  assert.doesNotThrow(() => assertDrained({ workerDeploymentVersionInfo: info }, config));
  assert.throws(() => assertDrained({ ...info, currentSinceTime: '2026-01-01' }, config));
  assert.throws(() => assertDrained({ ...info, drainageInfo: { status: 'VERSION_DRAINAGE_STATUS_DRAINING' } }, config));
  assert.throws(() => assertDrained(info, { ...config, workerBuildId: 'd'.repeat(40) }));
});

test('separate domain workers use scoped provider and Firebase secrets while sharing one deployment version', () => {
  const deployments = renderPlatform(config).worker.items.filter((r) => r.kind === 'Deployment');
  assert.equal(deployments.length, 6);
  for (const deployment of deployments) {
    const role = deployment.metadata.labels['urm.temporal/role'];
    const pod = deployment.spec.template.spec;
    const env = Object.fromEntries(pod.containers[0].env.map((e) => [e.name, e.value]));
    assert.equal(env.TEMPORAL_DEPLOYMENT_NAME, config.workerDeploymentName);
    assert.equal(env.TEMPORAL_BUILD_ID, config.workerBuildId);
    assert.equal(env.TEMPORAL_TASK_QUEUES, `urm-${role}`);
    assert.equal(env.TEMPORAL_DISPATCHER_ENABLED, String(role === 'orchestration'));
    assert.equal(pod.containers[0].envFrom[0].secretRef.name, `temporal-worker-${role}-runtime`);
    assert.equal(pod.volumes.find((v) => v.name === 'firebase').secret.secretName, `temporal-firebase-${role}`);
    assert.equal(Boolean(env.TEMPORAL_SEARCH_CONFIG_FILE), role === 'search');
  }
});

for (const failure of ['wrong-cluster', 'insufficient-nodes', 'unsupported-kubernetes']) {
  test(`remote ${failure} preflight performs no mutations even with --apply`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'temporal-preflight-test-'));
    try {
      const executable = join(directory, 'kubectl');
      await writeFile(
        executable,
        `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(process.env.TEST_KUBECTL_LOG,JSON.stringify(args)+'\\n');
if(args.includes('kube-system')) console.log(JSON.stringify({metadata:{uid:${JSON.stringify(
          failure === 'wrong-cluster' ? 'another-cluster' : config.clusterUid
        )}}}));
else if(args.includes('nodes')) console.log(JSON.stringify({items:Array.from({length:${
          failure === 'insufficient-nodes' ? 2 : 3
        }},(_,i)=>({metadata:{labels:{'kubernetes.io/hostname':'node'+i}},spec:{},status:{conditions:[{type:'Ready',status:'True'}]}}))}));
else if(args.includes('version')) console.log(JSON.stringify({serverVersion:{major:'1',minor:${JSON.stringify(
          failure === 'unsupported-kubernetes' ? '37' : '36'
        )}}}));
else {console.error('Unexpected remote operation');process.exit(99);}
`
      );
      await chmod(executable, 0o700);
      await writeFile(join(directory, 'config.json'), JSON.stringify(config));
      await writeFile(join(directory, 'peer.json'), JSON.stringify(peer));
      assert.throws(() =>
        execFileSync(
          process.execPath,
          [
            new URL('./deploy-temporal-platform.mjs', import.meta.url).pathname,
            'worker',
            '--config',
            join(directory, 'config.json'),
            '--peer',
            join(directory, 'peer.json'),
            '--apply',
          ],
          {
            env: {
              ...process.env,
              PATH: `${directory}:${process.env.PATH}`,
              TEST_KUBECTL_LOG: join(directory, 'calls.jsonl'),
            },
            stdio: 'pipe',
          }
        )
      );
      const calls = (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.ok(calls.every((call) => call[0] === '--context' && call[1] === config.context));
      assert.ok(calls.every((call) => call.includes('get') || call.includes('version')));
      assert.ok(!calls.some((call) => ['apply', 'create', 'delete', 'patch'].some((verb) => call.includes(verb))));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const media of [
  { ...config.media, concurrency: 0 },
  { ...config.media, retainedVersions: 1 },
  { ...config.media, storageBudget: '640Gi' },
  { ...config.media, scratchStorage: '128Gi' },
  { ...config.media, workspaceGiB: 60 },
  { ...config.media, sourceLimitGiB: 10 },
  { ...config.media, storageClass: 'REQUIRED' },
]) {
  test(`unsafe media capacity ${JSON.stringify(media)} fails closed`, () =>
    assert.throws(() => validateConfig({ ...config, media }, peer)));
}
test('media pods get independent quota-enforced scratch claims and native byte reservations', () => {
  const media = renderPlatform(config).worker.items.find(
    (v) => v.kind === 'Deployment' && v.metadata.labels['urm.temporal/role'] === 'media'
  );
  const pod = media.spec.template.spec;
  assert.equal(
    pod.volumes.find((v) => v.name === 'tmp').ephemeral.volumeClaimTemplate.spec.resources.requests.storage,
    '160Gi'
  );
  assert.equal(
    pod.containers[0].env.find((v) => v.name === 'TEMPORAL_MEDIA_WORKSPACE_MAX_BYTES').value,
    String(64 * 2 ** 30)
  );
  assert.equal(pod.containers[0].env.find((v) => v.name === 'TEMPORAL_MEDIA_CONCURRENCY').value, '2');
  assert.equal(pod.securityContext.fsGroup, 1000);
});

test('SMTP ports are permitted only for the email role and exact reviewed endpoint addresses', () => {
  const { network, worker } = renderPlatform(config);
  const policy = network.items.find((p) => p.metadata.name === 'email-reviewed-provider');
  assert.equal(policy.spec.podSelector.matchLabels['urm.temporal/role'], 'email');
  assert.deepEqual(policy.spec.egress, [
    { to: [{ ipBlock: { cidr: '64.233.179.109/32' } }], ports: [{ port: 465, protocol: 'TCP' }] },
  ]);
  const generic = network.items.find((p) => p.metadata.name === 'application-worker');
  assert.ok(!generic.spec.egress.some((e) => e.ports.some((p) => [465, 587].includes(p.port))));
  const email = worker.items.find((p) => p.kind === 'Deployment' && p.metadata.labels['urm.temporal/role'] === 'email');
  assert.ok(email.spec.template.spec.containers[0].env.some((e) => e.name === 'EMAIL_EGRESS_DESCRIPTOR_PATH'));
  for (const emailEgress of [
    { ...config.emailEgress, addresses: ['0.0.0.0/0'] },
    { ...config.emailEgress, port: 25 },
    { ...config.emailEgress, tls: 'starttls' },
    { ...config.emailEgress, provider: 'sendgrid' },
  ])
    assert.throws(() => validateConfig({ ...config, emailEgress }, peer));
});
test('PostgreSQL and orchestration can reach only reviewed private Kubernetes API endpoints', () => {
  const rendered = renderPlatform(config);
  const dbPolicy = rendered.database.items.find((p) => p.kind === 'NetworkPolicy');
  assert.equal(dbPolicy.spec.podSelector.matchLabels['urm.temporal/database-network'], 'temporal-postgres');
  assert.ok(
    dbPolicy.spec.egress.some(
      (e) => e.to?.some((p) => p.ipBlock?.cidr === '10.0.0.1/32') && e.ports.some((p) => p.port === 6443)
    )
  );
  const db = rendered.database.items.find((p) => p.kind === 'Cluster');
  assert.equal(db.spec.inheritedMetadata.labels['urm.temporal/database-network'], 'temporal-postgres');
  const api = rendered.network.items.find((p) => p.metadata.name === 'orchestration-private-api');
  assert.equal(api.spec.podSelector.matchLabels['urm.temporal/role'], 'orchestration');
  const nodeRole = rendered.worker.items.find((p) => p.kind === 'ClusterRole');
  assert.deepEqual(
    nodeRole.rules.find((r) => r.resources.includes('nodes')).resourceNames,
    config.workerIdentityNodeNames
  );
  assert.deepEqual(nodeRole.rules.find((r) => r.resources.includes('namespaces')).resourceNames, ['kube-system']);
  for (const kubernetesApiEndpoints of [
    [],
    [
      { cidr: '0.0.0.0/0', port: 443 },
      { cidr: '10.0.0.1/32', port: 6443 },
    ],
    [{ cidr: '10.43.0.1/32', port: 443 }],
  ])
    assert.throws(() => validateConfig({ ...config, kubernetesApiEndpoints }, peer));
});

test('deployment cannot accept old generic readable-database restore reports', () => {
  assert.throws(() => validateBackupEvidence(config, { result: 'passed', bothDatabasesVerified: true }));
  const target = new Date(Date.now() - 3600000).toISOString();
  const proof = {
    witnessProofs: [
      { database: 'temporal', includedBefore: true, excludedAfter: true },
      { database: 'temporal_visibility', includedBefore: true, excludedAfter: true },
    ],
    witnessIds: { before: 'included-marker', after: 'excluded-marker' },
    schemaProofs: [
      { database: 'temporal', version: '1.19', tableCount: 11 },
      { database: 'temporal_visibility', version: '1.14', tableCount: 3 },
    ],
    archiveSource: {
      sourceClusterUid: 'physical-pg-uid',
      sourceSystemId: '123456',
      archiveDestination: config.backupDestination,
      archiveEndpoint: config.backupEndpoint,
      targetTime: target,
      sourceBackup: 'completed-before-target',
      sourceBackupCompletedAt: new Date(Date.now() - 7200000).toISOString(),
    },
    recoveryProof: { targetReached: true, firstExcludedTransactionTime: new Date(Date.now() - 3590000).toISOString() },
  };
  assert.equal(validateBackupEvidence(config, proof), proof);
  assert.throws(() => validateBackupEvidence(config, { ...proof, recoveryProof: { targetReached: false } }));
  assert.throws(() =>
    validateBackupEvidence(config, {
      ...proof,
      archiveSource: { ...proof.archiveSource, archiveDestination: 's3://wrong-source/' },
    })
  );
  assert.throws(() => validateBackupEvidence(config, { ...proof, schemaProofs: [] }));
});

test('new-cluster schema bootstrap is possible only for genuinely empty databases with physical backup', () => {
  const now = Date.now();
  const source = {
    metadata: { uid: 'pg1', creationTimestamp: new Date(now - 7200000).toISOString() },
    status: { systemID: '1234', currentPrimary: 'pg1-primary' },
  };
  const backup = {
    metadata: { creationTimestamp: new Date(now - 3600000).toISOString() },
    spec: {
      cluster: { name: 'temporal-postgres' },
      method: 'plugin',
      pluginConfiguration: { name: 'barman-cloud.cloudnative-pg.io' },
    },
    status: { phase: 'completed', stoppedAt: new Date(now - 3000000).toISOString() },
  };
  validateInitialSchemaBootstrap(source, [backup], { temporal: 0, temporal_visibility: 0 }, now);
  assert.throws(() => validateInitialSchemaBootstrap(source, [backup], { temporal: 1, temporal_visibility: 0 }, now));
  assert.throws(() => validateInitialSchemaBootstrap(source, [], { temporal: 0, temporal_visibility: 0 }, now));
  assert.throws(() =>
    validateInitialSchemaBootstrap(
      source,
      [{ ...backup, metadata: { creationTimestamp: new Date(now - 10800000).toISOString() } }],
      { temporal: 0, temporal_visibility: 0 },
      now
    )
  );
});

test('real TemporalCLI formatted JSON proves current routing, typed queue registration and retirement', () => {
  const routing = {
    name: config.workerDeploymentName,
    routingConfig: {
      currentVersionDeploymentName: config.workerDeploymentName,
      currentVersionBuildID: config.workerBuildId,
      rampingVersionPercentage: 0,
      rampingVersionBuildID: '',
    },
  };
  assertWorkerRouting(routing, config);
  const info = {
    deploymentName: config.workerDeploymentName,
    BuildID: config.workerBuildId,
    currentSinceTime: '1970-01-01T00:00:00Z',
    rampingSinceTime: '1970-01-01T00:00:00Z',
    drainageInfo: { drainageStatus: 'drained' },
    taskQueuesInfos: [
      ...config.workerRoles.map((role) => ({ name: `urm-${role}`, type: 'activity' })),
      { name: 'urm-orchestration', type: 'workflow' },
    ],
  };
  assertWorkerQueues(info, config);
  assertDrained(info, config);
  assert.throws(() =>
    assertWorkerQueues(
      { ...info, taskQueuesInfos: info.taskQueuesInfos.filter((q) => q.name !== 'urm-controls') },
      config
    )
  );
  assert.throws(() =>
    assertWorkerQueues({ ...info, taskQueuesInfos: info.taskQueuesInfos.filter((q) => q.type !== 'workflow') }, config)
  );
  assert.throws(() =>
    assertWorkerRouting(
      { ...routing, routingConfig: { ...routing.routingConfig, currentVersionBuildID: 'wrong' } },
      config
    )
  );
  assert.throws(() => assertDrained({ ...info, currentSinceTime: '2026-10-12T00:00:00Z' }, config));
  assert.throws(() => assertDrained({ ...info, drainageInfo: { drainageStatus: 'draining' } }, config));
});

test('reviewed registry pull secrets propagate to all worker images, but not public schema tooling', () => {
  const privateConfig = { ...config, imagePullSecrets: ['worker-registry'] };
  validateConfig(privateConfig, peer);
  const expected = [{ name: 'worker-registry' }];
  for (const deployment of renderPlatform(privateConfig).worker.items.filter((item) => item.kind === 'Deployment')) {
    assert.deepEqual(deployment.spec.template.spec.imagePullSecrets, expected);
  }
  assert.deepEqual(emailCanary(privateConfig, 'process.exit(0)').spec.template.spec.imagePullSecrets, expected);
  assert.deepEqual(
    databaseApiCanary(
      privateConfig,
      'restore-isolated',
      'restore-db',
      { metadata: { name: 'restore-db-1', uid: 'pod-uid' } },
      'process.exit(0)'
    ).spec.template.spec.imagePullSecrets,
    expected
  );
  assert.equal(schemaJob(privateConfig).spec.template.spec.imagePullSecrets, undefined);
  for (const imagePullSecrets of [undefined, ['REQUIRED_SECRET'], ['bad/name']]) {
    assert.throws(() => validateConfig({ ...config, imagePullSecrets }, peer));
  }
});

function cloudConfig(environment = 'staging') {
  const c = structuredClone(config);
  for (const key of [
    'privateApiHost',
    'postgresHost',
    'postgresServerName',
    'postgresCidr',
    'backupEvidence',
    'backupDestination',
    'backupEndpoint',
    'databaseMode',
    'databaseStorage',
    'storageClass',
    'historyShards',
  ])
    delete c[key];
  return {
    ...c,
    environment,
    firebaseProjectId: environment === 'staging' ? 'urm-app-staging' : 'urm-app',
    firebaseResources: {
      storageBucket: environment === 'staging' ? 'urm-app-staging.firebasestorage.app' : 'urm-app.appspot.com',
      imagesBucket: environment === 'staging' ? 'urm-app-staging-images' : 'urm-app-images',
      databaseUrl: `https://${environment === 'staging' ? 'urm-app-staging' : 'urm-app'}-default-rtdb.firebaseio.com/`,
    },
    context: `gke-${environment}`,
    clusterUid: `gke-${environment}-uid`,
    temporalNamespace: `${environment === 'staging' ? 'urm-app-staging' : 'urm-app'}.qwejt`,
    workerHosting: 'gke',
    gke: {
      clusterName: `urm-temporal-${environment}`,
      location: 'us-central1',
      workloadPool: `${environment === 'staging' ? 'urm-app-staging' : 'urm-app'}.svc.id.goog`,
      dataplane: 'ADVANCED_DATAPATH',
      firebaseAuthentication: 'workload-identity',
      nodePoolName: 'temporal-workers',
      nodeServiceAccount: `temporal-nodes@${
        environment === 'staging' ? 'urm-app-staging' : 'urm-app'
      }.iam.gserviceaccount.com`,
      operatorServiceAccount: `temporal-operator@${
        environment === 'staging' ? 'urm-app-staging' : 'urm-app'
      }.iam.gserviceaccount.com`,
      secretManagerRotationInterval: '120s',
      minNodes: 3,
      maxNodes: 6,
      nodeLocations: ['us-central1-a', 'us-central1-b', 'us-central1-c'],
      workerServiceAccounts: Object.fromEntries(
        c.workerRoles.map((role) => [
          role,
          `temporal-${role}@${environment === 'staging' ? 'urm-app-staging' : 'urm-app'}.iam.gserviceaccount.com`,
        ])
      ),
    },
    connectionMode: 'temporal-cloud',
    cloudAccountId: 'qwejt',
    cloudProvider: 'gcp',
    cloudRegion: 'us-central1',
    cloudAddress: `${environment === 'staging' ? 'urm-app-staging' : 'urm-app'}.qwejt.tmprl.cloud:7233`,
    cloudReplicaRegions: environment === 'production' ? ['us-east4'] : [],
    cloudEvidence: '/secure/cloud-proof.json',
    kubernetesApiEndpoints: [
      { cidr: '10.43.0.1/32', port: 443 },
      { cidr: '10.0.0.1/32', port: 443 },
    ],
  };
}
test('Cloud GCP config renders only isolated application workers and their scoped credentials', () => {
  const c = cloudConfig();
  assert.equal(validateConfig(c, cloudConfig('production')), c);
  const rendered = renderPlatform(c);
  for (const key of ['values', 'certificates', 'database']) assert.equal(rendered[key], undefined);
  assert.deepEqual(
    rendered.monitoring.scrape_configs.map((job) => job.job_name),
    ['temporal-sdk-worker']
  );
  const deployments = rendered.worker.items.filter((item) => item.kind === 'Deployment');
  assert.equal(deployments.length, c.workerRoles.length);
  for (const deployment of deployments) {
    const pod = deployment.spec.template.spec;
    const container = pod.containers[0];
    const env = Object.fromEntries(container.env.map(({ name, value }) => [name, value]));
    assert.equal(env.TEMPORAL_CONNECTION_MODE, 'temporal-cloud');
    assert.equal(env.TEMPORAL_NAMESPACE, 'urm-app-staging.qwejt');
    assert.equal(env.TEMPORAL_ADDRESS, c.cloudAddress);
    assert.equal(env.TEMPORAL_API_KEY_FILE, '/run/temporal-cloud/api-key');
    assert.equal(container.image, c.workerImage);
    assert.equal(env.TEMPORAL_BUILD_ID, c.workerBuildId);
    assert.equal(
      container.env.some(({ name }) => name.startsWith('TEMPORAL_TLS_')),
      false
    );
    assert.equal(
      pod.volumes.find((volume) => volume.name === 'temporal-cloud').csi.volumeAttributes.secretProviderClass,
      'temporal-worker-api-key'
    );
    assert.equal(
      pod.volumes.some((volume) => volume.name === 'tls'),
      false
    );
  }
  assert.equal(
    rendered.network.items.some((policy) => policy.metadata.name === 'temporal-server'),
    false
  );
  assert.equal(JSON.stringify(rendered.network).includes('5432'), false);
  assert.equal(JSON.stringify(rendered.worker).includes('api-key-value'), false);
});
for (const [field, value] of [
  ['cloudAccountId', 'other'],
  ['cloudProvider', 'aws'],
  ['cloudRegion', 'us-east1'],
  ['cloudAddress', 'evil.example:7233'],
  ['temporalNamespace', 'urm-app.qwejt'],
  ['apiKey', 'do-not-store-secrets'],
  ['databaseMode', 'self-hosted'],
  ['postgresHost', 'private.db'],
  ['backupEvidence', '/secure/fake-pitr.json'],
  ['workerImage', 'image:latest'],
  ['cloudEvidence', ''],
])
  test(`Cloud rejects ${field} mismatch`, () =>
    assert.throws(() => validateConfig({ ...cloudConfig(), [field]: value }, cloudConfig('production'))));
test('Cloud peer cannot share a cluster, namespace or foreign account', () => {
  for (const override of [
    { clusterUid: 'gke-staging-uid' },
    { temporalNamespace: 'urm-app-staging.qwejt' },
    { cloudAccountId: 'other' },
  ])
    assert.throws(() => validateConfig(cloudConfig(), { ...cloudConfig('production'), ...override }));
});
test('Cloud readiness requires real scoped connection and restart/resume proof, never database restore assertions', () => {
  const c = cloudConfig();
  const evidence = {
    schemaVersion: 1,
    connectionMode: 'temporal-cloud',
    projectId: c.firebaseProjectId,
    accountId: c.cloudAccountId,
    namespace: c.temporalNamespace,
    provider: 'gcp',
    region: 'us-central1',
    address: c.cloudAddress,
    namespaceState: 'ACTIVE',
    replicaRegions: c.cloudReplicaRegions,
    highAvailabilityEnabled: false,
    tlsVerified: true,
    namespaceAccessVerified: true,
    runtimePermission: 'Write',
    runtimeServiceAccountScope: c.temporalNamespace,
    verifiedAt: new Date().toISOString(),
  };
  assert.equal(validateCloudEvidence(c, evidence), evidence);
  assert.throws(() => validateCloudEvidence(c, evidence, { requireRecovery: true }));
  const recovered = {
    ...evidence,
    recovery: {
      result: 'passed',
      workerBuildId: c.workerBuildId,
      clusterUid: c.clusterUid,
      workflowId: 'isolated-recovery',
      runId: 'original-run',
      workerRestarted: true,
      resumedOriginalExecution: true,
      sideEffectsDisabled: true,
    },
  };
  assert.equal(validateCloudEvidence(c, recovered, { requireRecovery: true }), recovered);
  for (const override of [
    { region: 'us-east1' },
    { runtimePermission: 'Admin' },
    { runtimeServiceAccountScope: 'urm-app.qwejt' },
    { verifiedAt: '2000-01-01' },
    { tlsVerified: false },
  ])
    assert.throws(() => validateCloudEvidence(c, { ...recovered, ...override }, { requireRecovery: true }));
  assert.throws(() =>
    validateCloudEvidence(
      c,
      { ...recovered, recovery: { ...recovered.recovery, workerBuildId: 'c'.repeat(40) } },
      { requireRecovery: true }
    )
  );
});

test('Cloud CLI rendering excludes schema jobs and rejects stale self-hosted output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'urm-cloud-render-'));
  try {
    await writeFile(join(dir, 'stage.json'), JSON.stringify(cloudConfig()));
    await writeFile(join(dir, 'prod.json'), JSON.stringify(cloudConfig('production')));
    const output = join(dir, 'rendered');
    const argv = [
      'scripts/temporal-platform.mjs',
      'render',
      '--config',
      join(dir, 'stage.json'),
      '--peer',
      join(dir, 'prod.json'),
      '--output',
      output,
    ];
    execFileSync(process.execPath, argv, { stdio: 'pipe' });
    await assert.rejects(readFile(join(output, 'schema.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(output, 'values.json')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(output, 'worker.json'))).kind, 'List');
    await writeFile(join(output, 'schema.json'), '{}');
    assert.throws(() => execFileSync(process.execPath, argv, { stdio: 'pipe' }));
    assert.throws(() => schemaJob(cloudConfig()));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Cloud endpoint remains account-bound while supporting the managed failover namespace DNS', () => {
  const c = cloudConfig();
  assert.equal(
    validateConfig({ ...c, cloudAddress: 'us-central1.gcp.api.temporal.io:7233' }, cloudConfig('production'))
      .firebaseProjectId,
    c.firebaseProjectId
  );
  for (const address of [
    'urm-app.qwejt.tmprl.cloud:7233',
    'urm-app-staging.other.tmprl.cloud:7233',
    'us-east4.gcp.api.temporal.io:7233',
    'us-east-1.aws.api.temporal.io:7233',
  ])
    assert.throws(() => validateConfig({ ...c, cloudAddress: address }, cloudConfig('production')));
  assert.throws(() => validateConfig({ ...c, cloudReplicaRegions: ['us-east4'] }, cloudConfig('production')));
});

test('Cloud deployment blocks self-hosted actions before contacting Kubernetes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'urm-cloud-actions-'));
  try {
    await writeFile(join(dir, 'stage.json'), JSON.stringify(cloudConfig()));
    await writeFile(join(dir, 'prod.json'), JSON.stringify(cloudConfig('production')));
    for (const action of ['server', 'schema-bootstrap', 'database', 'certificates', 'operators']) {
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [
              'scripts/deploy-temporal-platform.mjs',
              action,
              '--config',
              join(dir, 'stage.json'),
              '--peer',
              join(dir, 'prod.json'),
              '--apply',
            ],
            { stdio: 'pipe' }
          ),
        (error) => String(error.stderr).includes('self-hosted actions are forbidden')
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Cloud worker deployment with a missing mounted API key applies no workloads or network policies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'urm-cloud-missing-key-'));
  try {
    const c = { ...cloudConfig(), workerRoles: ['orchestration', 'controls'], cloudEvidence: join(dir, 'proof.json') };
    c.gke.workerServiceAccounts = Object.fromEntries(
      c.workerRoles.map((role) => [role, `temporal-${role}@${c.firebaseProjectId}.iam.gserviceaccount.com`])
    );
    await writeFile(
      c.cloudEvidence,
      JSON.stringify({
        schemaVersion: 1,
        connectionMode: 'temporal-cloud',
        projectId: c.firebaseProjectId,
        accountId: c.cloudAccountId,
        namespace: c.temporalNamespace,
        provider: 'gcp',
        region: 'us-central1',
        address: c.cloudAddress,
        namespaceState: 'ACTIVE',
        replicaRegions: [],
        highAvailabilityEnabled: false,
        tlsVerified: true,
        namespaceAccessVerified: true,
        runtimePermission: 'Write',
        runtimeServiceAccountScope: c.temporalNamespace,
        verifiedAt: new Date().toISOString(),
      })
    );
    await writeFile(join(dir, 'stage.json'), JSON.stringify(c));
    await writeFile(join(dir, 'prod.json'), JSON.stringify({ ...plannedPeer('production'), workerHosting: 'gke' }));
    const executable = join(dir, 'kubectl');
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(process.env.TEST_KUBECTL_LOG,JSON.stringify(args)+'\\n');
if(args.includes('kube-system')) console.log(JSON.stringify({metadata:{uid:'gke-staging-uid'}}));
else if(args.includes('nodes')) console.log(JSON.stringify({items:Array.from({length:3},(_,i)=>({metadata:{labels:{'kubernetes.io/hostname':'node'+i}},spec:{},status:{conditions:[{type:'Ready',status:'True'}]}}))}));
else if(args.includes('secret')) console.log(JSON.stringify({data:{}}));
else if(args.includes('create')) {fs.readFileSync(0); console.log(JSON.stringify({metadata:{uid:'lock-test'}}));}
else if(args.includes('configmap')) console.log(JSON.stringify({metadata:{uid:'lock-test'}}));
else {console.error('Unexpected remote operation');process.exit(99);}
`
    );
    await chmod(executable, 0o700);
    await writeFile(
      join(dir, 'gcloud'),
      `#!/usr/bin/env node\nconst args=process.argv.slice(2);console.log(JSON.stringify(args.includes('clusters') ? ${JSON.stringify(
        actualGkeCluster(c)
      )} : {state:'DISABLED'}));\n`
    );
    await chmod(join(dir, 'gcloud'), 0o700);
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            'scripts/deploy-temporal-platform.mjs',
            'worker',
            '--config',
            join(dir, 'stage.json'),
            '--peer',
            join(dir, 'prod.json'),
            '--apply',
          ],
          {
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TEST_KUBECTL_LOG: join(dir, 'calls.jsonl') },
            stdio: 'pipe',
          }
        ),
      (error) =>
        String(error.stderr).includes('Managed Secret TEMPORAL_WORKER_API_KEY must have an enabled latest version')
    );
    const calls = (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(
      calls.some((args) => args.includes('apply')),
      false
    );
    assert.equal(
      calls.some((args) => args.includes('rollout')),
      false
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function actualGkeCluster(c) {
  return {
    name: c.gke.clusterName,
    location: 'us-central1',
    selfLink: `https://container.googleapis.com/v1/projects/${c.firebaseProjectId}/locations/us-central1/clusters/${c.gke.clusterName}`,
    workloadIdentityConfig: { workloadPool: c.gke.workloadPool },
    networkConfig: { datapathProvider: 'ADVANCED_DATAPATH' },
    privateClusterConfig: { enablePrivateNodes: true },
    secretManagerConfig: { enabled: true, rotationConfig: { enabled: true, rotationInterval: '120s' } },
    nodePools: [
      {
        name: c.gke.nodePoolName,
        config: { serviceAccount: c.gke.nodeServiceAccount, workloadMetadataConfig: { mode: 'GKE_METADATA' } },
        autoscaling: { enabled: true, totalMinNodeCount: 3, totalMaxNodeCount: 6 },
        locations: c.gke.nodeLocations,
      },
    ],
  };
}
test('Cloud GKE workers use role-scoped WIF instead of static Firebase credentials and managed CSI for rotating Temporal keys', () => {
  const c = cloudConfig(),
    rendered = renderPlatform(c);
  for (const deployment of rendered.worker.items.filter((item) => item.kind === 'Deployment')) {
    const role = deployment.metadata.labels['urm.temporal/role'],
      pod = deployment.spec.template.spec,
      container = pod.containers[0];
    assert.equal(pod.serviceAccountName, `temporal-worker-${role}`);
    assert.equal(pod.nodeSelector['iam.gke.io/gke-metadata-server-enabled'], 'true');
    assert.equal(
      pod.volumes.some((volume) => volume.name === 'firebase'),
      false
    );
    assert.equal(
      container.env.some(({ name }) => name === 'GOOGLE_APPLICATION_CREDENTIALS'),
      false
    );
    assert.equal(container.env.find(({ name }) => name === 'GOOGLE_CLOUD_PROJECT').value, c.firebaseProjectId);
    const account = rendered.worker.items.find(
      (item) => item.kind === 'ServiceAccount' && item.metadata.name === pod.serviceAccountName
    );
    assert.equal(account.metadata.annotations['iam.gke.io/gcp-service-account'], c.gke.workerServiceAccounts[role]);
    assert.equal(
      pod.volumes.find((volume) => volume.name === 'temporal-cloud').csi.driver,
      'secrets-store-gke.csi.k8s.io'
    );
    assert.equal(
      pod.volumes.some((volume) => volume.name === 'kubernetes-identity'),
      role === 'orchestration'
    );
  }
  for (const spc of rendered.worker.items.filter((item) => item.kind === 'SecretProviderClass')) {
    assert.equal(spc.spec.provider, 'gke');
    assert.ok(spc.spec.parameters.secrets.includes(`projects/${c.firebaseProjectId}/secrets/TEMPORAL_`));
    assert.ok(spc.spec.parameters.secrets.includes('/versions/latest'));
  }
  const network = rendered.network.items.find((item) => item.metadata.name === 'application-worker');
  assert.ok(
    network.spec.egress.some(
      (rule) =>
        rule.to?.some((target) => target.ipBlock?.cidr === '169.254.169.254/32') &&
        rule.ports.every((p) => [80, 8080].includes(p.port))
    )
  );
  const foreign = {
    ...c.gke,
    workerServiceAccounts: {
      ...c.gke.workerServiceAccounts,
      controls: 'temporal-controls@urm-app.iam.gserviceaccount.com',
    },
  };
  assert.throws(() => validateConfig({ ...c, gke: foreign }, cloudConfig('production')));
  assert.throws(() =>
    validateConfig({ ...c, gke: { ...c.gke, workloadPool: 'urm-app.svc.id.goog' } }, cloudConfig('production'))
  );
  assert.throws(() =>
    validateConfig({ ...c, gke: { ...c.gke, firebaseAuthentication: 'json-key' } }, cloudConfig('production'))
  );
});
test('Actual GKE evidence rejects disabled WIF, foreign projects, missing rotation, wrong dataplane and unsafe node pools', () => {
  const c = cloudConfig(),
    actual = actualGkeCluster(c);
  assert.equal(validateGkeCluster(c, actual), actual);
  for (const mutate of [
    (x) => {
      x.workloadIdentityConfig.workloadPool = 'other.svc.id.goog';
    },
    (x) => {
      x.selfLink = x.selfLink.replace('urm-app-staging', 'urm-app');
    },
    (x) => {
      x.networkConfig.datapathProvider = 'LEGACY_DATAPATH';
    },
    (x) => {
      x.secretManagerConfig.rotationConfig.enabled = false;
    },
    (x) => {
      x.nodePools[0].config.workloadMetadataConfig.mode = 'GCE_METADATA';
    },
    (x) => {
      x.nodePools[0].config.serviceAccount = 'default';
    },
    (x) => {
      x.nodePools[0].autoscaling.totalMinNodeCount = 1;
    },
    (x) => {
      x.nodePools[0].locations = ['us-central1-a'];
    },
  ]) {
    const bad = structuredClone(actual);
    mutate(bad);
    assert.throws(() => validateGkeCluster(c, bad));
  }
});

function vmConfig(environment = 'staging') {
  const c = cloudConfig(environment);
  delete c.gke;
  c.workerHosting = 'gce-k3s';
  c.workerReplicas = 1;
  c.cloudReplicaRegions = [];
  c.context = `single-vm-${environment}`;
  c.clusterUid = `single-vm-${environment}-uid`;
  c.workerIdentityNodeNames = [`urm-temporal-${environment}`];
  c.kubernetesApiEndpoints[1].port = 6443;
  c.media = {
    ...c.media,
    concurrency: 1,
    scratchStorage: '100Gi',
    storageBudget: '400Gi',
    storageClass: 'temporal-media-local',
  };
  c.gce = {
    instanceName: `urm-temporal-${environment}`,
    instanceId: environment === 'staging' ? '12345' : '67890',
    zone: 'us-central1-a',
    machineType: 'e2-standard-4',
    serviceAccount: `temporal-worker@${c.firebaseProjectId}.iam.gserviceaccount.com`,
    privateIp: environment === 'staging' ? '10.10.0.2' : '10.20.0.2',
    mediaMount: '/var/lib/urm-temporal/media',
    mediaDiskGiB: 470,
    mediaRequiredCapacityGiB: 400,
    mediaFilesystemEvidence: '/private/actual-mount.json',
  };
  return c;
}
test('Simple Cloud uses one actual VM/node and attached ADC with bounded media, no GKE WIF/CSI or Firebase keys', () => {
  const c = vmConfig();
  assert.equal(validateConfig(c, vmConfig('production')), c);
  const rendered = renderPlatform(c);
  assert.equal(
    rendered.worker.items.some((item) => item.kind === 'SecretProviderClass'),
    false
  );
  for (const deployment of rendered.worker.items.filter((item) => item.kind === 'Deployment')) {
    const pod = deployment.spec.template.spec,
      container = pod.containers[0];
    assert.equal(deployment.spec.replicas, 1);
    assert.equal(
      pod.volumes.find((volume) => volume.name === 'temporal-cloud').secret.secretName,
      'temporal-worker-api-key'
    );
    assert.equal(
      pod.volumes.some((volume) => volume.name === 'firebase'),
      false
    );
    assert.equal(pod.nodeSelector, undefined);
    assert.equal(
      container.env.some(({ name }) => name === 'GOOGLE_APPLICATION_CREDENTIALS'),
      false
    );
    if (deployment.metadata.labels['urm.temporal/role'] === 'media') {
      assert.equal(container.resources.requests.cpu, '1');
      assert.equal(container.env.find(({ name }) => name === 'TEMPORAL_MEDIA_CONCURRENCY').value, '1');
    }
  }
  assert.throws(() => validateConfig({ ...c, workerReplicas: 2 }, vmConfig('production')));
  assert.throws(() =>
    validateConfig(
      { ...c, gce: { ...c.gce, serviceAccount: 'temporal-worker@urm-app.iam.gserviceaccount.com' } },
      vmConfig('production')
    )
  );
});
test('Actual simple VM identity cannot borrow the other project, attached account, zone or private address', () => {
  const c = vmConfig(),
    instance = {
      id: c.gce.instanceId,
      name: c.gce.instanceName,
      status: 'RUNNING',
      selfLink: `https://compute.googleapis.com/compute/v1/projects/${c.firebaseProjectId}/zones/us-central1-a/instances/${c.gce.instanceName}`,
      zone: 'zones/us-central1-a',
      machineType: 'machineTypes/e2-standard-4',
      serviceAccounts: [{ email: c.gce.serviceAccount, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }],
      networkInterfaces: [{ networkIP: c.gce.privateIp }],
    };
  assert.equal(validateGceInstance(c, instance), instance);
  for (const overrides of [
    { id: 'other' },
    { status: 'TERMINATED' },
    { zone: 'zones/us-east4-a' },
    { serviceAccounts: [{ email: 'default' }] },
    { serviceAccounts: [{ email: c.gce.serviceAccount, scopes: 'https://www.googleapis.com/auth/cloud-platform' }] },
    {
      serviceAccounts: [
        {
          email: c.gce.serviceAccount,
          scopes: ['https://evil.invalid/https://www.googleapis.com/auth/cloud-platform'],
        },
      ],
    },
    {
      serviceAccounts: [
        { email: c.gce.serviceAccount, scopes: ['https://www.googleapis.com/auth/cloud-platform.evil.invalid'] },
      ],
    },
    { networkInterfaces: [{ networkIP: '10.0.0.9' }] },
  ])
    assert.throws(() => validateGceInstance(c, { ...instance, ...overrides }));
});
test('Single-host upgrade checks actual retained CPU/memory demand and never deletes old pinned workers to make space', () => {
  const c = vmConfig(),
    worker = renderPlatform(c).worker,
    node = { status: { allocatable: { cpu: '4', memory: '15Gi' } } };
  assert.equal(validateSingleHostCapacity(c, node, [], worker).cpu, 2250);
  const old = worker.items
    .filter((item) => item.kind === 'Deployment')
    .map((deployment) => ({
      metadata: { labels: { ...deployment.metadata.labels, 'app.kubernetes.io/version': 'a'.repeat(40) } },
      spec: deployment.spec.template.spec,
      status: { phase: 'Running' },
    }));
  assert.throws(() => validateSingleHostCapacity(c, node, old, worker), /retained workers/);
  assert.throws(() =>
    validateSingleHostCapacity(c, { status: { allocatable: { cpu: '4', memory: '1Gi' } } }, [], worker)
  );
  const same = worker.items
    .filter((item) => item.kind === 'Deployment')
    .map((deployment) => ({
      metadata: { labels: deployment.metadata.labels },
      spec: deployment.spec.template.spec,
      status: { phase: 'Running' },
    }));
  assert.equal(validateSingleHostCapacity(c, node, same, worker).cpu, 2250);
});
test('Single-host dedicated scratch proof rejects an unmounted root filesystem, small GB disk, stale identity or missing mount', () => {
  const c = vmConfig(),
    proof = {
      schemaVersion: 1,
      projectId: c.firebaseProjectId,
      instanceId: c.gce.instanceId,
      clusterUid: c.clusterUid,
      mountPoint: c.gce.mediaMount,
      filesystem: 'ext4',
      device: '/dev/sdb',
      totalBytes: 410 * 2 ** 30,
      verifiedAt: new Date().toISOString(),
    };
  assert.equal(validateSingleHostMedia(c, proof), proof);
  // Raw disk capacity includes filesystem overhead; the usable quota remains independently reviewed.
  assert.equal(validateConfig(c, vmConfig('production')), c);
  for (const gce of [
    { ...c.gce, mediaDiskGiB: 399 },
    { ...c.gce, mediaDiskGiB: 470.5 },
    { ...c.gce, mediaRequiredCapacityGiB: undefined },
    { ...c.gce, mediaRequiredCapacityGiB: 390 },
  ])
    assert.throws(() => validateConfig({ ...c, gce }, vmConfig('production')));
  assert.equal(validateSingleHostMedia(c, { ...proof, totalBytes: 495588900864 }).totalBytes, 495588900864);
  for (const overrides of [
    { mountPoint: '/' },
    { totalBytes: 400 * 10 ** 9 },
    { instanceId: 'foreign' },
    { verifiedAt: '2000-01-01' },
    { filesystem: 'tmpfs' },
  ])
    assert.throws(() => validateSingleHostMedia(c, { ...proof, ...overrides }));
});

test('Simple VM operator jobs connect to exact Cloud TLS namespace with a separate file-derived key and no self-hosted credentials', () => {
  const c = vmConfig(),
    job = renderOperatorJob(c, 'describe-version', ['worker', 'deployment', 'describe-version']);
  const pod = job.spec.template.spec,
    command = pod.containers[0].command[2];
  assert.ok(command.includes(c.cloudAddress));
  assert.ok(command.includes(c.temporalNamespace));
  assert.ok(command.includes("'--tls'"));
  assert.equal(command.includes('--tls-cert-path'), false);
  assert.equal(command.includes('--disable-config-env'), false);
  assert.ok(command.includes('cat /run/tls/api-key'));
  assert.equal(command.includes('--api-key'), false);
  assert.equal(pod.volumes[0].secret.secretName, 'temporal-operator-api-key');
  assert.equal(pod.volumes[0].csi, undefined);
  assert.equal(job.spec.activeDeadlineSeconds, 300);
  const self = renderOperatorJob(config, 'describe', ['worker', 'deployment', 'describe']);
  assert.ok(self.spec.template.spec.containers[0].command[2].includes('--tls-cert-path'));
  assert.equal(self.spec.template.spec.volumes[0].secret.secretName, 'temporal-operator-tls');
});

function plannedPeer(environment = 'production') {
  const project = environment === 'production' ? 'urm-app' : 'urm-app-staging';
  return {
    environment,
    deploymentState: 'planned',
    connectionMode: 'temporal-cloud',
    workerHosting: 'gce-k3s',
    firebaseProjectId: project,
    temporalNamespace: `${project}.qwejt`,
    cloudAccountId: 'qwejt',
    cloudProvider: 'gcp',
    cloudRegion: 'us-central1',
  };
}
test('Staging can target real infrastructure with a truthful not-yet-provisioned production identity, never fake peer witnesses', () => {
  const c = vmConfig(),
    planned = plannedPeer();
  assert.equal(validateConfig(c, planned), c);
  assert.throws(() => validateConfig(planned, c), /planned peer identity/);
  for (const overrides of [
    { clusterUid: 'fake' },
    { context: 'REQUIRED' },
    { cloudEvidence: '/fake.json' },
    { firebaseProjectId: 'urm-app-staging' },
    { temporalNamespace: 'urm-app-staging.qwejt' },
    { cloudAccountId: 'other' },
  ])
    assert.throws(() => validateConfig(c, { ...planned, ...overrides }));
  assert.throws(() => validateConfig({ ...c, clusterUid: 'REQUIRED' }, planned));
});

test('Selected single-VM Cloud preflight passes real-target restart/access proof without any database or disaster-recovery witnesses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'urm-cloud-simple-readiness-'));
  try {
    const c = { ...vmConfig(), cloudEvidence: join(dir, 'cloud.json') };
    const proof = {
      schemaVersion: 1,
      connectionMode: 'temporal-cloud',
      projectId: c.firebaseProjectId,
      accountId: c.cloudAccountId,
      namespace: c.temporalNamespace,
      provider: 'gcp',
      region: 'us-central1',
      address: c.cloudAddress,
      namespaceState: 'ACTIVE',
      replicaRegions: [],
      highAvailabilityEnabled: false,
      tlsVerified: true,
      namespaceAccessVerified: true,
      runtimePermission: 'Write',
      runtimeServiceAccountScope: c.temporalNamespace,
      verifiedAt: new Date().toISOString(),
      recovery: {
        result: 'passed',
        workerBuildId: c.workerBuildId,
        clusterUid: c.clusterUid,
        workflowId: 'isolated-worker-restart',
        runId: 'original-run',
        workerRestarted: true,
        resumedOriginalExecution: true,
        sideEffectsDisabled: true,
      },
    };
    await writeFile(c.cloudEvidence, JSON.stringify(proof));
    await writeFile(join(dir, 'stage.json'), JSON.stringify(c));
    await writeFile(join(dir, 'peer.json'), JSON.stringify(plannedPeer()));
    const instance = {
      id: c.gce.instanceId,
      name: c.gce.instanceName,
      status: 'RUNNING',
      selfLink: `https://compute.googleapis.com/compute/v1/projects/${c.firebaseProjectId}/zones/${c.gce.zone}/instances/${c.gce.instanceName}`,
      zone: `zones/${c.gce.zone}`,
      machineType: `machineTypes/${c.gce.machineType}`,
      serviceAccounts: [{ email: c.gce.serviceAccount, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }],
      networkInterfaces: [{ networkIP: c.gce.privateIp }],
    };
    await writeFile(
      join(dir, 'gcloud'),
      `#!/usr/bin/env node\nconst a=process.argv.slice(2);if(!a.includes('instances')||!a.includes('describe'))process.exit(99);console.log(${JSON.stringify(
        JSON.stringify(instance)
      )});\n`
    );
    await chmod(join(dir, 'gcloud'), 0o700);
    await writeFile(
      join(dir, 'kubectl'),
      `#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a.includes('kube-system'))console.log(JSON.stringify({metadata:{uid:${JSON.stringify(
        c.clusterUid
      )}}}));else if(a.includes('nodes'))console.log(JSON.stringify({items:[{metadata:{name:${JSON.stringify(
        c.workerIdentityNodeNames[0]
      )},labels:{'kubernetes.io/hostname':${JSON.stringify(
        c.workerIdentityNodeNames[0]
      )}}},spec:{},status:{conditions:[{type:'Ready',status:'True'}]}}]}));else process.exit(99);\n`
    );
    await chmod(join(dir, 'kubectl'), 0o700);
    const args = [
      'scripts/deploy-temporal-platform.mjs',
      'preflight',
      '--config',
      join(dir, 'stage.json'),
      '--peer',
      join(dir, 'peer.json'),
    ];
    const output = execFileSync(process.execPath, args, {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.ok(output.includes('preflight completed'));
    assert.equal(c.backupEvidence, undefined);
    assert.equal(c.postgresHost, undefined);
    assert.equal(c.databaseMode, undefined);
    delete proof.recovery;
    await writeFile(c.cloudEvidence, JSON.stringify(proof));
    assert.throws(
      () =>
        execFileSync(process.execPath, args, {
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
          stdio: 'pipe',
        }),
      (error) => String(error.stderr).includes('actual isolated worker restart/resume evidence')
    );
    const prod = vmConfig('production');
    assert.throws(
      () => validateConfig({ ...prod, cloudReplicaRegions: ['us-east4'] }, plannedPeer('staging')),
      /explicitly single-region/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Initial restart probe disables dispatcher in the Pod before startup and cannot be overridden by runtime Secret env', () => {
  const c = { ...vmConfig(), dispatcherEnabled: false };
  assert.equal(validateConfig(c, plannedPeer()), c);
  for (const deployment of renderPlatform(c).worker.items.filter((item) => item.kind === 'Deployment')) {
    const worker = deployment.spec.template.spec.containers[0];
    assert.equal(worker.env.find((variable) => variable.name === 'TEMPORAL_DISPATCHER_ENABLED').value, 'false');
  }
  const normal = renderPlatform(vmConfig()).worker.items.find(
    (item) => item.kind === 'Deployment' && item.metadata.labels['urm.temporal/role'] === 'orchestration'
  );
  assert.equal(
    normal.spec.template.spec.containers[0].env.find((variable) => variable.name === 'TEMPORAL_DISPATCHER_ENABLED')
      .value,
    'true'
  );
  assert.throws(() => validateConfig({ ...vmConfig(), dispatcherEnabled: 'false' }, plannedPeer()), /explicit boolean/);
});

test('Every Cloud role receives explicitly authorized storage/images/RTDB settings instead of shared defaults or stale runtime aliases', () => {
  for (const environment of ['staging', 'production']) {
    const c = vmConfig(environment),
      expected = firebaseResourceEnvironment(c);
    for (const pod of renderPlatform(c)
      .worker.items.filter((item) => item.kind === 'Deployment')
      .map((item) => item.spec.template.spec)) {
      const env = Object.fromEntries(pod.containers[0].env.map(({ name, value }) => [name, value]));
      for (const [name, value] of Object.entries(expected)) assert.equal(env[name], value);
      assert.equal(pod.containers[0].env.filter(({ name }) => name === 'FIREBASE_PROJECT_ID').length, 1);
    }
  }
  const c = vmConfig();
  assert.throws(
    () => validateConfig({ ...c, firebaseResources: undefined }, plannedPeer()),
    /Explicit reviewed Firebase/
  );
  for (const resources of [
    { ...c.firebaseResources, storageBucket: 'urm-app-staging.appspot.com' },
    { ...c.firebaseResources, storageBucket: 'urm-app.appspot.com' },
    { ...c.firebaseResources, imagesBucket: 'urm-app-images' },
    { ...c.firebaseResources, databaseUrl: 'https://urm-app-default-rtdb.firebaseio.com/' },
    { ...c.firebaseResources, databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com/foreign' },
  ])
    assert.throws(() => validateConfig({ ...c, firebaseResources: resources }, plannedPeer()));
});
test('Runtime resource contradictions are rejected before deployment instead of silently overridden', () => {
  const c = vmConfig();
  assertFirebaseRuntimeSecretResources(c, { data: { SENTRY_DSN: Buffer.from('synthetic').toString('base64') } });
  for (const [name, value] of Object.entries(firebaseResourceEnvironment(c)))
    assertFirebaseRuntimeSecretResources(c, { data: { [name]: Buffer.from(value).toString('base64') } });
  for (const [name, value] of [
    ['FIREBASE_STORAGE_BUCKET', 'urm-app-staging.appspot.com'],
    ['NEXT_PUBLIC_FIREBASE_IMAGES_BUCKET', 'urm-app-images'],
    ['FIREBASE_DATABASE_URL', 'https://urm-app-default-rtdb.firebaseio.com/'],
    [
      'FIREBASE_CONFIG',
      JSON.stringify({
        projectId: 'urm-app-staging',
        storageBucket: 'urm-app-staging.appspot.com',
        databaseURL: c.firebaseResources.databaseUrl,
      }),
    ],
  ])
    assert.throws(() =>
      assertFirebaseRuntimeSecretResources(c, { data: { [name]: Buffer.from(value).toString('base64') } })
    );
});

test('CLI 1.9.1 parses rendered Cloud and self-hosted operation-local connection options without making a connection', (t) => {
  let installed;
  try {
    installed = execFileSync('temporal', ['--version'], { encoding: 'utf8' });
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('Temporal CLI unavailable');
      return;
    }
    throw error;
  }
  assert.match(installed, /temporal version 1\.9\.1/);
  for (const c of [vmConfig(), config]) {
    const commands = platformOperatorCommands(c, 10);
    for (const [name, args] of Object.entries(commands)) {
      const job = renderOperatorJob(c, name, args);
      const command =
        job.spec.template.spec.containers[0].command[2].replace(/^export TEMPORAL_API_KEY=.*?; /, '') + ' --help';
      assert.ok(command.indexOf("'--disable-config-file'") > command.indexOf(`'${args[2]}'`));
      const output = execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 5000 });
      assert.match(output, /Usage:/, name);
    }
    // Queue coverage is provided by the actual versionDescribe report, not a legacy reachability command.
    assert.ok(commands.versionDescribe.includes('--report-task-queue-stats'));
    assert.ok(commands.deploymentDescribe.includes('--name'));
    assert.equal(commands.deploymentDescribe.includes('--deployment-name'), false);
  }
});

test('Platform Job polling stops on terminal failure and never waits out the success timeout', async () => {
  for (const status of [
    { failed: 1 },
    { conditions: [{ type: 'Failed', status: 'True' }] },
    { conditions: [{ type: 'FailureTarget', status: 'True' }] },
  ]) {
    let polls = 0;
    await assert.rejects(
      waitPlatformJob(
        () => {
          polls++;
          return { status };
        },
        {
          sleep: () => {
            throw new Error('must not sleep');
          },
        }
      ),
      /Platform Job failed/
    );
    assert.equal(polls, 1);
  }
  let elapsed = 0,
    polls = 0;
  await waitPlatformJob(
    () => ({ status: ++polls === 2 ? { conditions: [{ type: 'Complete', status: 'True' }] } : {} }),
    {
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    }
  );
  assert.equal(polls, 2);
  elapsed = 0;
  await assert.rejects(
    waitPlatformJob(() => ({ status: {} }), {
      timeoutMs: 2000,
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    }),
    /bounded deadline/
  );
  assert.equal(elapsed, 2000);
});

test('Public DNS email IPv4 policy is explicit, role/port scoped and cannot be overridden by generic additive HTTPS', () => {
  const c = vmConfig();
  c.emailEgress = {
    schemaVersion: 1,
    provider: 'smtp',
    hostname: 'smtp.gmail.com',
    port: 465,
    tls: 'implicit',
    dnsMode: 'public-ipv4',
  };
  validateConfig(c, vmConfig('production'));
  const { network, worker } = renderPlatform(c);
  const generic = network.items.find((policy) => policy.metadata.name === 'application-worker');
  assert.deepEqual(generic.spec.podSelector.matchExpressions, [
    { key: 'urm.temporal/role', operator: 'NotIn', values: ['email'] },
  ]);
  const email = network.items.find((policy) => policy.metadata.name === 'email-reviewed-provider');
  assert.equal(email.spec.podSelector.matchLabels['urm.temporal/role'], 'email');
  assert.deepEqual(email.spec.egress[0].ports, [{ port: 465, protocol: 'TCP' }]);
  const ipBlock = email.spec.egress[0].to[0].ipBlock;
  assert.equal(ipBlock.cidr, '0.0.0.0/0');
  for (const denied of [
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '224.0.0.0/4',
    '240.0.0.0/4',
  ])
    assert.ok(ipBlock.except.includes(denied));
  const base = network.items.find((policy) => policy.metadata.name === 'email-public-base');
  assert.equal(base.spec.podSelector.matchLabels['urm.temporal/role'], 'email');
  assert.deepEqual(base.spec.egress.find((rule) => rule.ports.some(({ port }) => port === 443)).to, [{ ipBlock }]);
  assert.ok(base.spec.egress.some((rule) => rule.ports.some(({ port }) => port === 7233)));
  assert.ok(
    base.spec.egress.some(
      (rule) =>
        rule.ports.some(({ port }) => port === 80) &&
        rule.to.some(({ ipBlock }) => ipBlock?.cidr === '169.254.169.254/32')
    )
  );
  assert.equal(
    JSON.parse(
      worker.items.find((item) => item.kind === 'ConfigMap' && item.metadata.name === 'temporal-email-egress').data[
        'egress.json'
      ]
    ).dnsMode,
    'public-ipv4'
  );
  for (const emailEgress of [
    { ...c.emailEgress, addresses: ['64.233.179.109'] },
    { ...c.emailEgress, dnsMode: 'guess' },
    { ...c.emailEgress, dnsMode: 'static', addresses: ['169.254.169.254'] },
    { ...c.emailEgress, port: 25 },
  ])
    assert.throws(() => validateConfig({ ...c, emailEgress }, vmConfig('production')));
  c.emailEgress.oauthTokenEgress = { hostname: 'oauth2.googleapis.com', port: 443, dnsMode: 'public-ipv4' };
  validateConfig(c, vmConfig('production'));
  assert.deepEqual(
    renderPlatform(c).network.items.find((policy) => policy.metadata.name === 'email-reviewed-provider').spec.egress[1],
    { to: [{ ipBlock }], ports: [{ port: 443, protocol: 'TCP' }] }
  );
  assert.throws(() =>
    validateConfig(
      {
        ...c,
        emailEgress: {
          ...c.emailEgress,
          oauthTokenEgress: { hostname: 'metadata.google.internal', port: 443, dnsMode: 'public-ipv4' },
        },
      },
      vmConfig('production')
    )
  );
});
