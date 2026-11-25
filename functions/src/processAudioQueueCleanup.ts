import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MOSES_BACKLOG_FENCES_PATH } from '../../packages/contracts/mosesDeferredRecovery';
import type { Database } from 'firebase-admin/database';
import { getFunctions, type TaskQueue } from 'firebase-admin/functions';
import type { AddIntroOutroInputType } from '../../packages/contracts/addIntroOutro/types';
import {
  getProcessAudioTaskQueueNameForSource,
  PROCESS_AUDIO_LOCKS_PATH,
  PROCESS_AUDIO_QUEUE_CLAIMS_PATH,
  PROCESS_AUDIO_QUEUE_CLAIM_TTL_MS,
  PROCESS_AUDIO_REQUESTS_PATH,
  type StoredProcessAudioRequestState,
  YOUTUBE_QUEUE_STATE_PATH,
} from '../../packages/contracts/processAudioQueue';

const CLAIM_ACQUIRE_ATTEMPTS = 20;
const CLAIM_ACQUIRE_DELAY_MS = 150;

type QueueCleanupResult = {
  deletedTaskId: string | null;
  advancedProbe: boolean;
  deferredRemaining: number;
  disposition?: 'stale' | 'held';
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
};

const isTaskMissingError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('task') && normalized.includes('not found');
};

async function deleteExistingTask(queue: TaskQueue<AddIntroOutroInputType>, taskId: string | null | undefined): Promise<void> {
  if (!taskId) return;

  try {
    await queue.delete(taskId);
  } catch (error) {
    if (isTaskMissingError(error)) {
      return;
    }
    throw error;
  }
}

async function withProcessAudioQueueClaim<T>(
  database: Database,
  sermonId: string,
  ownerId: string,
  run: () => Promise<T>
): Promise<T> {
  const claimRef = database.ref(`${PROCESS_AUDIO_QUEUE_CLAIMS_PATH}/${sermonId}`);

  for (let attempt = 1; attempt <= CLAIM_ACQUIRE_ATTEMPTS; attempt += 1) {
    const now = Date.now();
    const result = await claimRef.transaction((current) => {
      const record = asRecord(current);
      const acquiredAt = typeof record?.acquiredAt === 'number' ? record.acquiredAt : 0;
      const requestId = typeof record?.requestId === 'string' ? record.requestId : null;
      const expired = !acquiredAt || now - acquiredAt > PROCESS_AUDIO_QUEUE_CLAIM_TTL_MS;

      if (requestId && requestId !== ownerId && !expired) {
        return;
      }

      return {
        requestId: ownerId,
        acquiredAt: now,
        acquiredAtIso: new Date(now).toISOString(),
      };
    });

    if (result.committed && result.snapshot.val()?.requestId === ownerId) {
      try {
        return await run();
      } finally {
        await claimRef.transaction(current => current === null || current.requestId === ownerId ? null : undefined, undefined, false);
      }
    }

    await sleep(CLAIM_ACQUIRE_DELAY_MS);
  }

  throw new Error(`Timed out acquiring process-audio queue mutation claim for sermon ${sermonId}.`);
}

