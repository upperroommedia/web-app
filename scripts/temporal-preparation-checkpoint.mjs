import { assertNativeSnapshot, nativeSnapshotProof, proofDigest } from './temporal-release-runtime.mjs';

/** Persist under the same native operation AND release authority snapshots. No
 * callback can authorize HTTP until this transaction has acknowledged completion.
 */
async function saveCheckpoint({ firestore, lockRef, controlRef, stateRef,
  immutableReceipt, ownedOperation, expectedAuthority, config, operationId, bindingDigest, operatorPrincipal, identityState, kind }) {
  const [field, action] = { identity: ['cloudIdentityPreparation', 'prepare-cloud-run-identity'],
    dispatchAccess: ['cloudDispatchAccessPreparation', 'prepare-cloud-run-dispatch-access'],
    service: ['cloudDispatchServicePreparation', 'prepare-cloud-run-dispatch-service'],
    pool: ['cloudPoolPreparation', 'prepare-cloud-run-pool'], secret: ['cloudSecretAccessPreparation', 'prepare-cloud-run-secret-access'],
    runtimeAccess: ['cloudRuntimeAccessPreparation', 'prepare-cloud-run-runtime-access'],
    runtimeRole: ['cloudRuntimeRolePreparation', 'prepare-cloud-run-runtime-role'],
    firestore: ['cloudFirestoreAccessPreparation', 'prepare-cloud-run-firestore-access'],
    scaler: ['cloudScalerAccessPreparation', 'prepare-cloud-run-scaler-access'] }[kind] ?? [];
  if (!field) throw new Error('PREPARATION_KIND_REQUIRED');
  await firestore.runTransaction(async tx => {
    const [current, control, state, receipt] = await Promise.all([
      tx.get(lockRef), tx.get(controlRef), tx.get(stateRef),
      identityState.stage === 'completed' ? tx.get(immutableReceipt) : Promise.resolve(undefined),
    ]);
    assertNativeSnapshot(ownedOperation, current);
    assertNativeSnapshot(expectedAuthority.control, control);
    assertNativeSnapshot(expectedAuthority.state, state);
    if (control.get('releaseId') !== config.releaseId || state.get('releaseId') !== config.releaseId ||
      control.get('admission') !== 'paused' || state.get('phase') !== 'provider-usage-ready' ||
      config.domains.some(domain => control.get(`domains.${domain}.admission`) !== 'paused') ||
      current.get('operationId') !== operationId || current.get('releaseId') !== config.releaseId ||
      current.get('bindingDigest') !== bindingDigest || current.get('action') !== action)
      throw new Error('IDENTITY_PREPARATION_AUTHORITY_CHANGED');
    if (current.get(field)?.plan &&
      proofDigest(current.get(field).plan) !== proofDigest(identityState.plan))
      throw new Error('IDENTITY_PREPARATION_MANIFEST_CHANGED');
    const record = { operationId, releaseId: config.releaseId, bindingDigest, identityState, operatorPrincipal };
    if (receipt?.exists && proofDigest(receipt.data()) !== proofDigest(record))
      throw new Error('IDENTITY_PREPARATION_RECEIPT_CHANGED');
    tx.update(lockRef, { [field]: identityState });
    if (receipt && !receipt.exists) tx.create(immutableReceipt, record);
  });
  return nativeSnapshotProof(await lockRef.get());
}

export const saveIdentityPreparationCheckpoint = options => saveCheckpoint({ ...options, kind: 'identity' });
export const savePoolPreparationCheckpoint = options => saveCheckpoint({ ...options, kind: 'pool' });
export const saveSecretAccessPreparationCheckpoint = options => saveCheckpoint({ ...options, kind: 'secret' });
export const saveScalerAccessPreparationCheckpoint = options => saveCheckpoint({ ...options, kind: 'scaler' });

export const saveFirestoreAccessPreparationCheckpoint = options => saveCheckpoint({ ...options, kind: 'firestore' });

export const saveRuntimeRolePreparationCheckpoint = options => saveCheckpoint({ ...options, kind: 'runtimeRole' });

export const saveRuntimeAccessPreparationCheckpoint = options => saveCheckpoint({ ...options, kind: 'runtimeAccess' });

export const saveDispatchServicePreparationCheckpoint = options => saveCheckpoint({ ...options, kind: 'service' });

export const saveDispatchAccessPreparationCheckpoint = options => saveCheckpoint({ ...options, kind: 'dispatchAccess' });
