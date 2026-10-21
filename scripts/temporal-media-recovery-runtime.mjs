import {observeMediaRecoveryPhasePool} from './temporal-media-recovery-phase-pool.mjs';
import {startCloudRunMediaRecovery,collectCloudRunMediaRecovery,drainCloudRunMediaRecovery,confirmCloudRunMediaRecoveryStopped,confirmCloudRunMediaRecoveryNeverStarted,protectCloudRunMediaRecovery} from './temporal-release-cloud-run.mjs';
import { prepareMediaRecoveryJournal } from './temporal-media-recovery-checkpoint.mjs';
/** Canonical preflight stays unavailable. Source preparation, episode and drain
 * adapters are connected below; native platform acceptance,
 * explicit restored-origin normal activation and actual platform proof remain.
 * Local/controlled adapters cannot be selected by a CLI flag. Deny BEFORE any
 * cycle checkpoint or native mutation, including preparation at zero. */
const unavailable = async () => {
  throw new Error('CLOUD_RUN_MEDIA_DIAGNOSTIC_RUNTIME_UNAVAILABLE');
};
export const canonicalMediaRecoveryRuntime = Object.freeze({
  assertSupported: unavailable,
  observeProtection: unavailable,
  prepare: unavailable,
  execute: unavailable,
  drain: unavailable,
  confirmStopped: unavailable,
  confirmNeverStarted: unavailable,
});

/** The actual canonical prepare stage uses the native private journal. Preflight
 * remains fixed-deny, so this cannot yet arm a live diagnostic through the CLI. */
export function mediaRecoveryPreparation(o) {
  return async ({ plan }) => {
    const result = await prepareMediaRecoveryJournal({ ...o.options(), plan });
    o.setOwnedOperation(result.ownedOperation);
    return result.prepared;
  };
}

/** Source execution joins the original START and historical same-image episode.
 * Canonical preflight remains denied pending the remaining operational guards. */
export function mediaRecoveryExecution(o){
 return async scope=>{
   const result=await startCloudRunMediaRecovery({...o.options(),...scope,onOwnedOperation:o.setOwnedOperation});
   o.setOwnedOperation(result.ownedOperation);
   return collectCloudRunMediaRecovery({...o.options(),...scope,start:result.start});
 };
}

/** Separate immutable-checkpoint drain result; canonical preflight stays denied. */
export const mediaRecoveryDrainage=o=>scope=>drainCloudRunMediaRecovery({...o.options(),...scope});

export const mediaRecoveryStoppedConfirmation=o=>scope=>confirmCloudRunMediaRecoveryStopped({...o.options(),...scope});
export const mediaRecoveryNeverStartedConfirmation=o=>scope=>confirmCloudRunMediaRecoveryNeverStarted({...o.options(),...scope});

/** A real native resource sub-fence, not complete mutation protection. The
 * source-fixed namespace/poller/own-startup policy follows below. This cannot
 * enable canonical preflight or replace native platform acceptance. */
export const mediaRecoveryProtection=o=>async scope=>{
 const options=o.options();
 const phasePool=await observeMediaRecoveryPhasePool({...options,...scope});
 return protectCloudRunMediaRecovery({...options,...scope,phasePool});
};
