import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { validateCloudRunReleasePlatform } from './temporal-release-cloud-run.mjs';
import { renderServerlessWorkerPool } from './temporal-serverless-resources.mjs';
import { readOwnedPreparationRunner, poolSecretReferences, normalizeStagingResourceName as normalize } from './temporal-preparation-resources.mjs';
const fail = () => { throw new Error('CLOUD_RUN_SECRET_ACCESS_PREPARATION_UNCONFIRMED'); };
const accessor = 'roles/secretmanager.secretAccessor';
function policyValue(policy) {
  if (!policy || typeof policy !== 'object' || Object.keys(policy).some(key => !['version', 'etag', 'bindings', 'auditConfigs'].includes(key)) ||
    typeof policy.etag !== 'string' || !policy.etag || policy.etag.length > 1000 ||
    ![undefined, 1, 3].includes(policy.version) || (policy.bindings !== undefined && !Array.isArray(policy.bindings)) ||
    (policy.auditConfigs !== undefined && !Array.isArray(policy.auditConfigs))) fail();
  const bindings = policy.bindings ?? [];
  if (bindings.length > 1500) fail();
  for (const binding of bindings) {
    if (!binding || Object.keys(binding).some(key => !['role', 'members', 'condition'].includes(key)) ||
      typeof binding.role !== 'string' || !binding.role || binding.role.includes('_withcond_') ||
      !Array.isArray(binding.members) || !binding.members.length || binding.members.length > 1500 ||
      new Set(binding.members).size !== binding.members.length || binding.members.some(member =>
        typeof member !== 'string' || !member || member === 'allUsers' || member === 'allAuthenticatedUsers')) fail();
    if (binding.condition !== undefined && (!binding.condition || typeof binding.condition !== 'object' ||
      Object.keys(binding.condition).some(key => !['title', 'description', 'expression', 'location'].includes(key)) ||
      typeof binding.condition.expression !== 'string' || !binding.condition.expression ||
      typeof binding.condition.title !== 'string' || !binding.condition.title || policy.version !== 3)) fail();
  }
  const keys = bindings.map(binding => `${binding.role}:${proofDigest(binding.condition ?? null)}`);
  if (new Set(keys).size !== keys.length) fail();
  // Ordering is not policy semantics. Preserve all binding/condition/audit content.
  const value = { bindings: bindings.map(binding => ({ ...binding, members: [...binding.members].sort() }))
    .sort((a, b) => proofDigest(a).localeCompare(proofDigest(b))), auditConfigs: structuredClone(policy.auditConfigs ?? []) };
  return value;
}
function desiredPolicy(before, member) {
  policyValue(before);
  const result = structuredClone(before);
  result.bindings ??= [];
  const binding = result.bindings.find(binding => binding.role === accessor && binding.condition === undefined);
  if (binding) { if (!binding.members.includes(member)) binding.members.push(member); }
  else result.bindings.push({ role: accessor, members: [member] });
  // Preserve the fetched conditional-policy representation; set v3 if conditional.
  result.version = result.bindings.some(binding => binding.condition !== undefined) ? 3 : (before.version ?? 1);
  return result;
}
const samePolicy = (a, b) => proofDigest(policyValue(a)) === proofDigest(policyValue(b));
/** One source-derived secret grant, with one etag-fenced write at most. Unknown
 * ACK reconciliation observes the desired state; it never asserts causal write proof.
 */
