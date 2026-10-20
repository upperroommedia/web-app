import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
const fail = () => { throw new Error('CLOUD_RUN_FENCED_POLICY_GRANT_UNCONFIRMED'); };
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
function desiredPolicy(before, grants) {
  policyValue(before);
  const result = structuredClone(before);
  result.bindings ??= [];
  for (const grant of grants) {
    if (!grant || Object.keys(grant).sort().join(',') !== 'members,role' || !/^roles\/[A-Za-z0-9.]+$/.test(grant.role ?? '') ||
      !Array.isArray(grant.members) || !grant.members.length || new Set(grant.members).size !== grant.members.length ||
      grant.members.some(member => !/^serviceAccount:[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.gserviceaccount\.com$/.test(member))) fail();
    const binding = result.bindings.find(binding => binding.role === grant.role && binding.condition === undefined);
    if (binding) { for (const member of grant.members) if (!binding.members.includes(member)) binding.members.push(member); }
    else result.bindings.push(structuredClone(grant));
  }
  // Preserve the fetched conditional-policy representation; set v3 if conditional.
  result.version = result.bindings.some(binding => binding.condition !== undefined) ? 3 : (before.version ?? 1);
  return result;
}
const samePolicy = (a, b) => proofDigest(policyValue(a)) === proofDigest(policyValue(b));
/** Internal frozen-source IAM protocol. Public release actions derive every
 * resource, role, member and native callback; descriptors cannot supply these.
 */
export async function prepareFencedPolicyGrant({ plan, readPolicy, setPolicy, verifyPrerequisites, save, saved }) {
  if (!Array.isArray(plan?.grants) || !plan.grants.length || plan.grants.length > 4 ||
    [readPolicy, setPolicy, verifyPrerequisites, save].some(value => typeof value !== 'function')) fail();
  let state = saved;
  try {
    if (state !== undefined && (!state || !isDeepStrictEqual(state.plan, plan) ||
      !['planned', 'attempted', 'acknowledged', 'rejected', 'completed'].includes(state.stage))) fail();
    if (state === undefined) { state = { plan, stage: 'planned' }; await save(state); }
    if (state.stage === 'rejected') fail();
    const observedPrerequisites = await verifyPrerequisites();
    if (state.stage === 'planned') {
      const before = await readPolicy(), desired = desiredPolicy(before, plan.grants);
      if (samePolicy(before, desired)) {
        state = { plan, stage: 'completed', before, desired, prerequisites: observedPrerequisites, outcome: 'observed-existing-direct-policy', scope: 'direct policy observed; no inherited-isolation, effective-access or activation proof', observedEtag: before.etag, verifiedAt: new Date().toISOString() };
        await save(state);
        return state;
      }
      const prerequisites = await verifyPrerequisites();
      state = { plan, stage: 'attempted', before, desired, prerequisites, attemptedAt: new Date().toISOString() };
      await save(state);
      let acknowledgement;
      try {
        acknowledgement = await setPolicy({ policy: desired, updateMask: 'bindings,etag' });
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
    if (!state.before || !state.desired || !isDeepStrictEqual(desiredPolicy(state.before, plan.grants), state.desired)) fail();
    const current = await readPolicy();
    if (!samePolicy(current, state.desired)) fail();
    if (state.stage === 'completed') return state;
    state = { ...state, stage: 'completed', observedEtag: current.etag, verifiedAt: new Date().toISOString(),
      outcome: state.stage === 'acknowledged' ? 'acknowledged-write-and-policy-observation' : 'desired-policy-observed-after-unconfirmed-write',
      scope: 'direct policy observed; no inherited-isolation, effective-access, causal unknown-write or activation proof' };
    await save(state);
    return state;
  } catch { return fail(); }
}
