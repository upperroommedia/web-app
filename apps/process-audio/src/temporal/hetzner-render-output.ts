import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CRC32C, type Bucket, type CreateWriteStreamOptions } from '@google-cloud/storage';
import type { MediaJobRef } from './types';
import { youtubeAcquisitionId } from './hetzner-acquisition';

import { YOUTUBE_RENDER_MAX_FILE_BYTES } from './hetzner-render-limits';
const invalid = () => new Error('YOUTUBE_RENDER_OUTPUT_UNCONFIRMED');

// The pinned Storage SDK converts generation selectors to JavaScript numbers.
const isExactGeneration = (generation: unknown): generation is string =>
  typeof generation === 'string' && /^[1-9][0-9]*$/.test(generation) && Number.isSafeInteger(Number(generation));

export function youtubeRenderOutput(ref: MediaJobRef, attemptId: string) {
  const operationId = youtubeAcquisitionId(ref);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(attemptId)) throw invalid();
  const prefix = `workflow-audio/${ref.sermonId}/${ref.requestVersion}/`;
  return Object.freeze({
    source: `${prefix}source-${attemptId}.bin`,
    processed: `${prefix}processed-${attemptId}.mp3`,
    merged: `${prefix}final-${attemptId}.mp3`,
    metadata: Object.freeze({ jobId: ref.jobId, requestVersion: ref.requestVersion, operationId, attemptId }),
  });
}

export interface YouTubeRenderArtifact {
  path: string;
  generation: string;
  bytes: number;
  crc32c: string;
  duration: number;
}

/** Verify candidate object identity independently of the host's HTTP response.
 * The caller still needs the durable claim and original execution's terminal receipt. */
export async function readYouTubeRenderArtifact(o: {
  bucket: Bucket;
  ref: MediaJobRef;
  attemptId: string;
  stage: 'source' | 'processed' | 'merged';
  generation?: string;
  duration: number;
  signal: AbortSignal;
}): Promise<YouTubeRenderArtifact> {
  o.signal.throwIfAborted();
  if (
    o.bucket.name !== 'urm-app-staging.firebasestorage.app' ||
    !Number.isFinite(o.duration) ||
    o.duration <= 0 ||
    o.duration > 86400 ||
    (o.generation !== undefined && !isExactGeneration(o.generation))
  )
    throw invalid();
  const output = youtubeRenderOutput(o.ref, o.attemptId),
    path = output[o.stage];
  const file = o.generation === undefined ? o.bucket.file(path) : o.bucket.file(path, { generation: o.generation });
  const [metadata] = await file.getMetadata();
  o.signal.throwIfAborted();
  const bytes = Number(metadata.size);
  if (
    metadata.bucket !== o.bucket.name ||
    metadata.name !== path ||
    metadata.contentType !== (o.stage === 'source' ? 'application/octet-stream' : 'audio/mpeg') ||
    !isExactGeneration(metadata.generation) ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    bytes > YOUTUBE_RENDER_MAX_FILE_BYTES ||
    typeof metadata.crc32c !== 'string' ||
    !/^[A-Za-z0-9+/]{6}==$/.test(metadata.crc32c) ||
    !Object.entries(output.metadata).every(([key, value]) => metadata.metadata?.[key] === value) ||
    (o.generation !== undefined && metadata.generation !== o.generation)
  )
    throw invalid();
  return { path, generation: metadata.generation, bytes, crc32c: metadata.crc32c, duration: o.duration };
}

function uncertainUploadResponse(error: unknown): boolean {
  const code = (error as { code?: string | number } | null)?.code;
  return typeof code === 'number'
    ? code === 408 || (code >= 500 && code < 600)
    : code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
}

/** The caller independently proves its original producer exited successfully.
 * Once the complete stream has been seen, a lost response permits one
 * observation of the same create-only upload, with no new stream or object.
 */
