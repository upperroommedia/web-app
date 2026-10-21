/** CONTROLLED retained-activation provenance for the actual original SDK episode
 * test. This is not a real restored startup and must fail its full validator. */
import { proofDigest as hash } from '../../temporal-release-runtime.mjs';
export async function seedControlledPromotionRetention({
  db,
  activationId,
  activationBinding,
  recovery,
  ancestors,
  operatorIdentity,
  operatorPrincipal,
  controlRef,
  stateRef,
  ownedRefs,
}) {
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
  };
  const refs = [];
  for (const [key, name] of Object.entries(names)) {
    const ref = db.doc(`_control/${name}-${ancestors[key].operationId}`);
    if ((await ref.get()).exists) throw Error('Owned fixture input must be absent');
    await ref.create(ancestors[key]);
    refs.push(ref);
    ownedRefs.push(ref);
  }
  const receipt = db.doc(`_control/temporalCloudRestoredMediaActivation-${activationId}`),
    cap = db.doc(`_control/temporalRestoredMediaActivationCapsule-${activationId}`),
    kernel = db.doc(`_control/temporalRestoredMediaKernel-${activationId}`),
    startup = db.doc(`temporalRestoredMediaStartupCapacity/${activationId}`);
  ownedRefs.push(receipt, cap, kernel, startup);
  const recoveryReceipt = db.doc(`_control/temporalCloudMediaRecovery-${recovery.plan.operationId}`),
    r = (await recoveryReceipt.get()).data(),
    receipts = { ...ancestors, recovery: r };
  const pool = {
    ...recovery.restore.pool,
    desiredManualInstanceCount: 1,
    generation: String(BigInt(recovery.restore.pool.generation) + 1n),
    etag: 'CONTROLLED_NATIVE_RETAINED_ONE',
  };
  const p = {
    schemaVersion: 1,
    role: 'media',
    operationId: activationId,
    bindingDigest: activationBinding,
    releaseId: recovery.plan.releaseId,
    recoveryOperationId: recovery.plan.operationId,
    buildId: recovery.plan.buildId,
    image: recovery.plan.image,
    evidenceDigest: recovery.plan.evidenceDigest,
    receiptIds: Object.fromEntries(Object.entries(receipts).map(([k, v]) => [k, v.operationId])),
    receiptsSHA256: hash(receipts),
    origin: {
      capsuleSHA256: (await db.doc(`_control/temporalMediaRecoveryCapsule-${recovery.plan.operationId}`).get()).get(
        'capsuleSHA256'
      ),
    },
  };
  const k = { stage: 'running', CONTROLLED_NOT_NATIVE_STARTUP: true },
    s = { CONTROLLED_NOT_NATIVE_STARTUP: true };
  await kernel.create(k);
  await startup.create(s);
  const stamp = (x) => ({
    path: x.ref.path,
    dataSHA256: hash(x.data()),
    createTime: { seconds: x.createTime.seconds, nanoseconds: x.createTime.nanoseconds },
    updateTime: { seconds: x.updateTime.seconds, nanoseconds: x.updateTime.nanoseconds },
  });
  await db.runTransaction(
    async (tx) => {
      const [c, t, ...facts] = await Promise.all(
        [controlRef, stateRef, ...refs, recoveryReceipt, kernel, startup].map((ref) => tx.get(ref))
      );
      const completed = {
        plan: p,
        stage: 'completed',
        disposition: 'retained',
        start: { stage: 'completed', pool },
        registration: { observedAt: new Date().toISOString(), CONTROLLED_NOT_NATIVE_REGISTRATION: true },
      };
      const record = {
        operationId: activationId,
        releaseId: recovery.plan.releaseId,
        bindingDigest: activationBinding,
        operatorPrincipal,
        identityState: completed,
      };
      const v = {
        schemaVersion: 1,
        kind: 'retained-restored-media-provenance-only-v1',
        operationId: activationId,
        releaseId: recovery.plan.releaseId,
        bindingDigest: activationBinding,
        source: {
          buildId: p.buildId,
          image: p.image,
          evidenceDigest: p.evidenceDigest,
          receiptIds: p.receiptIds,
          receiptsSHA256: p.receiptsSHA256,
        },
        originalParent: {
          action: 'activate-restored-cloud-run-media',
          operationId: activationId,
          releaseId: recovery.plan.releaseId,
          bindingDigest: activationBinding,
          operatorPrincipal,
          operatorIdentity,
          cloudRestoredMediaActivation: completed,
        },
        originalAuthority: { control: { data: c.data(), stamp: stamp(c) }, state: { data: t.data(), stamp: stamp(t) } },
        activationReceiptSHA256: hash(record),
        recoveryCapsuleSHA256: p.origin.capsuleSHA256,
        pool,
        registrationSHA256: hash(completed.registration),
        facts: facts.map(stamp),
        kernel: k,
        startup: s,
      };
      tx.create(receipt, record);
      tx.create(cap, { ...v, capsuleSHA256: hash(v) });
    },
    { maxAttempts: 1 }
  );
  return { cap, pool, plan: p };
}
