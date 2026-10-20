/** Native metadata helpers shared by the guarded pool and secret preparation paths.
 * Receipts are private immutable operation records, not descriptor assertions.
 */
const fail = () => { throw new Error('CLOUD_RUN_PREPARATION_RESOURCE_UNCONFIRMED'); };
export const normalizeStagingResourceName = value => typeof value === 'string'
  ? value.replace(/^projects\/251680231116\//, 'projects/urm-app-staging/') : value;
export async function readOwnedPreparationRunner(plan, identityReceipt, api) {
  const state = identityReceipt?.identityState;
  if (identityReceipt?.releaseId !== plan.releaseId || state?.stage !== 'completed' || state.plan?.kind !== 'runner' ||
    state.plan.role !== plan.role || state.plan.buildId !== plan.buildId || state.plan.email !== plan.runner ||
    state.plan.evidenceDigest !== plan.evidenceDigest || state.account?.email !== plan.runner ||
    !/^[0-9]{10,30}$/.test(state.account?.uniqueId ?? '')) fail();
  const account = await api(`https://iam.googleapis.com/v1/projects/urm-app-staging/serviceAccounts/${plan.runner}`);
  if (account.email !== plan.runner || account.projectId !== 'urm-app-staging' || account.disabled === true ||
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
