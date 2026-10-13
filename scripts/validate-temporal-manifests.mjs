#!/usr/bin/env node
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { renderPlatform, versions } from './temporal-platform.mjs';
const directory = await mkdtemp(join(tmpdir(), 'urm-temporal-validation-'));
try {
  const config = JSON.parse(
    await readFile(new URL('../ops/temporal/environments/staging.example.json', import.meta.url), 'utf8')
  );
  Object.assign(config, {
    privateApiHost: 'temporal.staging.internal',
    emailEgress: {
      schemaVersion: 1,
      provider: 'smtp',
      hostname: 'smtp.example.org',
      port: 465,
      tls: 'implicit',
      addresses: ['192.0.2.10'],
    },
    kubernetesApiEndpoints: [
      { cidr: '10.43.0.1/32', port: 443 },
      { cidr: '10.0.0.1/32', port: 6443 },
    ],
    workerIdentityNodeNames: ['node-1', 'node-2', 'node-3'],
    postgresHost: 'temporal-postgres-rw.temporal-staging.svc.cluster.local',
    postgresServerName: 'temporal-postgres-rw.temporal-staging.svc.cluster.local',
    storageClass: 'durable-csi',
    media: { ...config.media, storageClass: 'quota-csi' },
    backupDestination: 's3://test-only-staging/temporal/',
    backupEndpoint: 'https://backups.example.org',
    applicationEgressCidrs: ['0.0.0.0/0'],
    imagePullSecrets: [],
    workerImage: `ghcr.io/upperroommedia/temporal-worker@sha256:${'a'.repeat(64)}`,
    workerBuildId: 'b'.repeat(40),
  });
  const rendered = renderPlatform(config);
  await writeFile(join(directory, 'values.json'), JSON.stringify(rendered.values));
  await writeFile(join(directory, 'database.json'), JSON.stringify(rendered.database));
  for (const [name, url, sha] of [
    ['chart.tgz', versions.chartUrl, versions.chartSha256],
    [
      'cnpg.yaml',
      `https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v${versions.cloudNativePg}/cnpg-${versions.cloudNativePg}.yaml`,
      versions.cloudNativePgManifestSha256,
    ],
    [
      'barman.yaml',
      `https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v${versions.barmanCloud}/manifest.yaml`,
      versions.barmanCloudManifestSha256,
    ],
  ]) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed download: HTTP${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(buffer).digest('hex') !== sha) throw new Error(`Pinned ${name} checksum mismatch`);
    await writeFile(join(directory, name), buffer);
  }
  const helm = process.env.HELM_BIN || 'helm';
  execFileSync(helm, ['lint', join(directory, 'chart.tgz'), '-f', join(directory, 'values.json')], {
    stdio: 'inherit',
  });
  const manifest = execFileSync(
    helm,
    [
      'template',
      'temporal',
      join(directory, 'chart.tgz'),
      '--namespace',
      config.namespace,
      '-f',
      join(directory, 'values.json'),
    ],
    { encoding: 'utf8' }
  );
  await writeFile(join(directory, 'rendered.yaml'), manifest);
  // Python validators are QA-only and are not runtime dependencies of the platform.
  const python = String.raw`
import json,sys,yaml,jsonschema
root=sys.argv[1]
schemas={}
for file in ['cnpg.yaml','barman.yaml']:
  for d in yaml.safe_load_all(open(root+'/'+file)):
    if d and d.get('kind')=='CustomResourceDefinition':
      for v in d['spec']['versions']:
        schemas[(d['spec']['group']+'/'+v['name'],d['spec']['names']['kind'])]=v['schema']['openAPIV3Schema']
for d in json.load(open(root+'/database.json'))['items']:
  schema=schemas.get((d['apiVersion'],d['kind']))
  if schema: jsonschema.validate(d,schema)
resources=[r for r in yaml.safe_load_all(open(root+'/rendered.yaml')) if r]
deployments=[r for r in resources if r['kind']=='Deployment']
assert len(deployments)==5
for d in deployments:
  if d['metadata']['name']!='temporal-web':
    assert d['spec']['replicas']==3
    pod=d['spec']['template']['spec']
    assert len(pod['topologySpreadConstraints'])==1
    assert any(v['name']=='internode-tls' for v in pod['volumes'])
    assert any(v['name']=='frontend-tls' for v in pod['volumes'])
    assert any(v['name']=='database-ca' for v in pod['volumes'])
for r in resources:
  if r['kind']=='Service': assert r['spec'].get('type','ClusterIP')=='ClusterIP'
  assert r['kind']!='Ingress'
print('Pinned Helm chart and PostgreSQL/backup CRD schemas validated; all services private and server replicas distributed.')
`;
  const pythonBin = process.env.PYTHON_BIN || 'python3';
  execFileSync(pythonBin, ['-c', python, directory], { stdio: 'inherit' });
} finally {
  await rm(directory, { recursive: true, force: true });
}
