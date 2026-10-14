import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import admin from '@upperroom/shared/firebase/firebaseAdmin';
import { SandboxAssetEvidence, SandboxHttpError, StageAssetRef, SandboxRequestContext } from './types';
import {
  sandboxRoot,
  SandboxStoreProfile,
  assertSandboxAssetPreparation,
  beginSandboxAssetPreparation,
  completeSandboxAssetPreparation,
  markSandboxAssetPreparationUncertain,
} from './store';

const STAGING_BUCKETS = new Set([
  'urm-app-staging.firebasestorage.app',
  'urm-app-staging.appspot.com',
  'urm-app-staging-images',
]);
export function validateStageAssetRef(ref: StageAssetRef): void {
  if (
    !ref ||
    !STAGING_BUCKETS.has(ref.bucket) ||
    !ref.path ||
    ref.path.length > 1024 ||
    ref.path.startsWith('/') ||
    ref.path.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\x00-\x1f\x7f]/.test(ref.path) ||
    !/^[1-9][0-9]{0,29}$/.test(ref.generation)
  )
    throw new SandboxHttpError(400, 'Only an exact staging object generation is permitted');
}
export async function resolveStageAsset(
  profile: SandboxStoreProfile,
  input: string,
  defaultBucket?: string
): Promise<StageAssetRef> {
  sandboxRoot(profile);
  let bucket = defaultBucket,
    path = input,
    requestedGeneration: string | undefined;
  if (/^https?:|^gs:/.test(input)) {
    const url = new URL(input);
    if (url.username || url.password || url.hash) throw new SandboxHttpError(400, 'Invalid staging asset URL');
    if (url.protocol === 'gs:') {
      bucket = url.hostname;
      path = decodeURIComponent(url.pathname.slice(1));
    } else if (url.protocol === 'https:' && url.hostname === 'storage.googleapis.com') {
      const parts = url.pathname.slice(1).split('/');
      bucket = parts.shift();
      path = decodeURIComponent(parts.join('/'));
    } else if (url.protocol === 'https:' && url.hostname === 'firebasestorage.googleapis.com') {
      const match = /^\/v0\/b\/([^/]+)\/o\/(.+)$/.exec(url.pathname);
      if (!match) throw new SandboxHttpError(400, 'Unsupported staging asset URL');
      bucket = decodeURIComponent(match[1]);
      path = decodeURIComponent(match[2]);
    } else throw new SandboxHttpError(400, 'External media URLs are forbidden in staging simulation');
    requestedGeneration = url.searchParams.get('generation') ?? undefined;
  }
  if (!bucket || !STAGING_BUCKETS.has(bucket)) throw new SandboxHttpError(400, 'Asset bucket is not staging');
  const provisional = { bucket, path, generation: requestedGeneration ?? '1' };
  validateStageAssetRef(provisional);
  const [metadata] = await admin
    .storage()
    .bucket(bucket)
    .file(path, requestedGeneration ? { generation: requestedGeneration } : undefined)
    .getMetadata();
  const ref = { bucket, path, generation: String(metadata.generation) };
  validateStageAssetRef(ref);
  return ref;
}
export async function inspectStageAsset(
  profile: SandboxStoreProfile,
  ref: StageAssetRef,
  maxBytes = 1024 * 1024 * 1024
): Promise<SandboxAssetEvidence> {
  sandboxRoot(profile);
  validateStageAssetRef(ref);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024)
    throw new SandboxHttpError(400, 'Invalid bounded asset size');
  const file = admin.storage().bucket(ref.bucket).file(ref.path, { generation: ref.generation });
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size),
    contentType = metadata.contentType ?? 'application/octet-stream';
  if (String(metadata.generation) !== ref.generation || !Number.isSafeInteger(size) || size < 1 || size > maxBytes)
    throw new SandboxHttpError(422, 'Staging media generation/size is invalid');
  let count = 0;
  const hash = createHash('sha256'),
    stream = file.createReadStream({ validation: 'crc32c' });
  const timer = setTimeout(() => stream.destroy(new Error('Sandbox asset read timed out')), 120_000);
  timer.unref();
  try {
    for await (const chunk of stream) {
      count += chunk.length;
      if (count > size || count > maxBytes) throw new SandboxHttpError(413, 'Staging media exceeds bounded size');
      hash.update(chunk);
    }
  } finally {
    clearTimeout(timer);
    stream.destroy();
  }
  if (count !== size) throw new SandboxHttpError(409, 'Staging media read was incomplete');
  const sha256 = hash.digest('hex');
  let measuredDuration: unknown;
  const ownerJobId = metadata.metadata?.jobId,
    requestVersion = metadata.metadata?.requestVersion;
  if (typeof ownerJobId === 'string' && ownerJobId && !ownerJobId.includes('/') && typeof requestVersion === 'string') {
    // Temporal records ffprobe measurements together with the exact immutable output generation.
    const request = (await admin.firestore().collection('temporalMediaRequests').doc(ownerJobId).get()).data();
    if (
      request?.ref?.projectId === profile.projectId &&
      request.ref.jobId === ownerJobId &&
      request.ref.requestVersion === requestVersion
    ) {
      const artifacts = Object.values(request.artifacts ?? {}) as Array<{
        path?: unknown;
        generation?: unknown;
        duration?: unknown;
      }>;
      const exact = artifacts.find((artifact) => artifact.path === ref.path && artifact.generation === ref.generation);
      measuredDuration = exact?.duration;
    }
  } else if (/^(processed-sermons|intro-outro-sermons)\/[^/]+$/.test(ref.path)) {
    // These legacy output destinations are server-write-only in Storage rules.
    measuredDuration = metadata.metadata?.duration;
  }
  if (measuredDuration === undefined && /^audio\//.test(contentType)) {
    const fixture = (await sandboxRoot(profile).get()).get('fixture') as SandboxAssetEvidence | undefined;
    if (
      fixture?.bucket === ref.bucket &&
      fixture.path === ref.path &&
      fixture.generation === ref.generation &&
      fixture.sha256 === sha256 &&
      fixture.size === size
    )
      measuredDuration = fixture.durationSeconds;
  }
  const numericDuration =
    typeof measuredDuration === 'number' || typeof measuredDuration === 'string' ? Number(measuredDuration) : NaN;
  const durationSeconds =
    Number.isFinite(numericDuration) && numericDuration > 0 && numericDuration <= 86400 ? numericDuration : undefined;
  return {
    bucket: ref.bucket,
    path: ref.path,
    generation: ref.generation,
    size,
    contentType,
    sha256,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}
