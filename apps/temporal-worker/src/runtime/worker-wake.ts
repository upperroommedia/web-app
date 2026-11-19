import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { validWorkerWakeProbe, type WorkerWakeProbeInput } from '../workflows/verification/worker-wake-input';

export function createWorkerWakeActivities(options: {
  projectId: string;
  buildId: string;
  queue: string;
  identity: string;
}) {
  return {
    async probeWorkerWake(input: WorkerWakeProbeInput): Promise<string> {
      const { info } = Context.current();
      if (
        info.workflowType !== 'WorkerWakeProbe' ||
        info.workflowNamespace !== 'urm-app-staging.qwejt' ||
        !validWorkerWakeProbe(input, info.workflowExecution?.workflowId ?? '') ||
        input.projectId !== options.projectId ||
        input.buildId !== options.buildId ||
        options.queue !== `urm-${input.role}` ||
        info.taskQueue !== options.queue
      )
        throw ApplicationFailure.nonRetryable('Invalid worker wake execution', 'INVALID_WORKER_WAKE_EXECUTION');

      if (info.attempt === 1)
        throw ApplicationFailure.retryable('Intentional wake probe retry', 'WORKER_WAKE_RETRY', options.identity);
      if (info.attempt !== 2)
        throw ApplicationFailure.nonRetryable('Unexpected wake probe attempt', 'INVALID_WORKER_WAKE_ATTEMPT');
      return options.identity;
    },
  };
}
