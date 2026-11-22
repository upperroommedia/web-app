import { serverlessComputeArguments } from './temporal-serverless-platform.mjs';
import { firebaseResourceEnvironment } from './temporal-platform.mjs';
import { providerRuntimeEnvironment } from './provider-runtime-environment.mjs';

const commonSecrets = { TEMPORAL_SENTRY_DSN: 'TEMPORAL_WORKER_SENTRY_DSN' };
const roleSecrets = {
  orchestration: Object.fromEntries(
    [
      'SUBSPLASH_EMAIL',
      'SUBSPLASH_PASSWORD',
      'SOUNDCLOUD_CLIENT_ID',
      'SOUNDCLOUD_CLIENT_SECRET',
      'SOUNDCLOUD_REFRESH_TOKEN',
      'PROVIDER_EGRESS_RELAY_TOKEN',
      'RUNTIME_ALERT_RECIPIENTS',
      'ADMIN_BASE_URL',
    ].map((key) => [key, key])
  ),
  controls: {},
  media: {},
  images: {},
  search: { TEMPORAL_SEARCH_CONFIG_JSON: 'TEMPORAL_SEARCH_CONFIG' },
  email: Object.fromEntries(
    [
      'SMTP_CONNECTION_URI',
      'SMTP_PASSWORD',
      'CLIENT_SECRET',
      'REFRESH_TOKEN',
      'AUTH_TYPE',
      'CLIENT_ID',
      'HOST',
      'USER',
      'OAUTH_PORT',
      'OAUTH_SECURE',
      'TLS_OPTIONS',
      'DEFAULT_FROM',
      'DEFAULT_REPLY_TO',
      'MAIL_COLLECTION',
      'TEMPLATES_COLLECTION',
      'USERS_COLLECTION',
    ].map((key) => [key, key])
  ),
};
const version = (value) => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
/** Pure v2 request body. Rendering does not prove IAM, quota, filesystem access,
 * queue registration or any release gate. No resource is created by this module.
 */
