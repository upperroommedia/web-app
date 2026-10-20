import { assertDiagnosticWakeAuthority } from './temporal-diagnostic-authority.mjs';
import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { dispatchWakePlan } from './temporal-dispatch-wake-plan.mjs';
import { dispatchPreparationAuthority } from './temporal-dispatch-authority.mjs';
import { verifyDispatchManagedAgents } from './temporal-dispatch-managed-agents.mjs';
import { dispatchWakeIdentity, stopCloudRunDispatchWake } from './temporal-stop-dispatch-wake.mjs';
import { recoverEventarcCreateAudit, eventarcNativeOperation } from './temporal-eventarc-create-audit.mjs';
import { reconcileSchedulerCreateAudit } from './temporal-scheduler-create-audit.mjs';
const fail = () => { throw new Error('CLOUD_RUN_DISPATCH_WAKE_CYCLE_UNCONFIRMED'); };
/** Create and immediately stop one source-bound dispatch wake under the same owned
 * operation. The five-minute window limits creation authorization, not cleanup.
 * Audit/API outages can extend active requests; this is not a hard billing cap.
 */
export async function prepareStopCloudRunDispatchWake(options) {
  const { platform, role, settings, releaseId, evidenceDigest, operationId, creator, runnerReceipt,
    eventReceipt, schedulerReceipt, serviceReceipt, api, save, readCreationReceipt, saved, surface } = options;
  if ([api, save, readCreationReceipt].some(fn => typeof fn !== 'function') ||
    typeof creator !== 'string' || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(creator)) fail();
  if (!['scheduler', 'outbox-trigger', 'commands-trigger'].includes(surface)) fail();
  if (options.diagnostic !== undefined && surface !== 'outbox-trigger') fail();
  const scheduler = surface === 'scheduler';
  const creation = dispatchWakePlan(options);
  const authority = dispatchPreparationAuthority(options);
  const openedAt = saved === undefined ? new Date().toISOString() : saved?.plan?.openedAt;
  const opened = Date.parse(openedAt ?? '');
  if (!Number.isFinite(opened) || opened > Date.now() + 1000) fail();
  const plan = { schemaVersion: 1, creation, creator, openedAt,
    ...(options.diagnostic ? { diagnosticManifestSHA256: proofDigest(options.diagnostic.manifest) } : {}),
    ...(!scheduler ? { action: 'prepare-stop-cloud-run-dispatch-eventarc' } : {}),
    cleanupDueAt: new Date(opened + 300000).toISOString(),
    eventReceiptSHA256: proofDigest(eventReceipt), schedulerReceiptSHA256: proofDigest(schedulerReceipt) };
  const base = scheduler ? 'https://cloudscheduler.googleapis.com/v1/' : 'https://eventarc.googleapis.com/v1/';
  const url = `${base}${creation.body.name}`;
  const createUrl = scheduler ? `${base}projects/urm-app-staging/locations/us-central1/jobs`
    : `${base}projects/urm-app-staging/locations/us-central1/triggers?triggerId=${encodeURIComponent(creation.body.name.split('/').at(-1))}`;
  const verify = async () => {
    const owned = await authority.verify(api);
    const managed = await verifyDispatchManagedAgents(platform, api, 'dispatch-caller');
    const policy = await api(`https://run.googleapis.com/v2/${authority.workload.body.name}:getIamPolicy?options.requestedPolicyVersion=3`, 'GET');
    const members = [authority.callers.event, authority.callers.scheduler].map(email => `serviceAccount:${email}`).sort();
    if (!policy || !policy.etag || !Array.isArray(policy.bindings) || policy.bindings.length !== 1 ||
      policy.bindings[0].role !== 'roles/run.invoker' || policy.bindings[0].condition !== undefined ||
      !isDeepStrictEqual([...policy.bindings[0].members ?? []].sort(), members)) fail();
    return { ...owned, managed, invokerPolicySHA256: proofDigest(policy) };
  };
  let state = saved;
  try {
    if (state !== undefined && (!state || !isDeepStrictEqual(state.plan, plan) ||
      !['planned', 'attempted', 'acknowledged', 'created', 'stopping', 'completed', 'rejected', 'failed'].includes(state.stage))) fail();
    if (state === undefined) { state = { stage: 'planned', plan }; await save(state); }
    if (['rejected', 'failed'].includes(state.stage) || state.stage === 'completed' && state.stopState?.stage !== 'completed') fail();
    if (state.stage === 'planned') {
      if (Date.now() >= Date.parse(plan.cleanupDueAt)) fail();
      await verify();
      try { await api(url); fail(); } catch (error) { if (error?.status !== 404) throw error; }
      const prerequisites = await verify();
      if (Date.now() >= Date.parse(plan.cleanupDueAt)) fail();
      state = { ...state, stage: 'attempted', attemptedAt: new Date().toISOString(), prerequisites };
      await save(state);
      if (Date.now() >= Date.parse(plan.cleanupDueAt)) fail();
      if (options.diagnostic !== undefined) await assertDiagnosticWakeAuthority(options.diagnostic, true);
      if (Date.now() >= Date.parse(plan.cleanupDueAt) || options.diagnostic && Date.now() >= options.diagnostic.manifest.expiresAt) fail();
      try {
        const ack = await api(createUrl, 'POST', creation.body);
        state = { ...state, stage: 'acknowledged', ...(scheduler
          ? { acknowledgedResource: dispatchWakeIdentity(creation, ack) }
          : { nativeOperation: eventarcNativeOperation(ack?.name) }) };
        await save(state);
      } catch (error) {
        if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          state = { ...state, stage: 'rejected', rejectedStatus: error.status }; await save(state); fail();
        }
        if (state.stage === 'acknowledged') throw error;
      }
    }
    if (!scheduler && state.stage === 'attempted') {
      await verify();
      const recovered = await recoverEventarcCreateAudit({ creation, creator, attemptedAt: state.attemptedAt, api });
      state = { ...state, stage: 'acknowledged', ...recovered };
      // A recovered causal LRO acknowledgement is durable before any poll.
      await save(state);
    }
    if (['attempted', 'acknowledged'].includes(state.stage)) {
      await verify();
      let nativeResponse;
      if (!scheduler) {
        const name = eventarcNativeOperation(state.nativeOperation), deadline = Date.now() + 30000;
        let result;
        do {
          result = await api(`${base}${name}`);
          if (eventarcNativeOperation(result?.name) !== name) fail();
          if (result.done === true) break;
          if (result.done !== undefined && result.done !== false || Date.now() >= deadline) fail();
          await new Promise(resolve => setTimeout(resolve, 1000));
        } while (Date.now() < deadline);
        if (result?.done !== true) fail();
        if (result.error) { state = { ...state, stage: 'failed', errorSHA256: proofDigest(result.error) }; await save(state); fail(); }
        nativeResponse = dispatchWakeIdentity(creation, result.response);
      }
      const current = await api(url), resource = dispatchWakeIdentity(creation, current);
      let audit = state.audit;
      if (scheduler && state.stage === 'attempted') {
        ({ audit } = await reconcileSchedulerCreateAudit({ creation, creator, attemptedAt: state.attemptedAt, current, api }));
      } else if (!isDeepStrictEqual(resource, scheduler ? state.acknowledgedResource : nativeResponse)) fail();
      const creationState = { stage: 'completed', plan: creation, creator, attemptedAt: state.attemptedAt,
        resource, acknowledgedResource: resource, ...(audit ? { audit } : {}),
        ...(!scheduler ? { nativeOperation: state.nativeOperation } : {}),
        scope: audit ? 'native causal create audit and current identity joined' : 'native create response and current identity joined' };
      state = { ...state, stage: 'created', creationState };
      await save(state);
    }
    const receipt = await readCreationReceipt();
    if (receipt?.operationId !== operationId || receipt.releaseId !== releaseId ||
      !isDeepStrictEqual(receipt.identityState, state.creationState) || receipt.operatorPrincipal?.email !== creator) fail();
    await authority.verify(api);
    let observationFailed = false, observationWork;
    if (state.stage === 'created' && options.diagnostic !== undefined) {
      try {
        if (typeof options.observeDiagnostic !== 'function') fail();
        const controller = new AbortController(), observationDeadline = Date.now() + 30000;
        let timer;
        observationWork = Promise.resolve().then(() => options.observeDiagnostic({ surface, creationState: state.creationState, signal: controller.signal }));
        const observation = await Promise.race([observationWork, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('DIAGNOSTIC_OBSERVATION_DEADLINE')); }, 30000); })]).finally(() => clearTimeout(timer));
        if(controller.signal.aborted||Date.now()>=observationDeadline)fail();
        state = { ...state, diagnosticObservation: observation };
      } catch { observationFailed = true; state = { ...state, diagnosticObservationFailed: true }; }
      // Observation failures never bypass the acknowledged same-parent cleanup below.
    }
    let stopped;
    try {
      if (state.stage === 'created') { state = { ...state, stage: 'stopping' }; await save(state); }
      stopped = await stopCloudRunDispatchWake({ platform, role, settings, releaseId, evidenceDigest, operationId,
      surface, runnerReceipt, eventReceipt, schedulerReceipt, diagnostic: options.diagnostic, serviceReceipt, wakeReceipt: receipt, api,
      saved: state.stopState, save: async stopState => { state = { ...state, stopState }; await save(state); } });
    } finally { await observationWork?.catch(() => undefined); } // Native wakes are stopped before waiting for an interrupted observation to settle.
    if (state.stage === 'completed') { if (state.diagnosticObservationFailed) fail(); return state; }
    state = { ...state, stage: 'completed', stopState: stopped,
      scope: scheduler ? 'same original scheduler PAUSED; no effective delivery, in-flight drainage or readiness proof'
        : 'same original Eventarc trigger absent; no effective delivery, in-flight drainage or readiness proof' };
    await save(state);
    if (observationFailed || state.diagnosticObservationFailed) fail();
    return state;
  } catch { return fail(); }
}
