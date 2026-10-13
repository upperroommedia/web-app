#!/usr/bin/env node
// Runs as root on the reviewed worker VM. Secret/token values never enter argv or logs.
import { isIP } from 'node:net';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function crc32c(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function decodeTemporalKey(payload) {
  const data = Buffer.from(payload?.data ?? '', 'base64');
  const value = data.toString('utf8').trim();
  if (!value || /\s/.test(value) || data.length > 16 * 1024 || String(crc32c(data)) !== payload?.dataCrc32c)
    throw new Error('Invalid or corrupt scoped Temporal key payload');
  return data;
}
export async function synchronize({ projectId, namespace, instanceId, request = fetch, run = execFileSync }) {
  if (
    !['urm-app', 'urm-app-staging'].includes(projectId) ||
    namespace !== (projectId === 'urm-app-staging' ? 'temporal-staging' : 'temporal-production') ||
    !/^[a-z0-9-]+$/.test(namespace) ||
    !/^\d+$/.test(instanceId)
  )
    throw new Error('Exact reviewed project, namespace and VM instance identity required');
  const metadata = async (path) => {
    const response = await request(`http://169.254.169.254/computeMetadata/v1/${path}`, {
      headers: { 'Metadata-Flavor': 'Google' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok || response.headers.get('Metadata-Flavor') !== 'Google')
      throw new Error('Cannot verify attached VM identity');
    return (await response.text()).trim();
  };
  const [actualProject, number, actualInstance, email, privateIp] = await Promise.all(
    [
      'project/project-id',
      'project/numeric-project-id',
      'instance/id',
      'instance/service-accounts/default/email',
      'instance/network-interfaces/0/ip',
    ].map(metadata)
  );
  if (
    actualProject !== projectId ||
    actualInstance !== instanceId ||
    email !== `temporal-worker@${projectId}.iam.gserviceaccount.com` ||
    !/^\d+$/.test(number) ||
    isIP(privateIp) !== 4 ||
    !privateIp.startsWith('10.')
  )
    throw new Error('Attached VM project/service account does not match reviewed worker identity');
  const token = JSON.parse(await metadata('instance/service-accounts/default/token')).access_token;
  if (typeof token !== 'string' || !token) throw new Error('Attached VM token unavailable');
  const registryHost = 'us-central1-docker.pkg.dev';
  const registryConfig = {
    auths: {
      [registryHost]: {
        username: 'oauth2accesstoken',
        password: token,
        auth: Buffer.from(`oauth2accesstoken:${token}`).toString('base64'),
      },
    },
  };
  const registrySecret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'temporal-artifact-registry', namespace },
    type: 'kubernetes.io/dockerconfigjson',
    data: { '.dockerconfigjson': Buffer.from(JSON.stringify(registryConfig)).toString('base64') },
  };
  try {
    run(
      '/usr/local/bin/k3s',
      [
        'kubectl',
        `--server=https://${privateIp}:6443`,
        '--cache-dir=/run/urm-temporal-key-sync/cache',
        'apply',
        '-f',
        '-',
      ],
      { input: JSON.stringify(registrySecret), stdio: ['pipe', 'ignore', 'ignore'], timeout: 30000 }
    );
  } catch {
    throw new Error('Cannot synchronize scoped Artifact Registry pull credential');
  }
  for (const [secretName, kubernetesName] of [
    ['TEMPORAL_WORKER_API_KEY', 'temporal-worker-api-key'],
    ['TEMPORAL_OPERATOR_API_KEY', 'temporal-operator-api-key'],
  ]) {
    const response = await request(
      `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${secretName}/versions/latest:access`,
      { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10000) }
    );
    if (!response.ok) throw new Error(`Scoped managed key unavailable (${secretName})`);
    const body = await response.json();
    if (!new RegExp(`^projects/${number}/secrets/${secretName}/versions/\\d+$`).test(body.name ?? ''))
      throw new Error('Managed key belongs to another project or secret');
    const bytes = decodeTemporalKey(body.payload);
    const object = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: kubernetesName, namespace, annotations: { 'urm.temporal/secret-version': body.name } },
      type: 'Opaque',
      data: { 'api-key': bytes.toString('base64') },
    };
    try {
      run(
        '/usr/local/bin/k3s',
        [
          'kubectl',
          `--server=https://${privateIp}:6443`,
          '--cache-dir=/run/urm-temporal-key-sync/cache',
          'apply',
          '-f',
          '-',
        ],
        {
          input: JSON.stringify(object),
          stdio: ['pipe', 'ignore', 'ignore'],
          timeout: 30000,
        }
      );
    } catch {
      throw new Error(`Cannot synchronize scoped mounted key (${secretName})`);
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    flags = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
  synchronize({
    projectId: flags['--project'],
    namespace: flags['--namespace'],
    instanceId: flags['--instance-id'],
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
