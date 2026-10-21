import {readRestoredMediaRecoveryPlan} from './temporal-restored-media-registration.mjs';
import {scanRestoredMediaInventory} from './temporal-restored-media-inventory.mjs';
import {readRestoredMediaActivationPool} from './temporal-restored-media-resources.mjs';
import {assertRestoredMediaActivationAuthority,readRestoredMediaActivationAccess} from './temporal-media-restored-origin.mjs';
import {scanPrivateMediaInventory} from './temporal-media-private-inventory.mjs';
import {observeMediaRecoveryProtection} from './temporal-media-recovery-protection.mjs';
import {observeMediaRecoveryDiagnosticZeroPool,mediaDiagnosticConfirmationProof} from './temporal-media-stop-confirmation.mjs';
import {waitForMediaDiagnosticDrain,assertFreshMediaDiagnosticDrain,observeMediaDiagnosticStopped,observeMediaDiagnosticNeverStarted} from './temporal-media-diagnostic-drain.mjs';
import {assertMediaRecoveryAuthority} from './temporal-media-recovery-checkpoint.mjs';
import {proofDigest as recoveryHash} from './temporal-release-runtime.mjs';
import {startMediaRecoveryWorkflow,observeMediaRecoveryStartedPool} from './temporal-media-recovery-start.mjs';
import {independentPromotionRoles,denyUnprovedMediaPromotion} from './temporal-promotion-roles.mjs';
import {loadNativeReleaseApplication} from './temporal-native-application.mjs';
import {promoteCloudRunControls,promoteCloudRunSearch,promoteCloudRunEmail,promoteCloudRunImages,promoteCloudRunMedia} from './temporal-promote-controls.mjs';
import { observeBootstrapProtection, observeBootstrapRegistration, observeControlsPromotionBefore, observeControlsPromotionAfter,observeSearchPromotionBefore,observeSearchPromotionAfter,observeEmailPromotionBefore,observeEmailPromotionAfter,observeImagesPromotionBefore,observeImagesPromotionAfter,observeMediaPromotionBefore,observeMediaPromotionAfter } from './temporal-bootstrap-observations.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createImageReplayObserver,createMediaRecoveryImageReplayObserver,assertMediaRecoveryImageReplayReceipt } from './temporal-image-replay.mjs';
import { isAbsolute, join } from 'node:path';
import { realpath, open, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
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
async function withNativeCloudRunClient({ binding, config, platform, firestore }, observe, purpose) {
  validateCloudRunReleasePlatform(platform);
  if (['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST',
    'FIREBASE_STORAGE_EMULATOR_HOST'].some(name => process.env[name]))
    throw new Error('CLOUD_RUN_RELEASE_REFUSES_EMULATOR_TRANSPORT');
  const key = await readCloudRunOperatorKey(platform.operatorApiKeyFile, platform.operatorApiKeySHA256);
  const { loadVerifiedRuntimeApplication } = await import('./temporal-release-runtime.mjs');
  const application = await loadVerifiedRuntimeApplication(binding, config, firestore, () => {
    return loadNativeReleaseApplication(binding.runtimeRoot);
  });
  let connection;
  try {
    connection = await application.Connection.connect({ address: platform.cloudAddress, tls: true, apiKey: key,
      connectTimeout: 15000,...nativePromotionConnectionOptions(purpose) });
    const client = new application.Client({ connection, namespace: platform.temporalNamespace });
    return await observe(client, application);

  } finally { await connection?.close(); }
}

export async function collectCloudRunReleaseWorkers({
  binding,
  config,
  platform,
  firestore,
  artifactDirectory,
  recordIntent,
  savedIntent,
  operationId,
  bindingDigest,
}) {
  return withNativeCloudRunClient({ binding, config, platform, firestore }, async (client, application) => {
    await application.assertServerlessReadinessArtifactDirectory(artifactDirectory);
    if (savedIntent && !/^[a-f0-9]{64}$/.test(savedIntent.imageWorkflowBundleSHA256 ?? ''))
      throw new Error('CLOUD_RUN_SAVED_BUNDLE_INTENT_INVALID');
    // This digest binds the canonical release configuration, not a new CI attestation.
    const evidenceDigest = createHash('sha256')
      .update(
        JSON.stringify({
          bindingDigest,
          releaseId: config.releaseId,
          image: platform.workerImage,
          scope: 'workers-ready-image-configuration',
        })
      )
      .digest('hex');
    const image = await createImageReplayObserver({
      image: platform.workerImage,
      buildId: platform.workerBuildId,
      operationId,
      bindingDigest,
      evidenceDigest,
      historyToJSON: application.historyToJSON,
    });
    const options = {
      client,
      firestore,
      artifactDirectory,
      imageWorkflowBundleSHA256: image.bundleSHA256,
      bindings: platform.roleBindings.map(
        ({ projectId, region, namespace, role, buildId, poolName, deploymentName, runnerServiceAccount, image }) => ({
          projectId,
          region,
          namespace,
          role,
          buildId,
          poolName,
          deploymentName,
          runnerServiceAccount,
          image,
        })
      ),
    };
    const proof = await (savedIntent
      ? application.reconcileServerlessRoleReadiness({ ...options, savedIntent })
      : application.collectServerlessRoleReadiness({ ...options, onStartIntent: recordIntent }));
    await writeFile(
      join(artifactDirectory, `worker-image-bundle-${randomUUID()}.json`),
      JSON.stringify(image.imageProof),
      { flag: 'wx', mode: 0o600 }
    );
    return proof;
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
export async function verifyCloudRunScalerPolicies(platform, api, selectedRoles) {
  validateCloudRunReleasePlatform(platform);
  selectedRoles ??= platform.workerRoles;
  if (!Array.isArray(selectedRoles) || !selectedRoles.length || new Set(selectedRoles).size !== selectedRoles.length || selectedRoles.some(role => !platform.workerRoles?.includes(role))) throw new Error('CLOUD_RUN_SCALER_POLICY_UNCONFIRMED');
  validateCloudRunReleasePlatform(platform);
  if (typeof api !== 'function') throw new Error('CLOUD_RUN_SCALER_POLICY_UNCONFIRMED');
  const receipts = [];
  const identities = new Set();
  try {
    for (const binding of platform.roleBindings.filter(binding => selectedRoles.includes(binding.role))) {
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
  const deadline=Date.now()+(options.recovery === 'scheduler' ? 80000 : options.recovery === 'retry' ? 50000 : 20000);
  while(Date.now()<deadline&&!options.signal?.aborted){
   try{return await application.collectDispatchDiagnosticExecution({db:options.firestore,client,manifest:options.diagnostic.manifest,surface:options.surface,recovery:options.recovery,deadline});}
   catch{if(Date.now()>=deadline||options.signal?.aborted)break;await new Promise(resolve=>setTimeout(resolve,500));}
  }
  throw new Error('NATIVE_DIAGNOSTIC_COMPLETION_UNCONFIRMED');
 });
}

export async function verifyCloudRunBootstrapProtection(options) {
  return withNativeCloudRunClient(options, client => observeBootstrapProtection({...options, client}));
}
export async function verifyCloudRunBootstrapRegistration(options) {
  return withNativeCloudRunClient(options, async (client,application) => {
    if(options.role!=='media')return observeBootstrapRegistration({...options,client});
    const b=options.platform.roleBindings.find(b=>b.role==='media');
    const capacity=await application.collectMediaStartupCapacity({firestore:options.firestore,operationId:options.operationId,
      binding:{projectId:b.projectId,region:b.region,namespace:b.namespace,role:b.role,buildId:b.buildId,poolName:b.poolName,deploymentName:b.deploymentName,runnerServiceAccount:b.runnerServiceAccount,image:b.image},
      readResource:application.readServerlessResource,verifyPool:application.verifyServerlessPool});
    const registration=await observeBootstrapRegistration({...options,client});
    return joinMediaStartupRegistration(registration,capacity);
  });
}

/** Source/CI/image guards are established by the canonical release controller. */
async function runPromotion(options,role){
 return withNativeCloudRunClient(options,async(client,application)=>{
  // No source-built bundle or caller-selected file can substitute for final image bytes.
  const imageReplay=await createImageReplayObserver({image:options.platform.workerImage,
    buildId:options.platform.workerBuildId,operationId:options.operationId,
    bindingDigest:options.bindingDigest,evidenceDigest:options.evidenceDigest,historyToJSON:application.historyToJSON});
  const observe={...options,client,bundleSHA256:imageReplay.bundleSHA256,
    replayHistory:imageReplay.replayHistory,imageReplayProof:imageReplay.imageProof};
  const operations={controls:[promoteCloudRunControls,observeControlsPromotionBefore,observeControlsPromotionAfter],search:[promoteCloudRunSearch,observeSearchPromotionBefore,observeSearchPromotionAfter],email:[promoteCloudRunEmail,observeEmailPromotionBefore,observeEmailPromotionAfter],images:[promoteCloudRunImages,observeImagesPromotionBefore,observeImagesPromotionAfter],media:[promoteCloudRunMedia,observeMediaPromotionBefore,observeMediaPromotionAfter]};
  const [run,before,after]=operations[role];
  return run({...options,client,before:()=>before(observe),after:()=>after(observe)});
 },`${role}-promotion`);
}

export const runCloudRunControlsPromotion=o=>runPromotion(o,'controls');
export const runCloudRunSearchPromotion=o=>runPromotion(o,'search');

export const runCloudRunEmailPromotion=o=>runPromotion(o,'email');

export const runCloudRunImagesPromotion=o=>runPromotion(o,'images');

export const runCloudRunMediaPromotion=async()=>denyUnprovedMediaPromotion();

/** Fixed promotion purposes use one transport attempt, including SDK interceptors. */
export function nativePromotionConnectionOptions(purpose){
 return (purpose==='media-recovery-start'||independentPromotionRoles.some(role=>purpose===`${role}-promotion`))?{interceptors:[],channelArgs:{'grpc.enable_retries':0}}:{};
}

export function joinMediaStartupRegistration(registration,capacity){
 const at=Date.parse(registration?.observedAt??'');
 const capacityAt=Date.parse(capacity?.capacityObservedAt??'');
 if(!Number.isFinite(at)||Math.abs(Date.now()-at)>5000||!Number.isFinite(capacityAt)||capacityAt>Date.now()+5000||Date.now()-capacityAt>120000)throw new Error('MEDIA_STARTUP_REGISTRATION_EXPIRED');
 return {...registration,mediaStartupCapacity:capacity};
}

/** Source/CI/image/authority loader and a fixed nonretrying native START purpose. */
export const startCloudRunMediaRecovery=o=>withNativeCloudRunClient(o,(client,application)=>startMediaRecoveryWorkflow({...o,client,application}),'media-recovery-start');

/** Exact verified-image private profile; GET-only native facts and offline replay.
 * This returns an episode proof only, never a drain or restored-origin proof. */
export const collectCloudRunMediaRecovery=o=>withNativeCloudRunClient(o,async(client,application)=>{
 try{
  await assertMediaRecoveryAuthority(o);
  if(o.platform.workerImage!==o.plan.image||o.platform.workerBuildId!==o.plan.buildId)throw Error();
  const collectorAuthority={db:o.firestore,client,operationId:o.operationId,plan:o.plan,
   expectedRootSHA256:o.ownedOperation.dataDigest,expectedControlSHA256:o.expectedAuthority.control.dataDigest,
   expectedStateSHA256:o.expectedAuthority.state.dataDigest};
  await application.waitForMediaRecoveryEpisode({...collectorAuthority,runId:o.start.runId});
  const image=await createMediaRecoveryImageReplayObserver({image:o.plan.image,buildId:o.plan.buildId,
   operationId:o.operationId,bindingDigest:o.bindingDigest,evidenceDigest:o.plan.evidenceDigest,historyToJSON:application.historyToJSON});
  const read=()=>application.collectMediaRecoveryExecution({db:o.firestore,client,operationId:o.operationId,plan:o.plan,
   expectedRootSHA256:o.ownedOperation.dataDigest,expectedControlSHA256:o.expectedAuthority.control.dataDigest,
   expectedStateSHA256:o.expectedAuthority.state.dataDigest,image:{bundleSHA256:image.bundleSHA256,tools:image.tools}});
  await observeMediaRecoveryStartedPool(o,o.plan,o.pool);
  const first=await read();
  const replay=await image.replayHistory(first.history,first.workflowId,first.runId);
  assertMediaRecoveryImageReplayReceipt(replay,{image:o.plan.image,buildId:o.plan.buildId,operationId:o.operationId,
   bindingDigest:o.bindingDigest,evidenceDigest:o.plan.evidenceDigest,bundleSHA256:image.bundleSHA256,
   workflowId:first.workflowId,runId:first.runId,historySHA256:recoveryHash(first.history)});
  const second=await read();
  if(second.evidenceSHA256!==first.evidenceSHA256)throw Error();
  const pool=await observeMediaRecoveryStartedPool(o,o.plan,o.pool);
  await assertMediaRecoveryAuthority(o);
  if(Date.now()>=pool.deadline||performance.now()-pool.sampledMonotonic>=5000)throw Error();
  return {kind:'recovery',operationId:o.operationId,bindingDigest:o.bindingDigest,buildId:o.plan.buildId,image:o.plan.image,
   proofSHA256:recoveryHash({evidence:first.evidenceSHA256,image:image.imageProof,replay})};
 }catch{throw new Error('MEDIA_RECOVERY_COLLECTION_UNCONFIRMED');}
});

/** Read-only namespace/partition drain. Native poller caches may outlive close;
 * only fresh empty native observations permit the immutable drain checkpoint. */
export const drainCloudRunMediaRecovery=o=>withNativeCloudRunClient(o,async client=>{
 try{
  await observeMediaRecoveryStartedPool(o,o.plan,o.pool);
  const observation=await waitForMediaDiagnosticDrain({...o,client});
  const pool=await observeMediaRecoveryStartedPool(o,o.plan,o.pool);
  await assertMediaRecoveryAuthority(o);
  if(Date.now()>=pool.deadline||performance.now()-pool.sampledMonotonic>=5000)throw Error();
  assertFreshMediaDiagnosticDrain(observation,o.plan,o.pool);
  return {kind:'drained',operationId:o.operationId,bindingDigest:o.bindingDigest,buildId:o.plan.buildId,image:o.plan.image,proofSHA256:recoveryHash(observation),observation};
 }catch{throw new Error('MEDIA_DIAGNOSTIC_DRAIN_UNCONFIRMED');}
});

const confirmMediaDiagnosticZero=(o,kind,observe)=>withNativeCloudRunClient(o,async client=>{
 try{
  const before=await observeMediaRecoveryDiagnosticZeroPool(o);
  const observation=await observe({...o,client});
  const after=await observeMediaRecoveryDiagnosticZeroPool(o);
  await assertMediaRecoveryAuthority(o);
  return mediaDiagnosticConfirmationProof(o,kind,observation,before,after);
 }catch{throw new Error('MEDIA_DIAGNOSTIC_CONFIRMATION_UNCONFIRMED');}
});
export const confirmCloudRunMediaRecoveryStopped=o=>confirmMediaDiagnosticZero(o,'stopped',observeMediaDiagnosticStopped);
export const confirmCloudRunMediaRecoveryNeverStarted=o=>confirmMediaDiagnosticZero(o,'never-started',observeMediaDiagnosticNeverStarted);

/** Exact source-authenticated original startup identity, not a poller policy. */
export const observeCloudRunMediaIdleStartup=o=>withNativeCloudRunClient(o,async(_client,application)=>{
 try{
  const boundedRead=async fn=>{let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('MEDIA_RECOVERY_IDLE_STARTUP_UNCONFIRMED')),5000);})]);}finally{clearTimeout(timer);}};
  await boundedRead(()=>assertMediaRecoveryAuthority(o));
  const startup=await boundedRead(()=>o.firestore.doc(`_control/temporalMediaRecoveryStartup-${o.operationId}`).get());
  const image=startup.exists?await createMediaRecoveryImageReplayObserver({image:o.plan.image,buildId:o.plan.buildId,operationId:o.operationId,bindingDigest:o.bindingDigest,evidenceDigest:o.plan.evidenceDigest,historyToJSON:application.historyToJSON}):undefined;
  const result=await application.collectMediaRecoveryIdleStartup({db:o.firestore,auth:o.firebaseAuth,operationId:o.operationId,plan:o.plan,phasePool:o.phasePool,expectedRootSHA256:o.ownedOperation.dataDigest,expectedControlSHA256:o.expectedAuthority.control.dataDigest,expectedStateSHA256:o.expectedAuthority.state.dataDigest,...(image?{image:{bundleSHA256:image.bundleSHA256,tools:image.tools}}:{})});
  await boundedRead(()=>assertMediaRecoveryAuthority(o));
  if(!Number.isFinite(Date.parse(result.observedAt))||!Number.isFinite(Date.parse(o.phasePool.observedAt))||Math.abs(Date.now()-Date.parse(result.observedAt))>=5000||Math.abs(Date.now()-Date.parse(o.phasePool.observedAt))>=5000)throw Error();
  return result;
 }catch{throw new Error('MEDIA_RECOVERY_IDLE_STARTUP_UNCONFIRMED');}
});

