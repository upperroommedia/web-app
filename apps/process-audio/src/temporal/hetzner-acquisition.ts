import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApplicationFailure } from '@temporalio/common';
import { GoogleAuth } from 'google-auth-library';
import type { MediaJobRef, MediaOutcome } from './types';

export interface AcquiredYouTubeSource {
  path: string;
  generation: string;
  bytes: number;
  crc32c: string;
}
export type RemoteYouTubeResult =
  | { kind: 'source'; artifact: AcquiredYouTubeSource }
  | { kind: 'source_available' }
  | { kind: 'retryable' }
  | Exclude<MediaOutcome, { kind: 'ready' }>;
export interface AcquisitionRequest {
  operationId: string;
  ref: MediaJobRef;
}
export type AcquisitionTransport = (
  method: 'GET' | 'POST',
  request: AcquisitionRequest,
  signal: AbortSignal
) => Promise<unknown>;
const failure = (type: string): never => {
  // Neither HTTP bodies nor provider exceptions may become Temporal failure messages.
  throw ApplicationFailure.create({ message: 'YouTube acquisition is awaiting a verified source result.', type });
};
export function youtubeAcquisitionId(ref: MediaJobRef): string {
  if (
    !ref ||
    typeof ref !== 'object' ||
    Array.isArray(ref) ||
    Object.keys(ref).sort().join(',') !== 'jobId,projectId,requestVersion,revision,sermonId' ||
    ref.projectId !== 'urm-app-staging' ||
    typeof ref.jobId !== 'string' ||
    typeof ref.sermonId !== 'string' ||
    typeof ref.requestVersion !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(ref.jobId) ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(ref.sermonId) ||
    !/^[a-f0-9]{16}$/.test(ref.requestVersion) ||
    !Number.isSafeInteger(ref.revision) ||
    ref.revision < 1
  )
    return failure('YOUTUBE_ACQUISITION_REFERENCE');
  return `ytacq-${createHash('sha256')
    .update(
      JSON.stringify(['acquisition-v1', ref.projectId, ref.jobId, ref.sermonId, ref.revision, ref.requestVersion])
    )
    .digest('hex')}`;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failure('YOUTUBE_ACQUISITION_PROTOCOL');
  return value as Record<string, unknown>;
};
export function validateAcquiredYouTubeSource(ref: MediaJobRef, value: unknown): AcquiredYouTubeSource {
  youtubeAcquisitionId(ref);
  const artifact = record(value);
  const prefix = `workflow-audio/${ref.sermonId}/${ref.requestVersion}/source-`;
  if (
    Object.keys(artifact).sort().join(',') !== 'bytes,crc32c,generation,path' ||
    typeof artifact.path !== 'string' ||
    !artifact.path.startsWith(prefix) ||
    !/^[A-Za-z0-9_-]+\.(mp3|m4a|webm|ogg|wav|opus|flac|mp4|bin)$/.test(artifact.path.slice(prefix.length)) ||
    typeof artifact.generation !== 'string' ||
    !/^[1-9][0-9]{0,29}$/.test(artifact.generation) ||
    !Number.isSafeInteger(artifact.bytes) ||
    typeof artifact.bytes !== 'number' ||
    artifact.bytes <= 0 ||
    artifact.bytes > 20 * 1024 ** 3 ||
    typeof artifact.crc32c !== 'string' ||
    !/^[A-Za-z0-9+/]{6}==$/.test(artifact.crc32c)
  )
    return failure('YOUTUBE_ACQUISITION_PROTOCOL');
  return { path: artifact.path, generation: artifact.generation, bytes: artifact.bytes, crc32c: artifact.crc32c };
}
/** Existing canonical sources already have a duration measured by the native
 * Activity. This is separate from the host's unmeasured byte locator protocol.
 */
export function validateCanonicalYouTubeSource(ref: MediaJobRef, value: unknown): void {
  const artifact = record(value);
  const prefix = `workflow-audio/${ref.sermonId}/${ref.requestVersion}/source-`;
  youtubeAcquisitionId(ref);
  if (
    Object.keys(artifact).sort().join(',') !== 'duration,generation,path' ||
    typeof artifact.path !== 'string' ||
    !artifact.path.startsWith(prefix) ||
    !/^[A-Za-z0-9_-]+\.(mp3|m4a|webm|ogg|wav|opus|flac|mp4|bin)$/.test(artifact.path.slice(prefix.length)) ||
    typeof artifact.generation !== 'string' ||
    !/^[1-9][0-9]{0,29}$/.test(artifact.generation) ||
    typeof artifact.duration !== 'number' ||
    !Number.isFinite(artifact.duration) ||
    artifact.duration <= 0 ||
    artifact.duration > 86400
  )
    return failure('YOUTUBE_ACQUISITION_PROTOCOL');
}
function observation(
  value: unknown,
  request: AcquisitionRequest
): { status: 'missing' | 'running' } | RemoteYouTubeResult {
  const data = record(value);
  if (
    data.operationId !== request.operationId ||
    Object.keys(data).some((key) => !['status', 'operationId', 'artifact'].includes(key))
  )
    return failure('YOUTUBE_ACQUISITION_PROTOCOL');
  if (data.status === 'ready') {
    return { kind: 'source', artifact: validateAcquiredYouTubeSource(request.ref, data.artifact) };
  }
  if (data.artifact !== undefined) return failure('YOUTUBE_ACQUISITION_PROTOCOL');
  if (data.status === 'missing' || data.status === 'running') return { status: data.status };
  if (data.status === 'retryable') return failure('YOUTUBE_ACQUISITION_RETRYABLE');
  if (data.status === 'waiting_auth') return { kind: 'waiting_auth', recoveryGeneration: null };
  if (
    data.status === 'waiting_archive' ||
    data.status === 'restricted' ||
    data.status === 'cancelled' ||
    data.status === 'superseded' ||
    data.status === 'deleted' ||
    data.status === 'completed' ||
    data.status === 'source_available'
  )
    return { kind: data.status };
  return failure('YOUTUBE_ACQUISITION_PROTOCOL');
}

