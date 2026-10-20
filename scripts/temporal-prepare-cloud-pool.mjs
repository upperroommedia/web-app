import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateCloudRunReleasePlatform } from './temporal-release-cloud-run.mjs';
import { readOwnedPreparationRunner, poolSecretReferences, normalizeStagingResourceName as normalize } from './temporal-preparation-resources.mjs';
import { renderServerlessWorkerPool } from './temporal-serverless-resources.mjs';
const fail = () => { throw new Error('CLOUD_RUN_ZERO_POOL_PREPARATION_UNCONFIRMED'); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

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
function preparedPool(plan, actual) {
  if (!actual || normalize(actual.name) !== plan.body.name || typeof actual.uid !== 'string' || !actual.uid || actual.deleteTime ||
    (actual.reconciling !== undefined && actual.reconciling !== false) ||
    !/^[1-9][0-9]*$/.test(String(actual.generation ?? '')) || String(actual.generation) !== String(actual.observedGeneration) ||
    (actual.scaling?.manualInstanceCount !== undefined && actual.scaling.manualInstanceCount !== 0) ||
    !matches(plan.body.annotations, actual.annotations) || !matches(plan.body.template, actual.template) || !matches(plan.body.labels, actual.labels) ||
    actual.template?.containers?.[0]?.command?.length || actual.template?.containers?.[0]?.args?.length ||
    actual.terminalCondition?.state !== 'CONDITION_SUCCEEDED' ||
    !actual.latestReadyRevision || normalize(actual.latestCreatedRevision) !== normalize(actual.latestReadyRevision)) fail();
  return { name: normalize(actual.name), uid: actual.uid, generation: String(actual.generation),
    revision: normalize(actual.latestReadyRevision), desiredManualInstanceCount: 0 };
}
/** Confirm only metadata and permissions, never read secret payloads. Runner must
 * come from this release's immutable account-creation record and still have its ID.
 */
async function prerequisites(plan, identityReceipt, api) {
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
/** Create at most once. A lost create ACK remains fenced: no GET/name adoption,
 * inferred LRO or retry. A saved native LRO may be polled on a later resume.
 */
export async function prepareCloudRunZeroPool({ platform, role, settings, operationId, releaseId, evidenceDigest,
  identityReceipt, api, save, observeComputeIsolation, saved }) {
  validateCloudRunReleasePlatform(platform);
  const binding = platform.roleBindings.find(binding => binding.role === role);
  if (!binding || !/^[a-f0-9-]{36}$/.test(operationId ?? '') || !/^[a-f0-9-]{36}$/.test(releaseId ?? '') ||
    !/^[a-f0-9]{64}$/.test(evidenceDigest ?? '') || typeof api !== 'function' || typeof save !== 'function' ||
    typeof observeComputeIsolation !== 'function') fail();
  const body = renderServerlessWorkerPool(binding, settings);
  body.annotations = { 'urm.upperroom.media/preparation': operationId };
  const plan = { schemaVersion: 1, operationId, releaseId, evidenceDigest, role, buildId: platform.workerBuildId,
    runner: binding.runnerServiceAccount, identityReceiptSHA256: hash(identityReceipt), body };
  let state = saved;
  try {
    if (state !== undefined && (!state || !isDeepStrictEqual(state.plan, plan) ||
      !['planned', 'attempted', 'acknowledged', 'failed', 'completed'].includes(state.stage))) fail();
    if (state === undefined) { state = { plan, stage: 'planned' }; await save(state); }
    if (state.stage === 'attempted' || state.stage === 'failed') fail();
    if (state.stage === 'planned') {
      const prerequisitesProof = await prerequisites(plan, identityReceipt, api);
      try { await api(`https://run.googleapis.com/v2/${body.name}`); fail(); }
      catch (error) { if (error?.status !== 404) throw error; }
      const isolation = await observeComputeIsolation();
      if (isolation?.namespace !== platform.temporalNamespace || !/^[a-f0-9]{64}$/.test(isolation.inventorySHA256 ?? '') ||
        !Number.isFinite(Date.parse(isolation.observedAt)) || Math.abs(Date.now() - Date.parse(isolation.observedAt)) > 5000) fail();
      state = { plan, stage: 'attempted', attemptedAt: new Date().toISOString(), prerequisites: prerequisitesProof, isolation };
      await save(state);
      // No automatic HTTP retry; this API has no requestId parameter.
      const response = await api(`https://run.googleapis.com/v2/projects/urm-app-staging/locations/us-central1/workerPools?workerPoolId=${binding.poolName}`, 'POST', body);
      state = { ...state, stage: 'acknowledged', nativeOperation: operationName(response?.name) };
      await save(state);
    }
    if (state.stage === 'completed') {
      const current = preparedPool(plan, await api(`https://run.googleapis.com/v2/${body.name}`));
      if (!isDeepStrictEqual(state.pool, current)) fail();
      return state;
    }
    const op = operationName(state.nativeOperation), end = Date.now() + 30000;
    let result;
    do {
      result = await api(`https://run.googleapis.com/v2/${op}`);
      if (operationName(result.name) !== op) fail();
      if (result.done === true) break;
      if (result.done !== undefined && result.done !== false) fail();
      if (Date.now() >= end) fail();
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < end);
    if (result?.done !== true) fail();
    if (result.error) { await save({ ...state, stage: 'failed', errorSHA256: hash(result.error) }); fail(); }
    const completed = preparedPool(plan, result.response);
    const current = preparedPool(plan, await api(`https://run.googleapis.com/v2/${body.name}`));
    if (!isDeepStrictEqual(completed, current)) fail();
    state = { ...state, stage: 'completed', pool: current, verifiedAt: new Date().toISOString(),
      scope: 'created configuration; desired manual count zero, not observed live instance count or activation readiness' };
    await save(state);
    return state;
  } catch { return fail(); }
}