/** Complete source-fixed diagnostic namespace policy. Preflight stays denied
 * pending separate native platform evidence and restored-origin activation. */
export const protectCloudRunMediaRecovery=o=>withNativeCloudRunClient(o,async(client,application)=>{
 try{
  const began=Date.now(),monotonic=performance.now();
  const fresh=()=>{if(Date.now()-began<0||Date.now()-began>=5000||performance.now()-monotonic<0||performance.now()-monotonic>=5000)throw Error();};
  const read=async fn=>{let timer;try{fresh();const value=await Promise.race([Promise.resolve().then(()=>{fresh();return fn();}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('MEDIA_RECOVERY_PHASE_PROTECTION_UNCONFIRMED')),Math.max(1,5000-(Date.now()-began)));})]);fresh();return value;}finally{clearTimeout(timer);}};
  await read(()=>assertMediaRecoveryAuthority(o));
  let readIdle;
  if(o.phase==='start'){
   const startup=await read(()=>o.firestore.doc(`_control/temporalMediaRecoveryStartup-${o.operationId}`).get());
   const image=startup.exists?await createMediaRecoveryImageReplayObserver({image:o.plan.image,buildId:o.plan.buildId,operationId:o.operationId,bindingDigest:o.bindingDigest,evidenceDigest:o.plan.evidenceDigest,historyToJSON:application.historyToJSON}):undefined;
   readIdle=()=>application.collectMediaRecoveryIdleStartup({db:o.firestore,auth:o.firebaseAuth,operationId:o.operationId,plan:o.plan,phasePool:o.phasePool,expectedRootSHA256:o.ownedOperation.dataDigest,expectedControlSHA256:o.expectedAuthority.control.dataDigest,expectedStateSHA256:o.expectedAuthority.state.dataDigest,...(image?{image:{bundleSHA256:image.bundleSHA256,tools:image.tools}}:{})});
  }
  const result=await observeMediaRecoveryProtection({...o,client,readIdle});
  await read(()=>assertMediaRecoveryAuthority(o));
  if(!Number.isFinite(Date.parse(result.observedAt))||Math.abs(Date.now()-Date.parse(result.observedAt))>=5000||Math.abs(Date.now()-Date.parse(o.phasePool.observedAt))>=5000)throw Error();
  fresh();
  return result;
 }catch{throw new Error('MEDIA_RECOVERY_PHASE_PROTECTION_UNCONFIRMED');}
});

