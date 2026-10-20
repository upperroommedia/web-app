import { ApplicationFailure, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type {
  WorkerReadinessRequest,
  WorkerReadinessReceipt,
  WorkerReadinessRole,
} from '../../runtime/readiness-probe';
const roles: readonly WorkerReadinessRole[] = ['orchestration', 'controls', 'media', 'email', 'images', 'search'];

/** Fresh inert per-role execution; does not admit application or provider work.
 * Public history carries only immutable private-receipt IDs and digests.
 */
export async function WorkerRuntimeProbe(input: {
  projectId: string;
  buildId: string;
  nonce: string;
  roles: WorkerReadinessRole[];
}): Promise<Record<string, WorkerReadinessReceipt>> {
  if (
    !input ||
    Object.keys(input).sort().join(',') !== 'buildId,nonce,projectId,roles' ||
    input.projectId !== 'urm-app-staging' ||
    !/^[a-f0-9]{40}$/.test(input.buildId) ||
    !/^[a-f0-9]{32}$/.test(input.nonce) ||
    workflowInfo().workflowId !== `serverless-readiness-${input.nonce}` ||
    !Array.isArray(input.roles) ||
    !input.roles.length ||
    input.roles.length > roles.length ||
    new Set(input.roles).size !== input.roles.length ||
    input.roles.some((role) => !roles.includes(role))
  )
    throw ApplicationFailure.nonRetryable('Invalid inert readiness request', 'INVALID_WORKER_READINESS_PROBE');
  const results: Record<string, WorkerReadinessReceipt> = {};
  for (const role of input.roles) {
    const activity = proxyActivities<{
      recordWorkerReadiness(request: WorkerReadinessRequest): Promise<WorkerReadinessReceipt>;
    }>({
      taskQueue: `urm-${role}`,
      startToCloseTimeout: '30 seconds',
      scheduleToCloseTimeout: '90 seconds',
      retry: { maximumAttempts: 1 },
    });
    const receipt = await activity.recordWorkerReadiness({
      projectId: input.projectId,
      buildId: input.buildId,
      nonce: input.nonce,
      role,
    });
    if (
      !receipt ||
      Object.keys(receipt).sort().join(',') !== 'digest,id' ||
      !/^[a-f0-9]{64}$/.test(receipt.id) ||
      !/^[a-f0-9]{64}$/.test(receipt.digest)
    )
      throw ApplicationFailure.nonRetryable('Invalid private readiness receipt', 'INVALID_WORKER_READINESS_RECEIPT');
    results[role] = receipt;
  }
  return results;
}
