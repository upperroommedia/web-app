import {
  ActivityCancellationType,
  CancellationScope,
  allHandlersFinished,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  getExternalWorkflowHandle,
  isCancellation,
  makeContinueAsNewFunc,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { MediaActivities, MediaJobRef, MediaOutcome } from '../../../../process-audio/src/temporal/types';

export const mediaRequest = defineSignal<[MediaJobRef]>('media.request');
export const mediaCancel = defineSignal<[string]>('media.cancel');
export const mediaAuthRecovered = defineSignal<[string]>('media.authRecovered');
export const mediaCompleted = defineSignal<[Pick<MediaJobRef, 'jobId' | 'projectId'>]>('media.completed');
export const mediaState = defineQuery<{ current: MediaJobRef | null; desired: MediaJobRef; phase: string }>(
  'media.state'
);

type Resume = {
  authAttempts: number;
  archiveAttempts: number;
  recoveryGeneration: string | null;
  archiveDueAt?: number;
};
export interface MediaCoordinatorInput {
  initial: MediaJobRef;
  mediaTaskQueue: string;
  controlTaskQueue?: string;
  resume?: Resume;
}
const ARCHIVE_DELAYS = [30 * 60_000, 60 * 60_000, 2 * 60 * 60_000, 4 * 60 * 60_000, 6 * 60 * 60_000];

/** Per-sermon serialization, durable waits and latest-request coalescing. No source data enters history. */
export async function SermonAudioCoordinator(input: MediaCoordinatorInput): Promise<void> {
  const operations = proxyActivities<
    Pick<MediaActivities, 'acquireMedia' | 'mergeMedia' | 'recoverMediaAuthentication'>
  >({
    taskQueue: input.mediaTaskQueue,
    startToCloseTimeout: '2 hours',
    scheduleToCloseTimeout: '12 hours',
    heartbeatTimeout: '1 minute',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { initialInterval: '5 seconds', maximumInterval: '5 minutes', maximumAttempts: 5 },
  });
  const projections = proxyActivities<
    Pick<
      MediaActivities,
      | 'prepareMedia'
      | 'publishMedia'
      | 'projectMediaWaiting'
      | 'projectMediaFailure'
      | 'cleanupMedia'
      | 'readMediaObservers'
    >
  >({
    taskQueue: input.controlTaskQueue ?? 'urm-controls',
    startToCloseTimeout: '3 minutes',
    scheduleToCloseTimeout: '30 minutes',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { initialInterval: '5 seconds', maximumInterval: '1 minute', maximumAttempts: 10 },
  });
  let desired = input.initial;
  let current: MediaJobRef | null = null;
  let phase = 'queued';
  let recoveryGeneration = input.resume?.recoveryGeneration ?? null;
  let cancellationJob: string | null = null;
  let activeScope: CancellationScope | undefined;
  let completedRevision = 0;
  let processedCount = 0;
  setHandler(mediaRequest, (ref) => {
    if (ref.sermonId !== desired.sermonId || ref.revision <= desired.revision) return;
    desired = ref;
    if (current && ref.revision > current.revision) activeScope?.cancel();
  });
  setHandler(mediaCancel, (jobId) => {
    if (jobId !== desired.jobId && jobId !== current?.jobId) return;
    cancellationJob = jobId;
    if (jobId === current?.jobId) activeScope?.cancel();
  });
  setHandler(mediaAuthRecovered, (generation) => {
    recoveryGeneration = generation;
  });
  setHandler(mediaState, () => ({ current, desired, phase }));

  const superseded = (ref: MediaJobRef) => desired.revision > ref.revision;
  while (true) {
    if (!(await condition(() => desired.revision > completedRevision, '10 minutes'))) {
      await condition(allHandlersFinished);
      if (desired.revision <= completedRevision) return;
    }
    current = desired;
    const ref = current;
    let authAttempts = input.resume && processedCount === 0 ? input.resume.authAttempts : 0;
    let archiveAttempts = input.resume && processedCount === 0 ? input.resume.archiveAttempts : 0;
    let waitCycles = 0;
    let archiveDueAt = input.resume && processedCount === 0 ? input.resume.archiveDueAt : undefined;
    let continuation: Resume | undefined;
    const resume = () => ({
      authAttempts,
      archiveAttempts,
      recoveryGeneration,
      ...(archiveDueAt ? { archiveDueAt } : {}),
    });
    activeScope = new CancellationScope();
    try {
      await activeScope.run(async () => {
        const obsolete = async (outcome?: MediaOutcome) => {
          if (outcome?.kind === 'completed') return;
          await projections.projectMediaFailure(
            ref,
            outcome?.kind === 'cancelled' ? 'CANCELLED' : outcome?.kind === 'deleted' ? 'SERMON_DELETED' : 'SUPERSEDED'
          );
        };
        if (cancellationJob === ref.jobId) {
          await projections.projectMediaFailure(ref, 'CANCELLED');
          return;
        }
        phase = 'preparing';
        let outcome: MediaOutcome = await projections.prepareMedia(ref);
        if (outcome.kind !== 'ready') {
          await obsolete(outcome);
          return;
        }
        if (workflowInfo().targetWorkerDeploymentVersionChanged) {
          continuation = resume();
          return;
        }
        while (true) {
          if (superseded(ref)) {
            await obsolete();
            return;
          }
          while (archiveDueAt && Date.now() < archiveDueAt) {
            phase = 'waiting_archive';
            await condition(
              () => superseded(ref) || workflowInfo().targetWorkerDeploymentVersionChanged,
              Math.min(5 * 60_000, archiveDueAt - Date.now())
            );
            if (superseded(ref)) {
              await obsolete();
              return;
            }
            if (workflowInfo().targetWorkerDeploymentVersionChanged) {
              continuation = resume();
              return;
            }
          }
          archiveDueAt = undefined;
          phase = 'acquiring';
          outcome = await operations.acquireMedia(ref);
          if (outcome.kind === 'ready') break;
          if (outcome.kind === 'completed') return;
          if (outcome.kind === 'superseded' || outcome.kind === 'deleted' || outcome.kind === 'cancelled') {
            await obsolete(outcome);
            return;
          }
          if (outcome.kind === 'restricted') {
            await projections.projectMediaFailure(ref, 'YOUTUBE_ACCOUNT_ACCESS_DENIED');
            return;
          }
          if (outcome.kind === 'waiting_archive') {
            archiveAttempts += 1;
            if (archiveAttempts > 12) {
              await projections.projectMediaFailure(ref, 'YOUTUBE_ARCHIVE_RETRY_EXHAUSTED');
              return;
            }
            phase = 'waiting_archive';
            await projections.projectMediaWaiting(ref, 'archive', archiveAttempts);
            archiveDueAt = Date.now() + ARCHIVE_DELAYS[Math.min(archiveAttempts - 1, ARCHIVE_DELAYS.length - 1)];
            continue;
          }
          phase = 'waiting_auth';
          await projections.projectMediaWaiting(ref, 'authentication', authAttempts);
          let observedGeneration = recoveryGeneration;
          while (true) {
            if (superseded(ref)) {
              await obsolete();
              return;
            }
            await condition(() => superseded(ref) || recoveryGeneration !== observedGeneration, '5 minutes');
            if (superseded(ref)) {
              await obsolete();
              return;
            }
            const recovery = await operations.recoverMediaAuthentication(ref);
            if (recovery.ready && recovery.generation && recovery.generation !== observedGeneration) {
              recoveryGeneration = recovery.generation;
              authAttempts += 1;
              if (authAttempts > 6) {
                await projections.projectMediaFailure(ref, 'YOUTUBE_AUTH_RETRY_EXHAUSTED');
                return;
              }
              break;
            }
            waitCycles += 1;
            observedGeneration = recoveryGeneration;
            if (
              waitCycles >= 100 ||
              workflowInfo().continueAsNewSuggested ||
              workflowInfo().targetWorkerDeploymentVersionChanged
            ) {
              continuation = resume();
              return;
            }
          }
        }
        if (superseded(ref)) {
          await obsolete();
          return;
        }
        if (workflowInfo().targetWorkerDeploymentVersionChanged) {
          continuation = resume();
          return;
        }
        phase = 'merging';
        const merged = await operations.mergeMedia(ref);
        if (merged.kind !== 'ready') {
          await obsolete(merged);
          return;
        }
        if (superseded(ref)) {
          await obsolete();
          return;
        }
        if (workflowInfo().targetWorkerDeploymentVersionChanged) {
          continuation = resume();
          return;
        }
        phase = 'publishing';
        const published = await projections.publishMedia(ref);
        if (published.kind !== 'ready') await obsolete(published);
      });
    } catch (error) {
      await CancellationScope.nonCancellable(async () => {
        await projections.projectMediaFailure(
          ref,
          isCancellation(error) && superseded(ref)
            ? 'SUPERSEDED'
            : isCancellation(error)
            ? 'CANCELLED'
            : 'MEDIA_PROCESSING_FAILED'
        );
      });
      if (isCancellation(error) && cancellationJob !== ref.jobId && !superseded(ref)) throw error;
    } finally {
      await CancellationScope.nonCancellable(async () => {
        await projections.cleanupMedia(ref);
        // Observer registration followed by a status read covers the late-registration race.
        if (!continuation)
          for (const observer of await projections.readMediaObservers(ref)) {
            try {
              await getExternalWorkflowHandle(observer).signal(mediaCompleted, {
                jobId: ref.jobId,
                projectId: ref.projectId,
              });
            } catch {
              /* Closed observers reconcile from the persisted terminal projection. */
            }
          }
      });
      activeScope = undefined;
    }
    if (continuation) {
      const rotate = workflowInfo().targetWorkerDeploymentVersionChanged
        ? makeContinueAsNewFunc<typeof SermonAudioCoordinator>({ initialVersioningBehavior: 'AUTO_UPGRADE' })
        : continueAsNew<typeof SermonAudioCoordinator>;
      await condition(allHandlersFinished);
      await rotate({
        initial: desired,
        mediaTaskQueue: input.mediaTaskQueue,
        ...(input.controlTaskQueue ? { controlTaskQueue: input.controlTaskQueue } : {}),
        ...(desired.jobId === ref.jobId ? { resume: continuation } : {}),
      });
    }
    completedRevision = ref.revision;
    processedCount += 1;
    current = null;
    phase = 'idle';
    // Continue with the current ref as already completed, so restart cannot redo a completed request.
    if (
      processedCount >= 50 ||
      workflowInfo().continueAsNewSuggested ||
      workflowInfo().targetWorkerDeploymentVersionChanged
    ) {
      await condition(allHandlersFinished);
      if (desired.revision > completedRevision) {
        const rotate = workflowInfo().targetWorkerDeploymentVersionChanged
          ? makeContinueAsNewFunc<typeof SermonAudioCoordinator>({ initialVersioningBehavior: 'AUTO_UPGRADE' })
          : continueAsNew<typeof SermonAudioCoordinator>;
        await rotate({
          initial: desired,
          mediaTaskQueue: input.mediaTaskQueue,
          ...(input.controlTaskQueue ? { controlTaskQueue: input.controlTaskQueue } : {}),
        });
      }
      // Idle coordinator can close; signalWithStart starts the next revision without losing ingress.
      return;
    }
  }
}

interface AwaitMediaInput {
  ref: MediaJobRef;
  mediaTaskQueue: string;
  controlTaskQueue?: string;
  nextCheckMs?: number;
}
type MediaCompletion = { kind: 'succeeded' | 'failed' | 'cancelled' | 'superseded' };

/** Delete waits for actual native shutdown before provider/source cleanup is allowed. */
export async function DrainSermonAudio(input: AwaitMediaInput): Promise<MediaCompletion> {
  const cancellation = proxyActivities<Pick<MediaActivities, 'requestMediaCancellation'>>({
    taskQueue: input.controlTaskQueue ?? 'urm-controls',
    startToCloseTimeout: '1 minute',
    scheduleToCloseTimeout: '30 minutes',
    retry: { initialInterval: '5 seconds', maximumInterval: '1 minute' },
  });
  await cancellation.requestMediaCancellation(input.ref);
  try {
    await getExternalWorkflowHandle(`audio:${input.ref.projectId}:${input.ref.sermonId}`).signal(
      mediaCancel,
      input.ref.jobId
    );
  } catch {
    /* A pending outbox observes the persisted cancellation before any native work begins. */
  }
  return AwaitSermonAudio(input);
}

/** A bounded dependency execution observes the sole coordinator; it never starts a second processor. */
export async function AwaitSermonAudio(input: AwaitMediaInput): Promise<MediaCompletion> {
  const observations = proxyActivities<
    Pick<MediaActivities, 'registerMediaObserver' | 'readMediaCompletion' | 'requestMediaCancellation'>
  >({
    taskQueue: input.controlTaskQueue ?? 'urm-controls',
    startToCloseTimeout: '1 minute',
    scheduleToCloseTimeout: '30 minutes',
    retry: { initialInterval: '5 seconds', maximumInterval: '1 minute' },
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  });
  let notified = false;
  let phase = 'registering';
  setHandler(defineQuery<string>('media.dependencyState'), () => phase);
  let nextCheckMs = input.nextCheckMs ?? 1000;
  setHandler(mediaCompleted, (ref) => {
    if (ref.jobId === input.ref.jobId && ref.projectId === input.ref.projectId) notified = true;
  });
  try {
    await observations.registerMediaObserver(input.ref, workflowInfo().workflowId);
    for (let checks = 0; ; checks++) {
      const completion = await observations.readMediaCompletion(input.ref);
      if (completion.kind !== 'pending') return { kind: completion.kind };
      phase = 'waiting';
      await condition(() => notified, nextCheckMs);
      notified = false;
      nextCheckMs = Math.min(5 * 60_000, nextCheckMs * 2);
      if (
        checks >= 200 ||
        workflowInfo().continueAsNewSuggested ||
        workflowInfo().targetWorkerDeploymentVersionChanged
      ) {
        await condition(allHandlersFinished);
        const rotate = workflowInfo().targetWorkerDeploymentVersionChanged
          ? makeContinueAsNewFunc<typeof AwaitSermonAudio>({ initialVersioningBehavior: 'AUTO_UPGRADE' })
          : continueAsNew<typeof AwaitSermonAudio>;
        await rotate({ ...input, nextCheckMs });
      }
    }
  } catch (error) {
    if (!isCancellation(error)) throw error;
    phase = 'cancelling';
    // Cancellation acknowledgement to the parent is delayed until native work has stopped and settled.
    await CancellationScope.nonCancellable(async () => {
      await observations.requestMediaCancellation(input.ref);
      try {
        await getExternalWorkflowHandle(`audio:${input.ref.projectId}:${input.ref.sermonId}`).signal(
          mediaCancel,
          input.ref.jobId
        );
      } catch {
        /* Reconcile completed/coordinator-restarted work from the persisted status. */
      }
      while ((await observations.readMediaCompletion(input.ref)).kind === 'pending')
        await condition(() => notified, '30 seconds');
    });
    throw error;
  }
}

export { MediaArtifactCleanup } from './retention';
