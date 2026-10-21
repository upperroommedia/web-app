import { prepareRestoredMediaActivationCapsule } from './temporal-restored-media-capsule.mjs';
import { proofDigest as hash, assertNativeSnapshot, nativeSnapshotProof } from './temporal-release-runtime.mjs';
import { assertRestoredMediaActivationAuthority } from './temporal-media-restored-origin.mjs';
import { assertRestoredActivationState } from './temporal-media-restored-activation.mjs';
const fail = () => {
  throw new Error('RESTORED_MEDIA_ACTIVATION_CHECKPOINT_UNCONFIRMED');
};
/** No reuse of ordinary zero/bootstrap/start receipts. A distinct checkpoint
 * binds the new parent to its immutable historical origin and own start. */
export async function saveRestoredMediaActivationCheckpoint(o) {
  const next = o.identityState;
  assertRestoredActivationState(next);
  const p = next.plan;
  if (
    p.operationId !== o.operationId ||
    p.bindingDigest !== o.bindingDigest ||
    p.releaseId !== o.config.releaseId ||
    o.immutableReceipt.path !== `_control/temporalCloudRestoredMediaActivation-${o.operationId}`
  )
    fail();
  await assertRestoredMediaActivationAuthority({
    ...o,
    role: 'media',
    recoveryOperationId: p.recoveryOperationId,
    releaseId: o.config.releaseId,
  });
  await o.firestore.runTransaction(
    async (tx) => {
      const [root, c, s, capsule, completion, receipt] = await Promise.all(
        [
          o.lockRef,
          o.controlRef,
          o.stateRef,
          o.firestore.doc(`_control/temporalMediaRecoveryCapsule-${p.recoveryOperationId}`),
          o.firestore.doc(`_control/temporalCloudMediaRecovery-${p.recoveryOperationId}`),
          o.immutableReceipt,
        ].map((r) => tx.get(r))
      );
      assertNativeSnapshot(o.ownedOperation, root);
      assertNativeSnapshot(o.expectedAuthority.control, c);
      assertNativeSnapshot(o.expectedAuthority.state, s);
      if (
        root.get('action') !== 'activate-restored-cloud-run-media' ||
        root.get('operationId') !== p.operationId ||
        root.get('bindingDigest') !== p.bindingDigest ||
        root.get('releaseId') !== p.releaseId ||
        c.get('admission') !== 'paused' ||
        s.get('phase') !== 'provider-usage-ready' ||
        !capsule.exists ||
        !completion.exists ||
        capsule.get('schemaVersion') !== 1 ||
        capsule.get('kind') !== 'completed-media-recovery-provenance-only-v1' ||
        capsule.get('operationId') !== p.recoveryOperationId ||
        capsule.get('releaseId') !== p.releaseId ||
        capsule.get('source.buildId') !== p.buildId ||
        capsule.get('source.image') !== p.image ||
        capsule.get('source.evidenceDigest') !== p.evidenceDigest ||
        capsule.get('completionSHA256') !== hash(completion.data()) ||
        hash(capsule.get('restoredPool')) !== hash(p.origin.pool) ||
        capsule.get('capsuleSHA256') !== p.origin.capsuleSHA256 ||
        hash((({ capsuleSHA256, ...value }) => value)(capsule.data())) !== p.origin.capsuleSHA256 ||
        hash(capsule.createTime) !== hash(capsule.updateTime) ||
        hash(completion.createTime) !== hash(completion.updateTime) ||
        hash(capsule.createTime) !== hash(completion.createTime)
      )
        fail();
      const before = root.get('cloudRestoredMediaActivation');
      if (
        !before
          ? next.stage !== 'planned'
          : hash(before.plan) !== hash(p) ||
            !(
              {
                planned: ['planned', 'starting'],
                starting: ['starting', 'started'],
                started: ['started', 'cleaning', 'completed'],
                cleaning: ['cleaning', 'completed'],
                completed: ['completed'],
              }[before.stage] ?? []
            ).includes(next.stage)
      )
        fail();
      if (before) {
        assertRestoredActivationState(before);
        for (const key of ['registration', 'cleanup'])
          if (before[key] && hash(before[key]) !== hash(next[key] ?? null)) fail();
        for (const key of ['start', 'stop']) {
          const a = before[key],
            b = next[key];
          if (!a && b && b.stage !== 'attempted') fail();
          if (a) {
            if (
              !(
                {
                  attempted: ['attempted', 'acknowledged', 'rejected'],
                  acknowledged: ['acknowledged', 'completed'],
                  completed: ['completed'],
                  rejected: ['rejected'],
                }[a.stage] ?? []
              ).includes(b?.stage)
            )
              fail();
            for (const field of ['before', 'request', 'attemptedAt', 'phaseSHA256', 'computeSHA256', 'quota'])
              if (hash(a[field] ?? null) !== hash(b[field] ?? null)) fail();
            if (a.nativeOperation && a.nativeOperation !== b.nativeOperation) fail();
            if (['completed', 'rejected'].includes(a.stage) && hash(a) !== hash(b)) fail();
          }
        }
        if (before.stage === 'completed' && hash(before) !== hash(next)) fail();
      }
      const record = {
        operationId: p.operationId,
        releaseId: p.releaseId,
        bindingDigest: p.bindingDigest,
        operatorPrincipal: o.operatorPrincipal,
        identityState: next,
      };
      if (receipt.exists && (next.stage !== 'completed' || hash(receipt.data()) !== hash(record))) fail();
      const retained = next.stage === 'completed' && next.disposition === 'retained';
      const sealed = retained ? await prepareRestoredMediaActivationCapsule(o, tx, root, c, s, record) : null;
      if (retained && receipt.exists && sealed.create) fail();

      sealed?.checkFresh();
      tx.update(o.lockRef, { cloudRestoredMediaActivation: next });
      if (next.stage === 'completed' && !receipt.exists) tx.create(o.immutableReceipt, record);
      if (sealed?.create) tx.create(sealed.ref, sealed.record);
    },
    { maxAttempts: 1 }
  );
  return nativeSnapshotProof(await o.lockRef.get());
}
