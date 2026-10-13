import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

// Reviewed deployment bindings, never inferred from caller-supplied namespace names.
const CLOUD_ACCOUNT_ID = 'qwejt';
const CLOUD_NAMESPACES: Readonly<Record<string, string>> = Object.freeze({
  'urm-app-staging': 'urm-app-staging.qwejt',
  'urm-app': 'urm-app.qwejt',
});
const CLOUD_ADDRESS = 'us-central1.gcp.api.temporal.io:7233';
export const TASK_QUEUES = [
  'urm-orchestration',
  'urm-controls',
  'urm-media',
  'urm-email',
  'urm-images',
  'urm-search',
] as const;
export interface RuntimeConfig {
  connectionMode: 'self-hosted' | 'temporal-cloud';
  readonly cloudAccountId?: string;
  readonly cloudProvider?: 'gcp';
  readonly cloudRegion?: 'us-central1';
  apiKey?: string;
  projectId: string;
  namespace: string;
  address: string;
  deploymentName: string;
  buildId: string;
  queues: string[];
  workflowBundle: string;
  port: number;
  dispatcherEnabled: boolean;
  mediaConcurrency: number;
  controlsConcurrency: number;
  tls?:
    | true
    | { serverNameOverride?: string; serverRootCACertificate: Buffer; clientCertPair: { crt: Buffer; key: Buffer } };
}
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  const projectId = required('FIREBASE_PROJECT_ID');
  const namespace = required('TEMPORAL_NAMESPACE');
  const connectionMode = env.TEMPORAL_CONNECTION_MODE || 'self-hosted';
  if (connectionMode !== 'self-hosted' && connectionMode !== 'temporal-cloud')
    throw new Error('Invalid Temporal connection mode');
  const cloud = connectionMode === 'temporal-cloud';
  if (!cloud && namespace !== projectId) throw new Error('Temporal namespace must equal Firebase project ID');
  const production = env.NODE_ENV === 'production';
  const cert = env.TEMPORAL_TLS_CERT_FILE;
  const key = env.TEMPORAL_TLS_KEY_FILE;
  const ca = env.TEMPORAL_TLS_CA_FILE;
  let apiKey: string | undefined;
  if (env.TEMPORAL_API_KEY) throw new Error('Temporal API keys must use a mounted file');
  if (cloud) {
    if (!CLOUD_NAMESPACES[projectId] || namespace !== CLOUD_NAMESPACES[projectId])
      throw new Error('Temporal Cloud namespace must match its trusted Firebase project binding');
    if (required('TEMPORAL_CLOUD_ACCOUNT_ID') !== CLOUD_ACCOUNT_ID)
      throw new Error('Temporal Cloud account does not match its trusted deployment binding');
    if (required('TEMPORAL_CLOUD_PROVIDER') !== 'gcp' || required('TEMPORAL_CLOUD_REGION') !== 'us-central1')
      throw new Error('Temporal Cloud must use GCP us-central1, matching Firebase App Hosting');
    // Namespace DNS follows the active region after Cloud failover. The fixed regional
    // address remains supported for single-region namespaces and diagnostic deployments.
    const address = required('TEMPORAL_ADDRESS');
    const namespaceAddress = `${CLOUD_NAMESPACES[projectId]}.tmprl.cloud:7233`;
    if (address !== namespaceAddress && address !== CLOUD_ADDRESS)
      throw new Error('Temporal Cloud must use its exact trusted namespace or GCP us-central1 TLS endpoint');
    if (env.TEMPORAL_TLS === 'false' || env.TEMPORAL_TLS_DISABLED === 'true')
      throw new Error('Temporal Cloud requires TLS server authentication');
    if ([cert, key, ca, env.TEMPORAL_TLS_SERVER_NAME].some(Boolean))
      throw new Error('Temporal Cloud API key authentication cannot mix with mutual TLS or TLS overrides');
    const apiKeyFile = required('TEMPORAL_API_KEY_FILE');
    if (!isAbsolute(apiKeyFile)) throw new Error('Temporal API key file must be an absolute mounted path');
    try {
      apiKey = readFileSync(apiKeyFile, 'utf8').trim();
    } catch {
      throw new Error('Cannot read mounted Temporal API key file');
    }
    if (!apiKey || /\s/.test(apiKey) || Buffer.byteLength(apiKey) > 16 * 1024)
      throw new Error('Invalid mounted Temporal API key');
  } else if (
    [
      env.TEMPORAL_API_KEY_FILE,
      env.TEMPORAL_CLOUD_ACCOUNT_ID,
      env.TEMPORAL_CLOUD_PROVIDER,
      env.TEMPORAL_CLOUD_REGION,
    ].some(Boolean)
  ) {
    throw new Error('Cloud credentials require explicit Temporal Cloud mode');
  }
  if (!cloud && production && (!cert || !key || !ca)) throw new Error('Production requires private mutual TLS');
  if ([cert, key, ca].some(Boolean) && !(cert && key && ca))
    throw new Error('Mutual TLS files must be supplied together');
  const buildId = required('TEMPORAL_BUILD_ID');
  if (production && readFileSync('/etc/temporal-worker-build-id', 'utf8').trim() !== buildId)
    throw new Error('Worker deployment build does not match its immutable image');
  const queues = (env.TEMPORAL_TASK_QUEUES || TASK_QUEUES.join(',')).split(',').map((q) => q.trim());
  if (!queues.length || queues.some((q) => !TASK_QUEUES.includes(q as (typeof TASK_QUEUES)[number])))
    throw new Error('Unknown worker queue');
  const controlsConcurrency = Number(env.TEMPORAL_CONTROLS_CONCURRENCY || 10);
  if (!Number.isInteger(controlsConcurrency) || controlsConcurrency < 1 || controlsConcurrency > 100)
    throw new Error('Invalid controls concurrency');
  const mediaConcurrency = Number(env.TEMPORAL_MEDIA_CONCURRENCY || 2);
  if (!Number.isInteger(mediaConcurrency) || mediaConcurrency < 1 || mediaConcurrency > 16)
    throw new Error('Invalid media concurrency');
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid health port');
  return Object.freeze({
    connectionMode,
    ...(cloud
      ? { cloudAccountId: CLOUD_ACCOUNT_ID, cloudProvider: 'gcp' as const, cloudRegion: 'us-central1' as const, apiKey }
      : {}),
    mediaConcurrency,
    controlsConcurrency,
    projectId,
    namespace,
    address: required('TEMPORAL_ADDRESS'),
    deploymentName: required('TEMPORAL_DEPLOYMENT_NAME'),
    buildId,
    queues,
    dispatcherEnabled:
      env.TEMPORAL_DISPATCHER_ENABLED === undefined
        ? queues.includes('urm-orchestration')
        : env.TEMPORAL_DISPATCHER_ENABLED === 'true',
    workflowBundle: required('TEMPORAL_WORKFLOW_BUNDLE'),
    port,
    tls: cloud
      ? true
      : cert && key && ca
      ? {
          serverRootCACertificate: readFileSync(ca),
          ...(env.TEMPORAL_TLS_SERVER_NAME ? { serverNameOverride: env.TEMPORAL_TLS_SERVER_NAME } : {}),
          clientCertPair: { crt: readFileSync(cert), key: readFileSync(key) },
        }
      : undefined,
  });
}

/** Private equality witness for mounted credential rotation. Never emit this digest or credentials. */
export function runtimeCredentialFingerprint(config: Pick<RuntimeConfig, 'tls' | 'apiKey'>): string | undefined {
  if (!config.tls && !config.apiKey) return undefined;
  const hash = createHash('sha256');
  const field = (value: string | Buffer) => {
    hash.update(`${Buffer.byteLength(value)}:`).update(value);
  };
  field(config.apiKey || '');
  if (config.tls && config.tls !== true) {
    field(config.tls.serverNameOverride || '');
    field(config.tls.serverRootCACertificate);
    field(config.tls.clientCertPair.crt);
    field(config.tls.clientCertPair.key);
  }
  return hash.digest('hex');
}

/** An authenticated lookup must confirm the exact immutable binding before Firebase initialization. */
export function assertRuntimeNamespace(
  config: Pick<RuntimeConfig, 'namespace'>,
  describedName: string | null | undefined
): void {
  if (describedName !== config.namespace) throw new Error('Temporal returned a different namespace');
}
