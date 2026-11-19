import { isRenderProviderOutcome } from './hetzner-render-provider';
import { setTimeout as delay } from 'node:timers/promises';
import { ApplicationFailure } from '@temporalio/common';
import { youtubeAcquisitionId, type AcquisitionTransport } from './hetzner-acquisition';
import type { MediaJobRef } from './types';

const failed = (type: string, retryable = false) =>
  ApplicationFailure.create({ message: 'Hetzner render could not be confirmed.', type, nonRetryable: !retryable });

/** The response is a wakeup. Rendered audio is accepted only by the caller's
 * separate durable-receipt adoption. A known dispatch grant is consumed once. */
export async function waitForYouTubeRender(o: {
  ref: MediaJobRef;
  signal: AbortSignal;
  request: AcquisitionTransport;
  authorizeDispatch: () => Promise<boolean | 'busy'>;
  heartbeat: () => void;
  wait?: (signal: AbortSignal) => Promise<void>;
  maxPolls?: number;
  authentication?: true;
}) {
  const ref = Object.freeze({ ...o.ref });
  const operationId = youtubeAcquisitionId(ref),
    request = { ref, operationId };
  let mayDispatch = true;
  const wait = o.wait ?? ((signal: AbortSignal) => delay(2000, undefined, { signal }));
  for (let i = 0; i < (o.maxPolls ?? 3500); i++) {
    o.signal.throwIfAborted();
    o.heartbeat();
    let value: unknown;
    try {
      value = await o.request('GET', request, o.signal);
    } catch {
      o.signal.throwIfAborted();
      // A lost response or momentary HTTP failure is an observation failure.
      await wait(o.signal);
      continue;
    }
    o.signal.throwIfAborted();
    const item = value as { operationId?: string; status?: string } | null;
    if (!item || Object.keys(item).sort().join(',') !== 'operationId,status' || item.operationId !== operationId)
      throw failed('YOUTUBE_RENDER_PROTOCOL');
    if (
      o.authentication
        ? item.status === 'ready' || item.status === 'failed'
        : item.status === 'rendered' || item.status === 'cancelled' || isRenderProviderOutcome(item.status)
    )
      return item.status!;
    if (item.status === 'failed') throw failed('YOUTUBE_RENDER_FAILED');
    if (item.status === 'missing' && mayDispatch) {
      const authorization = await o.authorizeDispatch();
      // An auth Activity whose transaction observed another slot owner and no
      // dispatch can return to the durable Workflow timer. Once a dispatch
      // exists, this path stays observation-only until the exact probe settles.
      if (authorization === 'busy' && o.authentication) return 'busy';
      mayDispatch = authorization === 'busy';
      if (authorization === true) {
        o.signal.throwIfAborted();
        try {
          await o.request('POST', request, o.signal);
        } catch {
          o.signal.throwIfAborted();
        }
      }
    } else if (item.status !== 'missing' && item.status !== 'running') {
      throw failed('YOUTUBE_RENDER_PROTOCOL');
    }
    await wait(o.signal);
  }
  throw failed('YOUTUBE_RENDER_PENDING', true);
}
