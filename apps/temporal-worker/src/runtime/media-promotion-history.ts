/** Fixed promotion-parent native provenance reader. Historical parents remain
 * explicit data inputs to validators; they never stand in for current authority. */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { releaseProvenanceDigest as proof } from './media-recovery-history';
export type MediaPromotionAuthorityOptions = {
  db: Firestore;
  promotionOperationId: string;
  promotionBindingDigest: string;
  activationOperationId: string;
  recoveryOperationId: string;
  releaseId: string;
  buildId: string;
  imageDigest: string;
  expectedRootSHA256: string;
  expectedControlSHA256: string;
  expectedStateSHA256: string;
};
const fail = (): never => {
  throw new Error('MEDIA_PROMOTION_HISTORY_UNCONFIRMED');
};
const stamp = (s: any) => {
  if (!s.exists || !s.createTime || !s.updateTime) return fail();
  return {
    path: s.ref.path,
    dataSHA256: proof(s.data()),
    createTime: { seconds: s.createTime.seconds, nanoseconds: s.createTime.nanoseconds },
    updateTime: { seconds: s.updateTime.seconds, nanoseconds: s.updateTime.nanoseconds },
  };
};
const names = {
  runner: 'temporalCloudIdentityPreparation',
  scaler: 'temporalCloudIdentityPreparation',
  pool: 'temporalCloudPoolPreparation',
  runnerScaler: 'temporalCloudScalerAccessPreparation',
  scalerTrust: 'temporalCloudScalerAccessPreparation',
  poolAccess: 'temporalCloudScalerAccessPreparation',
  firestore: 'temporalCloudFirestoreAccessPreparation',
  projectRole: 'temporalCloudRuntimeRolePreparation',
  projectAccess: 'temporalCloudRuntimeAccessPreparation',
  storageRole: 'temporalCloudRuntimeRolePreparation',
  storageAccess: 'temporalCloudRuntimeAccessPreparation',
  bootstrapCycle: 'temporalCloudMediaBootstrapCycle',
  recovery: 'temporalCloudMediaRecovery',
} as const;
export async function readRetainedMediaPromotionAuthority(
  o: MediaPromotionAuthorityOptions,
  tx: Transaction,
  fresh: () => void
) {
  fresh();
  const ids = [o.promotionOperationId, o.activationOperationId, o.recoveryOperationId];
  if (
    !('projectId' in o.db) ||
    o.db.projectId !== 'urm-app-staging' ||
    o.db.databaseId !== '(default)' ||
    new Set(ids).size !== 3 ||
    ids.some((v) => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v))
  )
    fail();
  const paths = [
    '_control/temporalReleaseOperation',
    '_control/temporalRelease',
    '_control/temporalReleaseState',
    `_control/temporalRestoredMediaActivationCapsule-${o.activationOperationId}`,
    `_control/temporalCloudRestoredMediaActivation-${o.activationOperationId}`,
  ];
  const all = await Promise.all(paths.map((p) => tx.get(o.db.doc(p))));
  fresh();
  const [root, control, state, cap, receipt] = all;
  if (
    all.some((s) => !s.exists) ||
    proof(root.data()) !== o.expectedRootSHA256 ||
    proof(control.data()) !== o.expectedControlSHA256 ||
    proof(state.data()) !== o.expectedStateSHA256 ||
    root.get('action') !== 'promote-cloud-run-media' ||
    root.get('operationId') !== o.promotionOperationId ||
    root.get('bindingDigest') !== o.promotionBindingDigest ||
    root.get('releaseId') !== o.releaseId ||
    root.get('operatorPrincipal.adcAndGcloudAccountMatch') !== true ||
    control.get('releaseId') !== o.releaseId ||
    state.get('releaseId') !== o.releaseId ||
    control.get('admission') !== 'paused' ||
    state.get('phase') !== 'provider-usage-ready' ||
    ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
      (d) => control.get(`domains.${d}.admission`) !== 'paused'
    )
  )
    fail();
  const v = cap.data()!,
    { capsuleSHA256, ...preimage } = v,
    completed = receipt.get('identityState'),
    p = completed?.plan;
  if (
    v.schemaVersion !== 1 ||
    v.kind !== 'retained-restored-media-provenance-only-v1' ||
    capsuleSHA256 !== proof(preimage) ||
    v.operationId !== o.activationOperationId ||
    v.releaseId !== o.releaseId ||
    v.bindingDigest !== p?.bindingDigest ||
    receipt.get('operationId') !== o.activationOperationId ||
    receipt.get('releaseId') !== o.releaseId ||
    receipt.get('bindingDigest') !== v.bindingDigest ||
    v.activationReceiptSHA256 !== proof(receipt.data()) ||
    proof(cap.createTime) !== proof(cap.updateTime) ||
    proof(receipt.createTime) !== proof(receipt.updateTime) ||
    proof(cap.createTime) !== proof(receipt.createTime) ||
    completed.stage !== 'completed' ||
    completed.disposition !== 'retained' ||
    p.operationId !== o.activationOperationId ||
    p.recoveryOperationId !== o.recoveryOperationId ||
    p.buildId !== o.buildId ||
    p.image !== o.imageDigest ||
    p.releaseId !== o.releaseId ||
    proof(v.originalParent?.cloudRestoredMediaActivation) !== proof(completed) ||
    v.originalParent.action !== 'activate-restored-cloud-run-media' ||
    v.originalParent.operationId !== o.activationOperationId ||
    v.originalParent.bindingDigest !== p.bindingDigest ||
    v.originalParent.releaseId !== o.releaseId ||
    v.originalParent.operatorPrincipal?.adcAndGcloudAccountMatch !== true ||
    proof(v.originalParent.operatorPrincipal) !== proof(receipt.get('operatorPrincipal')) ||
    v.recoveryCapsuleSHA256 !== p.origin?.capsuleSHA256 ||
    v.registrationSHA256 !== proof(completed.registration) ||
    proof(v.pool) !== proof(completed.start?.pool) ||
    completed.start?.stage !== 'completed'
  )
    fail();
  const observed = Date.parse(completed.registration?.observedAt);
  if (
    !Number.isFinite(observed) ||
    Math.abs(cap.createTime!.toMillis() - observed) >= 5000 ||
    proof(v.source) !==
      proof({
        buildId: p.buildId,
        image: p.image,
        evidenceDigest: p.evidenceDigest,
        receiptIds: p.receiptIds,
        receiptsSHA256: p.receiptsSHA256,
      })
  )
    fail();
  for (const key of ['control', 'state']) {
    const a = v.originalAuthority?.[key];
    if (
      !a?.data ||
      a.stamp?.path !== (key === 'control' ? control.ref.path : state.ref.path) ||
      a.stamp.dataSHA256 !== proof(a.data)
    )
      fail();
  }
  const a = v.originalAuthority;
  if (
    a.control.data.releaseId !== o.releaseId ||
    a.state.data.releaseId !== o.releaseId ||
    a.control.data.admission !== 'paused' ||
    a.state.data.phase !== 'provider-usage-ready' ||
    ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
      (d) => a.control.data.domains?.[d]?.admission !== 'paused'
    )
  )
    fail();
  const expected = [
    ...Object.entries(names).map(([k, n]) => `_control/${n}-${p.receiptIds[k]}`),
    `_control/temporalRestoredMediaKernel-${o.activationOperationId}`,
    `temporalRestoredMediaStartupCapacity/${o.activationOperationId}`,
  ];
  if (!Array.isArray(v.facts) || v.facts.length !== 15 || proof(v.facts.map((f: any) => f.path)) !== proof(expected))
    fail();
  const facts = await Promise.all(expected.map((path) => tx.get(o.db.doc(path))));
  fresh();
  if (
    proof(facts.map(stamp)) !== proof(v.facts) ||
    facts[13].get('stage') !== 'running' ||
    proof(facts[13].data()) !== proof(v.kernel) ||
    proof(facts[14].data()) !== proof(v.startup) ||
    proof(facts[14].createTime) !== proof(facts[14].updateTime)
  )
    fail();
  const ancestors = Object.fromEntries(Object.keys(names).map((k, i) => [k, facts[i].data()]));
  if (proof(ancestors) !== p.receiptsSHA256) fail();
  fresh();
  return {
    current: root.data()!,
    originalParent: v.originalParent,
    originalAuthority: a,
    activationPlan: p,
    kernel: v.kernel,
    startup: v.startup,
    capsuleSHA256,
    stampsSHA256: proof([...all, ...facts].map(stamp)),
  };
}
