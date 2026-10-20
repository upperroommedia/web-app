import { isDeepStrictEqual } from 'node:util';
import { prepareFencedPolicyGrant } from './temporal-preparation-iam.mjs';
import { proofDigest } from './temporal-release-runtime.mjs';
import { runtimeRolePreparationPlan, readOwnedPreparationRuntimeRole } from './temporal-prepare-runtime-role.mjs';
const fail = () => { throw new Error('CLOUD_RUN_RUNTIME_ACCESS_PREPARATION_UNCONFIRMED'); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function storagePolicy(value, bucket) {
  if (!value || value.kind !== 'storage#policy' || value.resourceId !== `projects/_/buckets/${bucket}` ||
    Object.keys(value).some(key => !['kind', 'resourceId', 'bindings', 'version', 'etag'].includes(key))) fail();
  const { kind: _kind, resourceId: _resource, ...policy } = value;
  return policy;
}
function bucketIdentity(value, bucket) {
  if (value?.name !== bucket || value.id !== bucket || value.projectNumber !== '251680231116' ||
    typeof value.timeCreated !== 'string' || !Number.isFinite(Date.parse(value.timeCreated))) fail();
  return { name: value.name, id: value.id, projectNumber: value.projectNumber, timeCreated: value.timeCreated };
}
/** One source-derived custom role binding. The role ID alone is never authority:
 * its immutable creation receipt and current exact body/etag must join first.
 */
export async function prepareCloudRunRuntimeAccess({ platform, role, surface, settings, operationId, releaseId,
  evidenceDigest, identityReceipt, roleReceipt, api, save, saved }) {
  if (!uuid.test(operationId ?? '') || typeof api !== 'function' || typeof save !== 'function') fail();
  const creationPlan = runtimeRolePreparationPlan({ platform, role, surface, settings,
    operationId: roleReceipt?.operationId, releaseId, evidenceDigest, identityReceipt });
  const bucket = surface === 'storage' ? (role === 'images' ? platform.firebaseResources.imagesBucket : platform.firebaseResources.storageBucket) : undefined;
  const resource = bucket ? `projects/_/buckets/${bucket}` : 'projects/urm-app-staging';
  const plan = { schemaVersion: 1, operationId, releaseId, evidenceDigest, role, surface, buildId: platform.workerBuildId,
    runner: creationPlan.runner, pool: creationPlan.pool, resource,
    settingsSHA256: proofDigest(settings), identityReceiptSHA256: proofDigest(identityReceipt), roleReceiptSHA256: proofDigest(roleReceipt),
    grants: [{ role: `projects/urm-app-staging/roles/${creationPlan.request.roleId}`, members: [`serviceAccount:${creationPlan.runner}`] }] };
  let originalBucket = saved?.prerequisites?.resourceIdentity;
  if (bucket && saved && ['attempted', 'acknowledged', 'completed'].includes(saved.stage))
    bucketIdentity(originalBucket, bucket); // Missing original identity must never adopt a recreated bucket.
  const iam = bucket ? `https://storage.googleapis.com/storage/v1/b/${bucket}/iam` : 'https://cloudresourcemanager.googleapis.com/v1/projects/urm-app-staging';
  try {
    return await prepareFencedPolicyGrant({ plan, saved, save,
      readPolicy: async () => bucket
        ? storagePolicy(await api(`${iam}?optionsRequestedPolicyVersion=3`), bucket)
        : api(`${iam}:getIamPolicy`, 'POST', { options: { requestedPolicyVersion: 3 } }),
      setPolicy: async ({ policy, updateMask }) => bucket
        ? storagePolicy(await api(iam, 'PUT', policy), bucket)
        : api(`${iam}:setIamPolicy`, 'POST', { policy, updateMask }),
      verifyPrerequisites: async () => {
        const owned = await readOwnedPreparationRuntimeRole({ platform, role, surface, settings, releaseId, evidenceDigest,
          identityReceipt, roleReceipt, api });
        let resourceIdentity;
        if (bucket) {
          resourceIdentity = bucketIdentity(await api(`https://storage.googleapis.com/storage/v1/b/${bucket}?fields=name,id,projectNumber,timeCreated`), bucket);
          if (originalBucket && !isDeepStrictEqual(resourceIdentity, originalBucket)) fail();
          originalBucket = resourceIdentity;
        } else {
          const project = await api(iam);
          if (project?.projectId !== 'urm-app-staging' || project.projectNumber !== '251680231116' || project.lifecycleState !== 'ACTIVE') fail();
          resourceIdentity = { projectId: project.projectId, projectNumber: project.projectNumber };
        }
        if (!saved || saved.stage === 'planned') {
          try { await api(`https://run.googleapis.com/v2/${plan.pool}`); fail(); }
          catch (error) { if (error?.status !== 404) throw error; }
        }
        return { ...owned, resourceIdentity };
      },
    });
  } catch { return fail(); }
}
