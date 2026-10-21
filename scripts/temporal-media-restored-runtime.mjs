import { readRestoredMediaActivationOrigin } from './temporal-release-cloud-run.mjs';
const unavailable = async () => {
  throw new Error('RESTORED_MEDIA_NORMAL_RUNTIME_UNAVAILABLE');
};
/** Fixed source adapters. The zero-only historical origin is connected, while
 * distinct normal kernel/startup and phase collectors still deny. No descriptor
 * or receipt can enable this lifecycle until those native guards exist. */
export function restoredMediaActivationRuntime(o) {
  return Object.freeze({
    assertSupported: unavailable,
    readOrigin: () => {
      const options = o.options(),
        { recovery: _recovery, ...receipts } = options.receipts;
      return readRestoredMediaActivationOrigin({ ...options, receipts });
    },
    readPool: unavailable,
    phase: unavailable,
    quota: unavailable,
    registration: unavailable,
    unused: unavailable,
  });
}
