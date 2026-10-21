import {startCloudRunMediaRecovery,collectCloudRunMediaRecovery} from './temporal-release-cloud-run.mjs';
import { prepareMediaRecoveryJournal } from './temporal-media-recovery-checkpoint.mjs';
/** Canonical boundary, deliberately unavailable until the real image protocol,
 * fixed diagnostic queues, native original-run recovery and authoritative drain
 * are implemented. Local/controlled adapters cannot be selected by a CLI flag.
 * Deny BEFORE cycle checkpoint or native mutation, including preparation at zero.
 */
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
 * Canonical preflight remains denied pending native drain/restored-origin consumers. */
export function mediaRecoveryExecution(o){
 return async scope=>{
   const result=await startCloudRunMediaRecovery({...o.options(),...scope,onOwnedOperation:o.setOwnedOperation});
   o.setOwnedOperation(result.ownedOperation);
   return collectCloudRunMediaRecovery({...o.options(),...scope,start:result.start});
 };
}
