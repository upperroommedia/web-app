import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { renderPreparationWorkload, readOwnedPreparationRunner, readOwnedDispatchCaller } from './temporal-preparation-resources.mjs';
import { observeCloudRunDispatchService } from './temporal-release-dispatch.mjs';
import { preparedDispatchServiceIdentity } from './temporal-prepare-dispatch-service.mjs';
const fail = () => { throw new Error('CLOUD_RUN_DISPATCH_AUTHORITY_UNCONFIRMED'); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Re-derive ownership once; native identities and disabled configuration are
 * re-read on every verification. This helper creates no policy or resource.
 */
export function dispatchPreparationAuthority({ platform, role, settings, releaseId, evidenceDigest,
  runnerReceipt, eventReceipt, schedulerReceipt, serviceReceipt }) {
  const workload = renderPreparationWorkload(platform, role, settings);
  if (role !== 'dispatch' || !uuid.test(releaseId ?? '') || !/^[a-f0-9]{64}$/.test(evidenceDigest ?? '')) fail();
  const original = serviceReceipt?.identityState;
  if (serviceReceipt?.releaseId !== releaseId || original?.stage !== 'completed' ||
    !uuid.test(serviceReceipt.operationId ?? '') || serviceReceipt.operationId !== original.plan?.operationId) fail();
  workload.body.annotations = { 'urm.upperroom.media/preparation': serviceReceipt.operationId };
  const expected = { schemaVersion: 1, operationId: serviceReceipt.operationId, releaseId, evidenceDigest,
    role, buildId: platform.workerBuildId, runner: workload.runner, apiKeyVersion: settings.apiKeyVersion,
    identityReceiptSHA256: proofDigest(runnerReceipt), body: workload.body };
  if (!isDeepStrictEqual(original.plan, expected)) fail();
  const callers = { event: platform.dispatch.eventServiceAccount, scheduler: platform.dispatch.schedulerServiceAccount };
  const identityPlan = { role, buildId: platform.workerBuildId, releaseId, evidenceDigest, runner: workload.runner, callers };
  return { workload, original, callers, async verify(api) {
    const runner = await readOwnedPreparationRunner(identityPlan, runnerReceipt, api);
    const event = await readOwnedDispatchCaller(identityPlan, eventReceipt, api, 'event');
    const scheduler = await readOwnedDispatchCaller(identityPlan, schedulerReceipt, api, 'scheduler');
    if (new Set([runner.uniqueId, event.uniqueId, scheduler.uniqueId]).size !== 3 ||
      original.prerequisites?.runnerUniqueId !== runner.uniqueId) fail();
    const service = preparedDispatchServiceIdentity(await observeCloudRunDispatchService(platform, api, 'disabled'), expected);
    if (!isDeepStrictEqual(service, original.service)) fail();
    return { runnerUniqueId: runner.uniqueId, eventUniqueId: event.uniqueId, schedulerUniqueId: scheduler.uniqueId, service };
  } };
}
