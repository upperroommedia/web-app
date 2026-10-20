import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { dispatchWakePlan } from './temporal-dispatch-wake-plan.mjs';
import { dispatchPreparationAuthority } from './temporal-dispatch-authority.mjs';
import { verifyDispatchManagedAgents } from './temporal-dispatch-managed-agents.mjs';
import { dispatchWakeIdentity, stopCloudRunDispatchWake } from './temporal-stop-dispatch-wake.mjs';
import { reconcileSchedulerCreateAudit } from './temporal-scheduler-create-audit.mjs';
const fail = () => { throw new Error('CLOUD_RUN_SCHEDULER_CYCLE_UNCONFIRMED'); };
/** Create and immediately pause one source-bound scheduler under the same owned
 * operation. The five-minute window limits creation authorization, not cleanup.
 * Audit/API outages can extend active requests; this is not a hard billing cap.
 */
export async function prepareStopCloudRunScheduler(options) {
  const { platform, role, settings, releaseId, evidenceDigest, operationId, creator, runnerReceipt,
    eventReceipt, schedulerReceipt, serviceReceipt, api, save, readCreationReceipt, saved } = options;
  if ([api, save, readCreationReceipt].some(fn => typeof fn !== 'function') ||
    typeof creator !== 'string' || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(creator)) fail();
  const creation = dispatchWakePlan({ ...options, surface: 'scheduler' });
  const authority = dispatchPreparationAuthority(options);
  const openedAt = saved === undefined ? new Date().toISOString() : saved?.plan?.openedAt;
  const opened = Date.parse(openedAt ?? '');
  if (!Number.isFinite(opened) || opened > Date.now() + 1000) fail();
  const plan = { schemaVersion: 1, creation, creator, openedAt,
    cleanupDueAt: new Date(opened + 300000).toISOString(),
    eventReceiptSHA256: proofDigest(eventReceipt), schedulerReceiptSHA256: proofDigest(schedulerReceipt) };
  const url = `https://cloudscheduler.googleapis.com/v1/${creation.body.name}`;
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
      !['planned', 'attempted', 'acknowledged', 'created', 'stopping', 'completed', 'rejected'].includes(state.stage))) fail();
    if (state === undefined) { state = { stage: 'planned', plan }; await save(state); }
    if (state.stage === 'rejected' || state.stage === 'completed' && state.stopState?.stage !== 'completed') fail();
    if (state.stage === 'planned') {
      if (Date.now() >= Date.parse(plan.cleanupDueAt)) fail();
      await verify();
      try { await api(url); fail(); } catch (error) { if (error?.status !== 404) throw error; }
      const prerequisites = await verify();
      if (Date.now() >= Date.parse(plan.cleanupDueAt)) fail();
      state = { ...state, stage: 'attempted', attemptedAt: new Date().toISOString(), prerequisites };
      await save(state);
      if (Date.now() >= Date.parse(plan.cleanupDueAt)) fail();
      try {
        const ack = await api('https://cloudscheduler.googleapis.com/v1/projects/urm-app-staging/locations/us-central1/jobs', 'POST', creation.body);
        const resource = dispatchWakeIdentity(creation, ack);
        state = { ...state, stage: 'acknowledged', acknowledgedResource: resource };
        await save(state);
      } catch (error) {
        if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          state = { ...state, stage: 'rejected', rejectedStatus: error.status }; await save(state); fail();
        }
        if (state.stage === 'acknowledged') throw error;
      }
    }
    if (['attempted', 'acknowledged'].includes(state.stage)) {
      await verify();
      const current = await api(url), resource = dispatchWakeIdentity(creation, current);
      let audit;
      if (state.stage === 'attempted') {
        ({ audit } = await reconcileSchedulerCreateAudit({ creation, creator, attemptedAt: state.attemptedAt, current, api }));
      } else if (!isDeepStrictEqual(resource, state.acknowledgedResource)) fail();
      const creationState = { stage: 'completed', plan: creation, creator, attemptedAt: state.attemptedAt,
        resource, acknowledgedResource: resource, ...(audit ? { audit } : {}),
        scope: audit ? 'native causal create audit and current identity joined' : 'native create response and current identity joined' };
      state = { ...state, stage: 'created', creationState };
      // The real checkpoint must atomically persist the immutable creation receipt.
      await save(state);
    }
    const receipt = await readCreationReceipt();
    if (receipt?.operationId !== operationId || receipt.releaseId !== releaseId ||
      !isDeepStrictEqual(receipt.identityState, state.creationState) || receipt.operatorPrincipal?.email !== creator) fail();
    await authority.verify(api);
    if (state.stage === 'created') { state = { ...state, stage: 'stopping' }; await save(state); }
    const stopped = await stopCloudRunDispatchWake({ platform, role, settings, releaseId, evidenceDigest, operationId,
      surface: 'scheduler', runnerReceipt, serviceReceipt, wakeReceipt: receipt, api,
      saved: state.stopState, save: async stopState => { state = { ...state, stopState }; await save(state); } });
    if (state.stage === 'completed') return state;
    state = { ...state, stage: 'completed', stopState: stopped,
      scope: 'same original scheduler PAUSED; no effective delivery, in-flight drainage or readiness proof' };
    await save(state); return state;
  } catch { return fail(); }
}
