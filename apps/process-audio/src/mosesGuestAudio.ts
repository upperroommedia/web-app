import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { CancelToken } from './CancelToken';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const ENDPOINT_PATH = '/v1/youtube/guest-audio';
const MAX_BYTES = 200 * 1024 * 1024;
const TIMEOUT_MS = 180_000; // Includes remote extraction and transfer.

export interface MosesGuestAudioConfig {
  readonly endpoint: string;
  readonly token: string;
  readonly videoIds?: ReadonlySet<string>;
}

export function readMosesGuestAudioConfig(env: NodeJS.ProcessEnv = process.env): MosesGuestAudioConfig | null {
  if (env.MOSES_GUEST_AUDIO_ENABLED !== 'true') return null;
  const origin = env.MOSES_GUEST_AUDIO_ORIGIN;
  const token = env.MOSES_GUEST_AUDIO_TOKEN;
  if (!origin || !token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
  if (Buffer.from(token, 'base64url').toString('base64url') !== token) return null;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  // Compare to the serialized origin to reject credentials, paths, queries and URL parser fixups.
  if (url.protocol !== 'https:' || (origin !== url.origin && origin !== url.origin + '/')) return null;

  const videoIds = env.MOSES_GUEST_AUDIO_VIDEO_IDS?.split(',').map((entry) => entry.trim());
  if (videoIds?.some((id) => !VIDEO_ID.test(id))) return null;
  return { endpoint: url.origin + ENDPOINT_PATH, token, videoIds: videoIds && new Set(videoIds) };
}

export type MosesGuestAudioFallbackReason =
  | 'ineligible_video'
  | 'remote_busy'
  | 'remote_refused'
  | 'remote_error'
  | 'invalid_response'
  | 'integrity_mismatch'
  | 'transfer_interrupted'
  | 'timeout'
  | 'local_io';

export type MosesGuestAudioDownloadResult =
  | { status: 'downloaded'; filePath: string }
  | { status: 'fallback'; reason: MosesGuestAudioFallbackReason }
  | { status: 'cancelled' };

interface DownloadInput {
  config: MosesGuestAudioConfig;
  videoId: string;
  tempDir: string;
  cancelToken: Pick<CancelToken, 'isCancellationRequested'>;
}

interface DownloadDependencies {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

class DownloadFailure extends Error {
  constructor(readonly reason: MosesGuestAudioFallbackReason) {
    super(reason);
  }
}

function readAudioHeaders(response: Response): { length: number; digest: string } {
  if (response.redirected || (response.status >= 300 && response.status < 400))
    throw new DownloadFailure('invalid_response');
  if (response.status === 429) throw new DownloadFailure('remote_busy');
  if (response.status >= 400 && response.status < 500) throw new DownloadFailure('remote_refused');
  if (response.status >= 500) throw new DownloadFailure('remote_error');
  const length = response.headers.get('content-length') ?? '';
  const digest = response.headers.get('x-content-sha256') ?? '';
  if (
    response.status !== 200 ||
    response.headers.get('content-type')?.toLowerCase() !== 'application/octet-stream' ||
    response.headers.has('content-encoding') ||
    response.headers.has('content-range') ||
    !/^[1-9][0-9]{0,8}$/u.test(length) ||
    Number(length) > MAX_BYTES ||
    !/^[a-f0-9]{64}$/u.test(digest)
  )
    throw new DownloadFailure('invalid_response');
  return { length: Number(length), digest };
}

export async function downloadMosesGuestAudio(
  { config, videoId, tempDir, cancelToken }: DownloadInput,
  deps: DownloadDependencies = {}
): Promise<MosesGuestAudioDownloadResult> {
  if (cancelToken.isCancellationRequested) return { status: 'cancelled' };
  if (!VIDEO_ID.test(videoId) || (config.videoIds && !config.videoIds.has(videoId))) {
    return { status: 'fallback', reason: 'ineligible_video' };
  }

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), Math.min(deps.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS));
  const poll = setInterval(() => {
    if (cancelToken.isCancellationRequested) controller.abort();
  }, 100);
  const checkActive = (): void => {
    if (cancelToken.isCancellationRequested) controller.abort();
    controller.signal.throwIfAborted();
  };
  const finalPath = join(tempDir, 'moses-' + randomUUID() + '.audio');
  const partPath = finalPath + '.part';
  let ownedPath: string | undefined;
  let handle: FileHandle | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const onAbort = () => {
    // A stalled read must wake even when the transport has already delivered its declared byte count.
    void reader?.cancel().catch(() => {});
  };
  controller.signal.addEventListener('abort', onAbort);
  let reason: MosesGuestAudioFallbackReason = 'transfer_interrupted';
  let result: MosesGuestAudioDownloadResult;
  try {
    const response = await (deps.fetch ?? fetch)(config.endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + config.token,
        accept: 'application/octet-stream',
        'accept-encoding': 'identity',
        'content-type': 'application/json',
      },
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
      body: JSON.stringify({ videoId }),
    });
    reader = response.body?.getReader();
    checkActive();
    const expected = readAudioHeaders(response);
    if (!reader) throw new DownloadFailure('invalid_response');

    reason = 'local_io';
    handle = await open(partPath, 'wx', 0o600);
    ownedPath = partPath;
    const hash = createHash('sha256');
    let received = 0;
    for (;;) {
      checkActive();
      reason = 'transfer_interrupted';
      const { done, value } = await reader.read();
      checkActive();
      if (done) break;
      received += value.byteLength;
      if (received > expected.length) throw new DownloadFailure('integrity_mismatch');
      hash.update(value);
      reason = 'local_io';
      await handle.writeFile(value);
    }
    if (received !== expected.length || hash.digest('hex') !== expected.digest)
      throw new DownloadFailure('integrity_mismatch');
    reason = 'local_io';
    await handle.close();
    handle = undefined;
    checkActive();
    await rename(partPath, finalPath);
    ownedPath = finalPath;
    checkActive();
    result = { status: 'downloaded', filePath: finalPath };
  } catch (err) {
    result = cancelToken.isCancellationRequested
      ? { status: 'cancelled' }
      : {
          status: 'fallback',
          reason: controller.signal.aborted ? 'timeout' : err instanceof DownloadFailure ? err.reason : reason,
        };
    // Aborting the byte request cannot attest that remote extraction has already stopped.
    if (controller.signal.aborted) onAbort();
    else controller.abort();
  } finally {
    clearTimeout(deadline);
    clearInterval(poll);
    controller.signal.removeEventListener('abort', onAbort);
    reader?.releaseLock();
  }

  if (result.status !== 'downloaded') {
    // Losing ownership of a partial file is a local failure. Do not start fallback if cleanup failed.
    try {
      try {
        await handle?.close();
      } finally {
        if (ownedPath) await unlink(ownedPath);
      }
    } catch {
      throw new Error('Unable to clean up temporary guest audio');
    }
    if (cancelToken.isCancellationRequested) return { status: 'cancelled' };
  }
  return result;
}
