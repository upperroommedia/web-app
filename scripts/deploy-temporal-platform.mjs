#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import {
  validateConfig,
  validateCloudEvidence,
  validateGkeCluster,
  validateGceInstance,
  validateSingleHostCapacity,
  validateSingleHostMedia,
  renderOperatorJob as operatorJob,
  waitPlatformJob,
  platformOperatorCommands,
  assertFirebaseRuntimeSecretResources,
  validateBackupEvidence,
  validateInitialSchemaBootstrap,
  renderPlatform,
  schemaJob,
  versions,
  assertDrained,
  assertWorkerRouting,
  assertWorkerQueues,
  databaseApiCanary,
  emailCanary,
  firebaseRtdbCanary,
  assertFirebaseRtdbCanaryProof,
} from './temporal-platform.mjs';

const [action, ...args] = process.argv.slice(2);
const apply = args.includes('--apply');
const values = args.filter((a) => a !== '--apply');
const flags = Object.fromEntries(
  Array.from({ length: values.length / 2 }, (_, i) => [values[i * 2], values[i * 2 + 1]])
);
if (
  ![
    'preflight',
    'cert-manager',
    'operators',
    'certificates',
    'database',
    'schema-bootstrap',
    'server',
    'worker',
    'worker-status',
    'email-canary',
    'firebase-rtdb-canary',
    'promote',
    'ramp',
    'retire',
  ].includes(action) ||
  !flags['--config'] ||
  !flags['--peer']
) {
  throw new Error(
    'Usage: deploy-temporal-platform.mjs ACTION --config PATH --peer PATH [--apply] [--percentage NUMBER]'
  );
}
const peerDefinition = JSON.parse(await readFile(flags['--peer'], 'utf8'));
const c = validateConfig(JSON.parse(await readFile(flags['--config'], 'utf8')), peerDefinition);
const cloud = c.connectionMode === 'temporal-cloud';
if (cloud && ['cert-manager', 'operators', 'certificates', 'database', 'schema-bootstrap', 'server'].includes(action))
  throw new Error(
    'Temporal Cloud manages server, database, schema and certificates; self-hosted actions are forbidden'
  );
