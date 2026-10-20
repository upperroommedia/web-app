import { prepareFencedPolicyGrant } from './temporal-preparation-iam.mjs';
import { proofDigest } from './temporal-release-runtime.mjs';
import { validateCloudRunReleasePlatform } from './temporal-release-cloud-run.mjs';
import { readOwnedPreparationRunner, renderPreparationWorkload } from './temporal-preparation-resources.mjs';
const fail = () => { throw new Error('CLOUD_RUN_FIRESTORE_ACCESS_PREPARATION_UNCONFIRMED'); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Project policy binding, with access restricted to the actual default database.
 * This is not document-level isolation or proof of effective runtime permission.
 */
export async function prepareCloudRunFirestoreAccess({ platform, role, settings, operationId, releaseId,
  evidenceDigest, identityReceipt, api, save, saved }) {
  validateCloudRunReleasePlatform(platform);
  if (!uuid.test(operationId ?? '') || !uuid.test(releaseId ?? '') ||
    !/^[a-f0-9]{64}$/.test(evidenceDigest ?? '') || typeof api !== 'function' || typeof save !== 'function') fail();
  const database = 'projects/urm-app-staging/databases/(default)';
  const condition = { title: 'urm-temporal-default-firestore', expression: `resource.name=="${database}"` };
  const workload = renderPreparationWorkload(platform, role, settings);
  const plan = { schemaVersion: 1, operationId, releaseId, evidenceDigest, role, buildId: platform.workerBuildId,
    runner: workload.runner, resource: 'projects/urm-app-staging', database,
    workload: { type: workload.type, name: workload.body.name },
    settingsSHA256: proofDigest(settings), identityReceiptSHA256: proofDigest(identityReceipt),
    grants: [{ role: 'roles/datastore.user', members: [`serviceAccount:${workload.runner}`], condition }] };
  const originalDatabase = saved?.prerequisites?.database;
  if (saved && ['attempted', 'acknowledged', 'completed'].includes(saved.stage) &&
      (!originalDatabase || originalDatabase.name !== database || originalDatabase.type !== 'FIRESTORE_NATIVE' ||
       originalDatabase.locationId !== 'us-central1' || typeof originalDatabase.uid !== 'string' || !originalDatabase.uid)) fail();
  let databaseUID = originalDatabase?.uid;
  try {
    return await prepareFencedPolicyGrant({ plan, saved, save,
      readPolicy: () => api('https://cloudresourcemanager.googleapis.com/v1/projects/urm-app-staging:getIamPolicy', 'POST', { options: { requestedPolicyVersion: 3 } }),
      setPolicy: body => api('https://cloudresourcemanager.googleapis.com/v1/projects/urm-app-staging:setIamPolicy', 'POST', body),
      verifyPrerequisites: async () => {
        const account = await readOwnedPreparationRunner(plan, identityReceipt, api);
        const metadata = await api(`https://firestore.googleapis.com/v1/${database}`);
        if (metadata?.name !== database || metadata.type !== 'FIRESTORE_NATIVE' || metadata.locationId !== 'us-central1' ||
          typeof metadata.uid !== 'string' || !metadata.uid || metadata.deleteTime) fail();
        if (databaseUID !== undefined && databaseUID !== metadata.uid) fail();
        databaseUID = metadata.uid;
        if (!saved || saved.stage === 'planned') {
          try { await api(`https://run.googleapis.com/v2/${plan.workload.name}`); fail(); }
          catch (error) { if (error?.status !== 404) throw error; }
        }
        return { runnerUniqueId: account.uniqueId, database: { name: metadata.name, uid: metadata.uid, type: metadata.type, locationId: metadata.locationId } };
      },
    });
  } catch { return fail(); }
}
