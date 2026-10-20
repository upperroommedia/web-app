import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { firebaseResourceEnvironment, validateConfig } from './temporal-platform.mjs';
import { serverlessComputeArguments } from './temporal-serverless-platform.mjs';
import { observeNamespaceComputeIsolation } from './temporal-compute-isolation.mjs';
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
  if (!platform.dispatch || Object.keys(platform.dispatch).sort().join(',') !== [...Object.keys(names), 'apiKeyVersion'].sort().join(',') ||
    typeof platform.dispatch.apiKeyVersion !== 'string' || !/^[1-9][0-9]{0,18}$/.test(platform.dispatch.apiKeyVersion) ||
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
async function withNativeCloudRunClient({ binding, config, platform, firestore }, observe) {
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
    return await observe(client, application);

  } finally { await connection?.close(); }
}

export async function collectCloudRunReleaseWorkers({ binding, config, platform, firestore, artifactDirectory, recordIntent, savedIntent }) {
  return withNativeCloudRunClient({ binding, config, platform, firestore }, async (client, application) => {
    const options = { client, firestore, artifactDirectory,
      bindings: platform.roleBindings.map(({ projectId, region, namespace, role, buildId, poolName,
        deploymentName, runnerServiceAccount, image }) => ({ projectId, region, namespace, role, buildId,
        poolName, deploymentName, runnerServiceAccount, image })) };
    return savedIntent
      ? application.reconcileServerlessRoleReadiness({ ...options, savedIntent })
      : application.collectServerlessRoleReadiness({ ...options, onStartIntent: recordIntent });
  });
}
export async function verifyCloudRunComputeIsolation(options) {
  return withNativeCloudRunClient(options, client =>
    observeNamespaceComputeIsolation(client, options.platform.temporalNamespace));
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


// Native authenticated Temporal Cloud Access template, account qwejt, 2026-10-20.
// These are Temporal-owned impersonators, not application production identities.
// Changes require a new native template observation and reviewed source update.
export const temporalCloudScalerPrincipals = Object.freeze([
  'serviceAccount:serverless-qwejt@prod-vs4padk9dkczcey6d6st9c58e.iam.gserviceaccount.com',
  'serviceAccount:serverless-qwejt@prod-sbe56h6wr4sykaw47a6yg4h66.iam.gserviceaccount.com',
  'serviceAccount:serverless-qwejt@prod-97gr6tp6zkv2t4epubffpz7kt.iam.gserviceaccount.com',
  'serviceAccount:serverless-qwejt@prod-c4cqaqgbfzy23vpzkbxzrx378.iam.gserviceaccount.com',
  'serviceAccount:serverless-qwejt@prod-79z2c6d76au6g5fcq768buqf9.iam.gserviceaccount.com',
]);

/** Mandatory read-only direct-policy gate before native worker probes.
 * api is the guarded operator's authenticated Google API transport, never descriptor input.
 * This does not claim inherited-policy isolation or effective runtime data access.
 * Actual scale/wake and native runtime access checks remain separate release gates.
 */
export async function verifyCloudRunScalerPolicies(platform, api) {
  validateCloudRunReleasePlatform(platform);
  if (typeof api !== 'function') throw new Error('CLOUD_RUN_SCALER_POLICY_UNCONFIRMED');
  const receipts = [];
  const identities = new Set();
  try {
    for (const binding of platform.roleBindings) {
      const runner = `serviceAccount:${binding.runnerServiceAccount}`;
      const scaler = `serviceAccount:${binding.invokerServiceAccount}`;
      const observed = {};
      for (const [kind, email] of [
        ['runner', binding.runnerServiceAccount],
        ['scaler', binding.invokerServiceAccount],
      ]) {
        const resource = `projects/urm-app-staging/serviceAccounts/${email}`;
        const account = await api(`https://iam.googleapis.com/v1/${resource}`);
        if (
          account.email !== email ||
          account.projectId !== 'urm-app-staging' ||
          account.disabled === true ||
          !/^[0-9]{10,30}$/.test(account.uniqueId ?? '') ||
          identities.has(account.uniqueId)
        )
          throw new Error('invalid account');
        identities.add(account.uniqueId);
        observed[kind] = { email, uniqueId: account.uniqueId };
      }
      const scalerResource = `projects/urm-app-staging/serviceAccounts/${binding.invokerServiceAccount}`;
      const runnerResource = `projects/urm-app-staging/serviceAccounts/${binding.runnerServiceAccount}`;
      const pool = `projects/urm-app-staging/locations/us-central1/workerPools/${binding.poolName}`;
      const policies = [
        [
          await api(
            `https://iam.googleapis.com/v1/${scalerResource}:getIamPolicy?options.requestedPolicyVersion=3`,
            'POST'
          ),
          [{ role: 'roles/iam.serviceAccountTokenCreator', members: temporalCloudScalerPrincipals }],
        ],
        [
          await api(
            `https://iam.googleapis.com/v1/${runnerResource}:getIamPolicy?options.requestedPolicyVersion=3`,
            'POST'
          ),
          [{ role: 'roles/iam.serviceAccountUser', members: [scaler] }],
        ],
        [
          await api(`https://run.googleapis.com/v2/${pool}:getIamPolicy?options.requestedPolicyVersion=3`),
          [
            { role: 'roles/run.viewer', members: [runner] },
            { role: 'roles/run.developer', members: [scaler] },
          ],
        ],
      ];
      for (const [policy, expected] of policies) {
        if (
          !policy ||
          typeof policy.etag !== 'string' ||
          !policy.etag ||
          !Array.isArray(policy.bindings) ||
          policy.bindings.some((b) => b.condition || Object.keys(b).some((k) => !['role', 'members'].includes(k))) ||
          policy.bindings.length !== expected.length
        )
          throw new Error('invalid direct policy');
        for (const grant of expected) {
          const matches = policy.bindings.filter((b) => b.role === grant.role);
          const members = matches[0]?.members;
          if (
            matches.length !== 1 ||
            !Array.isArray(members) ||
            members.length !== grant.members.length ||
            new Set(members).size !== members.length ||
            !grant.members.every((member) => members.includes(member))
          )
            throw new Error('invalid direct grant');
        }
      }
      receipts.push({
        role: binding.role,
        pool,
        ...observed,
        directPolicySHA256: policies.map(([policy]) =>
          createHash('sha256').update(JSON.stringify(policy)).digest('hex')
        ),
      });
    }
    return {
      schemaVersion: 1,
      projectId: 'urm-app-staging',
      namespace: platform.temporalNamespace,
      buildId: platform.workerBuildId,
      observedAt: new Date().toISOString(),
      scope: 'resource direct policies only; inherited and effective access not established',
      roles: receipts,
    };
  } catch {
    throw new Error('CLOUD_RUN_SCALER_POLICY_UNCONFIRMED');
  }
}

export async function collectCloudRunDispatchDiagnostic(options){
 return withNativeCloudRunClient(options,async(client,application)=>{
  const deadline=Date.now()+20000;
  while(Date.now()<deadline&&!options.signal?.aborted){
   try{return await application.collectDispatchDiagnosticExecution({db:options.firestore,client,manifest:options.diagnostic.manifest,deadline});}
   catch{if(Date.now()>=deadline||options.signal?.aborted)break;await new Promise(resolve=>setTimeout(resolve,500));}
  }
  throw new Error('NATIVE_DIAGNOSTIC_COMPLETION_UNCONFIRMED');
 });
}
