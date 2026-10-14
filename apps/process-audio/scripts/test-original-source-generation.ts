import assert from 'node:assert/strict';
import { Storage } from '@google-cloud/storage';
import { pinOriginalLegacySourceBucket } from '../src/legacyMediaHttp';
const bucket = new Storage({ projectId: 'unit-only' }).bucket('owned-bucket');
const source = {
  kind: 'storage' as const,
  bucket: 'owned-bucket',
  path: 'sermons/original',
  generation: '1791910673197923',
  timeCreated: '2026-10-13T00:00:00.000000000Z',
};
const pinned = pinOriginalLegacySourceBucket(bucket, source);
assert.equal(String(pinned.file(source.path).generation), source.generation);
assert.equal(pinned.file('processed-sermons/original').generation, undefined);
assert.throws(() => pinned.file(source.path, { generation: '999' }));
assert.throws(() => pinOriginalLegacySourceBucket(bucket, { ...source, bucket: 'foreign' }));
assert.throws(() => pinOriginalLegacySourceBucket(bucket, { ...source, generation: '*' }));
assert.throws(() => pinOriginalLegacySourceBucket(bucket, { ...source, generation: '9007199254740993' }));
assert.equal(
  pinOriginalLegacySourceBucket(bucket, { kind: 'youtube', url: 'https://www.youtube.com/watch?v=owned' }),
  bucket
);
console.log(
  'Original source generation: actual SDK file selector pinned, unrelated paths preserved, changes/foreign buckets rejected.'
);

// Reprocessing uses the same processed path as its output. Only source access is
// pinned; the ordinary output bucket must observe the newly produced object.
const replacementSource = { ...source, path: 'processed-sermons/original' };
const sourceAccess = pinOriginalLegacySourceBucket(bucket, replacementSource);
assert.equal(String(sourceAccess.file(replacementSource.path).generation), source.generation);
assert.equal(bucket.file(replacementSource.path).generation, undefined);
