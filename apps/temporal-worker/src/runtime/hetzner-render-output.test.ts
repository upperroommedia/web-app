import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { CRC32C, type Bucket } from '@google-cloud/storage';
import {
  readYouTubeRenderArtifact,
  uploadYouTubeRenderSource,
  youtubeRenderOutput,
} from '../../../process-audio/src/temporal/hetzner-render-output';

const ref = {
  projectId: 'urm-app-staging',
  jobId: 'job-1',
  sermonId: 'sermon-1',
  requestVersion: '0123456789abcdef',
  revision: 1,
};
const attemptId = '00000000-0000-4000-8000-000000000001';
const output = youtubeRenderOutput(ref, attemptId);
const valid = {
  bucket: 'urm-app-staging.firebasestorage.app',
  name: output.processed,
  contentType: 'audio/mpeg',
  generation: '1780000000000001',
  size: '128',
  crc32c: 'AAAAAA==',
  metadata: output.metadata,
};
function read(metadata: object, signal = new AbortController().signal) {
  const getMetadata = jest.fn().mockResolvedValue([metadata]);
  const file = jest.fn().mockReturnValue({ getMetadata });
  const bucket = { name: valid.bucket, file } as unknown as Bucket;
  return {
    file,
    result: readYouTubeRenderArtifact({ bucket, ref, attemptId, stage: 'processed', duration: 30, signal }),
  };
}

test('a read returns the generation and checksum of the exact attempt output', async () => {
  const { file, result } = read(valid);
  await expect(result).resolves.toEqual({
    path: output.processed,
    generation: valid.generation,
    bytes: 128,
    crc32c: valid.crc32c,
    duration: 30,
  });
  expect(file).toHaveBeenCalledWith(output.processed);
});

test.each([
  { ...valid, metadata: { ...valid.metadata, attemptId: 'another-attempt' } },
  { ...valid, name: output.merged },
  { ...valid, size: '0' },
  { ...valid, generation: '0' },
  { ...valid, crc32c: '' },
])('rejects invalid or foreign output metadata', async (metadata) => {
  await expect(read(metadata).result).rejects.toThrow('YOUTUBE_RENDER_OUTPUT_UNCONFIRMED');
});

test('cancelled read cannot authorize artifact inspection', async () => {
  const cancellation = new AbortController();
  cancellation.abort();
  const { file, result } = read(valid, cancellation.signal);
  await expect(result).rejects.toThrow();
  expect(file).not.toHaveBeenCalled();
});

