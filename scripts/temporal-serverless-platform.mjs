// Offline construction only. The release controller must prove native handoff,
// exact CI/image provenance and IAM before executing any returned command.
const projectId = 'urm-app-staging';
const region = 'us-central1';
const commit = /^[a-f0-9]{40}$/;
const roles = { orchestration: 'o', controls: 'c', media: 'm', email: 'e', images: 'i', search: 's' };
export function serverlessResourceNames(buildId, role) {
  if (typeof buildId !== 'string' || !commit.test(buildId)) throw new Error('A full source commit is required');
  if (typeof role !== 'string' || !Object.hasOwn(roles, role))
    throw new Error('An explicit reviewed worker role is required');
  return {
    deploymentName: role === 'orchestration' ? 'urm-worker-staging' : `urm-worker-${role}-staging`,
    taskQueue: `urm-${role}`,
    poolName: `urm-worker-${role}-${buildId.slice(0, 20)}`,
    runnerServiceAccount: `tw-${roles[role]}-${buildId.slice(0, 20)}@${projectId}.iam.gserviceaccount.com`,
    invokerServiceAccount: `ts-${roles[role]}-${buildId.slice(0, 20)}@${projectId}.iam.gserviceaccount.com`,
  };
}
function validateBinding(config) {
  const names = serverlessResourceNames(config.buildId, config.role);
  const fields = [
    'projectId',
    'region',
    'namespace',
    'deploymentName',
    'buildId',
    'role',
    'taskQueue',
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
    Object.entries(names).some(([key, expected]) => config[key] !== expected) ||
    typeof config.image !== 'string' ||
    !/^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/.test(config.image) ||
    !Number.isInteger(config.maxInstances) ||
    config.maxInstances < 1 ||
    config.maxInstances > 3 ||
    // Source bounds one workspace; fresh native effective disk quotas are a separate mandatory preparation gate.
    (config.role === 'media' && config.maxInstances !== 1) ||
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
  const { provider, scaler } = serverlessComputeSettings(config);
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
    provider.details.project,
    '--gcp-cloud-run-region',
    provider.details.region,
    '--gcp-cloud-run-worker-pool',
    provider.details.worker_pool,
    '--gcp-cloud-run-service-account',
    provider.details.service_account,
    '--gcp-cloud-run-min-instances',
    String(scaler.details.min_count),
    '--gcp-cloud-run-max-instances',
    String(scaler.details.max_count),
    '--gcp-cloud-run-initial-instances',
    String(scaler.details.initial_count),
    '--gcp-cloud-run-utilization-target',
    String(scaler.details.utilization_target),
    '--gcp-cloud-run-scale-down-stabilization-duration',
    `${scaler.details.no_sync_quiet_ms / 1000}s`,
  ];
}

// Temporal CLI v1.9.1 uses the SDK JSON payload encoding for both details maps.
// See internal/temporalcli/commands.worker.deployment.go at that tag.
export function serverlessComputeSettings(config) {
  validateBinding(config);
  return {
    provider: {
      type: 'gcp-cloud-run',
      details: {
        project: config.projectId,
        region: config.region,
        worker_pool: config.poolName,
        service_account: config.invokerServiceAccount,
      },
    },
    scaler: {
      type: 'rate-based',
      details: {
        min_count: 0,
        max_count: config.maxInstances,
        initial_count: 1,
        utilization_target: 0.8,
        no_sync_quiet_ms: config.stabilizationSeconds * 1000,
      },
    },
  };
}
