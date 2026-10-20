import { proofDigest } from './temporal-release-runtime.mjs';
import { dispatchPreparationAuthority } from './temporal-dispatch-authority.mjs';
import { prepareFencedPolicyGrant } from './temporal-preparation-iam.mjs';
const fail = () => { throw new Error('CLOUD_RUN_DISPATCH_ACCESS_PREPARATION_UNCONFIRMED'); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Fixed app identities only. No service-agent or impersonation role is granted.
 * The exact existing service remains admission-disabled during either policy change.
 */
export async function prepareCloudRunDispatchAccess({ platform, role, surface, settings, operationId, releaseId,
  evidenceDigest, runnerReceipt, eventReceipt, schedulerReceipt, serviceReceipt, api, save, saved }) {
  const authority = dispatchPreparationAuthority({ platform, role, settings, releaseId, evidenceDigest, runnerReceipt, eventReceipt, schedulerReceipt, serviceReceipt });
  const { workload, callers } = authority;
  if (!uuid.test(operationId ?? '') || !uuid.test(releaseId ?? '') ||
    !/^[a-f0-9]{64}$/.test(evidenceDigest ?? '') || [api, save].some(fn => typeof fn !== 'function')) fail();
  const surfaces = {
    'event-receiver': { resource: 'projects/urm-app-staging', base: 'https://cloudresourcemanager.googleapis.com/v1/',
      grants: [{ role: 'roles/eventarc.eventReceiver', members: [`serviceAccount:${callers.event}`] }] },
    'service-invokers': { resource: workload.body.name, base: 'https://run.googleapis.com/v2/',
      grants: [{ role: 'roles/run.invoker', members: [callers.event, callers.scheduler].map(email => `serviceAccount:${email}`) }] },
  };
  if (typeof surface !== 'string' || !Object.hasOwn(surfaces, surface)) fail();
  const selected = surfaces[surface];
  const plan = { schemaVersion: 1, operationId, releaseId, evidenceDigest, role, surface, buildId: platform.workerBuildId,
    runner: workload.runner, callers, resource: selected.resource, grants: selected.grants,
    settingsSHA256: proofDigest(settings), runnerReceiptSHA256: proofDigest(runnerReceipt),
    eventReceiptSHA256: proofDigest(eventReceipt), schedulerReceiptSHA256: proofDigest(schedulerReceipt), serviceReceiptSHA256: proofDigest(serviceReceipt) };
  try {
    return await prepareFencedPolicyGrant({ plan, saved, save,
      readPolicy: () => surface === 'event-receiver'
        ? api(`${selected.base}${selected.resource}:getIamPolicy`, 'POST', { options: { requestedPolicyVersion: 3 } })
        : api(`${selected.base}${selected.resource}:getIamPolicy?options.requestedPolicyVersion=3`, 'GET'),
      setPolicy: body => api(`${selected.base}${selected.resource}:setIamPolicy`, 'POST', body),
      verifyPrerequisites: () => authority.verify(api),
    });
  } catch { return fail(); }
}
