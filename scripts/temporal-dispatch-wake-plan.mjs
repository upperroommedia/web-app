import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { renderPreparationWorkload } from './temporal-preparation-resources.mjs';
import { renderServerlessDispatchWakeups } from './temporal-serverless-dispatch-resources.mjs';
const fail = () => { throw new Error('CLOUD_RUN_OWNED_WAKE_PLAN_UNCONFIRMED'); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Source contract for future create receipts and their stop operation. No API
 * call or receipt construction is an authorization to create an active wake.
 */
export function dispatchWakePlan({ platform, role, settings, releaseId, evidenceDigest, operationId, surface, runnerReceipt, serviceReceipt }) {
  if (role !== 'dispatch' || !uuid.test(operationId ?? '') || !uuid.test(releaseId ?? '') || !/^[a-f0-9]{64}$/.test(evidenceDigest ?? '')) fail();
  const workload = renderPreparationWorkload(platform, role, settings), original = serviceReceipt?.identityState;
  if (serviceReceipt?.releaseId !== releaseId || original?.stage !== 'completed' ||
    !uuid.test(serviceReceipt.operationId ?? '') || serviceReceipt.operationId !== original.plan?.operationId) fail();
  workload.body.annotations = { 'urm.upperroom.media/preparation': serviceReceipt.operationId };
  const expectedServicePlan = { schemaVersion: 1, operationId: serviceReceipt.operationId, releaseId, evidenceDigest,
    role, buildId: platform.workerBuildId, runner: workload.runner, apiKeyVersion: settings.apiKeyVersion,
    identityReceiptSHA256: proofDigest(runnerReceipt), body: workload.body };
  if (!isDeepStrictEqual(original.plan, expectedServicePlan)) fail();
  const wakeups = renderServerlessDispatchWakeups({ projectId: platform.firebaseProjectId, region: platform.cloudRegion,
    buildId: platform.workerBuildId, image: platform.workerImage, apiKeyVersion: settings.apiKeyVersion }, original.service);
  const choices = { 'outbox-trigger': wakeups.triggers[0], 'commands-trigger': wakeups.triggers[1], scheduler: wakeups.scheduler };
  if (!Object.hasOwn(choices, surface)) fail();
  const body = structuredClone(choices[surface]);
  if (surface === 'scheduler') body.description = `urm-temporal-preparation:${operationId}`;
  else body.labels = { 'urm-preparation': operationId };
  return { schemaVersion: 1, operationId, releaseId, evidenceDigest, role, surface, buildId: platform.workerBuildId,
    serviceReceiptSHA256: proofDigest(serviceReceipt), runnerReceiptSHA256: proofDigest(runnerReceipt), body };
}
