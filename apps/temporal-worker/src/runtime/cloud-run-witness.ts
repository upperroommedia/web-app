import { GoogleAuth } from 'google-auth-library';

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
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : fail();

/** Compare platform metadata and the authenticated Cloud Run revision GET.
 * Environment variables alone are not accepted as runtime execution evidence.
 */
function validateBinding(binding: CloudRunBinding, metadata: InstanceMetadata): void {
  if (
    !['urm-app-staging', 'urm-app'].includes(binding.projectId) ||
    binding.region !== 'us-central1' ||
    !/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(binding.pool) ||
    !binding.revision.startsWith(`${binding.pool}-`) ||
    !/^[a-z0-9-]{1,63}$/.test(binding.revision) ||
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
    // Fixed platform metadata endpoint only; no caller-supplied URL or redirects.
    const metadata = async (path: string) => {
      const response = await fetch(`http://metadata.google.internal/computeMetadata/v1/${path}`, {
        headers: { 'Metadata-Flavor': 'Google' },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok || response.headers.get('metadata-flavor') !== 'Google') return fail();
      const value = (await response.text()).trim();
      if (!value || value.length > 512) return fail();
      return value;
    };
    const [projectId, projectNumber, serviceAccount, instanceId] = await Promise.all([
      metadata('project/project-id'),
      metadata('project/numeric-project-id'),
      metadata('instance/service-accounts/default/email'),
      metadata('instance/id'),
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