export function renderServerlessWorkerPool(config, settings) {
  serverlessComputeArguments(config); // Reuse exact staging/version/role binding validation.
  if (
    !settings ||
    Object.keys(settings).some((key) => !['apiKeyVersion', 'runtimeSecrets', 'emailEgressVersion', 'youtubeRendererReleaseId'].includes(key)) ||
    !version(settings.apiKeyVersion) ||
    !Array.isArray(settings.runtimeSecrets) ||
    settings.runtimeSecrets.length > 32 ||
    (settings.emailEgressVersion !== undefined && (config.role !== 'email' || !version(settings.emailEgressVersion))) ||
    (settings.youtubeRendererReleaseId !== undefined && (
      config.role !== 'media' || config.projectId !== 'urm-app-staging' ||
      typeof settings.youtubeRendererReleaseId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(settings.youtubeRendererReleaseId)
    ))
  )
    throw new Error('Invalid serverless resource settings');
  const allowed = { ...commonSecrets, ...roleSecrets[config.role] };
  const seen = new Set();
  const secrets = settings.runtimeSecrets.map((binding) => {
    if (
      !binding ||
      Object.keys(binding).sort().join(',') !== 'name,secret,version' ||
      typeof binding.name !== 'string' ||
      !Object.hasOwn(allowed, binding.name) ||
      binding.secret !== allowed[binding.name] ||
      !version(binding.version) ||
      seen.has(binding.name)
    )
      throw new Error('Unapproved or duplicate role secret binding');
    seen.add(binding.name);
    return { name: binding.name, valueSource: { secretKeyRef: { secret: binding.secret, version: binding.version } } };
  });
  if (
    (config.role === 'search' && !seen.has('TEMPORAL_SEARCH_CONFIG_JSON')) ||
    (config.role === 'email' && !settings.emailEgressVersion)
  )
    throw new Error('Required role configuration is missing');
  if (config.role === 'orchestration' && (!seen.has('RUNTIME_ALERT_RECIPIENTS') || !seen.has('ADMIN_BASE_URL')))
    throw new Error('Orchestration operational alert configuration is required');
  const media = config.role === 'media';
  const environment = {
    NODE_ENV: 'production',
    NODE_OPTIONS: '--max-old-space-size=1536',
    ...firebaseResourceEnvironment({
      firebaseProjectId: config.projectId,
      firebaseResources: {
        storageBucket: 'urm-app-staging.firebasestorage.app',
        imagesBucket: 'urm-app-staging-images',
        databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com/',
      },
    }),
    ...providerRuntimeEnvironment(config.projectId),
    TEMPORAL_CONNECTION_MODE: 'temporal-cloud',
    TEMPORAL_CLOUD_ACCOUNT_ID: 'qwejt',
    TEMPORAL_CLOUD_PROVIDER: 'gcp',
    TEMPORAL_CLOUD_REGION: config.region,
    TEMPORAL_ADDRESS: 'us-central1.gcp.api.temporal.io:7233',
    TEMPORAL_NAMESPACE: config.namespace,
    TEMPORAL_DEPLOYMENT_NAME: config.deploymentName,
    TEMPORAL_BUILD_ID: config.buildId,
    TEMPORAL_WORKER_HOSTING: 'cloud-run',
    TEMPORAL_WORKER_IMAGE: config.image,
    TEMPORAL_CLOUD_RUN_SERVICE_ACCOUNT: config.runnerServiceAccount,
    TEMPORAL_API_KEY_FILE: '/run/temporal-cloud/api-key',
    TEMPORAL_TASK_QUEUES: config.taskQueue,
    TEMPORAL_DISPATCHER_ENABLED: 'false',
    TEMPORAL_MEDIA_CONCURRENCY: '1',
    TMPDIR: '/tmp',
    ...(media
      ? {
          TEMPORAL_MEDIA_YOUTUBE_ACQUISITION: 'hetzner-render-v1',
          TEMPORAL_MEDIA_MAX_SOURCE_BYTES: String(20 * 2 ** 30),
          TEMPORAL_MEDIA_MAX_OUTPUT_BYTES: String(20 * 2 ** 30),
          TEMPORAL_MEDIA_WORKSPACE_MAX_BYTES: String(64 * 2 ** 30),
          TEMPORAL_MEDIA_DISK_HEADROOM_BYTES: String(16 * 2 ** 30),
        }
      : {}),
    ...(settings.youtubeRendererReleaseId ? {
      TEMPORAL_MEDIA_YOUTUBE_RENDER_TARGET: 'moses',
      TEMPORAL_MEDIA_YOUTUBE_RENDER_RELEASE_ID: settings.youtubeRendererReleaseId,
    } : {}),
    ...(config.role === 'email' ? { EMAIL_EGRESS_DESCRIPTOR_PATH: '/run/email/egress.json' } : {}),
  };
  const volumes = [
    {
      name: 'temporal-api',
      secret: {
        secret: 'TEMPORAL_WORKER_API_KEY',
        defaultMode: 292,
        items: [{ version: settings.apiKeyVersion, path: 'api-key' }],
      },
    },
    { name: 'scratch', emptyDir: { medium: media ? 'DISK' : 'MEMORY', sizeLimit: media ? '100Gi' : '256Mi' } },
    ...(config.role === 'email'
      ? [
          {
            name: 'email-egress',
            secret: {
              secret: 'TEMPORAL_EMAIL_EGRESS_DESCRIPTOR',
              defaultMode: 292,
              items: [{ version: settings.emailEgressVersion, path: 'egress.json' }],
            },
          },
        ]
      : []),
  ];
  return {
    name: `projects/${config.projectId}/locations/${config.region}/workerPools/${config.poolName}`,
    launchStage: 'BETA',
    labels: { 'urm-role': config.role, 'urm-build': config.buildId },
    scaling: { manualInstanceCount: 0 },
    template: {
      serviceAccount: config.runnerServiceAccount,
      containers: [
        {
          name: 'worker',
          image: config.image,
          env: [...Object.entries(environment).map(([name, value]) => ({ name, value })), ...secrets],
          resources: { limits: { cpu: media ? '2' : '1', memory: media ? '4Gi' : '2Gi' } },
          volumeMounts: [
            { name: 'temporal-api', mountPath: '/run/temporal-cloud' },
            { name: 'scratch', mountPath: '/tmp' },
            ...(config.role === 'email' ? [{ name: 'email-egress', mountPath: '/run/email' }] : []),
          ],
          startupProbe: {
            httpGet: { path: '/healthz', port: 8080 },
            periodSeconds: 5,
            timeoutSeconds: 2,
            failureThreshold: 24,
          },
        },
      ],
      volumes,
    },
  };
}

/** Additive resource-scoped IAM intents, not replacement policies or live grants.
 * The caller must merge against fresh policies with their etags. Runtime data
 * permissions and Temporal's account-specific scaler impersonators are separate
 * prerequisites. Secret IAM covers the secret resource; pinned versions in the
 * pool do not imply version-limited access. Inherited grants must be audited too.
 */
export function serverlessWorkerResourceGrants(config, settings) {
  const pool = renderServerlessWorkerPool(config, settings);
  const runner = `serviceAccount:${config.runnerServiceAccount}`;
  const scaler = `serviceAccount:${config.invokerServiceAccount}`;
  const secrets = new Set([
    ...pool.template.volumes.filter((volume) => volume.secret).map((volume) => volume.secret.secret),
    ...pool.template.containers[0].env
      .filter((entry) => entry.valueSource?.secretKeyRef)
      .map((entry) => entry.valueSource.secretKeyRef.secret),
  ]);
  return [
    ...[...secrets].sort().map((secret) => ({
      resource: `projects/${config.projectId}/secrets/${secret}`,
      role: 'roles/secretmanager.secretAccessor',
      members: [runner],
    })),
    { resource: pool.name, role: 'roles/run.viewer', members: [runner] },
    { resource: pool.name, role: 'roles/run.developer', members: [scaler] },
    {
      resource: `projects/${config.projectId}/serviceAccounts/${config.runnerServiceAccount}`,
      role: 'roles/iam.serviceAccountUser',
      members: [scaler],
    },
  ];
}
