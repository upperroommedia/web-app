import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { validateCloudRunReleasePlatform, temporalCloudScalerPrincipals } from './temporal-release-cloud-run.mjs';
import { renderServerlessWorkerPool } from './temporal-serverless-resources.mjs';
import { readOwnedPreparationRunner, readOwnedPreparationScaler } from './temporal-preparation-resources.mjs';
import { verifyPreparedPoolMetadata } from './temporal-prepare-cloud-pool.mjs';
import { prepareFencedPolicyGrant } from './temporal-preparation-iam.mjs';
const fail = () => { throw new Error('CLOUD_RUN_SCALER_ACCESS_PREPARATION_UNCONFIRMED'); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Three fixed native IAM surfaces. Resource/member/role derivation is reviewed
 * source, never a descriptor-supplied policy or generic IAM administration hook.
 */
export async function prepareCloudRunScalerAccess({ platform, role, surface, settings, operationId, releaseId,
  evidenceDigest, runnerReceipt, scalerReceipt, poolReceipt, api, save, saved, observeComputeIsolation }) {
  validateCloudRunReleasePlatform(platform);
  const binding = platform.roleBindings.find(binding => binding.role === role);
  if (!binding || !uuid.test(operationId ?? '') || !uuid.test(releaseId ?? '') ||
    !/^[a-f0-9]{64}$/.test(evidenceDigest ?? '') || [api, save, observeComputeIsolation].some(fn => typeof fn !== 'function')) fail();
  const runner = `serviceAccount:${binding.runnerServiceAccount}`, scaler = `serviceAccount:${binding.invokerServiceAccount}`;
  const account = email => `projects/urm-app-staging/serviceAccounts/${email}`;
  const expectedBody = renderServerlessWorkerPool(binding, settings);
  const surfaces = {
    'runner-scaler-user': { resource: account(binding.runnerServiceAccount), base: 'https://iam.googleapis.com/v1/', getMethod: 'POST',
      grants: [{ role: 'roles/iam.serviceAccountUser', members: [scaler] }] },
    'scaler-trust': { resource: account(binding.invokerServiceAccount), base: 'https://iam.googleapis.com/v1/', getMethod: 'POST',
      grants: [{ role: 'roles/iam.serviceAccountTokenCreator', members: [...temporalCloudScalerPrincipals] }] },
    'pool-access': { resource: expectedBody.name, base: 'https://run.googleapis.com/v2/', getMethod: 'GET',
      grants: [{ role: 'roles/run.viewer', members: [runner] }, { role: 'roles/run.developer', members: [scaler] }] },
  };
  if (typeof surface !== 'string' || !Object.hasOwn(surfaces, surface)) fail();
  const selected = surfaces[surface], poolState = poolReceipt?.identityState;
  if (poolReceipt?.releaseId !== releaseId || poolState?.stage !== 'completed' || poolState.plan?.releaseId !== releaseId ||
    poolState.plan.role !== role || poolState.plan.buildId !== platform.workerBuildId || poolState.plan.evidenceDigest !== evidenceDigest ||
    poolState.plan.runner !== binding.runnerServiceAccount || !uuid.test(poolState.plan.operationId ?? '') ||
    poolReceipt.operationId !== poolState.plan.operationId) fail();
  expectedBody.annotations = { 'urm.upperroom.media/preparation': poolState.plan.operationId };
  if (proofDigest(expectedBody) !== proofDigest(poolState.plan.body)) fail();
  const plan = { schemaVersion: 1, operationId, releaseId, evidenceDigest, role, surface, buildId: platform.workerBuildId,
    runner: binding.runnerServiceAccount, scaler: binding.invokerServiceAccount, resource: selected.resource, grants: selected.grants,
    settingsSHA256: proofDigest(settings), runnerReceiptSHA256: proofDigest(runnerReceipt),
    scalerReceiptSHA256: proofDigest(scalerReceipt), poolReceiptSHA256: proofDigest(poolReceipt) };
  try {
    return await prepareFencedPolicyGrant({ plan, saved, save,
      readPolicy: () => api(`${selected.base}${selected.resource}:getIamPolicy?options.requestedPolicyVersion=3`, selected.getMethod),
      setPolicy: body => api(`${selected.base}${selected.resource}:setIamPolicy`, 'POST', body),
      verifyPrerequisites: async () => {
        const nativeRunner = await readOwnedPreparationRunner(plan, runnerReceipt, api);
        const nativeScaler = await readOwnedPreparationScaler(plan, scalerReceipt, api);
        if (nativeRunner.uniqueId === nativeScaler.uniqueId || poolState.prerequisites?.runnerUniqueId !== nativeRunner.uniqueId) fail();
        const pool = verifyPreparedPoolMetadata({ body: expectedBody }, await api(`https://run.googleapis.com/v2/${expectedBody.name}`));
        if (!isDeepStrictEqual(pool, poolState.pool)) fail();
        const isolation = await observeComputeIsolation();
        if (isolation?.namespace !== platform.temporalNamespace || !/^[a-f0-9]{64}$/.test(isolation.inventorySHA256 ?? '') ||
          !Number.isFinite(Date.parse(isolation.observedAt)) || Math.abs(Date.now() - Date.parse(isolation.observedAt)) > 5000) fail();
        return { runnerUniqueId: nativeRunner.uniqueId, scalerUniqueId: nativeScaler.uniqueId, pool, isolation };
      },
    });
  } catch { return fail(); }
}