/** Fixed NEW-parent historical origin, never scale/promotion authority. */
export const readRestoredMediaActivationOrigin=o=>withNativeCloudRunClient(o,async(client,application)=>{
 try{
  const bounded=async fn=>{let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('RESTORED_MEDIA_ORIGIN_UNCONFIRMED')),5000);})]);}finally{clearTimeout(timer);}};
  await bounded(()=>assertRestoredMediaActivationAuthority(o));
  const before=await readRestoredMediaActivationAccess(o),p=before.plan;
  const image=await createMediaRecoveryImageReplayObserver({image:p.image,buildId:p.buildId,operationId:o.recoveryOperationId,bindingDigest:p.bindingDigest,evidenceDigest:p.evidenceDigest,historyToJSON:application.historyToJSON});
  const args={db:o.firestore,client,recoveryOperationId:o.recoveryOperationId,activationOperationId:o.operationId,activationBindingDigest:o.bindingDigest,releaseId:o.releaseId,expectedRootSHA256:o.ownedOperation.dataDigest,expectedControlSHA256:o.expectedAuthority.control.dataDigest,expectedStateSHA256:o.expectedAuthority.state.dataDigest,buildId:p.buildId,imageDigest:p.image,image:{bundleSHA256:image.bundleSHA256,tools:image.tools}};
  const first=await application.collectCompletedMediaRecoveryExecution(args);
  const replay=await image.replayHistory(first.history,first.workflowId,first.runId);
  assertMediaRecoveryImageReplayReceipt(replay,{image:p.image,buildId:p.buildId,operationId:o.recoveryOperationId,bindingDigest:p.bindingDigest,evidenceDigest:p.evidenceDigest,bundleSHA256:image.bundleSHA256,workflowId:first.workflowId,runId:first.runId,historySHA256:recoveryHash(first.history)});
  const second=await application.collectCompletedMediaRecoveryExecution(args);
  if(first.evidenceSHA256!==second.evidenceSHA256||first.provenanceSHA256!==second.provenanceSHA256)throw Error();
  const at=Date.now(),mono=performance.now(),fresh=()=>{if(Date.now()<at||Date.now()-at>=5000||performance.now()-mono>=5000)throw Error();};
  const read=async fn=>{fresh();const value=await bounded(fn);fresh();return value;},rpc=fn=>read(()=>client.connection.withDeadline(at+5000,fn));
  const ready=await read(()=>o.firestore.doc(`_control/temporalMediaRecoveryOriginalReady-${o.recoveryOperationId}`).get()),kernel=await read(()=>o.firestore.doc(`_control/temporalMediaRecoveryReplacementKernel-${o.recoveryOperationId}`).get());
  const scan=()=>scanPrivateMediaInventory({client,db:o.firestore,plan:p,operationId:o.recoveryOperationId,read,rpc,auth:{ready:ready.data(),worker:kernel.get('worker')}});
  const native1=await scan(),native2=await scan(),compute=await read(()=>observeNamespaceComputeIsolation(client,'urm-app-staging.qwejt'));
  if(recoveryHash(native1)!==recoveryHash(native2))throw Error();
  const proven=await read(()=>application.confirmCompletedMediaRecoveryProvenance(args));
  if(proven.provenanceSHA256!==first.provenanceSHA256)throw Error();
  const after=await readRestoredMediaActivationAccess(o);
  if(recoveryHash(before.plan)!==recoveryHash(after.plan)||recoveryHash(before.pool)!==recoveryHash(after.pool)||before.capsuleSHA256!==after.capsuleSHA256||before.provenanceSHA256!==after.provenanceSHA256||before.accessSHA256!==after.accessSHA256)throw Error();
  await read(()=>assertRestoredMediaActivationAuthority(o));fresh();
  if(!Number.isFinite(Date.parse(after.observedAt))||Math.abs(Date.now()-Date.parse(after.observedAt))>=5000)throw Error();
  return {kind:'restored-media-activation-origin-v1',operationId:o.operationId,recoveryOperationId:o.recoveryOperationId,bindingDigest:o.bindingDigest,releaseId:o.releaseId,buildId:p.buildId,image:p.image,pool:after.pool,capsuleSHA256:after.capsuleSHA256,proofSHA256:recoveryHash({before:after.provenanceSHA256,access:after.accessSHA256,evidence:first.evidenceSHA256,image:image.imageProof,replay,inventory:native2,compute}),observedAt:new Date(at).toISOString(),scope:'historical-origin-only-no-scale-or-promotion-authority'};
 }catch{throw new Error('RESTORED_MEDIA_ORIGIN_UNCONFIRMED');}
});

