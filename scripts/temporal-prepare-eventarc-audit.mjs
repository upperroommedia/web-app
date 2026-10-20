import { proofDigest } from './temporal-release-runtime.mjs';
import { renderPreparationWorkload, readOwnedPreparationRunner } from './temporal-preparation-resources.mjs';
import { prepareFencedEventarcAuditPolicy } from './temporal-preparation-iam.mjs';
const fail = () => { throw new Error('CLOUD_RUN_EVENTARC_AUDIT_PREPARATION_UNCONFIRMED'); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Staging-only pre-service prerequisite. No bindings or exemption edits. */
export async function prepareCloudRunEventarcAudit({ platform, role, settings, operationId, releaseId, evidenceDigest,
  identityReceipt, api, save, saved }) {
  const workload = renderPreparationWorkload(platform, role, settings);
  if (role !== 'dispatch' || !uuid.test(operationId ?? '') || !uuid.test(releaseId ?? '') ||
    !/^[a-f0-9]{64}$/.test(evidenceDigest ?? '') || [api,save].some(fn => typeof fn !== 'function')) fail();
  const plan = { schemaVersion: 1, operationId, releaseId, evidenceDigest, role, buildId: platform.workerBuildId,
    runner: workload.runner, resource: 'projects/urm-app-staging', auditService: 'eventarc.googleapis.com', auditLogType: 'DATA_WRITE',
    service: workload.body.name, settingsSHA256: proofDigest(settings), identityReceiptSHA256: proofDigest(identityReceipt) };
  try {
    return await prepareFencedEventarcAuditPolicy({ plan, saved, save,
      readPolicy: () => api('https://cloudresourcemanager.googleapis.com/v1/projects/urm-app-staging:getIamPolicy', 'POST', { options: { requestedPolicyVersion: 3 } }),
      setPolicy: body => api('https://cloudresourcemanager.googleapis.com/v1/projects/urm-app-staging:setIamPolicy', 'POST', body),
      verifyPrerequisites: async () => {
        const account = await readOwnedPreparationRunner(plan, identityReceipt, api);
        if (!saved || saved.stage === 'planned') {
          try { await api(`https://run.googleapis.com/v2/${plan.service}`); fail(); }
          catch (error) { if (error?.status !== 404) throw error; }
        }
        return { runnerUniqueId: account.uniqueId };
      },
    });
  } catch { return fail(); }
}