const context = ['--context', c.context];
function kubectl(command, input) {
  return execFileSync('kubectl', [...context, ...command], {
    input: input ? JSON.stringify(input) : undefined,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 960_000,
  });
}
const json = (command) => JSON.parse(kubectl([...command, '-o', 'json']));
function requireReadyCluster() {
  if (cloud && c.workerHosting === 'gce-k3s') {
    const instance = JSON.parse(
      execFileSync(
        'gcloud',
        [
          'compute',
          'instances',
          'describe',
          c.gce.instanceName,
          '--project',
          c.firebaseProjectId,
          '--zone',
          c.gce.zone,
          '--format=json',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }
      )
    );
    validateGceInstance(c, instance);
  }
  if (cloud && c.workerHosting === 'gke') {
    const actual = JSON.parse(
      execFileSync(
        'gcloud',
        [
          'container',
          'clusters',
          'describe',
          c.gke.clusterName,
          '--project',
          c.firebaseProjectId,
          '--location',
          c.gke.location,
          '--format=json',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }
      )
    );
    validateGkeCluster(c, actual);
  }
  const uid = json(['get', 'namespace', 'kube-system']).metadata.uid;
  if (uid !== c.clusterUid) throw new Error('Cluster UID differs from the reviewed environment descriptor');
  const nodes = json(['get', 'nodes']).items;
  const ready = nodes.filter(
    (n) => !n.spec.unschedulable && n.status.conditions.some((s) => s.type === 'Ready' && s.status === 'True')
  );
  if (ready.length < (cloud && c.workerHosting === 'gce-k3s' ? 1 : 3))
    throw new Error('Reviewed Ready schedulable node count is required');
  if (
    cloud &&
    c.workerHosting === 'gce-k3s' &&
    (ready.length !== 1 ||
      c.workerIdentityNodeNames.length !== 1 ||
      ready[0].metadata.name !== c.workerIdentityNodeNames[0])
  )
    throw new Error('Simple worker mode requires the one actual reviewed Node identity');
  if (!ready.every((n) => n.metadata.labels['kubernetes.io/hostname']))
    throw new Error('Node topology labels are missing');
  if (c.databaseMode === 'self-hosted') {
    const version = JSON.parse(kubectl(['version', '-o', 'json'])).serverVersion;
    const minor = Number.parseInt(version.minor, 10);
    if (version.major !== '1' || minor < 34 || minor > 36)
      throw new Error('CloudNativePG1.30 requires supported Kubernetes1.34 through1.36');
  }
}
function secret(name, keys) {
  const resource = json(['get', 'secret', name, '-n', c.namespace]);
  if (keys.some((k) => !resource.data?.[k])) throw new Error(`Secret ${name} is missing required fields`);
  // Certificates/passwords stay in process memory and are never printed.
  return resource;
}
function requireManagedSecret(name) {
  const version = JSON.parse(
    execFileSync(
      'gcloud',
      [
        'secrets',
        'versions',
        'describe',
        'latest',
        '--secret',
        name,
        '--project',
        c.firebaseProjectId,
        '--format=json',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }
    )
  );
  if (version.state !== 'ENABLED') throw new Error(`Managed Secret ${name} must have an enabled latest version`);
}
async function requirePlatformReadiness({ requireRecovery = false } = {}) {
  if (cloud) return validateCloudEvidence(c, JSON.parse(await readFile(c.cloudEvidence, 'utf8')), { requireRecovery });
  const evidence = validateBackupEvidence(c, JSON.parse(await readFile(c.backupEvidence, 'utf8')));
  if (c.databaseMode === 'self-hosted') {
    const source = json(['get', 'cluster', 'temporal-postgres', '-n', c.namespace]);
    if (
      evidence.archiveSource.sourceClusterUid !== source.metadata.uid ||
      evidence.archiveSource.sourceSystemId !== source.status?.systemID
    )
      throw new Error('Restore proof belongs to a different physical PostgreSQL cluster');
  }
  if (
    evidence.clusterUid !== c.clusterUid ||
    evidence.environment !== c.environment ||
    evidence.postgresHost !== c.postgresHost ||
    evidence.isolatedRestore !== true ||
    evidence.bothDatabasesVerified !== true ||
    evidence.sideEffectsDisabled !== true ||
    evidence.result !== 'passed'
  )
    throw new Error('Backup evidence does not prove an isolated restore of this database');
  for (const key of ['backupVerifiedAt', 'restoreVerifiedAt']) {
    const age = Date.now() - Date.parse(evidence[key]);
    if (!Number.isFinite(age) || age < 0 || age > (key === 'backupVerifiedAt' ? 2 : 30) * 86400_000)
      throw new Error(`Stale ${key} in backup evidence`);
  }
}
requireReadyCluster();
if (cloud && peerDefinition.deploymentState !== 'planned') {
  if (peerDefinition.workerHosting === 'gce-k3s') {
    const actual = JSON.parse(
      execFileSync(
        'gcloud',
        [
          'compute',
          'instances',
          'describe',
          peerDefinition.gce.instanceName,
          '--project',
          peerDefinition.firebaseProjectId,
          '--zone',
          peerDefinition.gce.zone,
          '--format=json',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }
      )
    );
    validateGceInstance(peerDefinition, actual);
  } else if (peerDefinition.workerHosting === 'gke') {
    const actual = JSON.parse(
      execFileSync(
        'gcloud',
        [
          'container',
          'clusters',
          'describe',
          peerDefinition.gke.clusterName,
          '--project',
          peerDefinition.firebaseProjectId,
          '--location',
          peerDefinition.gke.location,
          '--format=json',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }
      )
    );
    validateGkeCluster(peerDefinition, actual);
  } else throw new Error('Deployed Cloud peer must provide its actual reviewed infrastructure descriptor');
  const system = JSON.parse(
    execFileSync('kubectl', ['--context', peerDefinition.context, 'get', 'namespace', 'kube-system', '-o', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    })
  );
  if (system.metadata.uid !== peerDefinition.clusterUid)
    throw new Error('Deployed peer actual cluster identity differs from reviewed isolation proof');
}

