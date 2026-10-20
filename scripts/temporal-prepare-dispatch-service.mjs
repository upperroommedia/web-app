import { verifyDispatchManagedAgents } from './temporal-dispatch-managed-agents.mjs';
import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { readOwnedPreparationRunner, renderPreparationWorkload, normalizeStagingResourceName as normalize } from './temporal-preparation-resources.mjs';
import { observeCloudRunDispatchService } from './temporal-release-dispatch.mjs';
const fail = () => { throw new Error('CLOUD_RUN_DISPATCH_SERVICE_PREPARATION_UNCONFIRMED'); };
function operationName(value) {
  const name = normalize(value);
  if (!/^projects\/urm-app-staging\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/.test(name ?? '')) fail();
  return name;
}
async function prerequisites(plan, identityReceipt, api, platform) {
  const runner = await readOwnedPreparationRunner(plan, identityReceipt, api);
  const secret = 'projects/urm-app-staging/secrets/TEMPORAL_DISPATCH_API_KEY';
  const version = await api(`https://secretmanager.googleapis.com/v1/${secret}/versions/${plan.apiKeyVersion}`);
  if (normalize(version.name) !== `${secret}/versions/${plan.apiKeyVersion}` || version.state !== 'ENABLED') fail();
  const policy = await api(`https://secretmanager.googleapis.com/v1/${secret}:getIamPolicy?options.requestedPolicyVersion=3`);
  if (!policy.etag || !policy.bindings?.some(b => b.role === 'roles/secretmanager.secretAccessor' && !b.condition &&
    b.members?.includes(`serviceAccount:${plan.runner}`))) fail();
  const managedAgents = await verifyDispatchManagedAgents(platform, api, 'managed-only');
  return { runnerUniqueId: runner.uniqueId, secretVersion: normalize(version.name), managedAgents };
}
export function preparedDispatchServiceIdentity(observation, plan) {
  const { service, revision } = observation;
  if (!isDeepStrictEqual(service.annotations, plan.body.annotations)) fail();
  return { name: service.name, uid: service.uid, generation: String(service.generation),
    revision: revision.name, revisionUid: revision.uid, admission: 'disabled', uri: service.uri };
}
/** Only creates an inert private service. Unknown create ACKs never adopt by name
 * or resubmit. A saved native LRO may be polled; preparation cannot enable dispatch.
 */
export async function prepareCloudRunDispatchService({ platform, role, settings, operationId, releaseId, evidenceDigest,
  identityReceipt, api, save, saved }) {
  const workload = renderPreparationWorkload(platform, role, settings);
  if (role !== 'dispatch' || workload.type !== 'service' || !/^[a-f0-9-]{36}$/.test(operationId ?? '') ||
    !/^[a-f0-9-]{36}$/.test(releaseId ?? '') || !/^[a-f0-9]{64}$/.test(evidenceDigest ?? '') ||
    typeof api !== 'function' || typeof save !== 'function') fail();
  const body = workload.body;
  body.annotations = { 'urm.upperroom.media/preparation': operationId };
  const plan = { schemaVersion: 1, operationId, releaseId, evidenceDigest, role, buildId: platform.workerBuildId,
    runner: workload.runner, apiKeyVersion: settings.apiKeyVersion, identityReceiptSHA256: proofDigest(identityReceipt), body };
  let state = saved;
  try {
    if (state !== undefined && (!state || !isDeepStrictEqual(state.plan, plan) ||
      !['planned', 'attempted', 'acknowledged', 'failed', 'completed'].includes(state.stage))) fail();
    if (state === undefined) { state = { plan, stage: 'planned' }; await save(state); }
    if (state.stage === 'attempted' || state.stage === 'failed') fail();
    if (state.stage === 'planned') {
      const before = await prerequisites(plan, identityReceipt, api, platform);
      try { await api(`https://run.googleapis.com/v2/${body.name}`); fail(); }
      catch (error) { if (error?.status !== 404) throw error; }
      const fresh = await prerequisites(plan, identityReceipt, api, platform);
      if (!isDeepStrictEqual(before, fresh)) fail();
      state = { plan, stage: 'attempted', attemptedAt: new Date().toISOString(), prerequisites: fresh };
      await save(state);
      // v2 services.create has serviceId/validateOnly, not an idempotency requestId.
      const response = await api(`https://run.googleapis.com/v2/projects/urm-app-staging/locations/us-central1/services?serviceId=${platform.dispatch.serviceId}`, 'POST', body);
      state = { ...state, stage: 'acknowledged', nativeOperation: operationName(response?.name) };
      await save(state);
    }
    if (state.stage === 'completed') {
      const current = preparedDispatchServiceIdentity(await observeCloudRunDispatchService(platform, api, 'disabled'), plan);
      if (!isDeepStrictEqual(state.service, current)) fail();
      const fresh = await prerequisites(plan, identityReceipt, api, platform);
      if (!isDeepStrictEqual(fresh, state.prerequisites)) fail();
      const policy = await api(`https://run.googleapis.com/v2/${body.name}:getIamPolicy?options.requestedPolicyVersion=3`);
      if (!policy || (policy.bindings !== undefined && (!Array.isArray(policy.bindings) || policy.bindings.length))) fail();
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
    if (result.error) { await save({ ...state, stage: 'failed', errorSHA256: proofDigest(result.error) }); fail(); }
    const acknowledged = preparedDispatchServiceIdentity(await observeCloudRunDispatchService(platform,
      (url, ...args) => url === `https://run.googleapis.com/v2/${body.name}` ? Promise.resolve(result.response) : api(url, ...args), 'disabled'), plan);
    const current = preparedDispatchServiceIdentity(await observeCloudRunDispatchService(platform, api, 'disabled'), plan);
    if (!isDeepStrictEqual(acknowledged, current)) fail();
    const policy = await api(`https://run.googleapis.com/v2/${body.name}:getIamPolicy?options.requestedPolicyVersion=3`);
    if (!policy || (policy.bindings !== undefined && (!Array.isArray(policy.bindings) || policy.bindings.length))) fail();
    const fresh = await prerequisites(plan, identityReceipt, api, platform);
    if (!isDeepStrictEqual(fresh, state.prerequisites)) fail();
    state = { ...state, stage: 'completed', service: current, verifiedAt: new Date().toISOString(),
      scope: 'inert admission-disabled min0 configuration only; no dispatch, delivery, effective access or zero-live-instance proof' };
    await save(state);
    return state;
  } catch { return fail(); }
}
