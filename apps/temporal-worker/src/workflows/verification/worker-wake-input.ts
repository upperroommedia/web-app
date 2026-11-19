import type { WorkerReadinessRole } from '../../runtime/readiness-probe';

export interface WorkerWakeProbeInput {
  projectId: string;
  buildId: string;
  nonce: string;
  role: WorkerReadinessRole;
  delayMs: number;
}

export function validWorkerWakeProbe(input: WorkerWakeProbeInput, workflowId: string): boolean {
  return Boolean(
    input &&
      Object.keys(input).sort().join(',') === 'buildId,delayMs,nonce,projectId,role' &&
      input.projectId === 'urm-app-staging' &&
      typeof input.buildId === 'string' &&
      /^[a-f0-9]{40}$/.test(input.buildId) &&
      typeof input.nonce === 'string' &&
      /^[a-f0-9]{32}$/.test(input.nonce) &&
      ['orchestration', 'controls', 'media', 'email', 'images', 'search'].includes(input.role) &&
      Number.isSafeInteger(input.delayMs) &&
      input.delayMs >= 1000 &&
      input.delayMs <= 3 * 60 * 60 * 1000 &&
      workflowId === `worker-wake-${input.nonce}`
  );
}