async function existingPreparedBytes(
  profile: SandboxStoreProfile,
  path: string,
  id: string,
  maxBytes: number
): Promise<SandboxAssetEvidence | undefined> {
  const file = admin.storage().bucket('urm-app-staging.firebasestorage.app').file(path);
  let metadata;
  try {
    [metadata] = await file.getMetadata();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && Number(error.code) === 404) return undefined;
    throw error;
  }
  if (metadata.metadata?.sandboxProfileId !== profile.profileId || metadata.metadata?.preparationId !== id)
    throw new SandboxHttpError(409, 'Existing private asset is not owned by this preparation');
  const actual = await inspectStageAsset(
    profile,
    { bucket: file.bucket.name, path, generation: String(metadata.generation) },
    maxBytes
  );
  return { ...actual, preparationId: id };
}
async function boundedIncomingDigest(
  bytes: AsyncIterable<Uint8Array>,
  maxBytes: number
): Promise<{ size: number; sha256: string }> {
  const source = Readable.from(bytes),
    hash = createHash('sha256');
  let size = 0;
  const timer = setTimeout(() => source.destroy(new Error('Private image replay timed out')), 120000);
  timer.unref();
  try {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > maxBytes) throw new SandboxHttpError(413, 'Image replay exceeds bounded size');
      hash.update(chunk);
    }
  } finally {
    clearTimeout(timer);
    source.destroy();
  }
  if (!size) throw new SandboxHttpError(409, 'Image replay was empty');
  return { size, sha256: hash.digest('hex') };
}
export async function writeSandboxAllocation(
  profile: SandboxStoreProfile,
  allocationId: string,
  bytes: AsyncIterable<Uint8Array>,
  options: { contentType: string; contentLength?: number; maxBytes?: number },
  context?: SandboxRequestContext
): Promise<SandboxAssetEvidence> {
  await assertSandboxAssetPreparation(profile, context);
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(allocationId) || !/^image\/(jpeg|png|webp|avif)$/.test(options.contentType))
    throw new SandboxHttpError(400, 'Invalid image allocation');
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1))
    throw new SandboxHttpError(400, 'Invalid upload size bound');
  const maxBytes = Math.min(options.maxBytes ?? 32 * 1024 * 1024, 32 * 1024 * 1024);
  if (
    options.contentLength !== undefined &&
    (!Number.isSafeInteger(options.contentLength) || options.contentLength < 1 || options.contentLength > maxBytes)
  )
    throw new SandboxHttpError(413, 'Image allocation exceeds bounded size');
  const path = `_providerSandbox/${profile.profileId}/allocations/${allocationId}/asset`,
    preparation = await beginSandboxAssetPreparation(profile, context, path);
  const existing = await existingPreparedBytes(profile, path, preparation.id, maxBytes);
  if (existing) {
    const incoming = await boundedIncomingDigest(bytes, maxBytes);
    if (
      incoming.size !== existing.size ||
      incoming.sha256 !== existing.sha256 ||
      existing.contentType !== options.contentType ||
      (options.contentLength !== undefined && incoming.size !== options.contentLength)
    )
      throw new SandboxHttpError(409, 'Image retry differs from the original owned allocation');
    await completeSandboxAssetPreparation(profile, preparation.id, existing);
    await assertSandboxAssetPreparation(profile, context);
    return existing;
  }
  if (preparation.target) throw new SandboxHttpError(409, 'Retained private allocation is missing its exact object');
  const file = admin.storage().bucket('urm-app-staging.firebasestorage.app').file(path),
    hash = createHash('sha256');
  let size = 0;
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > maxBytes) {
        done(new SandboxHttpError(413, 'Image upload exceeds bounded size'));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  const input = Readable.from(bytes),
    output = file.createWriteStream({
      resumable: false,
      validation: 'crc32c',
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: {
        contentType: options.contentType,
        cacheControl: 'private, no-store',
        metadata: { sandboxProfileId: profile.profileId, preparationId: preparation.id },
      },
    });
  const timer = setTimeout(() => {
    input.destroy(new Error('Sandbox upload timed out'));
    output.destroy();
  }, 120000);
  timer.unref();
  try {
    await pipeline(input, counter, output);
  } catch (error) {
    await markSandboxAssetPreparationUncertain(profile, preparation.id);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!size || (options.contentLength !== undefined && options.contentLength !== size)) {
    await markSandboxAssetPreparationUncertain(profile, preparation.id);
    throw new SandboxHttpError(409, 'Incomplete allocation upload');
  }
  const [metadata] = await file.getMetadata();
  const evidence: SandboxAssetEvidence = {
    preparationId: preparation.id,
    bucket: file.bucket.name,
    path,
    generation: String(metadata.generation),
    size,
    contentType: options.contentType,
    sha256: hash.digest('hex'),
  };
  await completeSandboxAssetPreparation(profile, preparation.id, evidence);
  await assertSandboxAssetPreparation(profile, context);
  return evidence;
}
export async function probeStageAsset(
  profile: SandboxStoreProfile,
  ref: StageAssetRef,
  maxBytes: number
): Promise<{ ok: boolean; contentType: string; size: number; sha256: string }> {
  sandboxRoot(profile);
  validateStageAssetRef(ref);
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024)
    throw new SandboxHttpError(400, 'Invalid bounded media probe');
  const file = admin.storage().bucket(ref.bucket).file(ref.path, { generation: ref.generation });
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size);
  if (String(metadata.generation) !== ref.generation || !Number.isSafeInteger(size) || size < 1)
    throw new SandboxHttpError(409, 'Media object is unavailable');
  const [bytes] = await file.download({ start: 0, end: Math.min(size, maxBytes) - 1, validation: false });
  return {
    ok: bytes.length > 0,
    contentType: metadata.contentType ?? 'application/octet-stream',
    size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** A provider upload owns its bytes independently of the app's original retention lifecycle. */
export async function copyStageAssetToSandbox(
  profile: SandboxStoreProfile,
  origin: SandboxAssetEvidence,
  context?: SandboxRequestContext
): Promise<SandboxAssetEvidence> {
  await assertSandboxAssetPreparation(profile, context);
  validateStageAssetRef(origin);
  if (
    !Number.isSafeInteger(origin.size) ||
    origin.size < 1 ||
    origin.size > 1024 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(origin.sha256)
  )
    throw new SandboxHttpError(400, 'Invalid bounded source evidence');
  // This deduplicates private input preparation only. Every provider POST still allocates a new provider identity.
  const key = createHash('sha256')
    .update(
      JSON.stringify([profile.profileId, context!.jobId, origin.bucket, origin.path, origin.generation, origin.sha256])
    )
    .digest('hex');
  const path = `_providerSandbox/${profile.profileId}/media/${key}/asset`,
    preparation = await beginSandboxAssetPreparation(profile, context, path, origin);
  const recover = async (): Promise<SandboxAssetEvidence | undefined> => {
    const existing = await existingPreparedBytes(profile, path, preparation.id, origin.size);
    if (!existing) return undefined;
    if (
      existing.sha256 !== origin.sha256 ||
      existing.size !== origin.size ||
      existing.contentType !== origin.contentType
    )
      throw new SandboxHttpError(409, 'Existing private copy differs from its immutable source');
    const measuredDuration =
      origin.durationSeconds ?? preparation.origin?.durationSeconds ?? preparation.target?.durationSeconds;
    const evidence = {
      ...existing,
      ...(measuredDuration !== undefined ? { durationSeconds: measuredDuration } : {}),
    };
    await completeSandboxAssetPreparation(profile, preparation.id, evidence);
    await assertSandboxAssetPreparation(profile, context);
    return evidence;
  };
  const existing = await recover();
  if (existing) return existing;
  if (preparation.target) throw new SandboxHttpError(409, 'Retained private copy is missing its exact object');
  const source = admin.storage().bucket(origin.bucket).file(origin.path, { generation: origin.generation }),
    target = admin.storage().bucket('urm-app-staging.firebasestorage.app').file(path);
  let count = 0;
  const hash = createHash('sha256'),
    counter = new Transform({
      transform(chunk, _encoding, done) {
        count += chunk.length;
        if (count > origin.size) {
          done(new SandboxHttpError(413, 'Provider upload exceeds pinned source size'));
          return;
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });
  const input = source.createReadStream({ validation: 'crc32c' }),
    output = target.createWriteStream({
      resumable: false,
      validation: 'crc32c',
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: {
        contentType: origin.contentType,
        cacheControl: 'private, no-store',
        metadata: {
          sandboxProfileId: profile.profileId,
          preparationId: preparation.id,
          originBucket: origin.bucket,
          originPath: origin.path,
          originGeneration: origin.generation,
          originSha256: origin.sha256,
        },
      },
    });
  const timer = setTimeout(() => {
    input.destroy(new Error('Provider media copy timed out'));
    output.destroy();
  }, 120000);
  timer.unref();
  try {
    await pipeline(input, counter, output);
  } catch (error) {
    await markSandboxAssetPreparationUncertain(profile, preparation.id);
    const recovered = await recover();
    if (recovered) return recovered;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (count !== origin.size || hash.digest('hex') !== origin.sha256) {
    await markSandboxAssetPreparationUncertain(profile, preparation.id);
    throw new SandboxHttpError(409, 'Provider media copy does not match the exact source generation');
  }
  const [metadata] = await target.getMetadata();
  const evidence = {
    ...origin,
    preparationId: preparation.id,
    bucket: target.bucket.name,
    path,
    generation: String(metadata.generation),
  };
  await completeSandboxAssetPreparation(profile, preparation.id, evidence);
  await assertSandboxAssetPreparation(profile, context);
  return evidence;
}

/** Bootstrap-only inspection of an explicitly reviewed owned WAV; no existing catalog marker is required. */
export async function inspectReviewedSandboxWav(
  profile: SandboxStoreProfile,
  ref: StageAssetRef,
  expected: { sha256: string; size: number; durationSeconds: number }
): Promise<SandboxAssetEvidence> {
  sandboxRoot(profile);
  validateStageAssetRef(ref);
  if (
    !ref.path.startsWith(`_providerSandbox/${profile.profileId}/`) ||
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    !Number.isSafeInteger(expected.size) ||
    expected.size < 44 ||
    expected.size > 32 * 1024 * 1024 ||
    !Number.isFinite(expected.durationSeconds) ||
    expected.durationSeconds <= 0 ||
    expected.durationSeconds > 86400
  )
    throw new SandboxHttpError(400, 'Reviewed owned WAV proof is required');
  const evidence = await inspectStageAsset(profile, ref, 32 * 1024 * 1024);
  if (
    evidence.sha256 !== expected.sha256 ||
    evidence.size !== expected.size ||
    !['audio/wav', 'audio/x-wav', 'audio/wave'].includes(evidence.contentType)
  )
    throw new SandboxHttpError(409, 'Reviewed WAV bytes or identity changed');
  const headerStream = admin
    .storage()
    .bucket(ref.bucket)
    .file(ref.path, { generation: ref.generation })
    .createReadStream({ start: 0, end: Math.min(evidence.size, 65536) - 1, validation: false });
  const chunks: Buffer[] = [];
  let headerBytes = 0;
  const headerTimer = setTimeout(() => headerStream.destroy(new Error('Reviewed WAV header read timed out')), 15000);
  headerTimer.unref();
  try {
    for await (const chunk of headerStream) {
      headerBytes += chunk.length;
      if (headerBytes > 65536) throw new SandboxHttpError(413, 'Reviewed WAV header exceeds its read bound');
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    clearTimeout(headerTimer);
    headerStream.destroy();
  }
  const header = Buffer.concat(chunks, headerBytes);
  if (
    header.length < 44 ||
    header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.toString('ascii', 8, 12) !== 'WAVE' ||
    header.readUInt32LE(4) + 8 !== evidence.size
  )
    throw new SandboxHttpError(422, 'Owned fixture must be a complete bounded RIFF/WAV');
  let offset = 12,
    byteRate = 0,
    blockAlign = 0,
    sampleRate = 0,
    dataBytes: number | undefined,
    seenFormat = false;
  while (offset + 8 <= header.length) {
    const tag = header.toString('ascii', offset, offset + 4),
      length = header.readUInt32LE(offset + 4),
      start = offset + 8;
    if (start + length > evidence.size) throw new SandboxHttpError(422, 'WAV chunk exceeds its actual object');
    if (tag === 'fmt ') {
      if (seenFormat) throw new SandboxHttpError(422, 'Reviewed WAV contains duplicate format chunks');
      seenFormat = true;
      if (length < 16 || start + 16 > header.length) throw new SandboxHttpError(422, 'WAV format header is incomplete');
      const format = header.readUInt16LE(start),
        channels = header.readUInt16LE(start + 2),
        bits = header.readUInt16LE(start + 14);
      sampleRate = header.readUInt32LE(start + 4);
      byteRate = header.readUInt32LE(start + 8);
      blockAlign = header.readUInt16LE(start + 12);
      if (
        ![1, 3].includes(format) ||
        channels < 1 ||
        channels > 8 ||
        sampleRate < 8000 ||
        sampleRate > 192000 ||
        ![8, 16, 24, 32, 64].includes(bits) ||
        blockAlign !== (channels * bits) / 8 ||
        byteRate !== sampleRate * blockAlign ||
        (format === 3 && ![32, 64].includes(bits))
      )
        throw new SandboxHttpError(422, 'Reviewed WAV has an unsupported or inconsistent measured format');
    }
    if (tag === 'data') {
      if (start + length + (length % 2) !== evidence.size)
        throw new SandboxHttpError(422, 'Reviewed WAV data and padding must reach the actual object boundary');
      dataBytes = length;
      break;
    }
    offset = start + length + (length % 2);
  }
  if (!byteRate || !sampleRate || !blockAlign || !dataBytes || dataBytes % blockAlign !== 0)
    throw new SandboxHttpError(422, 'Reviewed WAV has no bounded measured PCM data');
  const durationSeconds = dataBytes / byteRate;
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    Math.abs(durationSeconds - expected.durationSeconds) > 1 / sampleRate
  )
    throw new SandboxHttpError(409, 'Reviewed WAV duration does not match the actual decoded header');
  return { ...evidence, durationSeconds };
}
