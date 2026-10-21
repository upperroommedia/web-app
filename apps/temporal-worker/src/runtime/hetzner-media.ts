import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { WorkerWitness } from './worker-witness';
import type { MediaJobRef } from '../../../process-audio/src/temporal/types';
import {
  createHetznerAcquisitionClient,
  createHetznerAcquisitionTransport,
} from '../../../process-audio/src/temporal/hetzner-acquisition';
import { prepareNativeYouTubeEpisode } from '../../../process-audio/src/temporal/hetzner-acquisition-episode';
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
  return async (ref: MediaJobRef, signal: AbortSignal) => {
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
