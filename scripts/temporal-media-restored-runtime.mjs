import {
  readRestoredMediaActivationPool,
  readRestoredMediaActivationQuota,
} from './temporal-restored-media-resources.mjs';
import {
  readRestoredMediaActivationOrigin,
  readRestoredMediaStartupWitness,
  readRestoredMediaRegistration,
  readRestoredMediaPhaseProtection,
  readRestoredMediaUnused,
} from './temporal-release-cloud-run.mjs';
const unavailable = async () => {
  throw new Error('RESTORED_MEDIA_NORMAL_RUNTIME_UNAVAILABLE');
};
/** Source-owned origin, resources, startup, registration and phase/unused
 * readers are connected. The canonical execution preflight still denies.
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
    phase: (scope) => readRestoredMediaPhaseProtection({ ...o.options(), ...scope }),
    quota: (scope) => readRestoredMediaActivationQuota({ ...o.options(), ...scope }),
    registration: (scope) => readRestoredMediaRegistration({ ...o.options(), ...scope }),
    unused: (scope) => readRestoredMediaUnused({ ...o.options(), ...scope }),
  });
}
