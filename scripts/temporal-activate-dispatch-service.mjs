import { assertDiagnosticWakeAuthority } from './temporal-diagnostic-authority.mjs';
import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { dispatchPreparationAuthority } from './temporal-dispatch-authority.mjs';
import { normalizeStagingResourceName as normalize } from './temporal-preparation-resources.mjs';
import { observeCloudRunDispatchService } from './temporal-release-dispatch.mjs';
import { verifyDispatchManagedAgents } from './temporal-dispatch-managed-agents.mjs';
import { renderServerlessDispatchService, renderServerlessDispatchWakeups } from './temporal-serverless-dispatch-resources.mjs';
const fail = () => { throw new Error('CLOUD_RUN_DISPATCH_ACTIVATION_UNCONFIRMED'); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
function operation(value) {
  const name = typeof value === 'string' ? value.replace(/^projects\/251680231116\//, 'projects/urm-app-staging/') : '';
  if (!/^projects\/urm-app-staging\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/.test(name)) fail();
  return name;
}
function intentValid(intent, bindings) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent) ||
    Object.keys(intent).sort().join(',') !== 'bindings,createdAt,imageWorkflowBundleSHA256,nonce,schemaVersion,workflowId' ||
    intent.schemaVersion !== 1 || !hash.test(intent.imageWorkflowBundleSHA256 ?? '') || typeof intent.workflowId !== 'string' || !intent.workflowId ||
    typeof intent.nonce !== 'string' || !intent.nonce || !Number.isFinite(Date.parse(intent.createdAt)) ||
    !isDeepStrictEqual(intent.bindings, bindings)) fail();
}
/** Enables only the owned min0 service under paused canonical release authority.
 * Its mandatory runtime admission fence prevents new business leases while paused.
 * No wake creation, invocation, release phase, ownership, routing or WCI change.
 */
