import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { tagMediaJobFailure, type MediaJobLaunchPhase } from './media-job-launch-failure';

import type { DurableCloudRunWorkerIdentity } from '@upperroom/orchestration/job-store';
export type CloudRunWorkerIdentity = DurableCloudRunWorkerIdentity;
interface CloudRunBinding {
  projectId: string;
  region: string;
  pool: string;
  revision: string;
  buildId: string;
  image: string;
  serviceAccount: string;
}
interface InstanceMetadata {
  projectId: string;
  projectNumber?: string;
  serviceAccount: string;
  instanceId: string;
}
const fail = (): never => {
  throw new Error('CLOUD_RUN_WORKER_IDENTITY_MISMATCH');
};
/** Join the provider's instance to one SDK process, including same-instance restarts. */
export function cloudRunPollerIdentity(instanceId: string, processId: string): string {
  if (
    !/^[A-Za-z0-9_-]{1,256}$/.test(instanceId) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(processId)
  )
    return fail();
  const instance = createHash('sha256').update(instanceId).digest('hex');
  return `cloud-run-${instance}-${processId}`;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : fail();

export function isCloudRunWorkerRevision(pool: string, revision: string): boolean {
  if (!/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(pool) || revision.length > 63) return false;
  const suffix = revision.slice(pool.length);
  return revision.startsWith(pool) && /^(?:-[a-z0-9][a-z0-9-]*|\.[1-9][0-9]*)$/.test(suffix);
}

/** Compare platform metadata and the authenticated Cloud Run revision GET.
 * Environment variables alone are not accepted as runtime execution evidence.
 */
function validateBinding(binding: CloudRunBinding, metadata: InstanceMetadata): void {
  if (
    !['urm-app-staging', 'urm-app'].includes(binding.projectId) ||
    binding.region !== 'us-central1' ||
    !isCloudRunWorkerRevision(binding.pool, binding.revision) ||
    !/^[a-f0-9]{40}$/.test(binding.buildId) ||
    !new RegExp(`^us-central1-docker\\.pkg\\.dev/${binding.projectId}/urm-temporal/worker@sha256:[a-f0-9]{64}$`).test(
      binding.image
    ) ||
    !binding.serviceAccount.endsWith(`@${binding.projectId}.iam.gserviceaccount.com`) ||
    metadata.projectId !== binding.projectId ||
    metadata.serviceAccount !== binding.serviceAccount ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(metadata.instanceId)
  )
    return fail();
}

export function verifyCloudRunWorkerIdentity(
  binding: CloudRunBinding,
  metadata: InstanceMetadata,
  rawRevision: unknown
): CloudRunWorkerIdentity {
  validateBinding(binding, metadata);
  const revision = record(rawRevision);
  const projects = [
    binding.projectId,
    ...(metadata.projectNumber && /^\d+$/.test(metadata.projectNumber) ? [metadata.projectNumber] : []),
  ];
  if (
    !projects.some(
      (project) =>
        revision.name ===
        `projects/${project}/locations/${binding.region}/workerPools/${binding.pool}/revisions/${binding.revision}`
    ) ||
    typeof revision.uid !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(revision.uid) ||
    revision.serviceAccount !== binding.serviceAccount ||
    !Array.isArray(revision.containers)
  )
    return fail();
  const workers = revision.containers.map(record).filter((container) => container.name === 'worker');
  if (workers.length !== 1 || workers[0].image !== binding.image || !Array.isArray(workers[0].env)) return fail();
  const variables = workers[0].env.map(record);
  if (variables.some((variable) => ['CLOUD_RUN_WORKER_POOL', 'CLOUD_RUN_REVISION'].includes(String(variable.name))))
    return fail();
  const builds = variables.filter((variable) => variable.name === 'TEMPORAL_BUILD_ID');
  if (builds.length !== 1 || builds[0].value !== binding.buildId) return fail();
  return {
    projectId: binding.projectId,
    region: binding.region,
    pool: binding.pool,
    revision: binding.revision,
    revisionUid: revision.uid,
    imageDigest: binding.image.split('@')[1],
    serviceAccount: binding.serviceAccount,
    instanceId: metadata.instanceId,
  };
}

// Fixed platform metadata endpoint only; no caller-supplied URL or redirects.
export async function readCloudRunMetadata(path: string, phase?: Extract<MediaJobLaunchPhase, `metadata-${string}`>) {
  const response = await fetch(`http://metadata.google.internal/computeMetadata/v1/${path}`, {
    headers: { 'Metadata-Flavor': 'Google' },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok && phase) {
    const error = new Error('CLOUD_RUN_WORKER_IDENTITY_MISMATCH');
    tagMediaJobFailure(phase, { status: response.status }, error);
    throw error;
  }
  if (!response.ok || response.headers.get('metadata-flavor') !== 'Google') return fail();
  const value = (await response.text()).trim();
  if (!value || value.length > 512) return fail();
  return value;
}

export async function loadCloudRunWorkerIdentity(
  buildId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<CloudRunWorkerIdentity> {
  const binding: CloudRunBinding = {
    projectId: env.FIREBASE_PROJECT_ID ?? '',
    region: env.TEMPORAL_CLOUD_REGION ?? '',
    pool: env.CLOUD_RUN_WORKER_POOL ?? '',
    revision: env.CLOUD_RUN_REVISION ?? '',
    buildId,
    image: env.TEMPORAL_WORKER_IMAGE ?? '',
    serviceAccount: env.TEMPORAL_CLOUD_RUN_SERVICE_ACCOUNT ?? '',
  };
  try {
    const [projectId, projectNumber, serviceAccount, instanceId] = await Promise.all([
      readCloudRunMetadata('project/project-id'),
      readCloudRunMetadata('project/numeric-project-id'),
      readCloudRunMetadata('instance/service-accounts/default/email'),
      readCloudRunMetadata('instance/id'),
    ]);
    validateBinding(binding, { projectId, projectNumber, serviceAccount, instanceId });
    const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
    const observed = await client.request({
      url: `https://run.googleapis.com/v2/projects/${binding.projectId}/locations/${binding.region}/workerPools/${binding.pool}/revisions/${binding.revision}`,
      method: 'GET',
      timeout: 5000,
      retry: false,
    });
    return verifyCloudRunWorkerIdentity(
      binding,
      { projectId, projectNumber, serviceAccount, instanceId },
      observed.data
    );
  } catch {
    return fail();
  }
}
