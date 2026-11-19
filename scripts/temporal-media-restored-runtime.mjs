import {
  readRestoredMediaActivationPool,
  readRestoredMediaActivationQuota,
} from './temporal-restored-media-resources.mjs';
import {
  assertCloudRunRestoredMediaSupported,
  readRestoredMediaActivationOrigin,
  readRestoredMediaStartupWitness,
  readRestoredMediaRegistration,
  readRestoredMediaPhaseProtection,
  readRestoredMediaUnused,
} from './temporal-release-cloud-run.mjs';
/** Guard the restored normal lifecycle with the source-owned completed recovery and paused release. */
export function restoredMediaActivationRuntime(o) {
  return Object.freeze({
    assertSupported: async () => {
      try {
        await assertCloudRunRestoredMediaSupported(o.options());
      } catch (error) {
        throw new Error('RESTORED_MEDIA_NORMAL_RUNTIME_UNAVAILABLE', { cause: error });
      }
    },
    readOrigin: () => {
      const options = o.options(),
        { recovery: _recovery, ...receipts } = options.receipts;
      return readRestoredMediaActivationOrigin({ ...options, receipts });
    },
    readPool: (scope) => readRestoredMediaActivationPool({ ...o.options(), ...scope }),
    readStartup: (scope) => readRestoredMediaStartupWitness({ ...o.options(), ...scope }),
    phase: (scope) => readRestoredMediaPhaseProtection({ ...o.options(), ...scope }),
    quota: (scope) => readRestoredMediaActivationQuota({ ...o.options(), ...scope }),
    registration: (scope) => readRestoredMediaRegistration({ ...o.options(), ...scope }),
    unused: (scope) => readRestoredMediaUnused({ ...o.options(), ...scope }),
  });
}