test('retains the untrimmed local file under a separate create-only generation', async () => {
  const work = await mkdtemp(join(tmpdir(), 'yt-render-source-test-'));
  try {
    const path = join(work, 'downloaded.webm');
    const raw = Buffer.alloc(128, 7);
    await writeFile(path, raw);
    const checksum = new CRC32C();
    checksum.update(raw);
    const bytes: Buffer[] = [];
    const createWriteStream = jest.fn().mockReturnValue(
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          bytes.push(chunk);
          done();
        },
      })
    );
    const file = jest.fn().mockReturnValue({
      createWriteStream,
      getMetadata: async () => [
        {
          ...valid,
          name: output.source,
          contentType: 'application/octet-stream',
          crc32c: checksum.toString(),
          metadata: createWriteStream.mock.calls[0][0].metadata.metadata,
        },
      ],
    });
    await expect(
      uploadYouTubeRenderSource({
        bucket: { name: valid.bucket, file } as unknown as Bucket,
        ref,
        attemptId,
        localPath: path,
        duration: 150,
        signal: AbortSignal.timeout(3000),
      })
    ).resolves.toEqual({
      path: output.source,
      generation: valid.generation,
      bytes: raw.length,
      crc32c: checksum.toString(),
      duration: 150,
    });
    expect(Buffer.concat(bytes)).toEqual(raw);
    expect(file.mock.calls).toEqual([[output.source], [output.source]]);
    expect(createWriteStream).toHaveBeenCalledWith(
      expect.objectContaining({
        validation: 'crc32c',
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          contentType: 'application/octet-stream',
          metadata: {
            ...output.metadata,
            uploadAttemptId: expect.stringMatching(/^[a-f0-9-]{36}$/),
          },
        },
      })
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test.each(['matching', 'missing', 'foreign attempt', 'wrong checksum', 'rejected', 'cancelled', 'partial'])(
  'observes the original Storage upload after response loss: %s',
  async (outcome) => {
    const work = await mkdtemp(join(tmpdir(), 'yt-render-source-ack-'));
    const controller = new AbortController();
    const reset = Object.assign(new Error('synthetic upload response lost'), { code: 'ECONNRESET' });
    try {
      const path = join(work, 'downloaded.webm');
      const raw = Buffer.alloc(outcome === 'partial' ? 512 * 1024 : 128, 7);
      await writeFile(path, raw);
      const checksum = new CRC32C();
      checksum.update(raw);
      const createWriteStream = jest.fn(
        (_options: Parameters<ReturnType<Bucket['file']>['createWriteStream']>[0]) =>
          new Writable({
            write(_chunk, _encoding, done) {
              done(outcome === 'partial' ? reset : undefined);
            },
            final(done) {
              if (outcome === 'cancelled') controller.abort();
              done(
                outcome === 'rejected'
                  ? Object.assign(new Error('synthetic create-only conflict'), { code: 412 })
                  : reset
              );
            },
          })
      );
      const getMetadata = jest.fn(async () => {
        if (outcome === 'missing') throw Object.assign(new Error('synthetic no committed object'), { code: 404 });
        const metadata = createWriteStream.mock.calls[0][0]!.metadata!.metadata!;
        return [
          {
            ...valid,
            name: output.source,
            contentType: 'application/octet-stream',
            size: String(raw.length),
            crc32c: outcome === 'wrong checksum' ? 'AAAAAA==' : checksum.toString(),
            metadata: outcome === 'foreign attempt' ? { ...metadata, uploadAttemptId: 'foreign' } : metadata,
          },
        ];
      });
      const file = jest.fn().mockReturnValue({ createWriteStream, getMetadata });
      const result = uploadYouTubeRenderSource({
        bucket: { name: valid.bucket, file } as unknown as Bucket,
        ref,
        attemptId,
        localPath: path,
        duration: 150,
        signal: controller.signal,
      });
      if (outcome === 'matching')
        await expect(result).resolves.toMatchObject({
          path: output.source,
          generation: valid.generation,
          bytes: raw.length,
        });
      else await expect(result).rejects.toThrow();
      expect(createWriteStream).toHaveBeenCalledTimes(1);
      expect(getMetadata).toHaveBeenCalledTimes(['rejected', 'cancelled', 'partial'].includes(outcome) ? 0 : 1);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
);

test('post-render read names the original generation and rejects a replacement', async () => {
  const getMetadata = jest.fn().mockResolvedValue([{ ...valid, generation: '1780000000000002' }]);
  const file = jest.fn().mockReturnValue({ getMetadata });
  await expect(
    readYouTubeRenderArtifact({
      bucket: { name: valid.bucket, file } as unknown as Bucket,
      ref,
      attemptId,
      stage: 'processed',
      generation: valid.generation,
      duration: 30,
      signal: new AbortController().signal,
    })
  ).rejects.toThrow('YOUTUBE_RENDER_OUTPUT_UNCONFIRMED');
  expect(file).toHaveBeenCalledWith(output.processed, { generation: valid.generation });
});

test('rejects a generation the Storage SDK cannot select exactly before issuing a read', async () => {
  const file = jest.fn();
  await expect(
    readYouTubeRenderArtifact({
      bucket: { name: valid.bucket, file } as unknown as Bucket,
      ref,
      attemptId,
      stage: 'processed',
      generation: '9007199254740993',
      duration: 30,
      signal: new AbortController().signal,
    })
  ).rejects.toThrow('YOUTUBE_RENDER_OUTPUT_UNCONFIRMED');
  expect(file).not.toHaveBeenCalled();
});
