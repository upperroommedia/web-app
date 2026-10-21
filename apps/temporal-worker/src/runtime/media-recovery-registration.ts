import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type { Client } from '@temporalio/client';
import type { Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import type { Bucket } from '@google-cloud/storage';
import type { WorkerWitness } from './worker-witness';
import type { MediaJobRef, MediaOutcome } from '../../../process-audio/src/temporal/types';
import {
  createMediaRecoveryWorkActivities,
  mediaRecoveryPinnedVersion,
  MEDIA_RECOVERY_QUEUE,
  MEDIA_RECOVERY_DEPLOYMENT,
} from './media-recovery-work';
import { mediaRecoveryKernelContext } from './media-recovery-capability';
import { readMediaRecoveryKernelBirth } from './media-kernel-supervisor';
import { workerReadinessDigest as hash } from './readiness-probe';
function fail(): never {
  throw ApplicationFailure.nonRetryable(
    'Private media registration cannot be verified',
    'MEDIA_RECOVERY_REGISTRATION_UNCONFIRMED'
  );
}
/** Fixed image Worker surface. It exposes neither ordinary media dispatch nor
 * readiness/provider Activities. The production acquire path retains its own
 * durable execution, ownership, actor and artifact authorization. */
export async function createMediaRecoveryRegistration(o: {
  firestore: Firestore;
  auth: Auth;
  bucket: Bucket;
  client: Client;
  witness: WorkerWitness;
  operationId: string;
  kernel: unknown;
  acquire: (ref: MediaJobRef) => Promise<MediaOutcome>;
}) {
  const cap = await mediaRecoveryKernelContext(o.firestore, o.auth, o.witness, o.operationId);
  const birth = await readMediaRecoveryKernelBirth(
    o.firestore,
    o.operationId,
    cap.context.intentSHA256,
    o.kernel,
    o.witness
  );
  if (birth.value.stage !== 'running') fail();
  const authorize = async () => {
    await o.firestore.runTransaction(cap.authorize, { readOnly: true });
    cap.checkFresh();
  };
  const producer = createMediaRecoveryWorkActivities(o);
  const acquireMedia = async (ref: MediaJobRef) => {
    try {
      const context = Context.current(),
        info = context.info,
        execution = info.workflowExecution;
      if (
        context.cancellationSignal.aborted ||
        info.namespace !== 'urm-app-staging.qwejt' ||
        info.taskQueue !== MEDIA_RECOVERY_QUEUE ||
        info.workflowType !== 'MediaRecoveryProbe' ||
        info.activityId !== 'media-recovery-acquire' ||
        info.activityType !== 'acquireMedia' ||
        execution?.workflowId !== `media-recovery-${o.operationId}`
      )
        fail();
      await authorize();
      const doc = o.firestore.doc(`_control/temporalMediaRecoveryWork-${o.operationId}`);
      await o.firestore.runTransaction(
        async (tx) => {
          await cap.authorize(tx);
          const record = (await tx.get(doc)).data(),
            grant = record?.grant;
          const intent = await tx.get(o.firestore.doc(`durableJobIntents/media-recovery-${o.operationId}`));
          const request = await tx.get(o.firestore.doc(`temporalMediaRequests/media-recovery-${o.operationId}`));
          const outbox = await tx.get(o.firestore.doc(`durableJobOutbox/media-recovery-${o.operationId}`));
          if (
            record?.stage !== 'admitted' ||
            grant?.scope !== 'fixed-private-media-acquire-only' ||
            grant.schemaVersion !== 1 ||
            grant.operationId !== o.operationId ||
            grant.planSHA256 !== hash(cap.plan) ||
            grant.workflowId !== execution!.workflowId ||
            grant.runId !== execution!.runId ||
            grant.queue !== MEDIA_RECOVERY_QUEUE ||
            hash(grant.ref) !== hash(ref) ||
            hash(grant.deploymentVersion) !==
              hash({ deploymentName: MEDIA_RECOVERY_DEPLOYMENT, buildId: o.witness.buildId }) ||
            grant.expiresAt !== cap.plan.expiresAt ||
            hash(record.worker) !== hash(o.witness) ||
            hash(intent.data()) !== grant.intentSHA256 ||
            intent.get('actorUid') !== grant.actorUid ||
            hash(request.get('ref')) !== hash(ref) ||
            request.get('sources.storage.path') !== grant.source?.path ||
            request.get('sources.storage.generation') !== grant.source?.generation ||
            outbox.exists
          )
            fail();
        },
        { readOnly: true }
      );
      const currentBirth = await readMediaRecoveryKernelBirth(
        o.firestore,
        o.operationId,
        cap.context.intentSHA256,
        o.kernel,
        o.witness
      );
      if (currentBirth.value.stage !== 'running') fail();
      const d = await o.client.connection.withDeadline(Date.now() + 5000, () =>
        o.client.workflow.getHandle(execution!.workflowId, execution!.runId, { followRuns: false }).describe()
      );
      const wi = d.raw.workflowExecutionInfo,
        vi = wi?.versioningInfo;
      if (
        wi?.execution?.runId !== execution!.runId ||
        wi.status !== 1 ||
        vi?.behavior !== 1 ||
        hash(vi.deploymentVersion) !== hash({ deploymentName: MEDIA_RECOVERY_DEPLOYMENT, buildId: o.witness.buildId })
      )
        fail();
      mediaRecoveryPinnedVersion(vi.versioningOverride, vi.deploymentVersion);
      await authorize();
      if (context.cancellationSignal.aborted) fail();
      return await o.acquire(ref);
    } catch {
      return fail();
    }
  };
  return {
    cap,
    birth,
    authorize,
    activities: Object.freeze({ admitMediaRecoveryWork: producer.admitMediaRecoveryWork, acquireMedia }),
  };
}
