// Offline construction only. The release controller must prove native handoff,
// exact CI/image provenance and IAM before executing any returned command.
const projectId = 'urm-app-staging';
const region = 'us-central1';
const commit = /^[a-f0-9]{40}$/;
export function serverlessResourceNames(buildId) {
  if (typeof buildId !== 'string' || !commit.test(buildId)) throw new Error('A full source commit is required');
  return {
    poolName: `urm-worker-${buildId.slice(0, 20)}`,
    runnerServiceAccount: `temporal-w-${buildId.slice(0, 16)}@${projectId}.iam.gserviceaccount.com`,
    invokerServiceAccount: `temporal-s-${buildId.slice(0, 16)}@${projectId}.iam.gserviceaccount.com`,
  };
}
function validateBinding(config) {
  const names = serverlessResourceNames(config.buildId);
  const fields = [
    'projectId',
    'region',
    'namespace',
    'deploymentName',
    'buildId',
    'poolName',
    'runnerServiceAccount',
    'invokerServiceAccount',
    'image',
    'maxInstances',
    'stabilizationSeconds',
  ];
  if (
    Object.keys(config).some((key) => !fields.includes(key)) ||
    config.projectId !== projectId ||
    config.region !== region ||
    config.namespace !== `${projectId}.qwejt` ||
    config.deploymentName !== 'urm-worker-staging' ||
    Object.entries(names).some(([key, expected]) => config[key] !== expected) ||
    typeof config.image !== 'string' ||
    !/^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/.test(config.image) ||
    !Number.isInteger(config.maxInstances) ||
    config.maxInstances < 1 ||
    config.maxInstances > 3 ||
    !Number.isInteger(config.stabilizationSeconds) ||
    config.stabilizationSeconds < 90 ||
    config.stabilizationSeconds > 7200
  )
    throw new Error('Invalid immutable serverless staging binding');
}
/** Attach compute only after old traditional queue pollers are authoritatively drained.
 * This neither promotes a version nor proves that its pool can wake or run safely.
 * The invoker is Temporal's scaler identity, never the workload runner identity.
 */
export function serverlessComputeArguments(config) {
  validateBinding(config);
  return [
    'worker',
    'deployment',
    'update-version-compute-config',
    '--namespace',
    config.namespace,
    '--deployment-name',
    config.deploymentName,
    '--build-id',
    config.buildId,
    '--gcp-cloud-run-project',
    config.projectId,
    '--gcp-cloud-run-region',
    config.region,
    '--gcp-cloud-run-worker-pool',
    config.poolName,
    '--gcp-cloud-run-service-account',
    config.invokerServiceAccount,
    '--gcp-cloud-run-min-instances',
    '0',
    '--gcp-cloud-run-max-instances',
    String(config.maxInstances),
    '--gcp-cloud-run-initial-instances',
    '0',
    '--gcp-cloud-run-utilization-target',
    '0.8',
    '--gcp-cloud-run-scale-down-stabilization-duration',
    `${config.stabilizationSeconds}s`,
  ];
}
