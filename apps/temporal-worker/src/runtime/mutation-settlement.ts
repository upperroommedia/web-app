import type { DurableJob } from '@upperroom/contracts/temporal';
import type { DurableJobPatch } from '@upperroom/orchestration/job-store';
const codes = new Set([
  'PROVIDER_MUTATION_UNRESOLVED',
  'PUBLISHING_CANCEL_MUTATION_REVIEW_REQUIRED',
  'PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED',
]);
/** Only the certificate interpreter's actual canonical/session commit can clear an active mutable barrier. */
export function createMutationSettlementProjection(
  job: DurableJob,
  result: { state: string; settledUiStepIds?: string[]; settledMutationSessionIds?: string[] },
  now: number
): DurableJobPatch | undefined {
  if (result.state !== 'completed') return;
  const sessions = new Set((result.settledMutationSessionIds ?? []).filter((id) => /^[a-f0-9]{64}$/.test(id)));
  const steps = new Set(result.settledUiStepIds ?? []);
  const settledSteps = job.steps
    .filter((step) => steps.has(step.id) && step.state !== 'succeeded')
    .map((step) => {
      const { error, nextRetryAt, ...prior } = step;
      return { ...prior, state: 'succeeded' as const, finishedAt: now };
    });
  const currentSession = typeof job.result?.mutationSessionId === 'string' ? job.result.mutationSessionId : undefined;
  const clearsSession = Boolean(currentSession && sessions.has(currentSession));
  const clearsError = Boolean(
    job.error &&
      codes.has(job.error.code) &&
      (clearsSession || (job.attention?.stepId && steps.has(job.attention.stepId)))
  );
  if (!settledSteps.length && !clearsSession && !clearsError) return;
  const nextResult = { ...job.result };
  if (clearsSession) delete nextResult.mutationSessionId;
  return {
    expectedRevision: job.revision,
    ...(settledSteps.length ? { steps: settledSteps } : {}),
    ...(clearsSession ? { result: nextResult } : {}),
    ...(clearsError
      ? {
          error: undefined,
          ...(!job.attention?.receiptId && !job.attention?.acknowledgementId ? { attention: undefined } : {}),
        }
      : {}),
  };
}
