import {
  readRestoredMediaActivationPool,
  readRestoredMediaActivationQuota,
} from './temporal-restored-media-resources.mjs';
import {
  readRestoredMediaActivationOrigin,
  readRestoredMediaStartupWitness,
  readRestoredMediaRegistration,
} from './temporal-release-cloud-run.mjs';
const unavailable = async () => {
  throw new Error('RESTORED_MEDIA_NORMAL_RUNTIME_UNAVAILABLE');
};
/** Read-only origin/pool/quota/startup and retained registration are connected.
 * Phase/unused-work collectors and canonical execution preflight still deny.
 * No descriptor or receipt enables the canonical preflight. */
export function restoredMediaActivationRuntime(o) {
  return Object.freeze({
    assertSupported: unavailable,
    readOrigin: () => {
      const options = o.options(),
        { recovery: _recovery, ...receipts } = options.receipts;
      return readRestoredMediaActivationOrigin({ ...options, receipts, observeProtection: unavailable });
    },
    readPool: (scope) => readRestoredMediaActivationPool({ ...o.options(), ...scope }),
    readStartup: (scope) => readRestoredMediaStartupWitness({ ...o.options(), ...scope }),
    phase: unavailable,
    quota: (scope) => readRestoredMediaActivationQuota({ ...o.options(), ...scope }),
    registration: (scope) => readRestoredMediaRegistration({ ...o.options(), ...scope }),
    unused: unavailable,
  });
}
