import {
  ActivityCancellationType,
  condition,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import type { DurableJobRef, PublishingEvidenceRef } from '@upperroom/contracts/temporal';
export const publishingEvidenceAvailable = defineSignal<[PublishingEvidenceRef]>('publishingEvidenceAvailable');
const compilation = proxyActivities<{
  compilePublishingCriticalRepairEvidence(
    ref: DurableJobRef
  ): Promise<{ state: 'ready' | 'pending' | 'unavailable'; progressed?: true }>;
}>({
  taskQueue: 'urm-controls',
  startToCloseTimeout: '1 minute',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 5 },
});
export function receivePublishingEvidence(ref: DurableJobRef): () => number {
  let version = 0;
  const seen = new Set<string>();
  setHandler(publishingEvidenceAvailable, (payload) => {
    if (
      !payload ||
      payload.projectId !== ref.projectId ||
      payload.jobId !== ref.jobId ||
      !Number.isSafeInteger(payload.generation) ||
      payload.generation < 1 ||
      !/^[a-f0-9]{64}$/.test(payload.sessionId) ||
      !/^[a-f0-9]{64}$/.test(payload.factId)
    )
      return;
    if (seen.has(payload.factId)) return;
    seen.add(payload.factId);
    if (seen.size > 128) seen.delete(seen.values().next().value!);
    version++;
  });
  return () => version;
}
/** Evidence can wake this private compiler; it cannot return control to a desired mutation. */
export async function awaitPublishingReview(
  ref: DurableJobRef,
  options: { resumed(): boolean; evidenceVersion(): number; rotate(): Promise<never> }
): Promise<void> {
  let pages = 0;
  while (!options.resumed()) {
    if (pages >= 100 || workflowInfo().continueAsNewSuggested || workflowInfo().targetWorkerDeploymentVersionChanged)
      return options.rotate();
    const evidence = options.evidenceVersion();
    let result: { state: 'ready' | 'pending' | 'unavailable'; progressed?: true };
    try {
      result = await compilation.compilePublishingCriticalRepairEvidence(ref);
    } catch (error) {
      if (isCancellation(error)) throw error;
      await sleep('30 seconds');
      pages++;
      continue;
    }
    pages++;
    if (pages >= 100 || workflowInfo().continueAsNewSuggested || workflowInfo().targetWorkerDeploymentVersionChanged)
      return options.rotate();
    if (result.state === 'pending') {
      // A successful bounded metadata page has made progress. Scheduling the
      // next control activity yields to the queue without delaying review for
      // every compiler phase. Failures retain the backoff above; the page bound
      // and continuation preserve finite history.
      if (result.progressed !== true) await sleep('30 seconds');
      continue;
    }
    // Durable source signals provide the normal wake-up. A sparse fallback repairs
    // a missed historical notification without continuously polling unknown RPCs.
    await condition(() => options.resumed() || options.evidenceVersion() > evidence, '1 hour');
  }
}
