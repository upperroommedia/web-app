import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { WorkerWitness } from './worker-witness';
import type { MediaJobRef, MediaArchiveWait } from '../../../process-audio/src/temporal/types';
import {
  createHetznerAcquisitionClient,
  createHetznerAcquisitionTransport,
} from '../../../process-audio/src/temporal/hetzner-acquisition';
import {
  prepareNativeYouTubeEpisode,
  recordNativeYouTubeArchiveWait,
} from '../../../process-audio/src/temporal/hetzner-acquisition-episode';
const fail = (): never => {
  throw ApplicationFailure.nonRetryable(
    'YouTube acquisition binding is unavailable.',
    'YOUTUBE_ACQUISITION_BINDING_REQUIRED'
  );
};
/** Explicit staging binding only. The rendered pools do not enable it until the
 * retained host's shared-capacity/bootstrap gates pass. No remote-to-local fallback. */
export function createRuntimeYouTubeAcquisition(o: {
  projectId: string;
  firestore: Firestore;
  witness?: WorkerWitness;
  assertCurrent: (tx: Transaction, ref: MediaJobRef) => Promise<unknown>;
}) {
  const mode = process.env.TEMPORAL_MEDIA_YOUTUBE_ACQUISITION;
  if (mode === undefined) return undefined;
  if (mode !== 'hetzner-v1' || o.projectId !== 'urm-app-staging' || process.env.TEMPORAL_WORKER_HOSTING !== 'cloud-run')
    return fail();
  let client: ReturnType<typeof createHetznerAcquisitionClient> | undefined;
  return async (ref: MediaJobRef, signal: AbortSignal, archiveResume?: MediaArchiveWait) => {
    signal.throwIfAborted();
    const w = o.witness,
      cloud = w?.cloudRun;
    if (
      !w ||
      !cloud ||
      cloud.projectId !== o.projectId ||
      cloud.region !== 'us-central1' ||
      cloud.serviceAccount !== `tw-m-${w.buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com` ||
      !/^[a-f0-9]{40}$/.test(w.buildId) ||
      !cloud.instanceId ||
      Context.current().info.activityType !== 'acquireMedia'
    )
      return fail();
    const info = Context.current().info;
    if (!info.workflowExecution) return fail();
    await prepareNativeYouTubeEpisode({
      archiveResume,
      invocation: {
        workflowId: info.workflowExecution.workflowId,
        runId: info.workflowExecution.runId,
        activityId: info.activityId,
        attempt: info.attempt,
      },
      firestore: o.firestore,
      ref,
      caller: { buildId: w.buildId, serviceAccount: cloud.serviceAccount, instanceId: cloud.instanceId },
      assertCurrent: async (tx, bound) => {
        signal.throwIfAborted();
        await o.assertCurrent(tx, bound);
        signal.throwIfAborted();
      },
    });
    signal.throwIfAborted();
    client ??= createHetznerAcquisitionClient({
      request: createHetznerAcquisitionTransport(o.projectId),
      heartbeat: () => Context.current().heartbeat({ stage: 'youtube-acquisition' }),
    });
    return client.acquire(ref, signal);
  };
}

/** The existing projection Activity records archive intent before the native
 * Workflow timer. Local/traditional jobs with no remote delegation are unchanged.
 * HTTP and the host cannot call this native projection entrypoint. */
export function createRuntimeYouTubeArchiveWaitRecorder(o: {
  projectId: string;
  firestore: Firestore;
  witness?: WorkerWitness;
  assertCurrent: (tx: Transaction, ref: MediaJobRef) => Promise<unknown>;
}) {
  if (o.projectId !== 'urm-app-staging') return undefined;
  return async (ref: MediaJobRef, wait: MediaArchiveWait) => {
    const wall = Date.now(),
      mono = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined, context: Context | undefined;
    const fresh = () => {
      if (Date.now() < wall || Date.now() - wall >= 5000 || performance.now() - mono >= 5000)
        throw new Error('ARCHIVE_OBSERVATION_EXPIRED');
    };
    const work = async () => {
      context = Context.current();
      context.cancellationSignal.throwIfAborted();
      const { youtubeAcquisitionId } = await import('../../../process-audio/src/temporal/hetzner-acquisition');
      const root = await o.firestore.doc(`temporalYouTubeAcquisitions/${youtubeAcquisitionId(ref)}`).get();
      fresh();
      if (!root.exists) return;
      context.cancellationSignal.throwIfAborted();
      const info = context.info,
        w = o.witness;
      if (
        !info.workflowExecution ||
        info.activityType !== 'projectMediaWaiting' ||
        !w?.cloudRun ||
        w.cloudRun.projectId !== o.projectId ||
        w.cloudRun.region !== 'us-central1' ||
        !/^[a-f0-9]{40}$/.test(w.buildId)
      )
        return fail();
      await recordNativeYouTubeArchiveWait({
        firestore: o.firestore,
        ref,
        wait,
        sourceBuildId: w.buildId,
        invocation: {
          workflowId: info.workflowExecution.workflowId,
          runId: info.workflowExecution.runId,
          activityId: info.activityId,
          attempt: info.attempt,
        },
        assertCurrent: async (tx, bound) => {
          fresh();
          context!.cancellationSignal.throwIfAborted();
          await o.assertCurrent(tx, bound);
          fresh();
          context!.cancellationSignal.throwIfAborted();
        },
      });
      fresh();
      context.cancellationSignal.throwIfAborted();
    };
    try {
      await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('ARCHIVE_OBSERVATION_EXPIRED')), 5000);
        }),
      ]);
      fresh();
    } catch {
      if (context?.cancellationSignal.aborted) context.cancellationSignal.throwIfAborted();
      throw ApplicationFailure.create({
        message: 'YouTube archive wait cannot be verified.',
        type: 'YOUTUBE_ARCHIVE_WAIT_UNCONFIRMED',
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