export async function activateCloudRunDispatchService(options) {
  const { platform, settings, operationId, releaseId, evidenceDigest, api, save, saved, artifactDirectory, probe } = options;
  const authority = dispatchPreparationAuthority(options);
  if (!uuid.test(operationId ?? '') || !hash.test(evidenceDigest ?? '') ||
    typeof artifactDirectory !== 'string' || !artifactDirectory.startsWith('/') ||
    [api, save, probe].some(fn => typeof fn !== 'function')) fail();
  const bindings = platform.roleBindings.map(({ projectId, region, namespace, role, buildId, poolName,
    deploymentName, runnerServiceAccount, image }) => ({ projectId, region, namespace, role, buildId, poolName,
    deploymentName, runnerServiceAccount, image }));
  const config = { projectId: 'urm-app-staging', region: 'us-central1', buildId: platform.workerBuildId,
    image: platform.workerImage, apiKeyVersion: settings.apiKeyVersion };
  const desired = renderServerlessDispatchService(config, 'enabled', { audience: authority.original.service.uri,
    eventSubject: options.eventReceipt.identityState.account.uniqueId, schedulerSubject: options.schedulerReceipt.identityState.account.uniqueId });
  desired.annotations = { ...authority.original.plan.body.annotations, 'urm.upperroom.media/activation': operationId };
  const plan = { schemaVersion: 1, operationId, releaseId, evidenceDigest, buildId: platform.workerBuildId,
    artifactDirectory, bindings, desired, serviceReceiptSHA256: proofDigest(options.serviceReceipt),
    runnerReceiptSHA256: proofDigest(options.runnerReceipt), eventReceiptSHA256: proofDigest(options.eventReceipt),
    schedulerReceiptSHA256: proofDigest(options.schedulerReceipt), settingsSHA256: proofDigest(settings) };
  let state = saved;
  const namedWakesAbsent = async () => {
    if (options.diagnostic !== undefined) {
      const m = await assertDiagnosticWakeAuthority(options.diagnostic);
      if (saved?.stage !== 'completed' || proofDigest(saved) !== proofDigest(options.diagnostic.activationReceipt.identityState) ||
        m.buildId !== platform.workerBuildId || m.image !== platform.workerImage || m.releaseId !== releaseId ||
        operationId !== options.diagnostic.activationReceipt.operationId) fail();
      return; // The completed original activation is read-only; owned diagnostic wakes may now exist.
    }
    const wakes = renderServerlessDispatchWakeups(config, authority.original.service);
    for (const [base, name] of [
      ...wakes.triggers.map(t => ['https://eventarc.googleapis.com/v1/', t.name]),
      ['https://cloudscheduler.googleapis.com/v1/', wakes.scheduler.name],
    ]) {
      try { await api(`${base}${name}`); fail(); }
      catch (error) { if (error?.status !== 404) throw error; }
    }
  };
  const prerequisites = async (disabled) => {
    const accounts = disabled ? await authority.verify(api) : await authority.verifyAccounts(api);
    const managed = await verifyDispatchManagedAgents(platform, api, 'dispatch-caller');
    const policy = await api(`https://run.googleapis.com/v2/${desired.name}:getIamPolicy?options.requestedPolicyVersion=3`);
    const expectedMembers = Object.values(authority.callers).map(email => `serviceAccount:${email}`).sort();
    if (!policy?.etag || !Array.isArray(policy.bindings) || policy.bindings.length !== 1 ||
      policy.bindings[0].role !== 'roles/run.invoker' || policy.bindings[0].condition ||
      !isDeepStrictEqual([...policy.bindings[0].members ?? []].sort(), expectedMembers)) fail();
    const secret = 'projects/urm-app-staging/secrets/TEMPORAL_WORKER_API_KEY';
    const version = await api(`https://secretmanager.googleapis.com/v1/${secret}/versions/${settings.apiKeyVersion}`);
    const access = await api(`https://secretmanager.googleapis.com/v1/${secret}:getIamPolicy?options.requestedPolicyVersion=3`);
    if (version.state !== 'ENABLED' || normalize(version.name) !== `${secret}/versions/${settings.apiKeyVersion}` ||
      !access?.etag || !access.bindings?.some(b => b.role === 'roles/secretmanager.secretAccessor' && !b.condition &&
        b.members?.includes(`serviceAccount:${authority.workload.runner}`))) fail();
    await namedWakesAbsent();
    return { runnerUniqueId: accounts.runnerUniqueId, eventUniqueId: accounts.eventUniqueId,
      schedulerUniqueId: accounts.schedulerUniqueId, managed, invokerPolicySHA256: proofDigest(policy),
      secretAccessSHA256: proofDigest(access) };
  };
  const enabled = async (reader = api) => {
    const observation = await observeCloudRunDispatchService(platform, reader, 'enabled');
    const { service, revision } = observation, original = authority.original.service;
    if (service.uid !== original.uid || service.uri !== original.uri ||
      BigInt(service.generation) <= BigInt(original.generation) || revision.name === original.revision ||
      !isDeepStrictEqual(service.annotations, desired.annotations)) fail();
    return { name: service.name, uid: service.uid, generation: String(service.generation), etag: service.etag,
      revision: revision.name, revisionUid: revision.uid, uri: service.uri, admission: 'enabled' };
  };
  const proofValid = (proof, fresh = true) => {
    intentValid(state.workerIntent, bindings);
    if (proof?.schemaVersion !== 1 || proof.scope !== 'observed-role-execution-and-declared-pool-identity' ||
      proof.imageWorkflowBundleSHA256 !== state.workerIntent.imageWorkflowBundleSHA256 || proof.workflowId !== state.workerIntent.workflowId || !uuid.test(proof.runId ?? '') || !hash.test(proof.historyDigest ?? '') ||
      !Number.isFinite(Date.parse(proof.verifiedAt)) || Date.parse(proof.verifiedAt) > Date.now() + 5000 ||
      Date.parse(proof.verifiedAt) < Date.parse(state.workerIntent.createdAt) - 5000 ||
      Date.parse(state.workerIntent.createdAt) > Date.now() + 5000 ||
      fresh && Date.now() - Date.parse(state.workerIntent.createdAt) > 600000 ||
      !Array.isArray(proof.roles) || !isDeepStrictEqual(proof.roles.map(r => r.role).sort(), bindings.map(b => b.role).sort())) fail();
  };
  try {
    if (state !== undefined && (!state || !isDeepStrictEqual(state.plan, plan) ||
      !['planned', 'attempted', 'acknowledged', 'completed', 'rejected', 'failed'].includes(state.stage))) fail();
    if (state === undefined) { state = { plan, stage: 'planned' }; await save(state); }
    if (Object.hasOwn(state, 'workerIntent')) intentValid(state.workerIntent, bindings);
    if (state.stage !== 'planned') {
      proofValid(state.proof, false);
      const attempted = Date.parse(state.attemptedAt), created = Date.parse(state.workerIntent.createdAt);
      if (!Number.isFinite(attempted) || attempted < created - 5000 || attempted - created > 600000 ||
        attempted > Date.now() + 5000 || Date.parse(state.proof.verifiedAt) > attempted + 5000 ||
        typeof state.request?.etag !== 'string' || !state.request.etag ||
        !isDeepStrictEqual(state.request, { name: desired.name, etag: state.request.etag,
          template: desired.template, annotations: desired.annotations }) || !state.prerequisites) fail();
    }
    if (['rejected', 'failed'].includes(state.stage)) fail();
    if (state.stage === 'planned') {
      const before = await prerequisites(true);
      const proof = await probe({ artifactDirectory, savedIntent: state.workerIntent,
        recordIntent: async intent => {
          if (Object.hasOwn(state, 'workerIntent')) fail();
          intentValid(intent, bindings);
          state = { ...state, workerIntent: intent }; await save(state);
        } });
      proofValid(proof);
      const fresh = await prerequisites(true);
      if (!isDeepStrictEqual(before, fresh)) fail();
      const native = await observeCloudRunDispatchService(platform, api, 'disabled');
      // Recheck the original owned identity/marker immediately before checkpoint and mutation.
      await authority.verify(api);
      const request = { name: desired.name, etag: native.service.etag, template: desired.template, annotations: desired.annotations };
      state = { ...state, stage: 'attempted', attemptedAt: new Date().toISOString(), prerequisites: fresh, proof, request };
      await save(state);
      // The checkpoint may block; refresh prerequisites after it without changing authority.
      proofValid(proof);
      if (!isDeepStrictEqual(fresh, await prerequisites(true))) fail();
      proofValid(proof);
      try {
        const response = await api(`https://run.googleapis.com/v2/${desired.name}?updateMask=template,annotations`, 'PATCH', request);
        state = { ...state, stage: 'acknowledged', nativeOperation: operation(response?.name) }; await save(state);
      } catch (error) {
        if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          state = { ...state, stage: 'rejected', httpStatus: error.status }; await save(state);
        }
        throw error;
      }
    }
    if (state.stage === 'attempted') {
      // Observation only: no causal claim and never resend an unacknowledged PATCH.
      const current = await enabled();
      if (!isDeepStrictEqual(state.prerequisites, await prerequisites(false))) fail();
      state = { ...state, stage: 'completed', service: current, outcome: 'enabled-config-observed-after-unconfirmed-write' };
    } else if (state.stage === 'acknowledged') {
      const name = operation(state.nativeOperation), deadline = Date.now() + 30000;
      let response;
      do {
        response = await api(`https://run.googleapis.com/v2/${name}`);
        if (operation(response?.name) !== name) fail();
        if (response.done === true) break;
        if (response.done !== undefined && response.done !== false || Date.now() >= deadline) fail();
        await new Promise(resolve => setTimeout(resolve, 1000));
      } while (Date.now() < deadline);
      if (response?.done !== true) fail();
      if (response.error) { state = { ...state, stage: 'failed', errorSHA256: proofDigest(response.error) }; await save(state); fail(); }
      const acknowledged = await enabled((url, ...args) => url === `https://run.googleapis.com/v2/${desired.name}`
        ? Promise.resolve(response.response) : api(url, ...args));
      const current = await enabled();
      if (!isDeepStrictEqual(acknowledged, current) || !isDeepStrictEqual(state.prerequisites, await prerequisites(false))) fail();
      state = { ...state, stage: 'completed', service: current, outcome: 'native-operation-and-enabled-config-observed' };
    } else if (state.stage === 'completed') {
      if (!isDeepStrictEqual(state.service, await enabled()) || !isDeepStrictEqual(state.prerequisites, await prerequisites(false))) fail();
      return state;
    }
    if (state.stage !== 'completed') fail();
    state = { ...state, verifiedAt: new Date().toISOString(), scope: 'enabled min0 configuration under paused runtime admission; no native delivery or readiness proof' };
    await save(state); return state;
  } catch { return fail(); }
}
