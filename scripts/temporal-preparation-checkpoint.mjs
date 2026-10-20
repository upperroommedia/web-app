import { assertNativeSnapshot, nativeSnapshotProof, proofDigest } from './temporal-release-runtime.mjs';

/** Persist under the same native operation AND release authority snapshots. No
 * callback can authorize HTTP until this transaction has acknowledged completion.
 */
export async function saveIdentityPreparationCheckpoint({ firestore, lockRef, controlRef, stateRef,
  immutableReceipt, ownedOperation, expectedAuthority, config, operationId, bindingDigest, operatorPrincipal, identityState }) {
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
      current.get('bindingDigest') !== bindingDigest || current.get('action') !== 'prepare-cloud-run-identity')
      throw new Error('IDENTITY_PREPARATION_AUTHORITY_CHANGED');
    if (current.get('cloudIdentityPreparation')?.plan &&
      proofDigest(current.get('cloudIdentityPreparation').plan) !== proofDigest(identityState.plan))
      throw new Error('IDENTITY_PREPARATION_MANIFEST_CHANGED');
    const record = { operationId, releaseId: config.releaseId, bindingDigest, identityState, operatorPrincipal };
    if (receipt?.exists && proofDigest(receipt.data()) !== proofDigest(record))
      throw new Error('IDENTITY_PREPARATION_RECEIPT_CHANGED');
    tx.update(lockRef, { cloudIdentityPreparation: identityState });
    if (receipt && !receipt.exists) tx.create(immutableReceipt, record);
  });
  return nativeSnapshotProof(await lockRef.get());
}