export async function uploadYouTubeRenderStream(o: {
  bucket: Bucket;
  path: string;
  input: Readable;
  options: Omit<CreateWriteStreamOptions, 'metadata'> & {
    contentType: 'audio/mpeg' | 'application/octet-stream';
    metadata?: { contentDisposition?: string; metadata?: Record<string, string | number | undefined> };
  };
  identity: Readonly<Record<string, string>>;
  expectedBytes?: number;
  signal: AbortSignal;
}): Promise<Omit<YouTubeRenderArtifact, 'duration' | 'path'>> {
  o.signal.throwIfAborted();
  if (o.bucket.name !== 'urm-app-staging.firebasestorage.app') throw invalid();
  const uploadAttemptId = randomUUID();
  const checksum = new CRC32C();
  let bytes = 0;
  let complete = false;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > YOUTUBE_RENDER_MAX_FILE_BYTES) return done(invalid());
      checksum.update(chunk);
      done(null, chunk);
    },
    flush(done) {
      complete = true;
      done();
    },
  });
  try {
    await pipeline(
      o.input,
      meter,
      o.bucket.file(o.path).createWriteStream({
        ...o.options,
        validation: 'crc32c',
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          ...o.options.metadata,
          contentType: o.options.contentType,
          metadata: { ...o.options.metadata?.metadata, ...o.identity, uploadAttemptId },
        },
      }),
      { signal: o.signal }
    );
  } catch (error) {
    o.signal.throwIfAborted();
    if (!complete || !uncertainUploadResponse(error)) throw error;
  }
  o.signal.throwIfAborted();
  if (!complete || bytes <= 0 || (o.expectedBytes !== undefined && bytes !== o.expectedBytes)) throw invalid();
  const [metadata] = await o.bucket.file(o.path).getMetadata();
  o.signal.throwIfAborted();
  const crc32c = checksum.toString();
  if (
    metadata.bucket !== o.bucket.name ||
    metadata.name !== o.path ||
    metadata.contentType !== o.options.contentType ||
    !isExactGeneration(metadata.generation) ||
    metadata.metadata?.uploadAttemptId !== uploadAttemptId ||
    !Object.entries(o.identity).every(([key, value]) => metadata.metadata?.[key] === value) ||
    Number(metadata.size) !== bytes ||
    metadata.crc32c !== crc32c
  )
    throw invalid();
  return { generation: metadata.generation, bytes, crc32c };
}

/** Copy the already-downloaded, untrimmed stream without another extraction or
 * workspace file. Only the host claim's create-only object can be retained. */
export async function uploadYouTubeRenderSource(o: {
  bucket: Bucket;
  ref: MediaJobRef;
  attemptId: string;
  localPath: string;
  duration: number;
  signal: AbortSignal;
}) {
  o.signal.throwIfAborted();
  if (
    o.bucket.name !== 'urm-app-staging.firebasestorage.app' ||
    !Number.isFinite(o.duration) ||
    o.duration <= 0 ||
    o.duration > 86400
  )
    throw invalid();
  const output = youtubeRenderOutput(o.ref, o.attemptId);
  const fd = await open(o.localPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const original = await fd.stat({ bigint: true });
    if (!original.isFile() || original.size <= 0n || original.size > BigInt(YOUTUBE_RENDER_MAX_FILE_BYTES))
      throw invalid();
    o.signal.throwIfAborted();
    const receipt = await uploadYouTubeRenderStream({
      bucket: o.bucket,
      path: output.source,
      input: fd.createReadStream({ autoClose: false, start: 0, end: Number(original.size) - 1 }),
      options: { resumable: true, chunkSize: 1024 * 1024, contentType: 'application/octet-stream' },
      identity: output.metadata,
      expectedBytes: Number(original.size),
      signal: o.signal,
    });
    const current = await fd.stat({ bigint: true });
    o.signal.throwIfAborted();
    if (current.size !== original.size || current.mtimeNs !== original.mtimeNs || current.ctimeNs !== original.ctimeNs)
      throw invalid();
    return { ...receipt, path: output.source, duration: o.duration };
  } finally {
    await fd.close();
  }
}
