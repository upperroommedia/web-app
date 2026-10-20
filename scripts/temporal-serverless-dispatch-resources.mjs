import { serverlessResourceNames, serverlessComputeArguments } from './temporal-serverless-platform.mjs';
import { firebaseResourceEnvironment } from './temporal-platform.mjs';

const projectId = 'urm-app-staging';
const region = 'us-central1';
const parent = `projects/${projectId}/locations/${region}`;
/** Names are version-specific. None of these helpers performs remote operations. */
export function dispatchResourceNames(buildId) {
  serverlessResourceNames(buildId, 'controls'); // Full source commit validation.
  const suffix = buildId.slice(0, 20);
  const serviceId = `urm-dispatch-${suffix}`;
  return {
    serviceId,
    service: `${parent}/services/${serviceId}`,
    runnerServiceAccount: `td-r-${suffix}@${projectId}.iam.gserviceaccount.com`,
    eventServiceAccount: `td-e-${suffix}@${projectId}.iam.gserviceaccount.com`,
    schedulerServiceAccount: `td-s-${suffix}@${projectId}.iam.gserviceaccount.com`,
    reconcileJob: `${parent}/jobs/urm-dispatch-reconcile-${suffix}`,
  };
}
function validate(config) {
  if (
    !config ||
    Object.keys(config).some((key) => !['projectId', 'region', 'buildId', 'image', 'apiKeyVersion'].includes(key)) ||
    typeof config.apiKeyVersion !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(config.apiKeyVersion)
  )
    throw new Error('Invalid dispatch resource configuration');
  serverlessComputeArguments({
    projectId: config.projectId,
    region: config.region,
    buildId: config.buildId,
    namespace: `${projectId}.qwejt`,
    role: 'controls',
    ...serverlessResourceNames(config.buildId, 'controls'),
    image: config.image,
    maxInstances: 1,
    stabilizationSeconds: 180,
  });
}
/** Private request-billed service. Ingress permits managed Eventarc/Scheduler
 * delivery; IAM remains mandatory. This body never grants public invocation.
 * The existing image's tini entrypoint is retained, only its node target changes.
 */
export function renderServerlessDispatchService(config, admission) {
  if (!['disabled', 'enabled'].includes(admission)) throw new Error('Explicit dispatch admission required');
  validate(config);
  const names = dispatchResourceNames(config.buildId);
  const env = {
    NODE_ENV: 'production',
    NODE_OPTIONS: '--max-old-space-size=1536',
    ...firebaseResourceEnvironment({
      firebaseProjectId: projectId,
      firebaseResources: {
        storageBucket: 'urm-app-staging.firebasestorage.app',
        imagesBucket: 'urm-app-staging-images',
        databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com/',
      },
    }),
    TEMPORAL_CONNECTION_MODE: 'temporal-cloud',
    TEMPORAL_CLOUD_ACCOUNT_ID: 'qwejt',
    TEMPORAL_CLOUD_PROVIDER: 'gcp',
    TEMPORAL_CLOUD_REGION: region,
    TEMPORAL_ADDRESS: 'us-central1.gcp.api.temporal.io:7233',
    TEMPORAL_NAMESPACE: `${projectId}.qwejt`,
    TEMPORAL_DEPLOYMENT_NAME: 'urm-worker-staging',
    TEMPORAL_BUILD_ID: config.buildId,
    // Shared connection-config parser only; dispatch.ts creates no polling Worker or witness.
    TEMPORAL_WORKER_HOSTING: 'traditional',
    TEMPORAL_TASK_QUEUES: 'urm-orchestration',
    TEMPORAL_DISPATCHER_ENABLED: 'false',
    TEMPORAL_DISPATCH_ADMISSION: admission,
    TEMPORAL_API_KEY_FILE: '/run/temporal-cloud/api-key',
    TEMPORAL_DISPATCH_RECONCILE_JOB: names.reconcileJob,
  };
  return {
    name: names.service,
    ingress: 'INGRESS_TRAFFIC_ALL',
    invokerIamDisabled: false,
    scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
    labels: { 'urm-role': 'dispatch', 'urm-build': config.buildId },
    template: {
      serviceAccount: names.runnerServiceAccount,
      scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
      maxInstanceRequestConcurrency: 1,
      timeout: '30s',
      containers: [
        {
          name: 'dispatch',
          image: config.image,
          args: ['node', 'apps/temporal-worker/lib/apps/temporal-worker/src/dispatch.js'],
          env: Object.entries(env).map(([name, value]) => ({ name, value })),
          resources: { limits: { cpu: '1', memory: '2Gi' }, cpuIdle: true },
          ports: [{ containerPort: 8080 }],
          volumeMounts: [{ name: 'temporal-api', mountPath: '/run/temporal-cloud' }],
          startupProbe: {
            httpGet: { path: '/healthz', port: 8080 },
            periodSeconds: 5,
            timeoutSeconds: 2,
            failureThreshold: 24,
          },
        },
      ],
      volumes: [
        {
          name: 'temporal-api',
          secret: {
            secret: 'TEMPORAL_WORKER_API_KEY',
            defaultMode: 292,
            items: [{ version: config.apiKeyVersion, path: 'api-key' }],
          },
        },
      ],
    },
  };
}
/** Construct wake resources only after the service URL has been read from GCP.
 * A supplied object is not an authenticated readback: the controller must retain
 * the real service/revision/image/identity receipt and effective IAM checks.
 */
export function renderServerlessDispatchWakeups(config, observedService) {
  validate(config);
  const names = dispatchResourceNames(config.buildId);
  let url;
  try {
    url = new URL(observedService?.uri);
  } catch {
    throw new Error('Invalid observed dispatch service');
  }
  if (
    observedService.name !== names.service ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !url.hostname.startsWith(`${names.serviceId}-`) ||
    !/^[a-z0-9-]+\.(?:[a-z0-9-]+\.)?run\.app$/.test(url.hostname) ||
    observedService.uri !== url.origin
  )
    throw new Error('Invalid observed dispatch service');
  const triggers = ['durableJobOutbox', 'durableJobCommands'].map((collection, index) => ({
    name: `${parent}/triggers/urm-dispatch-${index === 0 ? 'outbox' : 'commands'}-${config.buildId.slice(0, 20)}`,
    eventFilters: [
      { attribute: 'type', value: 'google.cloud.firestore.document.v1.written' },
      { attribute: 'database', value: '(default)' },
      { attribute: 'document', value: `${collection}/*`, operator: 'match-path-pattern' },
    ],
    eventDataContentType: 'application/protobuf',
    serviceAccount: names.eventServiceAccount,
    destination: { cloudRun: { service: names.serviceId, region, path: '/dispatch' } },
    // Omit retryPolicy: specifying maxAttempts:1 disables normal delivery retry.
  }));
  return {
    triggers,
    scheduler: {
      name: names.reconcileJob,
      schedule: '* * * * *',
      timeZone: 'Etc/UTC',
      attemptDeadline: '30s',
      retryConfig: {
        retryCount: 3,
        maxRetryDuration: '180s',
        minBackoffDuration: '5s',
        maxBackoffDuration: '60s',
        maxDoublings: 3,
      },
      httpTarget: {
        uri: `${url.origin}/reconcile`,
        httpMethod: 'POST',
        oidcToken: { serviceAccountEmail: names.schedulerServiceAccount, audience: url.origin },
      },
    },
    serviceInvokerGrant: {
      resource: names.service,
      role: 'roles/run.invoker',
      members: [names.eventServiceAccount, names.schedulerServiceAccount].map((email) => `serviceAccount:${email}`),
    },
  };
}