if (action !== 'preflight' && !apply) {
  console.log(
    `Read-only preflight passed for ${c.environment}. Add --apply only after infrastructure inputs have been reviewed.`
  );
  process.exit(0);
}
const directory = await mkdtemp(join(tmpdir(), 'urm-temporal-platform-'));
let lockUid;
try {
  if (action !== 'preflight') {
    const lock = jsonCreate({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'temporal-platform-operation-lock', namespace: c.namespace },
      data: { operation: action, operationId: randomUUID(), startedAt: new Date().toISOString() },
    });
    lockUid = lock.metadata.uid;
  }
  const manifests = renderPlatform(c);
  const commands = platformOperatorCommands(c, Number(flags['--percentage']));
  const write = async (name, data) => {
    const path = join(directory, name);
    await writeFile(path, JSON.stringify(data));
    return path;
  };
  const applyObject = (object) => kubectl(['apply', '-f', '-'], object);
  const job = async (object) => {
    const created = JSON.parse(kubectl(['create', '-f', '-', '-o', 'json'], object));
    await waitPlatformJob(() => json(['get', `job/${created.metadata.name}`, '-n', c.namespace]), {
      timeoutMs: ((created.spec.activeDeadlineSeconds ?? 300) + 30) * 1000,
    });
    return created.metadata.name;
  };
  async function verifyDatabaseApi() {
    const svc = json(['get', 'service', 'kubernetes', '-n', 'default']);
    const eps = json(['get', 'endpoints', 'kubernetes', '-n', 'default']);
    const expected = [
      { cidr: `${svc.spec.clusterIP}/32`, port: 443 },
      ...eps.subsets.flatMap((s) =>
        s.addresses.flatMap((a) => s.ports.map((p) => ({ cidr: `${a.ip}/32`, port: p.port })))
      ),
    ];
    if (expected.some((e) => !c.kubernetesApiEndpoints.some((r) => r.cidr === e.cidr && r.port === e.port)))
      throw new Error('Private Kubernetes service/DNAT endpoints differ from reviewed network allowlist');
    const pod = json(['get', 'pods', '-n', c.namespace, '-l', 'cnpg.io/cluster=temporal-postgres']).items.find((p) =>
      p.status.conditions?.some((s) => s.type === 'Ready' && s.status === 'True')
    );
    if (!pod) throw new Error('No ready database pod for private API identity proof');
    await job(
      databaseApiCanary(
        c,
        c.namespace,
        'temporal-postgres',
        pod,
        await readFile(new URL('../ops/temporal/kubernetes-api-canary.cjs', import.meta.url), 'utf8')
      )
    );
  }
  async function download(url, sha, filename) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Artifact download failed: HTTP${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(buffer).digest('hex') !== sha)
      throw new Error('Pinned infrastructure artifact checksum mismatch');
    const path = join(directory, filename);
    await writeFile(path, buffer);
    return path;
  }
  if (action === 'cert-manager') {
    kubectl([
      'apply',
      '--server-side',
      '-f',
      await download(
        `https://github.com/cert-manager/cert-manager/releases/download/v${versions.certManager}/cert-manager.yaml`,
        versions.certManagerManifestSha256,
        'cert-manager.yaml'
      ),
    ]);
    for (const name of ['cert-manager', 'cert-manager-webhook', 'cert-manager-cainjector'])
      kubectl(['rollout', 'status', `deployment/${name}`, '-n', 'cert-manager', '--timeout=300s']);
  } else if (action === 'operators') {
    const cm = json(['get', 'deployment', 'cert-manager', '-n', 'cert-manager']);
    if (!cm.status.availableReplicas) throw new Error('Install and verify cert-manager before database operators');
    for (const [url, sha, filename] of [
      [
        `https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v${versions.cloudNativePg}/cnpg-${versions.cloudNativePg}.yaml`,
        versions.cloudNativePgManifestSha256,
        'cnpg.yaml',
      ],
      [
        `https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v${versions.barmanCloud}/manifest.yaml`,
        versions.barmanCloudManifestSha256,
        'barman.yaml',
      ],
    ]) {
      kubectl(['apply', '--server-side', '-f', await download(url, sha, filename)]);
      if (filename === 'cnpg.yaml')
        kubectl(['rollout', 'status', 'deployment/cnpg-controller-manager', '-n', 'cnpg-system', '--timeout=300s']);
    }
    kubectl(['rollout', 'status', 'deployment/barman-cloud', '-n', 'cnpg-system', '--timeout=300s']);
  } else if (action === 'certificates') {
    secret('temporal-root-ca', ['tls.crt', 'tls.key']);
    const rootCa = json(['get', 'secret', 'temporal-root-ca', '-n', c.namespace]);
    applyObject({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'temporal-database-ca', namespace: c.namespace },
      type: 'Opaque',
      data: { 'ca.crt': rootCa.data['tls.crt'] },
    });
    applyObject(manifests.certificates);
    for (const resource of manifests.certificates.items.filter((r) => r.kind === 'Certificate')) {
      kubectl([
        'wait',
        '--for=condition=Ready',
        `certificate/${resource.metadata.name}`,
        '-n',
        c.namespace,
        '--timeout=300s',
      ]);
    }
  } else if (action === 'database') {
    if (c.databaseMode !== 'self-hosted') throw new Error('database action only supports the self-hosted recipe');
    json(['get', 'storageclass', c.storageClass]);
    secret('temporal-database', ['username', 'password']);
    secret('temporal-database-ca', ['ca.crt']);
    secret('temporal-database-server-tls', ['tls.crt', 'tls.key']);
    secret('temporal-backup-objectstore', ['ACCESS_KEY_ID', 'ACCESS_SECRET_KEY']);
    applyObject(manifests.network);
    applyObject(manifests.database);
    kubectl(['wait', '--for=condition=Ready', 'cluster/temporal-postgres', '-n', c.namespace, '--timeout=900s']);
    kubectl(['wait', '--for=condition=Ready', 'database/temporal-visibility', '-n', c.namespace, '--timeout=300s']);
    await verifyDatabaseApi();
  } else if (['schema-bootstrap', 'server'].includes(action)) {
    if (c.databaseMode === 'self-hosted') await verifyDatabaseApi();
    secret('temporal-database', ['password']);
    secret('temporal-database-ca', ['ca.crt']);
    if (action !== 'schema-bootstrap') await requirePlatformReadiness();
    applyObject(manifests.network);
    if (action === 'schema-bootstrap') {
      const pods = json(['get', 'pods', '-n', c.namespace, '-l', 'app.kubernetes.io/name=temporal']);
      if (pods.items.length) throw new Error('Bootstrap refuses an environment with existing Temporal server pods');
      if (c.databaseMode !== 'self-hosted')
        throw new Error(
          'External HA PostgreSQL requires provider-reviewed initial schema setup; automatic bootstrap only operates verified empty CNPG databases'
        );
      const source = json(['get', 'cluster', 'temporal-postgres', '-n', c.namespace]);
      const tableCounts = {};
      if (!source.status?.currentPrimary)
        throw new Error('No verified PostgreSQL primary for initial empty-schema check');
      for (const db of ['temporal', 'temporal_visibility']) {
        const count = kubectl([
          'exec',
          '-n',
          c.namespace,
          source.status.currentPrimary,
          '-c',
          'postgres',
          '--',
          'psql',
          '-X',
          '-A',
          '-t',
          '-U',
          'postgres',
          '-d',
          db,
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public'",
        ]).trim();
        if (!/^\d+$/.test(count)) throw new Error('Invalid initial schema inventory');
        tableCounts[db] = Number(count);
      }
      validateInitialSchemaBootstrap(source, json(['get', 'backups', '-n', c.namespace]).items, tableCounts);

      await job(schemaJob(c, 'bootstrap'));
    } else {
      for (const name of ['temporal-internode-tls', 'temporal-frontend-tls', 'temporal-ui-tls'])
        secret(name, ['tls.crt', 'tls.key', 'ca.crt']);
      if (cloud) {
        requireManagedSecret('TEMPORAL_OPERATOR_API_KEY');
        if (c.workerHosting === 'gce-k3s') secret('temporal-operator-api-key', ['api-key']);
      } else secret('temporal-operator-tls', ['tls.crt', 'tls.key', 'ca.crt']);
      const deployments = json(['get', 'deployments', '-n', c.namespace, '-l', 'app.kubernetes.io/name=temporal']);
      if (deployments.items.length) {
        const previous = JSON.parse(
          execFileSync(
            'helm',
            ['get', 'values', 'temporal', '--kube-context', c.context, '--namespace', c.namespace, '--output', 'json'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
          )
        );
        if (previous.server?.config?.persistence?.numHistoryShards !== c.historyShards)
          throw new Error('History shard count cannot change after cluster initialization');
      }
      for (const deployment of deployments.items) {
        if (deployment.metadata.name === 'temporal-web') continue;
        const image = deployment.spec.template.spec.containers[0].image;
        const match = image.match(/:(\d+)\.(\d+)\.(\d+)(?:@sha256:[a-f0-9]{64})?$/);
        const [major, minor, patch] = versions.server.split('.').map(Number);
        if (
          !match ||
          Number(match[1]) !== major ||
          Math.abs(Number(match[2]) - minor) > 1 ||
          Number(match[2]) > minor ||
          (Number(match[2]) === minor && Number(match[3]) > patch)
        )
          throw new Error('Server upgrades must be sequential, never skip a minor or downgrade');
      }
      await job(schemaJob(c, 'upgrade'));
      const chart = await download(versions.chartUrl, versions.chartSha256, 'temporal.tgz');
      execFileSync(
        'helm',
        [
          'upgrade',
          '--install',
          'temporal',
          chart,
          '--kube-context',
          c.context,
          '--namespace',
          c.namespace,
          '--values',
          await write('values.json', manifests.values),
          '--wait',
          '--timeout',
          '15m',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 960_000 }
      );
      // A separate mTLS operator job validates application readiness and creates the namespace.
      await job(operatorJob(c, 'namespace', commands.namespaceDescribe, commands.namespaceCreate));
    }
  } else if (action === 'worker') {
    await requirePlatformReadiness();
    if (cloud && c.workerHosting === 'gce-k3s') {
      validateSingleHostMedia(c, JSON.parse(await readFile(c.gce.mediaFilesystemEvidence, 'utf8')));
      const node = json(['get', 'node', c.workerIdentityNodeNames[0]]);
      validateSingleHostCapacity(c, node, json(['get', 'pods', '--all-namespaces']).items, manifests.worker);
    }
    if (c.workerRoles.includes('media')) {
      const storage = json(['get', 'storageclass', c.media.storageClass]);
      if (
        !storage.provisioner ||
        (c.workerHosting === 'gce-k3s'
          ? storage.provisioner !== 'rancher.io/local-path' || storage.parameters?.nodePath !== c.gce.mediaMount
          : /hostpath|local-path/i.test(storage.provisioner)) ||
        storage.reclaimPolicy !== 'Delete' ||
        storage.volumeBindingMode !== 'WaitForFirstConsumer'
      )
        throw new Error(
          c.workerHosting === 'gce-k3s'
            ? 'Single-host media storage must match the reviewed dedicated mount, Delete reclaim and WaitForFirstConsumer'
            : 'Media scratch requires topology-aware CSI, Delete reclaim and WaitForFirstConsumer; hostPath/local-path is unsafe'
        );
    }
    for (const name of c.imagePullSecrets) {
      const registry = secret(name, ['.dockerconfigjson']);
      if (registry.type !== 'kubernetes.io/dockerconfigjson')
        throw new Error('Worker registry credentials must be scoped dockerconfigjson Secret');
    }
    if (cloud) {
      requireManagedSecret('TEMPORAL_WORKER_API_KEY');
      if (c.workerHosting === 'gce-k3s') secret('temporal-worker-api-key', ['api-key']);
    } else secret('temporal-worker-tls', ['tls.crt', 'tls.key', 'ca.crt']);
    for (const role of c.workerRoles) {
      const runtime = secret(`temporal-worker-${role}-runtime`, []);
      if (cloud) assertFirebaseRuntimeSecretResources(c, runtime);
      if (
        role === 'controls' &&
        Object.keys(runtime.data ?? {}).some((key) =>
          /^(SMTP_|ALGOLIA_|SUBSPLASH_.*(?:SECRET|TOKEN|PASSWORD)|SOUNDCLOUD_.*(?:SECRET|TOKEN|PASSWORD)|YT_DLP_.*(?:COOKIE|TOKEN)|YOUTUBE_.*(?:COOKIE|TOKEN))|^(CLIENT_SECRET|REFRESH_TOKEN)$/.test(
            key
          )
        )
      )
        throw new Error('Controls runtime secret contains external provider mutation/authentication credentials');
      if (!cloud) secret(`temporal-firebase-${role}`, ['service-account.json']);
    }
    if (c.workerRoles.includes('search')) secret('temporal-search-config', ['instances.json']);
    applyObject(manifests.network);
    applyObject(manifests.worker);
    for (const deployment of manifests.worker.items.filter((resource) => resource.kind === 'Deployment')) {
      kubectl(['rollout', 'status', `deployment/${deployment.metadata.name}`, '-n', c.namespace, '--timeout=600s']);
    }
  } else if (action === 'firebase-rtdb-canary') {
    if (!flags['--output']) throw new Error('Firebase RTDB canary requires private proof output');
    const name = await job(
      firebaseRtdbCanary(
        c,
        await readFile(new URL('../ops/temporal/firebase-rtdb-canary.cjs', import.meta.url), 'utf8')
      )
    );
    const proof = JSON.parse(
      kubectl(['logs', `job/${name}`, '-n', c.namespace])
        .trim()
        .split('\n')
        .at(-1)
    );
    assertFirebaseRtdbCanaryProof(proof, c);
    await writeFile(flags['--output'], JSON.stringify(proof) + '\n', { mode: 0o600, flag: 'wx' });
  } else if (action === 'email-canary') {
    if (!c.workerRoles.includes('email') || !flags['--output'])
      throw new Error('Email canary requires configured email worker and private proof output');
    secret('temporal-worker-email-runtime', []);
    const name = await job(
      emailCanary(c, await readFile(new URL('../ops/temporal/email-canary.cjs', import.meta.url), 'utf8'))
    );
    const proof = JSON.parse(
      kubectl(['logs', `job/${name}`, '-n', c.namespace])
        .trim()
        .split('\n')
        .at(-1)
    );
    if (
      proof.projectId !== c.firebaseProjectId ||
      proof.buildId !== c.workerBuildId ||
      proof.result !== 'passed' ||
      proof.provider !== c.emailEgress.provider ||
      proof.mailPermissionVerified !== (c.emailEgress.provider === 'sendgrid') ||
      proof.tlsVerified !== true ||
      proof.authenticationVerified !== true ||
      proof.noMessageSent !== true
    )
      throw new Error('Email connectivity/authentication proof failed');
    await writeFile(flags['--output'], JSON.stringify(proof) + '\n', { mode: 0o600 });
  } else if (action === 'preflight') {
    await requirePlatformReadiness({ requireRecovery: cloud });
  } else {
    if (cloud) {
      requireManagedSecret('TEMPORAL_OPERATOR_API_KEY');
      if (c.workerHosting === 'gce-k3s') secret('temporal-operator-api-key', ['api-key']);
    } else secret('temporal-operator-tls', ['tls.crt', 'tls.key', 'ca.crt']);
    if (action === 'worker-status') {
      if (!flags['--output']) throw new Error('worker-status requires --output for its non-secret readiness proof');
      const deploymentJob = await job(operatorJob(c, 'describe-deployment', commands.deploymentDescribe));
      const response = JSON.parse(kubectl(['logs', `job/${deploymentJob}`, '-n', c.namespace]));
      assertWorkerRouting(response, c);
      const versionJob = await job(operatorJob(c, 'describe-version', commands.versionDescribe));
      const report = JSON.parse(kubectl(['logs', `job/${versionJob}`, '-n', c.namespace]));
      assertWorkerQueues(report, c);
      await writeFile(
        flags['--output'],
        JSON.stringify(
          {
            projectId: c.firebaseProjectId,
            deploymentName: c.workerDeploymentName,
            buildId: c.workerBuildId,
            current: true,
            allQueuesRegistered: true,
            verifiedAt: new Date().toISOString(),
          },
          null,
          2
        ) + '\n',
        { mode: 0o600 }
      );
    } else if (action === 'retire') {
      const inspectJob = await job(operatorJob(c, 'describe-version', commands.drainDescribe));
      assertDrained(JSON.parse(kubectl(['logs', `job/${inspectJob}`, '-n', c.namespace])), c);
      // The lock serializes all routing and retirement commands from this tooling.
      kubectl([
        'delete',
        ...manifests.worker.items
          .filter((resource) => ['Deployment', 'PodDisruptionBudget'].includes(resource.kind))
          .map((resource) => `${resource.kind.toLowerCase()}/${resource.metadata.name}`),
        '-n',
        c.namespace,
        '--wait=true',
        '--timeout=240s',
      ]);
      console.log(`Temporal ${c.environment} drained worker retired.`);
      process.exitCode = 0;
    } else {
      const percentage = Number(flags['--percentage']);
      if (action === 'ramp' && (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100))
        throw new Error('ramp requires --percentage in(0,100]');
      await job(operatorJob(c, action, commands[action]));
    }
  }
  console.log(
    `Temporal ${c.environment} ${action} completed. Worker versions are retained until drainage is verified.`
  );
} finally {
  if (lockUid) {
    const lock = json(['get', 'configmap', 'temporal-platform-operation-lock', '-n', c.namespace]);
    if (lock.metadata.uid === lockUid)
      kubectl(['delete', 'configmap', 'temporal-platform-operation-lock', '-n', c.namespace]);
  }
  await rm(directory, { recursive: true, force: true });
}

function jsonCreate(object) {
  return JSON.parse(kubectl(['create', '-f', '-', '-o', 'json'], object));
}