/** Source/image-bound historical startup only. Namespace policy, queue permission
 * and registration are deliberately separate and remain unavailable. */
export const readRestoredMediaStartupWitness=o=>withNativeCloudRunClient(o,async(_client,application)=>{
 try{
  const before=await readRestoredMediaActivationPool({...o,count:1});
  const image=await createMediaRecoveryImageReplayObserver({image:o.plan.image,buildId:o.plan.buildId,operationId:o.operationId,bindingDigest:o.bindingDigest,evidenceDigest:o.plan.evidenceDigest,historyToJSON:application.historyToJSON});
  const at=Date.now(),mono=performance.now();
  const fresh=()=>{if(Date.now()<at||Date.now()-at>=5000||performance.now()-mono>=5000)throw Error();};
  const read=async fn=>{let timer;try{fresh();const value=await Promise.race([Promise.resolve().then(()=>{fresh();return fn();}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('RESTORED_MEDIA_STARTUP_READBACK_UNCONFIRMED')),Math.max(1,5000-(Date.now()-at)));})]);fresh();return value;}finally{clearTimeout(timer);}};
  const args={db:o.firestore,auth:o.firebaseAuth,operationId:o.operationId,bindingDigest:o.bindingDigest,plan:o.plan,pool:before,expectedRootSHA256:o.ownedOperation.dataDigest,expectedControlSHA256:o.expectedAuthority.control.dataDigest,expectedStateSHA256:o.expectedAuthority.state.dataDigest,image:image.tools};
  const first=await read(()=>application.collectRestoredMediaStartup(args));
  const after=await read(()=>readRestoredMediaActivationPool({...o,count:1}));
  if(recoveryHash(before)!==recoveryHash(after))throw Error();
  const second=await read(()=>application.collectRestoredMediaStartup({...args,pool:after}));
  if(first.proofSHA256!==second.proofSHA256||first.identity!==second.identity||first.kernelBirthSHA256!==second.kernelBirthSHA256||first.startupSHA256!==second.startupSHA256)throw Error();
  await read(()=>assertRestoredMediaActivationAuthority(o));fresh();
  return {...second,imageSHA256:recoveryHash(image.imageProof),scope:'historical-startup-only-no-polling-or-registration-authority'};
 }catch{throw new Error('RESTORED_MEDIA_STARTUP_READBACK_UNCONFIRMED');}
});

