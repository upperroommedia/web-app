import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { renderPreparationWorkload, readOwnedPreparationRunner, readOwnedDispatchCaller } from './temporal-preparation-resources.mjs';
import { observeCloudRunDispatchService } from './temporal-release-dispatch.mjs';
import { preparedDispatchServiceIdentity } from './temporal-prepare-dispatch-service.mjs';
import { prepareFencedPolicyGrant } from './temporal-preparation-iam.mjs';
const fail = () => { throw new Error('CLOUD_RUN_DISPATCH_ACCESS_PREPARATION_UNCONFIRMED'); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Fixed app identities only. No service-agent or impersonation role is granted.
 * The exact existing service remains admission-disabled during either policy change.
 */
export async function prepareCloudRunDispatchAccess({ platform, role, surface, settings, operationId, releaseId,
  evidenceDigest, runnerReceipt, eventReceipt, schedulerReceipt, serviceReceipt, api, save, saved }) {
  const workload = renderPreparationWorkload(platform, role, settings);
  if (role !== 'dispatch' || workload.type !== 'service' || !uuid.test(operationId ?? '') || !uuid.test(releaseId ?? '') ||
    !/^[a-f0-9]{64}$/.test(evidenceDigest ?? '') || [api, save].some(fn => typeof fn !== 'function')) fail();
  const callers = { event: platform.dispatch.eventServiceAccount, scheduler: platform.dispatch.schedulerServiceAccount };
  const surfaces = {
    'event-receiver': { resource: 'projects/urm-app-staging', base: 'https://cloudresourcemanager.googleapis.com/v1/',
      grants: [{ role: 'roles/eventarc.eventReceiver', members: [`serviceAccount:${callers.event}`] }] },
    'service-invokers': { resource: workload.body.name, base: 'https://run.googleapis.com/v2/',
      grants: [{ role: 'roles/run.invoker', members: [callers.event, callers.scheduler].map(email => `serviceAccount:${email}`) }] },
  };
  if (typeof surface !== 'string' || !Object.hasOwn(surfaces, surface)) fail();
  const original = serviceReceipt?.identityState;
  if (serviceReceipt?.releaseId !== releaseId || original?.stage !== 'completed' ||
    !uuid.test(serviceReceipt.operationId ?? '') || serviceReceipt.operationId !== original.plan?.operationId) fail();
  workload.body.annotations = { 'urm.upperroom.media/preparation': serviceReceipt.operationId };
  const expectedServicePlan = { schemaVersion: 1, operationId: serviceReceipt.operationId, releaseId, evidenceDigest,
    role, buildId: platform.workerBuildId, runner: workload.runner, apiKeyVersion: settings.apiKeyVersion,
    identityReceiptSHA256: proofDigest(runnerReceipt), body: workload.body };
  if (!isDeepStrictEqual(original.plan, expectedServicePlan)) fail();
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
      verifyPrerequisites: async () => {
        const runner = await readOwnedPreparationRunner(plan, runnerReceipt, api);
        const event = await readOwnedDispatchCaller(plan, eventReceipt, api, 'event');
        const scheduler = await readOwnedDispatchCaller(plan, schedulerReceipt, api, 'scheduler');
        const ids = [runner.uniqueId, event.uniqueId, scheduler.uniqueId];
        if (new Set(ids).size !== 3 || original.prerequisites?.runnerUniqueId !== runner.uniqueId) fail();
        const service = preparedDispatchServiceIdentity(await observeCloudRunDispatchService(platform, api, 'disabled'), original.plan);
        if (!isDeepStrictEqual(service, original.service)) fail();
        return { runnerUniqueId: runner.uniqueId, eventUniqueId: event.uniqueId, schedulerUniqueId: scheduler.uniqueId, service };
      },
    });
  } catch { return fail(); }
}
