import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { validateCloudRunReleasePlatform } from './temporal-release-cloud-run.mjs';
import { renderServerlessWorkerPool } from './temporal-serverless-resources.mjs';
import { readOwnedPreparationRunner } from './temporal-preparation-resources.mjs';
const fail = () => { throw new Error('CLOUD_RUN_RUNTIME_ROLE_PREPARATION_UNCONFIRMED'); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const project = 'projects/urm-app-staging';
function permissionsFor(role, surface) {
  if (surface === 'project') return ['firebaseauth.users.get',
    ...(role === 'orchestration' ? ['firebaseauth.users.update'] : []),
    ...(['orchestration', 'controls', 'media', 'images'].includes(role)
      ? ['firebasedatabase.instances.get', 'firebasedatabase.instances.update'] : [])].sort();
  if (surface === 'storage' && ['orchestration', 'controls', 'media', 'images'].includes(role))
    return ['storage.objects.get', ...(role !== 'controls' ? ['storage.objects.delete'] : []),
      ...(role === 'images' ? ['storage.objects.update'] : []),
      ...(['orchestration', 'media'].includes(role) ? ['storage.objects.create'] : [])].sort();
  return fail();
}
async function supportedPermissions(permissions, api) {
  const found = new Map(), tokens = new Set(), names = new Set(), deadline = Date.now() + 60000; let pageToken;
  for (let page = 0; page < 30; page++) {
    const response = await api('https://iam.googleapis.com/v1/permissions:queryTestablePermissions', 'POST', {
      fullResourceName: '//cloudresourcemanager.googleapis.com/projects/urm-app-staging', pageSize: 1000,
      ...(pageToken ? { pageToken } : {}),
    });
    if (Date.now() > deadline || !Array.isArray(response?.permissions) || response.permissions.length > 1000) fail();
    for (const entry of response.permissions) {
      if (typeof entry?.name !== 'string' || !entry.name || names.has(entry.name)) fail();
      names.add(entry.name);
      if (!permissions.includes(entry.name)) continue;
      if (found.has(entry.name) || entry.stage !== 'GA' ||
        ![undefined, 'SUPPORTED'].includes(entry.customRolesSupportLevel) ||
        ![undefined, false].includes(entry.apiDisabled) || ![undefined, false].includes(entry.onlyInPredefinedRoles) ||
        (entry.primaryPermission !== undefined && entry.primaryPermission !== entry.name)) fail();
      found.set(entry.name, entry);
    }
    if (found.size === permissions.length) return { permissions, metadataSHA256: proofDigest([...found].sort()) };
    pageToken = response.nextPageToken;
    if (typeof pageToken !== 'string' || !pageToken || pageToken.length > 10000 || tokens.has(pageToken)) fail();
    tokens.add(pageToken);
  }
  return fail();
}
function nativeRole(plan, value) {
  if (value?.name !== `${project}/roles/${plan.request.roleId}` || value.title !== plan.request.role.title ||
    value.description !== plan.request.role.description || value.stage !== 'GA' ||
    ![undefined, false].includes(value.deleted) || typeof value.etag !== 'string' || !value.etag ||
    !Array.isArray(value.includedPermissions) ||
    !isDeepStrictEqual([...value.includedPermissions].sort(), plan.request.role.includedPermissions)) fail();
  return { name: value.name, title: value.title, description: value.description, stage: value.stage,
    includedPermissions: [...value.includedPermissions].sort(), etag: value.etag };
}
/** Create-only definition. No IAM binding is installed here. Unknown create ACK
 * remains fenced; a matching role name or body is never creation authority.
 */
export async function prepareCloudRunRuntimeRole({ platform, role, surface, settings, operationId, releaseId,
  evidenceDigest, identityReceipt, api, save, saved }) {
  validateCloudRunReleasePlatform(platform);
  const binding = platform.roleBindings.find(binding => binding.role === role);
  if (!binding || !uuid.test(operationId ?? '') || !uuid.test(releaseId ?? '') ||
    !/^[a-f0-9]{64}$/.test(evidenceDigest ?? '') || typeof api !== 'function' || typeof save !== 'function') fail();
  const includedPermissions = permissionsFor(role, surface);
  const plan = { schemaVersion: 1, operationId, releaseId, evidenceDigest, role, surface, buildId: platform.workerBuildId,
    runner: binding.runnerServiceAccount, pool: renderServerlessWorkerPool(binding, settings).name,
    settingsSHA256: proofDigest(settings), identityReceiptSHA256: proofDigest(identityReceipt),
    request: { roleId: `tw_${role}_${surface}_${platform.workerBuildId.slice(0, 20)}`, role: {
      title: `Temporal staging ${role} ${surface}`, stage: 'GA', includedPermissions,
      description: `urm-runtime-role:${operationId}:${proofDigest({ releaseId, evidenceDigest, build: platform.workerBuildId, role, surface, includedPermissions })}`,
    } } };
  let state = saved;
  const verify = async fresh => {
    const runner = await readOwnedPreparationRunner(plan, identityReceipt, api);
    const support = await supportedPermissions(includedPermissions, api);
    if (fresh) {
      try { await api(`https://run.googleapis.com/v2/${plan.pool}`); fail(); }
      catch (error) { if (error?.status !== 404) throw error; }
    }
    return { runnerUniqueId: runner.uniqueId, support };
  };
  try {
    if (state !== undefined && (!state || !isDeepStrictEqual(state.plan, plan) ||
      !['planned', 'attempted', 'acknowledged', 'rejected', 'completed'].includes(state.stage))) fail();
    if (state === undefined) { state = { plan, stage: 'planned' }; await save(state); }
    if (state.stage === 'rejected' || state.stage === 'attempted') fail(); // No inferred create ACK or automatic resend.
    await verify(state.stage === 'planned');
    const url = `https://iam.googleapis.com/v1/${project}/roles/${plan.request.roleId}`;
    if (state.stage === 'planned') {
      try { await api(url); fail(); } catch (error) { if (error?.status !== 404) throw error; }
      const prerequisites = await verify(true);
      state = { plan, prerequisites, stage: 'attempted', attemptedAt: new Date().toISOString() };
      await save(state);
      let response;
      try { response = await api(`https://iam.googleapis.com/v1/${project}/roles`, 'POST', plan.request); }
      catch (error) {
        if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          state = { ...state, stage: 'rejected', rejectedStatus: error.status }; await save(state);
        }
        return fail();
      }
      state = { ...state, stage: 'acknowledged', nativeRole: nativeRole(plan, response) }; await save(state);
    }
    if (!state.prerequisites || state.prerequisites.runnerUniqueId !== identityReceipt.identityState.account.uniqueId ||
      !Number.isFinite(Date.parse(state.attemptedAt ?? ''))) fail();
    const current = nativeRole(plan, await api(url));
    if (!isDeepStrictEqual(state.nativeRole, current)) fail();
    if (state.stage !== 'completed') {
      state = { ...state, stage: 'completed', verifiedAt: new Date().toISOString(),
        scope: 'custom role definition only; no binding, effective access, inherited isolation or activation proof' };
      await save(state);
    }
    return state;
  } catch { return fail(); }
}
