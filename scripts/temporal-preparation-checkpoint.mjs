import { assertNativeSnapshot, nativeSnapshotProof, proofDigest } from './temporal-release-runtime.mjs';

/** Persist under the same native operation AND release authority snapshots. No
 * callback can authorize HTTP until this transaction has acknowledged completion.
 */
async function saveCheckpoint({ firestore, lockRef, controlRef, stateRef,
  immutableReceipt, creationReceipt, ownedOperation, expectedAuthority, config, operationId, bindingDigest, operatorPrincipal, identityState, kind }) {
  const [field, action] = { searchPromotion:['cloudSearchPromotion','promote-cloud-run-search'],controlsPromotion:['cloudControlsPromotion','promote-cloud-run-controls'], mediaCycle:['cloudMediaBootstrapCycle','bootstrap-stop-cloud-run-media'],mediaActivation:['cloudMediaActivation','activate-cloud-run-media-pool'],mediaAbort:['cloudMediaActivationStop','stop-cloud-run-media-activation'], imagesCycle:['cloudImagesBootstrapCycle','bootstrap-stop-cloud-run-images'],imagesActivation:['cloudImagesActivation','activate-cloud-run-images-pool'],imagesAbort:['cloudImagesActivationStop','stop-cloud-run-images-activation'], emailCycle:['cloudEmailBootstrapCycle','bootstrap-stop-cloud-run-email'],emailActivation:['cloudEmailActivation','activate-cloud-run-email-pool'],emailAbort:['cloudEmailActivationStop','stop-cloud-run-email-activation'], searchCycle:['cloudSearchBootstrapCycle','bootstrap-stop-cloud-run-search'],searchActivation:['cloudSearchActivation','activate-cloud-run-search-pool'],searchAbort:['cloudSearchActivationStop','stop-cloud-run-search-activation'], orchestrationCycle:['cloudOrchestrationBootstrapCycle','bootstrap-stop-cloud-run-orchestration'], orchestrationActivation:['cloudOrchestrationActivation','activate-cloud-run-orchestration-pool'], orchestrationAbort:['cloudOrchestrationActivationStop','stop-cloud-run-orchestration-activation'], poolActivation: ['cloudControlsActivation','activate-cloud-run-controls-pool'], poolAbort: ['cloudControlsActivationStop','stop-cloud-run-controls-activation'], bootstrapCycle: ['cloudPoolBootstrapCycle', 'bootstrap-stop-cloud-run-controls'], dispatchActivation: ['cloudDispatchActivation', 'activate-cloud-run-dispatch-service'], identity: ['cloudIdentityPreparation', 'prepare-cloud-run-identity'],
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
  const expectedPoolRole={searchPromotion:'search',controlsPromotion:'controls',mediaCycle:'media',mediaActivation:'media',mediaAbort:'media',imagesCycle:'images',imagesActivation:'images',imagesAbort:'images',emailCycle:'email',emailActivation:'email',emailAbort:'email',searchCycle:'search',searchActivation:'search',searchAbort:'search',bootstrapCycle:'controls',poolActivation:'controls',poolAbort:'controls',orchestrationCycle:'orchestration',orchestrationActivation:'orchestration',orchestrationAbort:'orchestration'}[kind];
  if(expectedPoolRole&&identityState.plan?.role!==expectedPoolRole)throw new Error('BOOTSTRAP_ROLE_CHANGED');
  await firestore.runTransaction(async tx => {
    const creationState = ['bootstrapCycle','poolActivation','orchestrationCycle','orchestrationActivation','searchCycle','searchActivation','emailCycle','emailActivation','imagesCycle','imagesActivation','mediaCycle','mediaActivation'].includes(kind) ? identityState.activationState : ['schedulerCycle', 'eventarcCycle'].includes(kind) ? identityState.creationState : undefined;
    if (['bootstrapCycle','poolActivation','orchestrationCycle','orchestrationActivation','searchCycle','searchActivation','emailCycle','emailActivation','imagesCycle','imagesActivation','mediaCycle','mediaActivation'].includes(kind) && (['started', 'stopping', 'completed'].includes(identityState.stage) && !creationState ||
      creationState && (creationState.stage !== 'completed' || creationState.plan?.operationId !== operationId || creationState.plan?.mode !== 'start' || creationState.plan?.target !== 1 ||
       proofDigest(creationState.plan.origin) !== proofDigest(identityState.plan?.origin) || proofDigest(creationState) !== proofDigest(identityState.start))))
      throw new Error('BOOTSTRAP_ACTIVATION_RECEIPT_REQUIRED');
    if(['poolActivation','orchestrationActivation','searchActivation','emailActivation','imagesActivation','mediaActivation'].includes(kind)&&identityState.stage==='completed'){
      const retained=identityState.retainedRegistration;
      if(identityState.disposition==='retained'?
        identityState.stop!==undefined||identityState.observation?.status!=='confirmed'||retained?.role!==expectedPoolRole||retained.buildId!==identityState.plan?.buildId||
          !/^[a-f0-9]{64}$/.test(retained.registrationSHA256??'')||!Number.isFinite(Date.parse(retained.observedAt??'')):
        identityState.disposition!=='stopped'||identityState.stop?.stage!=='completed')throw new Error('CONTROLS_ACTIVATION_OUTCOME_UNCONFIRMED');
    }
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
    if(['controlsPromotion','searchPromotion'].includes(kind)){
      const before=current.get(field), transitions={planned:['planned','attempted'],attempted:['attempted','acknowledged','completed','rejected'],acknowledged:['acknowledged','completed'],completed:['completed'],rejected:['rejected']};
      if(!before&&identityState.stage!=='planned'||before&&!(transitions[before.stage]??[]).includes(identityState.stage))throw new Error('CONTROLS_PROMOTION_STAGE_ROLLBACK');
      if(before&&before.stage!=='planned'&&['request','proof','resources','attemptedAt'].some(key=>proofDigest(before[key]??null)!==proofDigest(identityState[key]??null)))throw new Error('CONTROLS_PROMOTION_INTENT_CHANGED');
      if(before?.acknowledgement&&proofDigest(before.acknowledgement)!==proofDigest(identityState.acknowledgement??null)||before?.stage==='completed'&&proofDigest(before)!==proofDigest(identityState))throw new Error('CONTROLS_PROMOTION_RECEIPT_CHANGED');
    }
    if(kind==='pool'){
      const before=current.get(field);
      if(before){
        const transitions={planned:['planned','attempted'],attempted:['attempted','acknowledged'],acknowledged:['acknowledged','completed','failed'],completed:['completed'],failed:['failed']};
        if(!(transitions[before.stage]??[]).includes(identityState.stage))throw new Error('POOL_PREPARATION_STAGE_ROLLBACK');
        if(before.stage!=='planned'&&['prerequisites','isolation','attemptedAt'].some(key=>proofDigest(before[key]??null)!==proofDigest(identityState[key]??null)))throw new Error('POOL_PREPARATION_ORIGINAL_ATTEMPT_CHANGED');
        if(before.nativeOperation&&before.nativeOperation!==identityState.nativeOperation)throw new Error('POOL_PREPARATION_NATIVE_OPERATION_CHANGED');
        if(before.stage==='completed'&&proofDigest(before)!==proofDigest(identityState))throw new Error('POOL_PREPARATION_COMPLETED_CHANGED');
      }
    }
    if (kind === 'dispatchActivation' && Object.hasOwn(current.get(field) ?? {}, 'workerIntent') &&
      proofDigest(current.get(field).workerIntent) !== proofDigest(identityState.workerIntent ?? null))
      throw new Error('DISPATCH_ACTIVATION_PROBE_INTENT_CHANGED');
    if (kind === 'dispatchActivation' && current.get(field) && current.get(field).stage !== 'planned' &&
      ['proof', 'request', 'attemptedAt', 'prerequisites'].some(key =>
        proofDigest(current.get(field)[key] ?? null) !== proofDigest(identityState[key] ?? null)))
      throw new Error('DISPATCH_ACTIVATION_AUTHORIZATION_CHANGED');
    if (['bootstrapCycle','poolActivation','poolAbort','orchestrationCycle','orchestrationActivation','orchestrationAbort','searchCycle','searchActivation','searchAbort','emailCycle','emailActivation','emailAbort','imagesCycle','imagesActivation','imagesAbort','mediaCycle','mediaActivation','mediaAbort'].includes(kind)) {
      const previous=current.get(field);
      if(previous){
        for(const key of ['activationState','observation','retentionFailed','retainedRegistration']) if(Object.hasOwn(previous,key) &&
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

export const saveControlsActivationCheckpoint = options => saveCheckpoint({ ...options, kind: 'poolActivation' });
export const saveControlsActivationStopCheckpoint = options => saveCheckpoint({ ...options, kind: 'poolAbort' });

export const saveOrchestrationBootstrapCycleCheckpoint=options=>saveCheckpoint({...options,kind:'orchestrationCycle'});
export const saveOrchestrationActivationCheckpoint=options=>saveCheckpoint({...options,kind:'orchestrationActivation'});
export const saveOrchestrationActivationStopCheckpoint=options=>saveCheckpoint({...options,kind:'orchestrationAbort'});

export const saveSearchBootstrapCycleCheckpoint=options=>saveCheckpoint({...options,kind:'searchCycle'});
export const saveSearchActivationCheckpoint=options=>saveCheckpoint({...options,kind:'searchActivation'});
export const saveSearchActivationStopCheckpoint=options=>saveCheckpoint({...options,kind:'searchAbort'});

export const saveEmailBootstrapCycleCheckpoint=options=>saveCheckpoint({...options,kind:'emailCycle'});
export const saveEmailActivationCheckpoint=options=>saveCheckpoint({...options,kind:'emailActivation'});
export const saveEmailActivationStopCheckpoint=options=>saveCheckpoint({...options,kind:'emailAbort'});

export const saveImagesBootstrapCycleCheckpoint=options=>saveCheckpoint({...options,kind:'imagesCycle'});
export const saveImagesActivationCheckpoint=options=>saveCheckpoint({...options,kind:'imagesActivation'});
export const saveImagesActivationStopCheckpoint=options=>saveCheckpoint({...options,kind:'imagesAbort'});

/** Read-only same-operation authority fence immediately before pool-create HTTP.
 * This does not make Firestore and the Cloud API one atomic transaction.
 */
export async function assertPoolPreparationAuthority({firestore,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,config,operationId,bindingDigest}){
 await firestore.runTransaction(async tx=>{
  const [operation,control,state]=await Promise.all([tx.get(lockRef),tx.get(controlRef),tx.get(stateRef)]);
  assertNativeSnapshot(ownedOperation,operation);assertNativeSnapshot(expectedAuthority.control,control);assertNativeSnapshot(expectedAuthority.state,state);
  if(operation.get('action')!=='prepare-cloud-run-pool'||operation.get('operationId')!==operationId||operation.get('releaseId')!==config.releaseId||operation.get('bindingDigest')!==bindingDigest||
   control.get('releaseId')!==config.releaseId||state.get('releaseId')!==config.releaseId||control.get('admission')!=='paused'||state.get('phase')!=='provider-usage-ready'||config.domains.some(domain=>control.get(`domains.${domain}.admission`)!=='paused'))throw new Error('POOL_PREPARATION_AUTHORITY_CHANGED');
 },{readOnly:true});
}

export const saveMediaBootstrapCycleCheckpoint=options=>saveCheckpoint({...options,kind:'mediaCycle'});
export const saveMediaActivationCheckpoint=options=>saveCheckpoint({...options,kind:'mediaActivation'});
export const saveMediaActivationStopCheckpoint=options=>saveCheckpoint({...options,kind:'mediaAbort'});

export const saveControlsPromotionCheckpoint=options=>saveCheckpoint({...options,kind:'controlsPromotion'});
async function assertPromotionAuthority({firestore,lockRef,controlRef,stateRef,ownedOperation,expectedAuthority,config,operationId,bindingDigest},role){
 await firestore.runTransaction(async tx=>{
  const [operation,control,state]=await Promise.all([tx.get(lockRef),tx.get(controlRef),tx.get(stateRef)]);
  assertNativeSnapshot(ownedOperation,operation);assertNativeSnapshot(expectedAuthority.control,control);assertNativeSnapshot(expectedAuthority.state,state);
  if(operation.get('action')!==`promote-cloud-run-${role}`||operation.get('operationId')!==operationId||operation.get('releaseId')!==config.releaseId||operation.get('bindingDigest')!==bindingDigest||control.get('releaseId')!==config.releaseId||state.get('releaseId')!==config.releaseId||control.get('admission')!=='paused'||state.get('phase')!=='provider-usage-ready'||config.domains.some(domain=>control.get(`domains.${domain}.admission`)!=='paused'))throw new Error('CONTROLS_PROMOTION_AUTHORITY_CHANGED');
 },{readOnly:true});
}

export const assertControlsPromotionAuthority=o=>assertPromotionAuthority(o,'controls');
export const assertSearchPromotionAuthority=o=>assertPromotionAuthority(o,'search');
export const saveSearchPromotionCheckpoint=o=>saveCheckpoint({...o,kind:'searchPromotion'});
