import {assertCloudRunMediaRecoverySupported,startCloudRunMediaRecovery,collectCloudRunMediaRecovery,drainCloudRunMediaRecovery,drainCloudRunMediaRecoveryJob,confirmCloudRunMediaRecoveryNeverStarted,readCloudRunMediaRecoveryStopEvents,protectCloudRunMediaRecovery} from './temporal-release-cloud-run.mjs';
import { prepareMediaRecoveryJournal, readMediaRecoveryJobJournal, saveMediaRecoveryJobJournal } from './temporal-media-recovery-checkpoint.mjs';
import { advanceMediaRecoveryJob, assertMediaRecoveryJobAccess } from './temporal-media-recovery-job.mjs';
import { attestMediaRecoveryTask } from './temporal-media-recovery-task-attestation.mjs';
/** The unsupported legacy diagnostic has no provider record for its original instance exit. */
const unavailable = async () => {
  throw new Error('CLOUD_RUN_MEDIA_DIAGNOSTIC_RUNTIME_UNAVAILABLE');
};
export const canonicalMediaRecoveryRuntime = Object.freeze({
  assertSupported: unavailable,
  observeProtection: unavailable,
  prepare: unavailable,
  execute: unavailable,
  drain: unavailable,
  confirmStopped: async () => {
    throw new Error('MEDIA_RECOVERY_EXACT_INSTANCE_EXIT_UNCONFIRMED');
  },
  confirmNeverStarted: unavailable,
});

export const mediaRecoveryJobPreflight = o => () =>
  assertCloudRunMediaRecoverySupported({ ...o.options(), requireTaskAttestation: o.requireTaskAttestation });

/** Job producer uses the paused release's durable provider journal. The
 * controller must supply the fresh isolation/normal-pool fence before send. */
export function mediaRecoveryJobLauncher(o) {
  return async ({ plan, protect, checkNormalZero }) => {
    if (typeof protect !== 'function' || typeof checkNormalZero !== 'function')
      throw new Error('MEDIA_RECOVERY_JOB_PROTECTION_REQUIRED');
    let saved = await readMediaRecoveryJobJournal({ ...o.options(), plan });
    // Children may already be polling after this receipt. The empty-queue
    // launch fence applies only to the original provider mutations.
    if (saved?.runIdentity) {
      await assertMediaRecoveryJobAccess({
        api: o.options().api,
        plan,
        access: saved.access,
        jobUid: saved.runIdentity.jobUid,
      });
      await readMediaRecoveryJobJournal({ ...o.options(), plan });
    } else saved = await advanceMediaRecoveryJob({
      api: o.options().api, plan, saved,
      observeAcknowledgedRun: plan.taskAttestationPublicKey
        ? () => Promise.all([checkNormalZero(), readMediaRecoveryJobJournal({ ...o.options(), plan })])
        : undefined,
      fence: async () => {
        await protect();
        await readMediaRecoveryJobJournal({ ...o.options(), plan });
      },
      save: async next => {
        const owned = await saveMediaRecoveryJobJournal({ ...o.options(), plan }, saved, next);
        o.setOwnedOperation(owned);
        saved = next;
      },
    });
    if (plan.taskAttestationPublicKey) {
      await checkNormalZero();
      await attestMediaRecoveryTask({ directory: o.attestationDirectory, o: o.options(),
        plan, provider: saved, setOwnedOperation: o.setOwnedOperation });
      await checkNormalZero();
    }
    return saved;
  };
}

/** Private Journal preparation is fenced by the owned release. */
export function mediaRecoveryPreparation(o) {
  return async ({ plan }) => {
    const result = await prepareMediaRecoveryJournal({ ...o.options(), plan });
    o.setOwnedOperation(result.ownedOperation);
    return result.prepared;
  };
}

/** Join the original START and the historical same-image episode. */
export function mediaRecoveryExecution(o){
 return async scope=>{
   const result=await startCloudRunMediaRecovery({...o.options(),...scope,observeConfirmedFailure:true,onOwnedOperation:o.setOwnedOperation});
   o.setOwnedOperation(result.ownedOperation);
   if (result.terminalFailure) {
     const { operationId, bindingDigest, buildId, image } = scope.plan;
     return { kind: 'recovery-failed', operationId, bindingDigest, buildId, image, proofSHA256: result.terminalFailure };
   }
   return collectCloudRunMediaRecovery({...o.options(),...scope,start:result.start});
 };
}

/** Confirm a separate private queue drain before the immutable completion. */
export const mediaRecoveryJobDrainage=o=>scope=>drainCloudRunMediaRecoveryJob({...o.options(),...scope});

export const mediaRecoveryDrainage=o=>scope=>drainCloudRunMediaRecovery({...o.options(),...scope});

export const mediaRecoveryNeverStartedConfirmation=o=>scope=>confirmCloudRunMediaRecoveryNeverStarted({...o.options(),...scope});

export const mediaRecoveryStoppedConfirmation = (o) => async (scope) => {
  const code = 'MEDIA_RECOVERY_EXACT_INSTANCE_EXIT_UNCONFIRMED';
  try {
    const observed = await readCloudRunMediaRecoveryStopEvents({ ...o.options(), ...scope });
    console.log(
      'Revision instance count samples: ' + observed.revisionSamples +
      ', zero samples after the stop attempt: ' + observed.zeroSamplesAfterStopAttempt + '.'
    );
    console.log(`Original instance stop log observation ${observed.observationSHA256}. ${observed.entries} entries, ${observed.lifecycleEntries} with lifecycle wording.`);
  } catch (cause) {
    throw new Error(code, { cause });
  }
  throw new Error(code);
};


/** Re-read the native pool and namespace before the provider operation. */
export const mediaRecoveryProtection = o => scope => protectCloudRunMediaRecovery({ ...o.options(), ...scope });
