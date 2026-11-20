import { sleep, workflowInfo } from '@temporalio/workflow';

export interface DispatchWakeProbeInput {
  projectId: string;
  buildId: string;
  nonce: string;
  operationId: string;
  surface: 'outbox' | 'commands';
}
/** Literal diagnostic: no Activities, providers, children, signals or continuation. */
export async function DispatchWakeProbe(input: DispatchWakeProbeInput) {
  if (
    !input ||
    Object.keys(input).sort().join(',') !== 'buildId,nonce,operationId,projectId,surface' ||
    !Object.values(input).every((value) => typeof value === 'string') ||
    input.projectId !== 'urm-app-staging' ||
    !/^[a-f0-9]{40}$/.test(input.buildId) ||
    !/^[a-f0-9]{32}$/.test(input.nonce) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.operationId) ||
    !['outbox', 'commands'].includes(input.surface) ||
    workflowInfo().workflowId !== `dispatch-diagnostic-${input.operationId}-${input.surface}`
  )
    throw new Error('DISPATCH_DIAGNOSTIC_INPUT_INVALID');
  await sleep(2000);
  return { nonce: input.nonce, runId: workflowInfo().runId };
}
