import { assertSandboxAssetPreparation } from './store';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
const profile = {
  schemaVersion: 1 as const,
  projectId: 'urm-app-staging' as const,
  mode: 'sandbox' as const,
  profileId: 'urm-app-staging-publishing-v1' as const,
  version: 1 as const,
  namespace: 'urm-app-staging-publishing-v1' as const,
};
let payload = Buffer.from('actual stage media bytes'),
  generation = '100',
  contentType = 'audio/wav',
  written = Buffer.alloc(0);
let requestedGeneration: string | undefined;
const privateObjects = new Map<string, { bytes: Buffer; metadata: any }>();
const context = { jobId: 'job', sourceStepIds: ['copy'] };
const fakeFile = (bucket: string, path: string, options?: { generation: string }) => {
  requestedGeneration = options?.generation;
  const owned = /^_providerSandbox\/[^/]+\/(media|allocations)\//.test(path);
  const bytes = () => privateObjects.get(path)?.bytes ?? payload;
  return {
    bucket: { name: bucket },
    name: path,
    getMetadata: async () => {
      if (owned && !privateObjects.has(path)) throw Object.assign(new Error('not found'), { code: 404 });
      return [privateObjects.get(path)?.metadata ?? { size: String(payload.length), generation, contentType }];
    },
    createReadStream: (options?: any) =>
      Readable.from([options?.end !== undefined ? bytes().subarray(options.start ?? 0, options.end + 1) : bytes()]),
    download: async (options: any) => [bytes().subarray(options.start, options.end + 1)],
    createWriteStream: (options: any) => {
      expect(options.preconditionOpts.ifGenerationMatch).toBe(0);
      expect(options.metadata.metadata.preparationId).toBe('a'.repeat(64));
      expect(options.metadata.metadata.sandboxProfileId).toBe(profile.profileId);
      let copy = Buffer.alloc(0);
      return new Writable({
        write(chunk, _enc, done) {
          written = Buffer.concat([written, chunk]);
          copy = Buffer.concat([copy, chunk]);
          done();
        },
        final(done) {
          privateObjects.set(path, {
            bytes: copy,
            metadata: { size: String(copy.length), generation: '200', ...options.metadata },
          });
          done();
        },
      });
    },
  };
};
jest.mock(
  '@upperroom/shared/firebase/firebaseAdmin',
  () => ({
    __esModule: true,
    default: {
      storage: () => ({
        bucket: (bucket: string) => ({
          file: (path: string, options?: { generation: string }) => fakeFile(bucket, path, options),
        }),
      }),
    },
  }),
  { virtual: true }
);
jest.mock('./store', () => ({
  assertSandboxAssetPreparation: jest.fn(async () => undefined),
  beginSandboxAssetPreparation: jest.fn(async () => ({ id: 'a'.repeat(64) })),
  completeSandboxAssetPreparation: jest.fn(async () => undefined),
  markSandboxAssetPreparationUncertain: jest.fn(async () => undefined),
  sandboxRoot: () => ({ get: async () => ({ get: () => undefined }) }),
}));
import {
  validateStageAssetRef,
  resolveStageAsset,
  inspectStageAsset,
  probeStageAsset,
  writeSandboxAllocation,
  copyStageAssetToSandbox,
  inspectReviewedSandboxWav,
} from './assets';
const asset = { bucket: 'urm-app-staging.firebasestorage.app', path: 'audio/test.wav', generation: '100' };
beforeEach(() => {
  payload = Buffer.from('actual stage media bytes');
  generation = '100';
  contentType = 'audio/wav';
  written = Buffer.alloc(0);
  privateObjects.clear();
});
it.each([
  { ...asset, bucket: 'urm-app.firebasestorage.app' },
  { ...asset, path: '../prod' },
  { ...asset, path: '/absolute' },
  { ...asset, path: 'audio//test' },
  { ...asset, generation: 'latest' },
  { ...asset, path: 'audio/\u0000.wav' },
])('rejects unpinned/cross-project/traversal asset %p', (ref) => expect(() => validateStageAssetRef(ref)).toThrow());
it('resolves staging Storage URLs without reading external HTTP or trusting URL tokens', async () => {
  expect(
    await resolveStageAsset(
      profile,
      'https://firebasestorage.googleapis.com/v0/b/urm-app-staging.firebasestorage.app/o/audio%2Ftest.wav?alt=media&token=secret&generation=100'
    )
  ).toEqual(asset);
  expect(requestedGeneration).toBe('100');
  await expect(
    resolveStageAsset(profile, 'https://storage.googleapis.com.evil.test/urm-app-staging.firebasestorage.app/a')
  ).rejects.toThrow('External');
});
it('hashes actual bytes from the exact generation, enforcing total bounds', async () => {
  const evidence = await inspectStageAsset(profile, asset, 1024);
  expect(evidence.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
  expect(evidence.size).toBe(payload.length);
  expect(requestedGeneration).toBe('100');
  await expect(inspectStageAsset(profile, asset, 1)).rejects.toThrow('size');
  generation = '101';
  await expect(inspectStageAsset(profile, asset)).rejects.toThrow('generation');
});
it('probes a bounded prefix of the actual object and rejects oversized probes', async () => {
  const proof = await probeStageAsset(profile, asset, 4);
  expect(proof.size).toBe(payload.length);
  expect(proof.sha256).toBe(createHash('sha256').update(payload.subarray(0, 4)).digest('hex'));
  await expect(probeStageAsset(profile, asset, 1025)).rejects.toThrow('bounded');
});
it('streams private allocation bytes with create-only GCS CAS and length/hash accounting', async () => {
  contentType = 'image/png';
  const proof = await writeSandboxAllocation(
    profile,
    '01234567-0123-4123-8123-0123456789ab',
    Readable.from([payload.subarray(0, 4), payload.subarray(4)]),
    { contentType, contentLength: payload.length, maxBytes: 100 }
  );
  expect(written).toEqual(payload);
  expect(proof.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
  expect(proof.path).toMatch(/^_providerSandbox\/urm-app-staging-publishing-v1\/allocations\//);
  await expect(
    writeSandboxAllocation(profile, 'id', Readable.from([payload]), { contentType, maxBytes: 1 })
  ).rejects.toThrow('bounded');
});

it('copies provider-owned bytes by stream with source generation and digest verification', async () => {
  const source = {
    ...asset,
    size: payload.length,
    contentType: 'audio/wav',
    sha256: createHash('sha256').update(payload).digest('hex'),
    durationSeconds: 20,
  };
  const copy = await copyStageAssetToSandbox(profile, source, context);
  expect(written).toEqual(payload);
  expect(copy.path).toMatch(/^_providerSandbox\/urm-app-staging-publishing-v1\/media\//);
  expect(copy.sha256).toBe(source.sha256);
  expect(copy.durationSeconds).toBe(20);
  expect(copy.preparationId).toBe('a'.repeat(64));
  await expect(copyStageAssetToSandbox(profile, { ...source, sha256: 'f'.repeat(64) }, context)).rejects.toThrow(
    'does not match'
  );
});

it('measures a reviewed WAV on an empty profile from actual bounded format/data bytes, not client metadata', async () => {
  const frames = 8000 * 2;
  payload = Buffer.alloc(44 + frames * 2);
  payload.write('RIFF', 0);
  payload.writeUInt32LE(payload.length - 8, 4);
  payload.write('WAVEfmt ', 8);
  payload.writeUInt32LE(16, 16);
  payload.writeUInt16LE(1, 20);
  payload.writeUInt16LE(1, 22);
  payload.writeUInt32LE(8000, 24);
  payload.writeUInt32LE(16000, 28);
  payload.writeUInt16LE(2, 32);
  payload.writeUInt16LE(16, 34);
  payload.write('data', 36);
  payload.writeUInt32LE(frames * 2, 40);
  contentType = 'audio/wav';
  const ref = { ...asset, path: '_providerSandbox/urm-app-staging-publishing-v1/reviewed/fixture.wav' },
    expected = { size: payload.length, sha256: createHash('sha256').update(payload).digest('hex'), durationSeconds: 2 };
  expect((await inspectReviewedSandboxWav(profile, ref, expected)).durationSeconds).toBe(2);
  await expect(inspectReviewedSandboxWav(profile, ref, { ...expected, durationSeconds: 20 })).rejects.toThrow(
    'duration'
  );
  await expect(inspectReviewedSandboxWav(profile, ref, { ...expected, sha256: 'f'.repeat(64) })).rejects.toThrow(
    'bytes'
  );
});

it('does not start a private byte write when catalog or current job validation rejects preparation', async () => {
  jest.mocked(assertSandboxAssetPreparation).mockRejectedValueOnce(new Error('stale job'));
  await expect(
    writeSandboxAllocation(profile, 'id', Readable.from([payload]), { contentType: 'image/png' })
  ).rejects.toThrow('stale job');
  expect(written.length).toBe(0);
  jest.mocked(assertSandboxAssetPreparation).mockRejectedValueOnce(new Error('catalog not ready'));
  await expect(
    copyStageAssetToSandbox(profile, {
      ...asset,
      size: payload.length,
      contentType: 'audio/wav',
      sha256: createHash('sha256').update(payload).digest('hex'),
    })
  ).rejects.toThrow('catalog not ready');
  expect(written.length).toBe(0);
});

it('reuses one private byte copy across repeated failed-provider attempts without deduplicating provider creation', async () => {
  const origin = {
    ...asset,
    size: payload.length,
    contentType: 'audio/wav',
    sha256: createHash('sha256').update(payload).digest('hex'),
    durationSeconds: 20,
  };
  const results = [];
  for (let attempt = 0; attempt < 5; attempt++) results.push(await copyStageAssetToSandbox(profile, origin, context));
  expect(privateObjects.size).toBe(1);
  expect(written.length).toBe(payload.length);
  expect(new Set(results.map((row) => row.path + ':' + row.generation)).size).toBe(1);
});
it('retains one uncertain private target across repeated digest conflicts instead of allocating endlessly', async () => {
  const origin = { ...asset, size: payload.length, contentType: 'audio/wav', sha256: 'f'.repeat(64) };
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(copyStageAssetToSandbox(profile, origin, context)).rejects.toThrow(/match|differs/);
  expect(privateObjects.size).toBe(1);
  expect(written.length).toBe(payload.length);
});
it('reuses only exact image replay bytes at one fixed allocation target', async () => {
  contentType = 'image/png';
  const bytes = Buffer.from(payload),
    options = { contentType, contentLength: bytes.length };
  const first = await writeSandboxAllocation(profile, 'allocation', Readable.from([bytes]), options, context);
  const second = await writeSandboxAllocation(profile, 'allocation', Readable.from([bytes]), options, context);
  expect(second.path).toBe(first.path);
  expect(second.generation).toBe(first.generation);
  expect(privateObjects.size).toBe(1);
  expect(written.length).toBe(bytes.length);
  await expect(
    writeSandboxAllocation(profile, 'allocation', Readable.from([Buffer.from('different')]), { contentType }, context)
  ).rejects.toThrow('differs');
  expect(privateObjects.size).toBe(1);
});

it('does not accept a caller supplied duration as measured asset evidence', async () => {
  const untrusted = { ...asset, durationSeconds: 9999 };
  const measured = await inspectStageAsset(profile, untrusted);
  expect(measured.durationSeconds).toBeUndefined();
});
