import { dispatchPreparationAuthority } from './temporal-dispatch-authority.mjs';
import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { dispatchWakePlan } from './temporal-dispatch-wake-plan.mjs';
import { observeCloudRunDispatchService } from './temporal-release-dispatch.mjs';
import { preparedDispatchServiceIdentity } from './temporal-prepare-dispatch-service.mjs';
import { readOwnedPreparationRunner, normalizeStagingResourceName as normalize } from './temporal-preparation-resources.mjs';
const fail = () => { throw new Error('CLOUD_RUN_DISPATCH_WAKE_STOP_UNCONFIRMED'); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function dispatchWakeIdentity(plan, resource) {
  const body = plan.body;
  if (!resource || normalize(resource.name) !== body.name) fail();
  if (plan.surface === 'scheduler') {
    for (const field of ['description', 'schedule', 'timeZone', 'attemptDeadline', 'retryConfig'])
      if (!isDeepStrictEqual(body[field], resource[field])) fail();
    if (resource.pubsubTarget || resource.appEngineHttpTarget || resource.httpTarget?.oauthToken || resource.httpTarget?.body ||
      Object.keys(resource.httpTarget?.headers ?? {}).some(key => !['user-agent', 'content-type'].includes(key.toLowerCase()))) fail();
    for (const field of ['uri', 'httpMethod', 'oidcToken'])
      if (!isDeepStrictEqual(body.httpTarget[field], resource.httpTarget?.[field])) fail();
    if (!['ENABLED', 'PAUSED'].includes(resource.state) || typeof resource.userUpdateTime !== 'string' ||
      !Number.isFinite(Date.parse(resource.userUpdateTime))) fail();
    return { name: body.name, userUpdateTime: resource.userUpdateTime };
  }
  for (const field of ['labels', 'eventFilters', 'eventDataContentType', 'serviceAccount', 'destination'])
    if (!isDeepStrictEqual(body[field], resource[field])) fail();
  if (resource.channel || Object.keys(resource.retryPolicy ?? {}).length || typeof resource.uid !== 'string' || !resource.uid ||
    typeof resource.etag !== 'string' || !resource.etag) fail();
  return { name: body.name, uid: resource.uid, etag: resource.etag };
}
function nativeOperation(value) {
  const name = normalize(value);
  if (!/^projects\/urm-app-staging\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/.test(name ?? '')) fail();
  return name;
}
/** Stop one already acknowledged, source-bound wake. No creation, resumption,
 * business cancellation, broad resource lookup, or retry of an unknown mutation.
 */
export async function stopCloudRunDispatchWake({ platform, role, settings, releaseId, evidenceDigest, operationId,
  surface, runnerReceipt, eventReceipt, schedulerReceipt, diagnostic, serviceReceipt, wakeReceipt, api, save, saved }) {
  if (diagnostic !== undefined && surface !== 'outbox-trigger') fail();
  if (!uuid.test(operationId ?? '') || [api, save].some(fn => typeof fn !== 'function')) fail();
  const original = wakeReceipt?.identityState;
  if (wakeReceipt?.releaseId !== releaseId || original?.stage !== 'completed' ||
    !uuid.test(wakeReceipt.operationId ?? '') || wakeReceipt.operationId !== original.plan?.operationId) fail();
  const creation = dispatchWakePlan({ platform, role, settings, releaseId, evidenceDigest, surface,
    operationId: wakeReceipt.operationId, runnerReceipt, serviceReceipt });
  if (!isDeepStrictEqual(original.plan, creation)) fail();
  // Only the original producer's native ACK identity may authorize stopping.
  const owned = original.resource;
  if (!owned || owned.name !== creation.body.name || (surface === 'scheduler'
    ? typeof owned.userUpdateTime !== 'string' || !Number.isFinite(Date.parse(owned.userUpdateTime))
    : typeof owned.uid !== 'string' || !owned.uid || typeof owned.etag !== 'string' || !owned.etag)) fail();
  if (surface === 'scheduler') {
    if (!isDeepStrictEqual(original.acknowledgedResource, owned)) fail();
  } else nativeOperation(original.nativeOperation);
  const base = surface === 'scheduler' ? 'https://cloudscheduler.googleapis.com/v1/' : 'https://eventarc.googleapis.com/v1/';
  const url = `${base}${creation.body.name}`;
  const request = surface === 'scheduler' ? { url: `${url}:pause`, method: 'POST' }
    : { url: `${url}?etag=${encodeURIComponent(owned.etag)}`, method: 'DELETE' };
  const plan = { schemaVersion: 1, operationId, releaseId, evidenceDigest, role, surface,
    buildId: platform.workerBuildId, ...(diagnostic ? { diagnosticManifestSHA256: proofDigest(diagnostic.manifest) } : {}), wakeReceiptSHA256: proofDigest(wakeReceipt), creation, request };
  const checkAuthority = async () => {
    if (diagnostic !== undefined) {
      await dispatchPreparationAuthority({platform,role,settings,releaseId,evidenceDigest,operationId,runnerReceipt,eventReceipt,schedulerReceipt,serviceReceipt,diagnostic}).verify(api);
      return;
    }
    const runner = await readOwnedPreparationRunner({ ...creation, runner: serviceReceipt.identityState.plan.runner }, runnerReceipt, api);
    if (runner.uniqueId !== serviceReceipt.identityState.prerequisites?.runnerUniqueId) fail();
    const service = preparedDispatchServiceIdentity(await observeCloudRunDispatchService(platform, api, 'disabled'), serviceReceipt.identityState.plan);
    if (!isDeepStrictEqual(service, serviceReceipt.identityState.service)) fail();
  };
  const read = async () => {
    try {
      const resource = await api(url);
      if (!isDeepStrictEqual(dispatchWakeIdentity(creation, resource), owned)) fail();
      return resource;
    } catch (error) { if (error?.status === 404 && surface !== 'scheduler') return undefined; throw error; }
  };
  let state = saved;
  try {
    if (state !== undefined && (!state || !isDeepStrictEqual(state.plan, plan) ||
      !['planned', 'attempted', 'acknowledged', 'rejected', 'failed', 'completed'].includes(state.stage))) fail();
    if (state === undefined) { state = { plan, stage: 'planned' }; await save(state); }
    if (['rejected', 'failed'].includes(state.stage)) fail();
    await checkAuthority();
    if (state.stage === 'planned') {
      const before = await read();
      if (!before || before.state === 'PAUSED') {
        state = { ...state, stage: 'completed', outcome: 'observed-already-stopped', scope: 'current absent/paused observation only; no mutation causality or delivery drainage proof' };
        await save(state); return state;
      }
      await checkAuthority();
      await read(); // Recheck original native identity immediately before the guarded mutation.
      state = { ...state, stage: 'attempted', attemptedAt: new Date().toISOString() };
      await save(state);
      try {
        const ack = await api(request.url, request.method);
        if (surface === 'scheduler') {
          if (!isDeepStrictEqual(dispatchWakeIdentity(creation, ack), owned) || ack.state !== 'PAUSED') fail();
          state = { ...state, stage: 'acknowledged' };
        } else state = { ...state, stage: 'acknowledged', nativeOperation: nativeOperation(ack?.name) };
        await save(state);
      } catch (error) {
        if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          state = { ...state, stage: 'rejected', rejectedStatus: error.status }; await save(state); fail();
        }
        if (state.stage === 'acknowledged') throw error; // Unknown checkpoint ACK must stop this turn.
      }
    }
    if (surface !== 'scheduler' && state.stage === 'acknowledged') {
      const operation = nativeOperation(state.nativeOperation), deadline = Date.now() + 30000;
      let result;
      do {
        result = await api(`https://eventarc.googleapis.com/v1/${operation}`);
        if (nativeOperation(result?.name) !== operation) fail();
        if (result.done === true) break;
        if (result.done !== undefined && result.done !== false) fail();
        if (Date.now() >= deadline) fail();
        await new Promise(resolve => setTimeout(resolve, 1000));
      } while (Date.now() < deadline);
      if (result?.done !== true) fail();
      if (result.error) { state = { ...state, stage: 'failed', errorSHA256: proofDigest(result.error) }; await save(state); fail(); }
    }
    const current = await read();
    if (surface === 'scheduler' ? current?.state !== 'PAUSED' : current !== undefined) fail();
    await checkAuthority();
    if (state.stage === 'completed') return state;
    state = { ...state, stage: 'completed', verifiedAt: new Date().toISOString(),
      outcome: state.stage === 'acknowledged' ? 'native-stop-acknowledged-and-observed' : 'stopped-observed-after-unknown-acknowledgement',
      scope: 'same-original job paused or trigger absent; no unknown-request causality or in-flight delivery drainage proof' };
    await save(state); return state;
  } catch { return fail(); }
}
