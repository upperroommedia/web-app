import {
  readRestoredMediaActivationPool,
  readRestoredMediaActivationQuota,
} from './temporal-restored-media-resources.mjs';
import { readRestoredMediaActivationOrigin, readRestoredMediaStartupWitness } from './temporal-release-cloud-run.mjs';
const unavailable = async () => {
  throw new Error('RESTORED_MEDIA_NORMAL_RUNTIME_UNAVAILABLE');
};
/** Read-only origin/pool/quota adapters are connected. Separate source-owned
 * namespace/phase, startup registration and unused-work collectors still deny.
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
    registration: unavailable,
    unused: unavailable,
  });
}
