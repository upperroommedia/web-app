import {observeMediaDiskQuota,assertMediaDiskQuotaFresh,assertMediaDiskQuotaProof} from './temporal-media-disk-quota.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateCloudRunReleasePlatform } from './temporal-release-cloud-run.mjs';
import { readOwnedPreparationRunner, poolSecretReferences, normalizeStagingResourceName as normalize } from './temporal-preparation-resources.mjs';
import { renderServerlessWorkerPool } from './temporal-serverless-resources.mjs';
const fail = () => { throw new Error('CLOUD_RUN_ZERO_POOL_PREPARATION_UNCONFIRMED'); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const mediaPoolPreSendAbortReason = 'media-pool-final-authorization-rejected-before-send';
export const mediaPoolSendFenceVersion = 'media-pool-send-v2';

function operationName(value) {
  const result = normalize(value);
  if (!/^projects\/urm-app-staging\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/.test(result ?? '')) fail();
  return result;
}
function matches(expected, actual) {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((value, i) => matches(value, actual[i]));
  if (expected && typeof expected === 'object') return actual && typeof actual === 'object' &&
    Object.entries(expected).every(([key, value]) => matches(value, actual[key]));
  return expected === actual;
}
export function verifyPreparedPoolMetadata(plan, actual, { manualInstanceCount = 0 } = {}) {
  if (![0, 1].includes(manualInstanceCount)) fail();
  const scaling = actual?.scaling;
  // Older responses omit the mode and may omit a zero count.
  if (scaling !== undefined && (
    !scaling || typeof scaling !== 'object' || Array.isArray(scaling) ||
    Object.keys(scaling).some(key => key !== 'scalingMode' && key !== 'manualInstanceCount') ||
    (scaling.scalingMode !== undefined && scaling.scalingMode !== 'MANUAL')
  )) fail();
  if (!actual || normalize(actual.name) !== plan.body.name || typeof actual.uid !== 'string' || !actual.uid || actual.deleteTime ||
    (actual.reconciling !== undefined && actual.reconciling !== false) ||
    !/^[1-9][0-9]*$/.test(String(actual.generation ?? '')) || String(actual.generation) !== String(actual.observedGeneration) ||
    (scaling?.manualInstanceCount === undefined ? 0 : scaling.manualInstanceCount) !== manualInstanceCount ||
    !matches(plan.body.annotations, actual.annotations) || !matches(plan.body.template, actual.template) || !matches(plan.body.labels, actual.labels) ||
    actual.template?.containers?.[0]?.command?.length || actual.template?.containers?.[0]?.args?.length ||
    actual.terminalCondition?.state !== 'CONDITION_SUCCEEDED' ||
    !actual.latestReadyRevision || normalize(actual.latestCreatedRevision) !== normalize(actual.latestReadyRevision)) fail();
  return { name: normalize(actual.name), uid: actual.uid, generation: String(actual.generation),
    revision: normalize(actual.latestReadyRevision), desiredManualInstanceCount: manualInstanceCount };
}
/** Confirm only metadata and permissions, never read secret payloads. Runner must
 * come from this release's immutable account-creation record and still have its ID.
 */
export async function verifyPoolPreparationSecretPrerequisites(plan, identityReceipt, api) {
  const account = await readOwnedPreparationRunner(plan, identityReceipt, api);
  const refs = poolSecretReferences(plan.body);
  for (const [secret, version] of refs.values()) {
    const resource = `projects/urm-app-staging/secrets/${secret}`;
    const metadata = await api(`https://secretmanager.googleapis.com/v1/${resource}/versions/${version}`);
    if (normalize(metadata.name) !== `${resource}/versions/${version}` || metadata.state !== 'ENABLED') fail();
    const policy = await api(`https://secretmanager.googleapis.com/v1/${resource}:getIamPolicy?options.requestedPolicyVersion=3`);
    if (!policy.etag || !Array.isArray(policy.bindings) || !policy.bindings.some(binding =>
      binding.role === 'roles/secretmanager.secretAccessor' && !binding.condition &&
      Array.isArray(binding.members) && binding.members.includes(`serviceAccount:${plan.runner}`))) fail();
  }
  return { runnerUniqueId: account.uniqueId, secretReferences: [...refs.keys()].sort() };
}
export async function verifyPoolPreparationPrerequisites(plan,identityReceipt,api){
  const secrets=await verifyPoolPreparationSecretPrerequisites(plan,identityReceipt,api);
  return {...secrets,...(plan.role==='media'?{mediaDiskQuota:await observeMediaDiskQuota(plan,api)}:{})};
}
function assertFreshComputeIsolation(isolation, namespace) {
  const observedAt = Date.parse(isolation?.observedAt);
  if (isolation?.namespace !== namespace || !/^[a-f0-9]{64}$/.test(isolation.inventorySHA256 ?? '') ||
    !Number.isFinite(observedAt) || Math.abs(Date.now() - observedAt) > 5000) fail();
}

/** Create at most once. A lost create ACK remains fenced: no GET/name adoption,
 * inferred LRO or retry. A saved native LRO may be polled on a later resume.
 */
export async function prepareCloudRunZeroPool({ platform, role, settings, operationId, releaseId, evidenceDigest,
  identityReceipt, api, save, observeComputeIsolation, authorizeCreate, saved }) {
  validateCloudRunReleasePlatform(platform);
  const binding = platform.roleBindings.find(binding => binding.role === role);
  if (!binding || !/^[a-f0-9-]{36}$/.test(operationId ?? '') || !/^[a-f0-9-]{36}$/.test(releaseId ?? '') ||
    !/^[a-f0-9]{64}$/.test(evidenceDigest ?? '') || typeof api !== 'function' || typeof save !== 'function' ||
    typeof observeComputeIsolation !== 'function'||typeof authorizeCreate!=='function') fail();
  const body = renderServerlessWorkerPool(binding, settings);
  body.annotations = { 'urm.upperroom.media/preparation': operationId };
  // Create derives the resource name from the parent and workerPoolId query.
  // Keep the full name in the saved plan for ownership and readback checks.
  const { name, ...createBody } = body;
  const plan = { schemaVersion: 1, operationId, releaseId, evidenceDigest, role, buildId: platform.workerBuildId,
    runner: binding.runnerServiceAccount, identityReceiptSHA256: hash(identityReceipt), body };
  let state = saved, confirmedNoSend;
  try {
    if (state !== undefined && (!state || !isDeepStrictEqual(state.plan, plan) ||
      !['planned', 'attempted', 'acknowledged', 'failed', 'completed', 'not-sent'].includes(state.stage))) fail();
    if (state === undefined) { state = { plan, stage: 'planned' }; await save(state); }
    if (state.stage === 'not-sent') {
      if (role !== 'media' || state.sendFenceVersion !== mediaPoolSendFenceVersion ||
        state.noSendReason !== mediaPoolPreSendAbortReason || state.nativeOperation) fail();
      assertMediaDiskQuotaProof(state.prerequisites?.mediaDiskQuota);
      return state;
    }
    if(plan.role==='media'&&['attempted','acknowledged','completed'].includes(state.stage))assertMediaDiskQuotaProof(state.prerequisites?.mediaDiskQuota);
    if (state.stage === 'attempted' || state.stage === 'failed') fail();
    if (state.stage === 'planned') {
      const prerequisitesProof = await verifyPoolPreparationPrerequisites(plan, identityReceipt, api);
      try { await api(`https://run.googleapis.com/v2/${name}`); fail(); }
      catch (error) { if (error?.status !== 404) throw error; }
      const isolation = await observeComputeIsolation();
      assertFreshComputeIsolation(isolation, platform.temporalNamespace);
      const saveAttempt = async (prerequisites, sendIsolation) => {
        const attempt = { plan, stage: 'attempted', attemptedAt: new Date().toISOString(), prerequisites,
          isolation: sendIsolation, ...(role === 'media' ? { sendFenceVersion: mediaPoolSendFenceVersion } : {}) };
        await save(attempt);
        state = attempt;
      };
      if (role !== 'media') {
        await saveAttempt(prerequisitesProof, isolation);
        await authorizeCreate();
      }
      const beforeSend = async () => {
        const latestIsolation = await observeComputeIsolation();
        assertFreshComputeIsolation(latestIsolation, platform.temporalNamespace);
        if (latestIsolation.inventorySHA256 !== isolation.inventorySHA256) fail();
        let mediaDiskQuota;
        if (role === 'media') {
          if (state.stage !== 'planned') fail();
          // The initial quota is a value baseline. Journal the samples taken
          // after credentials, then spend their remaining freshness on authority.
          mediaDiskQuota = await observeMediaDiskQuota(plan, api);
          if (mediaDiskQuota.quotaSHA256 !== prerequisitesProof.mediaDiskQuota.quotaSHA256) fail();
          assertFreshComputeIsolation(latestIsolation, platform.temporalNamespace);
          await saveAttempt({ ...prerequisitesProof, mediaDiskQuota }, latestIsolation);
        }
        try {
          await authorizeCreate();
          if (mediaDiskQuota) assertMediaDiskQuotaFresh(mediaDiskQuota);
          assertFreshComputeIsolation(latestIsolation, platform.temporalNamespace);
        } catch (error) {
          if (role !== 'media') throw error;
          // This callback has not returned, so the canonical transport cannot
          // have invoked its HTTP request. Persist that fact before rejecting.
          const notSent = { ...state, stage: 'not-sent', noSendReason: mediaPoolPreSendAbortReason };
          await save(notSent);
          state = notSent;
          confirmedNoSend = notSent;
          throw error;
        }
      };
      // No automatic HTTP retry; this API has no requestId parameter.
      const response = await api(
        `https://run.googleapis.com/v2/projects/urm-app-staging/locations/us-central1/workerPools?workerPoolId=${binding.poolName}`,
        'POST',
        createBody,
        beforeSend
      );
      if (state.stage !== 'attempted') fail();
      state = { ...state, stage: 'acknowledged', nativeOperation: operationName(response?.name) };
      await save(state);
    }
    if (state.stage === 'completed') {
      if(plan.role==='media')await verifyPoolPreparationPrerequisites(plan,identityReceipt,api);
      const current = verifyPreparedPoolMetadata(plan, await api(`https://run.googleapis.com/v2/${name}`));
      if (!isDeepStrictEqual(state.pool, current)) fail();
      return state;
    }
    const op = operationName(state.nativeOperation), end = performance.now() + 120_000;
    let result;
    do {
      result = await api(`https://run.googleapis.com/v2/${op}`);
      if (operationName(result.name) !== op) fail();
      if (performance.now() >= end) fail();
      if (result.done === true) break;
      if (result.done !== undefined && result.done !== false) fail();
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (performance.now() < end);
    if (result?.done !== true) fail();
    if (result.error) { await save({ ...state, stage: 'failed', errorSHA256: hash(result.error) }); fail(); }
    const completed = verifyPreparedPoolMetadata(plan, result.response);
    const current = verifyPreparedPoolMetadata(plan, await api(`https://run.googleapis.com/v2/${name}`));
    if (!isDeepStrictEqual(completed, current)) fail();
    state = { ...state, stage: 'completed', pool: current, verifiedAt: new Date().toISOString(),
      scope: 'created configuration; desired manual count zero, not observed live instance count or activation readiness' };
    await save(state);
    return state;
  } catch {
    if (confirmedNoSend) return confirmedNoSend;
    return fail();
  }
}
