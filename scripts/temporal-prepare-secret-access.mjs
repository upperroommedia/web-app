import { prepareFencedPolicyGrant } from './temporal-preparation-iam.mjs';
import { proofDigest } from './temporal-release-runtime.mjs';
import { validateCloudRunReleasePlatform } from './temporal-release-cloud-run.mjs';
import { renderServerlessWorkerPool } from './temporal-serverless-resources.mjs';
import { readOwnedPreparationRunner, poolSecretReferences, normalizeStagingResourceName as normalize } from './temporal-preparation-resources.mjs';
const fail = () => { throw new Error('CLOUD_RUN_SECRET_ACCESS_PREPARATION_UNCONFIRMED'); };
const accessor = 'roles/secretmanager.secretAccessor';
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
    settingsSHA256: proofDigest(settings), identityReceiptSHA256: proofDigest(identityReceipt),
    grants: [{ role: accessor, members: [`serviceAccount:${binding.runnerServiceAccount}`] }] };
  try {
    return await prepareFencedPolicyGrant({ plan, saved, save,
      readPolicy: () => api(`https://secretmanager.googleapis.com/v1/${plan.resource}:getIamPolicy?options.requestedPolicyVersion=3`),
      setPolicy: body => api(`https://secretmanager.googleapis.com/v1/${plan.resource}:setIamPolicy`, 'POST', body),
      verifyPrerequisites: async () => {
        const account = await readOwnedPreparationRunner(plan, identityReceipt, api);
        for (const version of versions) {
          const metadata = await api(`https://secretmanager.googleapis.com/v1/${plan.resource}/versions/${version}`);
          if (normalize(metadata.name) !== `${plan.resource}/versions/${version}` || metadata.state !== 'ENABLED') fail();
        }
        // A completed/uncertain prior operation is GET-only and can be reconciled
        // after later pool creation; a fresh write must still precede that pool.
        if (!saved || saved.stage === 'planned') {
          try { await api(`https://run.googleapis.com/v2/${plan.pool}`); fail(); }
          catch (error) { if (error?.status !== 404) throw error; }
        }
        return { runnerUniqueId: account.uniqueId, secretReferences: versions.map(version => `${secret}/${version}`) };
      },
    });
  } catch { return fail(); }
}
