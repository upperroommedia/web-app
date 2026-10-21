import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readRestoredMediaPromotionInput,
  confirmRestoredMediaActivationCapsule,
} from './temporal-restored-media-capsule.mjs';
for (const [name, read] of [
  ['new-parent sealed input', readRestoredMediaPromotionInput],
  ['same-parent retained confirmation', confirmRestoredMediaActivationCapsule],
]) {
  test(name + ' rejects a stalled native transaction', async () => {
    await assert.rejects(
      read({ firestore: { runTransaction: () => new Promise(() => {}) } }),
      /RESTORED_MEDIA_PROVENANCE_CAPSULE_UNCONFIRMED/
    );
  });
  test(name + ' rejects native settlement after the original wall/monotonic deadline', async () => {
    await assert.rejects(
      read({
        firestore: {
          runTransaction: async () => {
            const end = performance.now() + 5100;
            while (performance.now() < end) {}
            return { notAProof: true };
          },
        },
      }),
      /RESTORED_MEDIA_PROVENANCE_CAPSULE_UNCONFIRMED/
    );
  });
}