export async function prepareCloudRunSecretAccess({ platform, role, settings, secret, operationId, releaseId,
  evidenceDigest, identityReceipt, api, save, saved }) {
  validateCloudRunReleasePlatform(platform);
  const binding = platform.roleBindings.find(binding => binding.role === role);
  if (!binding || !/^[a-f0-9-]{36}$/.test(operationId ?? '') || !/^[a-f0-9-]{36}$/.test(releaseId ?? '') ||
    !/^[a-f0-9]{64}$/.test(evidenceDigest ?? '') || typeof api !== 'function' || typeof save !== 'function') fail();
  const body = renderServerlessWorkerPool(binding, settings);
  const versions = [...poolSecretReferences(body).values()].filter(([name]) => name === secret).map(([, version]) => version).sort();
  if (!versions.length) fail();
  const plan = { schemaVersion: 1, operationId, releaseId, evidenceDigest, role, buildId: platform.workerBuildId,
    runner: binding.runnerServiceAccount, member: `serviceAccount:${binding.runnerServiceAccount}`, roleName: accessor,
    resource: `projects/urm-app-staging/secrets/${secret}`, versions, pool: body.name,
    settingsSHA256: proofDigest(settings), identityReceiptSHA256: proofDigest(identityReceipt) };
  let state = saved;
  const readPolicy = () => api(`https://secretmanager.googleapis.com/v1/${plan.resource}:getIamPolicy?options.requestedPolicyVersion=3`);
  try {
    if (state !== undefined && (!state || !isDeepStrictEqual(state.plan, plan) ||
      !['planned', 'attempted', 'acknowledged', 'rejected', 'completed'].includes(state.stage))) fail();
    if (state === undefined) { state = { plan, stage: 'planned' }; await save(state); }
    if (state.stage === 'rejected') fail();
    await readOwnedPreparationRunner(plan, identityReceipt, api);
    for (const version of versions) {
      const metadata = await api(`https://secretmanager.googleapis.com/v1/${plan.resource}/versions/${version}`);
      if (normalize(metadata.name) !== `${plan.resource}/versions/${version}` || metadata.state !== 'ENABLED') fail();
    }
    if (state.stage === 'planned') {
      try { await api(`https://run.googleapis.com/v2/${plan.pool}`); fail(); }
      catch (error) { if (error?.status !== 404) throw error; }
      const before = await readPolicy(), desired = desiredPolicy(before, plan.member);
      if (samePolicy(before, desired)) {
        state = { plan, stage: 'completed', before, desired, outcome: 'observed-existing-direct-policy', scope: 'direct secret policy observed; no inherited-isolation, effective-access or activation proof', observedEtag: before.etag, verifiedAt: new Date().toISOString() };
        await save(state);
        return state;
      }
      state = { plan, stage: 'attempted', before, desired, attemptedAt: new Date().toISOString() };
      await save(state);
      let acknowledgement;
      try {
        acknowledgement = await api(`https://secretmanager.googleapis.com/v1/${plan.resource}:setIamPolicy`, 'POST',
          { policy: desired, updateMask: 'bindings,etag' });
      } catch (error) {
        if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          state = { ...state, stage: 'rejected', rejectedStatus: error.status };
          await save(state);
          fail(); // A definite rejection is not an unknown acknowledgement or successful observation.
        }
        // Transport/server-unknown remains attempted; only GET observation is allowed.
      }
      if (acknowledgement) {
        if (!samePolicy(acknowledgement, desired)) fail();
        state = { ...state, stage: 'acknowledged', acknowledgedPolicySHA256: proofDigest(acknowledgement) };
        await save(state);
      }
    }
    // Saved fields never grant authority to widen a future write or adopt drift.
    if (!state.before || !state.desired || !isDeepStrictEqual(desiredPolicy(state.before, plan.member), state.desired)) fail();
    const current = await readPolicy();
    if (!samePolicy(current, state.desired)) fail();
    if (state.stage === 'completed') return state;
    state = { ...state, stage: 'completed', observedEtag: current.etag, verifiedAt: new Date().toISOString(),
      outcome: state.stage === 'acknowledged' ? 'acknowledged-write-and-policy-observation' : 'desired-policy-observed-after-unconfirmed-write',
      scope: 'direct secret policy observed; no inherited-isolation, effective-access, causal unknown-write or activation proof' };
    await save(state);
    return state;
  } catch { return fail(); }
}
