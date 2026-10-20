import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { firebaseResourceEnvironment, validateConfig } from './temporal-platform.mjs';
import { serverlessComputeArguments } from './temporal-serverless-platform.mjs';
import { dispatchResourceNames } from './temporal-serverless-dispatch-resources.mjs';


const roles = ['orchestration', 'controls', 'media', 'email', 'images', 'search'];
const fail = () => { throw new Error('INVALID_CLOUD_RUN_RELEASE_PLATFORM'); };
/** Hosting-specific descriptor; no Kubernetes identity is invented or borrowed. */
export function validateCloudRunReleasePlatform(platform, peer) {
  const fields = ['schemaVersion', 'environment', 'workerHosting', 'connectionMode', 'firebaseProjectId',
    'firebaseResources', 'temporalNamespace', 'cloudAccountId', 'cloudProvider', 'cloudRegion', 'cloudAddress',
    'cloudReplicaRegions', 'cloudEvidence', 'workerBuildId', 'workerImage', 'workerRoles', 'roleBindings',
    'operatorApiKeyFile', 'operatorApiKeySHA256', 'dispatcherEnabled', 'dispatch'];
  if (!platform || Object.keys(platform).some(key => !fields.includes(key)) || platform.schemaVersion !== 1 ||
    platform.environment !== 'staging' || platform.workerHosting !== 'cloud-run' ||
    platform.connectionMode !== 'temporal-cloud' || platform.firebaseProjectId !== 'urm-app-staging' ||
    platform.temporalNamespace !== 'urm-app-staging.qwejt' || platform.cloudAccountId !== 'qwejt' ||
    platform.cloudProvider !== 'gcp' || platform.cloudRegion !== 'us-central1' ||
    !['us-central1.gcp.api.temporal.io:7233', 'urm-app-staging.qwejt.tmprl.cloud:7233'].includes(platform.cloudAddress) ||
    !Array.isArray(platform.cloudReplicaRegions) || platform.cloudReplicaRegions.length ||
    !/^[a-f0-9]{40}$/.test(platform.workerBuildId) ||
    !/^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/.test(platform.workerImage) ||
    !/^[a-f0-9]{64}$/.test(platform.operatorApiKeySHA256) || platform.dispatcherEnabled !== false || !Array.isArray(platform.workerRoles) ||
    !platform.workerRoles.includes('orchestration') || !platform.workerRoles.includes('controls') ||
    new Set(platform.workerRoles).size !== platform.workerRoles.length || platform.workerRoles.some(role => !roles.includes(role)) ||
    !Array.isArray(platform.roleBindings) || platform.roleBindings.length !== platform.workerRoles.length) fail();
  for (const field of ['operatorApiKeyFile', 'cloudEvidence'])
    if (typeof platform[field] !== 'string' || !isAbsolute(platform[field]) || /REQUIRED|PLACEHOLDER|EXAMPLE|[\r\n\0]/.test(platform[field])) fail();
  firebaseResourceEnvironment(platform);
  const seen = new Set();
  for (const binding of platform.roleBindings) {
    serverlessComputeArguments(binding);
    if (binding.buildId !== platform.workerBuildId || binding.image !== platform.workerImage ||
      !platform.workerRoles.includes(binding.role) || seen.has(binding.role)) fail();
    seen.add(binding.role);
  }
  const names = dispatchResourceNames(platform.workerBuildId);
  if (!platform.dispatch || Object.keys(platform.dispatch).sort().join(',') !== Object.keys(names).sort().join(',') ||
    Object.entries(names).some(([key, value]) => platform.dispatch[key] !== value)) fail();
  if (peer !== undefined) {
    if (peer.environment !== 'production' || peer.firebaseProjectId !== 'urm-app' ||
      peer.temporalNamespace === platform.temporalNamespace) fail();
    firebaseResourceEnvironment(peer);
  }
  return platform;
}
export function validateReleasePlatformConfig(platform, peer) {
  return platform.workerHosting === 'cloud-run'
    ? validateCloudRunReleasePlatform(platform, peer)
    : validateConfig(platform, peer);
}
export async function readCloudRunOperatorKey(path, expectedSHA256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSHA256) || !isAbsolute(path) || await realpath(path) !== path) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0 ||
      (file.mode & 0o400) === 0 || file.size < 1 || file.size > 16384) fail();
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== file.size || bytesRead > 16384) fail();
    const key = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (!/^[\x21-\x7e]{1,16384}$/.test(key) || createHash('sha256').update(key).digest('hex') !== expectedSHA256) fail();
    return key;
  } finally { await handle.close(); }
}
/** Load current verified TS source, not a possibly stale untracked lib/ build.
 * CI typechecking and the immutable release/source/image guards remain mandatory.
 * The compiler/SDK come from the frozen runtime's pinned dependency installation. */
export async function collectCloudRunReleaseWorkers({ binding, config, platform, firestore, artifactDirectory, recordIntent }) {
  validateCloudRunReleasePlatform(platform);
  if (['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST',
    'FIREBASE_STORAGE_EMULATOR_HOST'].some(name => process.env[name]))
    throw new Error('CLOUD_RUN_RELEASE_REFUSES_EMULATOR_TRANSPORT');
  const key = await readCloudRunOperatorKey(platform.operatorApiKeyFile, platform.operatorApiKeySHA256);
  const { loadVerifiedRuntimeApplication } = await import('./temporal-release-runtime.mjs');
  const application = await loadVerifiedRuntimeApplication(binding, config, firestore, () => {
    if (process[Symbol.for('ts-node.register.instance')]) throw new Error('RELEASE_COMPILER_ALREADY_ACTIVE');
    const runtimeRequire = createRequire(resolve(binding.runtimeRoot, 'package.json'));
    const service = runtimeRequire('ts-node').register({ skipProject: true, transpileOnly: true, preferTsExts: true,
      compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' } });
    try {
      const workerRequire = createRequire(resolve(binding.runtimeRoot, 'apps/temporal-worker/package.json'));
      return { ...workerRequire('@temporalio/client'),
        ...workerRequire(resolve(binding.runtimeRoot, 'apps/temporal-worker/src/runtime/serverless-release-readiness.ts')) };
    } finally { service.enabled(false); }
  });
  let connection;
  try {
    connection = await application.Connection.connect({ address: platform.cloudAddress, tls: true, apiKey: key,
      connectTimeout: 15000 });
    const client = new application.Client({ connection, namespace: platform.temporalNamespace });
    return await application.collectServerlessRoleReadiness({ client, firestore, artifactDirectory, onStartIntent: recordIntent,
      bindings: platform.roleBindings.map(({ projectId, region, namespace, role, buildId, poolName,
        deploymentName, runnerServiceAccount, image }) => ({ projectId, region, namespace, role, buildId,
        poolName, deploymentName, runnerServiceAccount, image })) });
  } finally { await connection?.close(); }
}

export async function readCloudRunNamespaceEvidence(platform) {
  let handle;
  try {
    handle = await open(platform.cloudEvidence, constants.O_RDONLY | constants.O_NOFOLLOW);
    const file = await handle.stat();
    if (!file.isFile() || file.size < 1 || file.size > 1024 * 1024) fail();
    const buffer = Buffer.alloc(file.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== file.size) fail();
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch { throw new Error('CLOUD_RUN_NAMESPACE_EVIDENCE_UNCONFIRMED'); }
  finally { await handle?.close(); }
}
