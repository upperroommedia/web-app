import { assertNativeSnapshot, nativeSnapshotProof, proofDigest } from './temporal-release-runtime.mjs';

/** Persist under the same native operation AND release authority snapshots. No
 * callback can authorize HTTP until this transaction has acknowledged completion.
 */
async function saveCheckpoint({ firestore, lockRef, controlRef, stateRef,
  immutableReceipt, creationReceipt, ownedOperation, expectedAuthority, config, operationId, bindingDigest, operatorPrincipal, identityState, kind }) {
  const [field, action] = { bootstrapCycle: ['cloudPoolBootstrapCycle', 'bootstrap-stop-cloud-run-controls'], dispatchActivation: ['cloudDispatchActivation', 'activate-cloud-run-dispatch-service'], identity: ['cloudIdentityPreparation', 'prepare-cloud-run-identity'],
    eventarcCycle: ['cloudDispatchEventarcCycle', 'prepare-stop-cloud-run-dispatch-eventarc'],
    schedulerCycle: ['cloudDispatchSchedulerCycle', 'prepare-stop-cloud-run-dispatch-scheduler'],
    eventarcAudit: ['cloudEventarcAuditPreparation', 'prepare-cloud-run-eventarc-audit'],
    wakeStop: ['cloudDispatchWakeStop', 'stop-cloud-run-dispatch-wake'],
    dispatchAccess: ['cloudDispatchAccessPreparation', 'prepare-cloud-run-dispatch-access'],
    service: ['cloudDispatchServicePreparation', 'prepare-cloud-run-dispatch-service'],
    pool: ['cloudPoolPreparation', 'prepare-cloud-run-pool'], secret: ['cloudSecretAccessPreparation', 'prepare-cloud-run-secret-access'],
    runtimeAccess: ['cloudRuntimeAccessPreparation', 'prepare-cloud-run-runtime-access'],
    runtimeRole: ['cloudRuntimeRolePreparation', 'prepare-cloud-run-runtime-role'],
    firestore: ['cloudFirestoreAccessPreparation', 'prepare-cloud-run-firestore-access'],
    scaler: ['cloudScalerAccessPreparation', 'prepare-cloud-run-scaler-access'] }[kind] ?? [];
  if (!field) throw new Error('PREPARATION_KIND_REQUIRED');
  await firestore.runTransaction(async tx => {
    const creationState = kind === 'bootstrapCycle' ? identityState.activationState : ['schedulerCycle', 'eventarcCycle'].includes(kind) ? identityState.creationState : undefined;
    if (kind === 'bootstrapCycle' && (['started', 'stopping', 'completed'].includes(identityState.stage) && !creationState ||
      creationState && (creationState.stage !== 'completed' || creationState.plan?.operationId !== operationId || creationState.plan?.mode !== 'start' || creationState.plan?.target !== 1 ||
       proofDigest(creationState.plan.origin) !== proofDigest(identityState.plan?.origin) || proofDigest(creationState) !== proofDigest(identityState.start))))
      throw new Error('BOOTSTRAP_ACTIVATION_RECEIPT_REQUIRED');
    if (['schedulerCycle', 'eventarcCycle'].includes(kind) && (['created', 'stopping', 'completed'].includes(identityState.stage) && !creationState ||
      creationState && (creationState.plan?.operationId !== operationId || proofDigest(creationState.plan) !== proofDigest(identityState.plan?.creation))))
      throw new Error('SCHEDULER_CREATION_PLAN_CHANGED');
    if (creationState && (!creationReceipt || creationState.stage !== 'completed')) throw new Error('SCHEDULER_CREATION_RECEIPT_REQUIRED');
    const [current, control, state, receipt, originalCreation] = await Promise.all([
      tx.get(lockRef), tx.get(controlRef), tx.get(stateRef),
      identityState.stage === 'completed' ? tx.get(immutableReceipt) : Promise.resolve(undefined),
      creationState ? tx.get(creationReceipt) : Promise.resolve(undefined),
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
    if (kind === 'dispatchActivation' && Object.hasOwn(current.get(field) ?? {}, 'workerIntent') &&
      proofDigest(current.get(field).workerIntent) !== proofDigest(identityState.workerIntent ?? null))
      throw new Error('DISPATCH_ACTIVATION_PROBE_INTENT_CHANGED');
    if (kind === 'dispatchActivation' && current.get(field) && current.get(field).stage !== 'planned' &&
      ['proof', 'request', 'attemptedAt', 'prerequisites'].some(key =>
        proofDigest(current.get(field)[key] ?? null) !== proofDigest(identityState[key] ?? null)))
      throw new Error('DISPATCH_ACTIVATION_AUTHORIZATION_CHANGED');
    if (kind === 'bootstrapCycle') {
      const previous=current.get(field);
      if(previous){
        for(const key of ['activationState','observation']) if(Object.hasOwn(previous,key) &&
          proofDigest(previous[key])!==proofDigest(identityState[key]??null)) throw new Error('BOOTSTRAP_ORIGINAL_OBSERVATION_CHANGED');
        for(const key of ['start','stop']) {
          const before=previous[key],after=identityState[key];
          if(before && !({planned:['planned','attempted'],attempted:['attempted','acknowledged','completed','rejected'],acknowledged:['acknowledged','completed','failed'],completed:['completed'],rejected:['rejected'],failed:['failed']}[before.stage]??[]).includes(after?.stage)) throw new Error('BOOTSTRAP_SCALE_STAGE_ROLLBACK');
          if(before && (!after || proofDigest(before.plan)!==proofDigest(after.plan))) throw new Error('BOOTSTRAP_SCALE_PLAN_CHANGED');
          if(before && before.stage!=='planned' && ['request','attemptedAt','before','access','protection'].some(name=>
            proofDigest(before[name]??null)!==proofDigest(after?.[name]??null))) throw new Error('BOOTSTRAP_SCALE_AUTHORIZATION_CHANGED');
          if(before?.stage==='completed' && proofDigest(before)!==proofDigest(after)) throw new Error('BOOTSTRAP_SCALE_RECEIPT_CHANGED');
          if(before?.nativeOperation && before.nativeOperation!==after?.nativeOperation) throw new Error('BOOTSTRAP_NATIVE_OPERATION_CHANGED');
        }
      }
    }
    const record = { operationId, releaseId: config.releaseId, bindingDigest, identityState, operatorPrincipal };
    if (receipt?.exists && proofDigest(receipt.data()) !== proofDigest(record))
      throw new Error('IDENTITY_PREPARATION_RECEIPT_CHANGED');
    const creationRecord = creationState ? { operationId, releaseId: config.releaseId, bindingDigest, identityState: creationState, operatorPrincipal } : undefined;
    if (originalCreation?.exists && proofDigest(originalCreation.data()) !== proofDigest(creationRecord))
      throw new Error('SCHEDULER_CREATION_RECEIPT_CHANGED');
    tx.update(lockRef, { [field]: identityState });
    if (originalCreation && !originalCreation.exists) tx.create(creationReceipt, creationRecord);
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

export const saveDispatchWakeStopCheckpoint = options => saveCheckpoint({ ...options, kind: 'wakeStop' });

export const saveEventarcAuditPreparationCheckpoint = options => saveCheckpoint({ ...options, kind: 'eventarcAudit' });

export const saveDispatchSchedulerCycleCheckpoint = options => saveCheckpoint({ ...options, kind: 'schedulerCycle' });

export const saveDispatchEventarcCycleCheckpoint = options => saveCheckpoint({ ...options, kind: 'eventarcCycle' });

export const saveDispatchActivationCheckpoint = options => saveCheckpoint({ ...options, kind: 'dispatchActivation' });

export const savePoolBootstrapCycleCheckpoint = options => saveCheckpoint({ ...options, kind: 'bootstrapCycle' });