export async function cleanupDeletedSermonProcessAudioState(args: {
  database: Database;
  sermonId: string;
  ownerId: string;
  deletedAtMs?: number;
  classifySource?: (backlog: unknown) => Promise<'stale' | 'ordinary' | 'held'>;
}): Promise<QueueCleanupResult> {
  const { database, sermonId } = args;
  const ownerId = args.ownerId + ':' + randomUUID();
  const queueRef = database.ref(YOUTUBE_QUEUE_STATE_PATH).parent!;
  return withProcessAudioQueueClaim(database, sermonId, ownerId, async () => {
    const [requestSnapshot, stateSnapshot, deferredSnapshot, backlog, observedLock] = await Promise.all([
      database.ref(PROCESS_AUDIO_REQUESTS_PATH + '/' + sermonId).get(), queueRef.child('state').get(), queueRef.child('deferred').get(),
      database.ref(MOSES_BACKLOG_FENCES_PATH + '/' + sermonId).get(), database.ref(PROCESS_AUDIO_LOCKS_PATH + '/' + sermonId).get(),
    ]);
    const request = requestSnapshot.val() as StoredProcessAudioRequestState | null;
    const observedDeferred = deferredSnapshot.child(sermonId).val();
    const observedState = stateSnapshot.val();
    const deferredRemaining = Object.keys(deferredSnapshot.val() ?? {}).length;
    const disposition = args.classifySource ? await args.classifySource(backlog.val()) : backlog.exists() ? 'held' : 'ordinary';
    if (disposition !== 'ordinary' || backlog.exists() || (args.deletedAtMs !== undefined && request &&
        (!Number.isFinite(Date.parse(request.updatedAt)) || Date.parse(request.updatedAt) >= args.deletedAtMs))) {
      return { deletedTaskId: null, advancedProbe: false, deferredRemaining,
        disposition: disposition === 'ordinary' ? 'stale' as const : disposition };
    }

    const deletedTaskId = request?.queuedTaskId ?? null;
    const queue = getFunctions().taskQueue<AddIntroOutroInputType>(getProcessAudioTaskQueueNameForSource(request?.sourceType ?? 'storage'));
    const stillOwns = async () => {
      const claim = (await database.ref(PROCESS_AUDIO_QUEUE_CLAIMS_PATH + '/' + sermonId).get()).val();
      return claim?.requestId === ownerId && Number.isFinite(claim.acquiredAt) && Date.now() - claim.acquiredAt < PROCESS_AUDIO_QUEUE_CLAIM_TTL_MS;
    };
    const changed = { deletedTaskId, advancedProbe: false, deferredRemaining, disposition: 'stale' as const };
    if (!await stillOwns()) return changed;
    await deleteExistingTask(queue, deletedTaskId);
    if (!await stillOwns() || (args.classifySource && await args.classifySource(backlog.val()) !== 'ordinary')) return changed;
    const current = await Promise.all([requestSnapshot, observedLock].map(async observed => {
      const value = observed.val();
      const removed = await observed.ref.transaction(live => live === null || isDeepStrictEqual(live, value) ? null : undefined, undefined, false);
      return removed.committed && !removed.snapshot.exists();
    }));
    if (!current.every(Boolean)) return changed;

    if (observedDeferred === null && observedState?.probeTaskSermonId !== sermonId) {
      return { deletedTaskId, advancedProbe: false, deferredRemaining };
    }

    // The worker owns all subsequent dispatches. Retire only the observed probe and
    // this sermon's deferral. Its neighbours keep their original payload, mode and history.
    if (!await stillOwns()) return changed;
    const settled = await queueRef.transaction(queue => {
      if (queue === null) return null;
      if (!isDeepStrictEqual(queue.deferred?.[sermonId] ?? null, observedDeferred)) return undefined;
      const state = queue.state;
      const ownsProbe = observedState?.probeTaskSermonId === sermonId && state?.probeTaskSermonId === sermonId &&
        ['probeRequestVersion', 'probeStartedAt', 'probeDispatchReservationId', 'probeMode', 'probeStatus']
          .every(key => (state[key] ?? null) === (observedState[key] ?? null));
      // A newer probe at the same ID owns any deferred entry now associated with it.
      if (state?.probeTaskSermonId === sermonId && !ownsProbe) return undefined;
      if (!ownsProbe && observedDeferred === null) return queue;
      const deferred = { ...queue.deferred };
      delete deferred[sermonId];
      const count = Object.keys(deferred).length;
      const next = { ...queue, deferred };
      if (state) {
        // A different in-flight reservation may already have discounted its own row.
        const storedCount = state.deferredYouTubeTaskCount;
        const nextCount = !ownsProbe && Number.isSafeInteger(storedCount) ? Math.max(0, storedCount - 1) : count;
        next.state = { ...state, deferredYouTubeTaskCount: nextCount };
      }
      if (ownsProbe) {
        Object.assign(next.state, {
          probeStatus: count ? 'waiting_for_auth_required_request' : 'idle', probeTaskSermonId: null,
          probeRequestVersion: null, probeStartedAt: null, probeDispatchReservationId: null,
          probeMode: count ? state.probeMode ?? null : null,
          ...(!count && { blocked: false, blockerReason: null, blockedAt: null }),
        });
      }
      return next;
    }, undefined, false);
    if (!settled.committed) return changed;
    return { deletedTaskId, advancedProbe: false, deferredRemaining: Object.keys(settled.snapshot.child('deferred').val() ?? {}).length };
  });
}
