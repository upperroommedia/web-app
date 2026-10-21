import test from 'node:test';
import assert from 'node:assert/strict';
import { readMediaPromotionRetainedResources } from './temporal-media-promotion-evidence.mjs';
import { runCloudRunMediaPromotion } from './temporal-release-cloud-run.mjs';
test('promotion retained input cannot wait past a stalled native authority read', async () => {
  await assert.rejects(
    readMediaPromotionRetainedResources({ firestore: { runTransaction: () => new Promise(() => {}) } }),
    /MEDIA_PROMOTION_RETAINED_EVIDENCE_UNCONFIRMED/
  );
});
test('late native authority settlement cannot escape the original wall and monotonic bound', async () => {
  const options = {
    firestore: {
      runTransaction: () => {
        const end = performance.now() + 5100;
        while (performance.now() < end) {}
        return Promise.resolve({});
      },
    },
  };
  await assert.rejects(readMediaPromotionRetainedResources(options), /MEDIA_PROMOTION_RETAINED_EVIDENCE_UNCONFIRMED/);
});
test('retained evidence never removes unconditional media promotion denial', async () => {
  let reads = 0;
  const options = new Proxy(
    {},
    {
      get() {
        reads++;
        throw Error('Unexpected read');
      },
    }
  );
  await assert.rejects(runCloudRunMediaPromotion(options), /CLOUD_RUN_MEDIA_NATIVE_CAPACITY_PROOF_REQUIRED/);
  assert.equal(reads, 0);
});