/** Client side only. Activation requires the reviewed host's atomic durable
 * admission, process fencing, resource budgets, canonical cancellation and source
 * receipt protocol. It never invokes legacy processing or declares remote drain.
 */
export function createHetznerAcquisitionClient(options: {
  request: AcquisitionTransport;
  heartbeat: () => void;
  wait?: (signal: AbortSignal) => Promise<void>;
  maxPolls?: number;
}) {
  const maxPolls = options.maxPolls ?? 900;
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 3600)
    throw new Error('Invalid acquisition polling bound');
  const wait =
    options.wait ??
    (async (signal: AbortSignal) => {
      await delay(2000, undefined, { signal });
    });
  return {
    async acquire(ref: MediaJobRef, signal: AbortSignal): Promise<RemoteYouTubeResult> {
      // Copy just the validated fields. No URL/payload or mutable reference crosses this boundary.
      const bound: MediaJobRef = {
        projectId: ref.projectId,
        jobId: ref.jobId,
        sermonId: ref.sermonId,
        revision: ref.revision,
        requestVersion: ref.requestVersion,
      };
      const request = { operationId: youtubeAcquisitionId(bound), ref: bound };
      let startAttempted = false;
      for (let count = 0; count < maxPolls; count++) {
        signal.throwIfAborted();
        let response: unknown;
        try {
          response = await options.request('GET', request, signal);
        } catch {
          signal.throwIfAborted();
          return failure('YOUTUBE_ACQUISITION_UNAVAILABLE');
        }
        signal.throwIfAborted();
        let current = observation(response, request);
        options.heartbeat();
        signal.throwIfAborted();
        if ('kind' in current) return current;
        if (current.status === 'missing') {
          if (startAttempted) return failure('YOUTUBE_ACQUISITION_ACK_UNKNOWN');
          startAttempted = true;
          try {
            response = await options.request('POST', request, signal);
          } catch {
            signal.throwIfAborted();
            // Unknown acknowledgement: next iteration reads the SAME operation.
            // Never start again within this attempt, even after a missing read.
            continue;
          }
          signal.throwIfAborted();
          current = observation(response, request);
          if ('kind' in current) return current;
          if (current.status === 'missing') return failure('YOUTUBE_ACQUISITION_ACK_UNKNOWN');
        }
        if (count + 1 < maxPolls) await wait(signal);
      }
      return failure('YOUTUBE_ACQUISITION_PENDING');
    },
  };
}

/** OIDC to the fixed staging host only; never follows redirects with credentials.
 * Hetzner verifies the signed token and its exact configured audience/SA itself.
 * No caller-supplied origin, service-account key or provider secret is accepted.
 */
export function createHetznerAcquisitionTransport(projectId: string): AcquisitionTransport {
  if (projectId !== 'urm-app-staging') throw new Error('Only staging acquisition transport is reviewed');
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('Acquisition requires a native service identity');
  const origin = 'https://yt-worker-staging.upperroommedia.org';
  const auth = new GoogleAuth();
  let clientPromise: ReturnType<GoogleAuth['getIdTokenClient']> | undefined;
  let headersPromise: Promise<Headers> | undefined;
  const getClient = () => {
    if (!clientPromise) {
      const pending = auth.getIdTokenClient(origin);
      clientPromise = pending;
      void pending.catch(() => {
        if (clientPromise === pending) clientPromise = undefined;
      });
    }
    return clientPromise;
  };
  return async (method, request, signal) => {
    signal.throwIfAborted();
    if (request.ref.projectId !== projectId || youtubeAcquisitionId(request.ref) !== request.operationId)
      return failure('YOUTUBE_ACQUISITION_REFERENCE');
    const deadline = new AbortController();
    const budget = AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), 10000);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('Acquisition request interrupted'));
      budget.addEventListener('abort', onAbort, { once: true });
      if (budget.aborted) onAbort();
    });
    try {
      return await Promise.race([
        aborted,
        (async () => {
          const client = await getClient();
          budget.throwIfAborted();
          // Token setup can outlive a caller's deadline. Share that pending setup,
          // and check cancellation again before it can cause any acquisition POST.
          if (!headersPromise) {
            const pending = client.getRequestHeaders(origin).then((headers) => new Headers(headers));
            headersPromise = pending;
            void pending
              .finally(() => {
                if (headersPromise === pending) headersPromise = undefined;
              })
              .catch(() => undefined);
          }
          const headers = new Headers(await headersPromise);
          budget.throwIfAborted();
          if (method === 'POST') headers.set('content-type', 'application/json');
          const response = await fetch(`${origin}/internal/temporal/youtube/acquisitions/${request.operationId}`, {
            method,
            headers,
            ...(method === 'POST' ? { body: JSON.stringify(request) } : {}),
            signal: budget,
            redirect: 'error',
          });
          if (!response.ok || !response.body) {
            void response.body?.cancel().catch(() => undefined);
            return failure('YOUTUBE_ACQUISITION_UNAVAILABLE');
          }
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            budget.throwIfAborted();
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 16384) {
              void reader.cancel().catch(() => undefined);
              return failure('YOUTUBE_ACQUISITION_PROTOCOL');
            }
            chunks.push(part.value);
          }
          budget.throwIfAborted();
          return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        })(),
      ]);
    } catch {
      signal.throwIfAborted();
      return failure('YOUTUBE_ACQUISITION_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      if (onAbort) budget.removeEventListener('abort', onAbort);
    }
  };
}
