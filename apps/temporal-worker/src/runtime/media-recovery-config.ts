import { loadRuntimeConfig, type RuntimeConfig } from './config';
const queue = 'urm-media-kernel-recovery',
  deployment = 'urm-worker-media-recovery-staging';
export function isMediaRecoveryConfiguration(env: NodeJS.ProcessEnv = process.env) {
  return (
    env.TEMPORAL_MEDIA_RECOVERY_OPERATION !== undefined ||
    env.TEMPORAL_TASK_QUEUES?.split(',').some((q) => q.trim() === queue) ||
    env.TEMPORAL_DEPLOYMENT_NAME === deployment
  );
}
/** A separate fixed image entrypoint. Normal configuration never learns this
 * queue; the copy below only reuses its unchanged credential/TLS/build checks. */
export function loadMediaRecoveryRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): RuntimeConfig & { operationId: string } {
  const operationId = env.TEMPORAL_MEDIA_RECOVERY_OPERATION;
  if (
    env.NODE_ENV !== 'production' ||
    env.FIREBASE_PROJECT_ID !== 'urm-app-staging' ||
    env.TEMPORAL_WORKER_HOSTING !== 'cloud-run' ||
    env.TEMPORAL_WORKFLOW_BUNDLE !== '/workspace/apps/temporal-worker/lib/media-recovery-workflow-bundle.js' ||
    env.TEMPORAL_TASK_QUEUES !== queue ||
    env.TEMPORAL_DEPLOYMENT_NAME !== deployment ||
    env.TEMPORAL_DISPATCHER_ENABLED !== 'false' ||
    env.TEMPORAL_MEDIA_CONCURRENCY !== '1' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId ?? '')
  )
    throw new Error('MEDIA_RECOVERY_CONFIGURATION_UNCONFIRMED');
  const base = loadRuntimeConfig({
    ...env,
    TEMPORAL_TASK_QUEUES: 'urm-media',
    TEMPORAL_DEPLOYMENT_NAME: 'urm-worker-media-staging',
  });
  return Object.freeze({
    ...base,
    queues: Object.freeze([queue]) as unknown as string[],
    deploymentName: deployment,
    operationId: operationId!,
  });
}
