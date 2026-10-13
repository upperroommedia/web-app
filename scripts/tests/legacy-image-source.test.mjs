import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePinnedImageSource } from '../lib/legacy-image-source.mjs';
const image = {
  downloadLink: 'https://firebasestorage.googleapis.com/v0/b/images/o/speaker-images%2Fone.png?token=known',
  dateAddedMillis: Date.parse('2026-01-02T00:00:00Z'),
};
const metadata = {
  generation: '42',
  contentType: 'image/png',
  timeCreated: '2026-01-01T00:00:00Z',
  metadata: { firebaseStorageDownloadTokens: 'other,known' },
};
test('pins original generation belonging to the canonical download link', () => {
  assert.deepEqual(derivePinnedImageSource(image, metadata, 'images'), {
    bucket: 'images',
    path: 'speaker-images/one.png',
    generation: '42',
    contentType: 'image/png',
  });
});
test('refuses a replacement object created after canonical publication', () => {
  assert.throws(
    () => derivePinnedImageSource(image, { ...metadata, timeCreated: '2026-01-03T00:00:00Z' }, 'images'),
    /replaced_after/
  );
});
test('refuses replaced download tokens and foreign buckets', () => {
  assert.throws(
    () => derivePinnedImageSource(image, { ...metadata, metadata: { firebaseStorageDownloadTokens: 'new' } }, 'images'),
    /token_no_longer_matches/
  );
  assert.throws(() => derivePinnedImageSource(image, metadata, 'other-images'), /canonical_image_storage_source/);
});
test('refuses unavailable publication timestamps instead of guessing identity', () => {
  assert.throws(
    () => derivePinnedImageSource({ ...image, dateAddedMillis: undefined }, metadata, 'images'),
    /replaced_after/
  );
});
