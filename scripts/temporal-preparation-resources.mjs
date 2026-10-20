import { validateCloudRunReleasePlatform } from './temporal-release-cloud-run.mjs';
import { renderServerlessWorkerPool } from './temporal-serverless-resources.mjs';
import { renderServerlessDispatchService } from './temporal-serverless-dispatch-resources.mjs';
/** Native metadata helpers shared by guarded workload preparation paths.
 * Receipts are private immutable operation records, not descriptor assertions.
 */
const fail = () => { throw new Error('CLOUD_RUN_PREPARATION_RESOURCE_UNCONFIRMED'); };
export function preparationIdentityEmail(platform, role, kind) {
  validateCloudRunReleasePlatform(platform);
  if (role === 'dispatch') {
    const fields = { runner: 'runnerServiceAccount', event: 'eventServiceAccount', scheduler: 'schedulerServiceAccount' };
    if (!Object.hasOwn(fields, kind)) fail();
    return platform.dispatch[fields[kind]];
  }
  const binding = platform.roleBindings.find(binding => binding.role === role);
  if (!binding || !['runner', 'scaler'].includes(kind)) fail();
  return kind === 'runner' ? binding.runnerServiceAccount : binding.invokerServiceAccount;
}
/** Dispatch is a service, not a polling worker or a new task queue role. */
export function renderPreparationWorkload(platform, role, settings) {
  validateCloudRunReleasePlatform(platform);
  if (role === 'dispatch') {
    if (!settings || Object.keys(settings).sort().join(',') !== 'apiKeyVersion,runtimeSecrets' ||
      settings.apiKeyVersion !== platform.dispatch.apiKeyVersion ||
      !Array.isArray(settings.runtimeSecrets) || settings.runtimeSecrets.length) fail();
    return { type: 'service', runner: platform.dispatch.runnerServiceAccount,
      body: renderServerlessDispatchService({ projectId: platform.firebaseProjectId, region: platform.cloudRegion,
        buildId: platform.workerBuildId, image: platform.workerImage, apiKeyVersion: settings.apiKeyVersion }, 'disabled') };
  }
  const binding = platform.roleBindings.find(binding => binding.role === role);
  if (!binding) fail();
  return { type: 'worker-pool', runner: binding.runnerServiceAccount, body: renderServerlessWorkerPool(binding, settings) };
}
export const normalizeStagingResourceName = value => typeof value === 'string'
  ? value.replace(/^projects\/251680231116\//, 'projects/urm-app-staging/') : value;
async function readOwnedIdentity(plan, identityReceipt, api, kind) {
  const email = kind === 'runner' ? plan.runner : kind === 'scaler' ? plan.scaler : plan.callers?.[kind];
  const state = identityReceipt?.identityState;
  if (identityReceipt?.releaseId !== plan.releaseId || state?.stage !== 'completed' || state.plan?.kind !== kind ||
    state.plan.role !== plan.role || state.plan.buildId !== plan.buildId || state.plan.email !== email ||
    state.plan.evidenceDigest !== plan.evidenceDigest || state.account?.email !== email ||
    !/^[0-9]{10,30}$/.test(state.account?.uniqueId ?? '')) fail();
  const account = await api(`https://iam.googleapis.com/v1/projects/urm-app-staging/serviceAccounts/${email}`);
  if (account.email !== email || account.projectId !== 'urm-app-staging' || account.disabled === true ||
    account.uniqueId !== state.account.uniqueId || account.description !== state.account.description) fail();
  return account;
}
export function poolSecretReferences(body) {
  const refs = new Map();
  for (const volume of body.template.volumes) if (volume.secret)
    for (const item of volume.secret.items) refs.set(`${volume.secret.secret}/${item.version}`, [volume.secret.secret, item.version]);
  for (const entry of body.template.containers[0].env) if (entry.valueSource?.secretKeyRef) {
    const ref = entry.valueSource.secretKeyRef; refs.set(`${ref.secret}/${ref.version}`, [ref.secret, ref.version]);
  }
  return refs;
}

export const readOwnedPreparationRunner = (plan, receipt, api) => readOwnedIdentity(plan, receipt, api, 'runner');
export const readOwnedPreparationScaler = (plan, receipt, api) => readOwnedIdentity(plan, receipt, api, 'scaler');

export function readOwnedDispatchCaller(plan, receipt, api, kind) {
  if (!['event', 'scheduler'].includes(kind) || plan.role !== 'dispatch') fail();
  return readOwnedIdentity(plan, receipt, api, kind);
}
