import { createHash } from 'node:crypto';
import { verifyCloudRunRtdbReadiness } from './cloud-run-rtdb-readiness';
import { Context } from '@temporalio/activity';
import type { Firestore } from 'firebase-admin/firestore';
import type { WorkerWitness } from './worker-witness';
import type { ConsumedWorkflowBundleEvidence } from './consumed-workflow-bundle';

/** Stable across Firestore map ordering; shared with the native collector. */
export function workerReadinessDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)])
      );
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      return item;
    throw new Error('INVALID_WORKER_READINESS_EVIDENCE');
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export const WORKER_READINESS_COLLECTION = 'temporalWorkerReadiness';
export const WORKER_READINESS_ROLES = ['orchestration', 'controls', 'media', 'email', 'images', 'search'] as const;
export type WorkerReadinessRole = (typeof WORKER_READINESS_ROLES)[number];
export interface WorkerReadinessRequest {
  projectId: string;
  buildId: string;
  nonce: string;
  role: WorkerReadinessRole;
}
export interface WorkerReadinessReceipt {
  id: string;
  digest: string;
}

/** Operator probe: writes only private execution evidence; orchestration also
 * verifies a fresh serving read with its native RTDB identity. Platform identity
 * was authenticated at startup; the release controller must independently join
 * it to fresh native pool/revision and Temporal routing observations. Nothing
 * returned to workflow history contains instance, service-account or runtime IDs.
 */
export function createWorkerReadinessActivities(options: {
  firestore: Firestore;
  projectId: string;
  buildId: string;
  queue: string;
  witness: WorkerWitness;
  workflowBundle?: ConsumedWorkflowBundleEvidence;
}) {
  return {
    async recordWorkerReadiness(request: WorkerReadinessRequest): Promise<WorkerReadinessReceipt> {
      const context = Context.current();
      const { info } = context; // Never accept a caller-supplied native execution context.
      const cloud = options.witness.cloudRun;
      const execution = info.workflowExecution;
      if (
        !request ||
        Object.keys(request).sort().join(',') !== 'buildId,nonce,projectId,role' ||
        request.projectId !== 'urm-app-staging' ||
        options.projectId !== request.projectId ||
        !('projectId' in options.firestore) ||
        options.firestore.projectId !== request.projectId ||
        options.firestore.databaseId !== '(default)' ||
        !/^[a-f0-9]{40}$/.test(request.buildId) ||
        request.buildId !== options.buildId ||
        options.witness.buildId !== request.buildId ||
        !/^[a-f0-9]{32}$/.test(request.nonce) ||
        !WORKER_READINESS_ROLES.includes(request.role) ||
        options.queue !== `urm-${request.role}` ||
        info.taskQueue !== options.queue ||
        info.workflowType !== 'WorkerRuntimeProbe' ||
        !execution ||
        execution.workflowId !== `serverless-readiness-${request.nonce}` ||
        !cloud ||
        cloud.projectId !== request.projectId ||
        cloud.region !== 'us-central1' ||
        !cloud.revisionUid ||
        !cloud.instanceId ||
        !options.witness.instanceId
      )
        throw new Error('WORKER_READINESS_EXECUTION_MISMATCH');
      const workflowBundle = request.role === 'orchestration' ? options.workflowBundle : null;
      if (
        request.role === 'orchestration' &&
        (!workflowBundle ||
          Object.keys(workflowBundle).sort().join(',') !== 'buildId,bundleBytes,bundleSHA256,schemaVersion' ||
          workflowBundle.schemaVersion !== 1 ||
          workflowBundle.buildId !== request.buildId ||
          !/^[a-f0-9]{64}$/.test(workflowBundle.bundleSHA256) ||
          !Number.isSafeInteger(workflowBundle.bundleBytes) ||
          workflowBundle.bundleBytes < 1 ||
          workflowBundle.bundleBytes > 64 * 1024 * 1024)
      )
        throw new Error('WORKER_READINESS_BUNDLE_UNCONFIRMED');
      const firebaseRtdb = request.role === 'orchestration' ? await verifyCloudRunRtdbReadiness(options.witness) : null;
      const email =
        request.role === 'email'
          ? await (
              await import('@upperroom/function-kit-firestore-send-email/lib/temporal/provider')
            ).verifyEmailTransportNoSendBounded(undefined, context.cancellationSignal)
          : null;
      const evidence = {
        email,
        firebaseRtdb,
        workflowBundle,
        schemaVersion: 2,
        projectId: request.projectId,
        buildId: request.buildId,
        nonce: request.nonce,
        role: request.role,
        taskQueue: info.taskQueue,
        workflowId: execution.workflowId,
        runId: execution.runId,
        activityId: info.activityId,
        attempt: info.attempt,
        worker: options.witness,
        observedAt: new Date().toISOString(),
      };
      const id = createHash('sha256').update(`${evidence.runId}:${request.role}:${request.nonce}`).digest('hex');
      const digest = workerReadinessDigest(evidence);
      // Create only: retries/ambiguous acknowledgements may not overwrite another
      // observation or manufacture a new instance under the same probe receipt.
      try {
        await options.firestore
          .collection(WORKER_READINESS_COLLECTION)
          .doc(id)
          .create({ ...evidence, digest });
      } catch {
        // SDK authentication/transport details can contain private identities.
        // A conflict or unknown acknowledgement is terminal for this probe.
        throw new Error('WORKER_READINESS_EVIDENCE_UNCONFIRMED');
      }
      return { id, digest };
    },
  };
}