/** Fixed retained normal-media readback. The original episode and current
 * activation remain separate throughout; no zero-origin reader runs here. */
export const readRestoredMediaRegistration = (o) =>
  withNativeCloudRunClient(o, async (client, application) => {
    try {
      const pool = await readRestoredMediaActivationPool({ ...o, count: 1 });
      const p = await readRestoredMediaRecoveryPlan(o);
      const image = await createMediaRecoveryImageReplayObserver({
        image: p.image,
        buildId: p.buildId,
        operationId: o.recoveryOperationId,
        bindingDigest: p.bindingDigest,
        evidenceDigest: p.evidenceDigest,
        historyToJSON: application.historyToJSON,
      });
      const args = {
        db: o.firestore,
        client,
        recoveryOperationId: o.recoveryOperationId,
        activationOperationId: o.operationId,
        activationBindingDigest: o.bindingDigest,
        releaseId: o.releaseId,
        expectedRootSHA256: o.ownedOperation.dataDigest,
        expectedControlSHA256: o.expectedAuthority.control.dataDigest,
        expectedStateSHA256: o.expectedAuthority.state.dataDigest,
        buildId: p.buildId,
        imageDigest: p.image,
        image: { bundleSHA256: image.bundleSHA256, tools: image.tools },
      };
      const first = await application.collectCompletedMediaRecoveryExecution(args);
      const replay = await image.replayHistory(first.history, first.workflowId, first.runId);
      assertMediaRecoveryImageReplayReceipt(replay, {
        image: p.image,
        buildId: p.buildId,
        operationId: o.recoveryOperationId,
        bindingDigest: p.bindingDigest,
        evidenceDigest: p.evidenceDigest,
        bundleSHA256: image.bundleSHA256,
        workflowId: first.workflowId,
        runId: first.runId,
        historySHA256: recoveryHash(first.history),
      });
      const second = await application.collectCompletedMediaRecoveryExecution(args);
      if (first.evidenceSHA256 !== second.evidenceSHA256 || first.provenanceSHA256 !== second.provenanceSHA256)
        throw Error();
      const at = Date.now(),
        mono = performance.now();
      const fresh = () => {
        if (Date.now() < at || Date.now() - at >= 5000 || performance.now() < mono || performance.now() - mono >= 5000)
          throw Error();
      };
      const read = async (fn) => {
        let timer;
        try {
          fresh();
          const value = await Promise.race([
            Promise.resolve().then(() => {
              fresh();
              return fn();
            }),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('RESTORED_MEDIA_REGISTRATION_UNCONFIRMED')),
                Math.max(1, 5000 - (Date.now() - at))
              );
            }),
          ]);
          fresh();
          return value;
        } finally {
          clearTimeout(timer);
        }
      };
      const rpc = (fn) => read(() => client.connection.withDeadline(at + 5000, fn));
      const startupArgs = {
        db: o.firestore,
        auth: o.firebaseAuth,
        operationId: o.operationId,
        bindingDigest: o.bindingDigest,
        plan: o.plan,
        pool,
        expectedRootSHA256: o.ownedOperation.dataDigest,
        expectedControlSHA256: o.expectedAuthority.control.dataDigest,
        expectedStateSHA256: o.expectedAuthority.state.dataDigest,
        image: image.tools,
      };
      const startup = await read(() => application.collectRestoredMediaStartup(startupArgs));
      const ready = await read(() =>
        o.firestore.doc(`_control/temporalMediaRecoveryOriginalReady-${o.recoveryOperationId}`).get()
      );
      const kernel = await read(() =>
        o.firestore.doc(`_control/temporalMediaRecoveryReplacementKernel-${o.recoveryOperationId}`).get()
      );
      const scan = async () => ({
        normal: await scanRestoredMediaInventory({ client, plan: o.plan, startup, rpc }),
        diagnostic: await scanPrivateMediaInventory({
          client,
          db: o.firestore,
          plan: p,
          operationId: o.recoveryOperationId,
          read,
          rpc,
          auth: { ready: ready.data(), worker: kernel.get('worker') },
        }),
        compute: await read(() => observeNamespaceComputeIsolation(client, 'urm-app-staging.qwejt')),
      });
      const before = await scan(),
        after = await scan();
      if (
        recoveryHash(before) !== recoveryHash(after) ||
        !after.normal.ownedPollers.some((row) => row.type === 2 && row.key === 'urm-media')
      )
        throw Error();
      const finalPool = await read(() => readRestoredMediaActivationPool({ ...o, count: 1 }));
      if (recoveryHash(pool) !== recoveryHash(finalPool)) throw Error();
      const finalStartup = await read(() =>
        application.collectRestoredMediaStartup({ ...startupArgs, pool: finalPool })
      );
      if (startup.proofSHA256 !== finalStartup.proofSHA256 || startup.identity !== finalStartup.identity) throw Error();
      const proven = await read(() => application.confirmCompletedMediaRecoveryProvenance(args));
      if (proven.provenanceSHA256 !== first.provenanceSHA256) throw Error();
      await read(() => assertRestoredMediaActivationAuthority(o));
      fresh();
      return {
        kind: 'restored-media-normal-registration-v1',
        operationId: o.operationId,
        planSHA256: recoveryHash(o.plan),
        pool: finalPool,
        proofSHA256: recoveryHash({
          episode: first.evidenceSHA256,
          provenance: first.provenanceSHA256,
          replay,
          image: image.imageProof,
          startup: startup.proofSHA256,
          inventory: after,
        }),
        observedAt: new Date(at).toISOString(),
      };
    } catch {
      throw new Error('RESTORED_MEDIA_REGISTRATION_UNCONFIRMED');
    }
  });
