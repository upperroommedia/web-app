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
