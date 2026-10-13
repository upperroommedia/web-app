import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { Transaction } from 'firebase-admin/firestore';
import type {
  DurableAdmissionRequest,
  DurableJobCommand,
  DurableCommandReceipt,
  DurableJob,
} from '@upperroom/contracts/temporal';
import { isDurableJobTerminal } from '@upperroom/contracts/temporal';
import {
  submitServerDurableJob,
  getServerDurableJobReceipt,
  temporalProjectId,
  admissionKey,
  confirmUploadSource,
  domainForKind,
  isDomainTemporalEnabled,
  durableInputFingerprint,
} from './bridge';
import { createDurableJobStore } from '../../../packages/orchestration/src/job-store';
import { resolveDurableDomain } from './domainResolver';
import { domainForIntent } from './ownership';
import { subsplashSecretsWithRuntimeAlerts } from '../subsplashSecrets';
import { soundcloudSecretsWithRuntimeAlerts } from '../soundcloudSecrets';
function uid(request: CallableRequest<unknown>): string {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to continue.');
  if (request.auth.uid.startsWith('system:'))
    throw new HttpsError('permission-denied', 'System actors cannot use browser admission.');
  return request.auth.uid;
}
const options = { timeoutSeconds: 120, memory: '256MiB' as const };
export const submitDurableJob = onCall<DurableAdmissionRequest>(options, async (request) => {
  const actorUid = uid(request);
  return submitServerDurableJob({ ...request.data, actorUid });
});
export const getDurableJobReceipt = onCall<{ requestId: string }>(options, async (request) => {
  const actorUid = uid(request);
  if (!request.data || typeof request.data.requestId !== 'string')
    throw new HttpsError('invalid-argument', 'Request ID is required.');
  return getServerDurableJobReceipt(actorUid, request.data.requestId);
});
export async function commandServerDurableJob(
  actorUid: string,
  input: DurableJobCommand
): Promise<DurableCommandReceipt> {
  if (
    !input ||
    typeof input.jobId !== 'string' ||
    !input.jobId.trim() ||
    input.jobId.includes('/') ||
    input.jobId.length > 200 ||
    typeof input.requestId !== 'string' ||
    !input.requestId.trim() ||
    input.requestId.length > 200 ||
    Buffer.byteLength(JSON.stringify(input)) > 32768 ||
    !Number.isSafeInteger(input.expectedRevision) ||
    !['cancel', 'retry', 'resume', 'resolve', 'resume_upload'].includes(input.action)
  )
    throw new HttpsError('invalid-argument', 'Invalid job command.');
  const db = firebaseAdmin.firestore(),
    projectId = temporalProjectId(),
    jobDoc = db.collection('durableJobs').doc(input.jobId),
    commandDoc = db.collection('durableJobCommands').doc(admissionKey(actorUid, `command:${input.requestId}`)),
    job = (await jobDoc.get()).data() as DurableJob | undefined;
  if (!job || job.projectId !== projectId) throw new HttpsError('not-found', 'Job not found.');
  const actor = await firebaseAdmin.auth().getUser(actorUid),
    admin = actor.customClaims?.role === 'admin';
  if (actor.disabled || (job.requestedBy !== actorUid && !admin))
    throw new HttpsError('permission-denied', 'You cannot control this job.');
  const jobDomain =
    job.kind === 'maintenance.run'
      ? domainForIntent(job.kind, (await db.collection('durableJobIntents').doc(job.jobId).get()).get('payload') ?? {})
      : domainForKind(job.kind);
  if (!isDomainTemporalEnabled(jobDomain))
    throw new HttpsError('failed-precondition', 'Temporal is not active for this operation.');
  if (
    input.action !== 'cancel' &&
    job.kind !== 'invite.claim' &&
    !['admin', 'publisher', 'uploader'].includes(String(actor.customClaims?.role))
  )
    throw new HttpsError('permission-denied', 'Your role no longer permits this action.');
  const hash = durableInputFingerprint(input);
  const existing = await commandDoc.get();
  if (existing.exists) {
    if (existing.get('inputHash') !== hash)
      throw new HttpsError('already-exists', 'Command ID already used for different input.');
    return { ...existing.get('receipt'), state: 'already_accepted' } as DurableCommandReceipt;
  }
  const confirmedUpload =
    input.action === 'resume_upload' &&
    job.kind === 'upload.create' &&
    job.state === 'succeeded' &&
    typeof job.result?.mediaJobId === 'string';
  if (!confirmedUpload && job.revision !== input.expectedRevision)
    throw new HttpsError('aborted', 'Job changed; refresh before acting.');
  if (!confirmedUpload && (isDurableJobTerminal(job.state) || !job.actions.includes(input.action)))
    throw new HttpsError('failed-precondition', 'This action is no longer available.');
  if (input.action === 'retry')
    throw new HttpsError('failed-precondition', 'Submit a new reviewed request to retry completed work.');
  if (input.action === 'cancel' && domainForKind(job.kind) === 'accounts' && job.state !== 'queued')
    throw new HttpsError('failed-precondition', 'Account changes have started and must finish consistently.');
  let replacementJobRef: { jobId: string; projectId: string } | undefined;
  let resolutionSignal: { name: string; args: unknown[] } | undefined;
  let resolvedCleanupOnly = false;
  let criticalRepairCertificateId: string | undefined;
  if (input.action === 'resume_upload') await confirmUploadSource(job.requestedBy, input.jobId, input.resolution ?? {});
  const prepareCommand = async (tx: Transaction): Promise<() => DurableCommandReceipt> => {
    const currentActor = await firebaseAdmin.auth().getUser(actorUid);
    if (currentActor.disabled || (job.requestedBy !== actorUid && currentActor.customClaims?.role !== 'admin'))
      throw new HttpsError('permission-denied', 'You can no longer control this job.');
    if (
      input.action !== 'cancel' &&
      job.kind !== 'invite.claim' &&
      !['admin', 'publisher', 'uploader'].includes(String(currentActor.customClaims?.role))
    )
      throw new HttpsError('permission-denied', 'Your role no longer permits this action.');
    if (input.action === 'resolve' && currentActor.customClaims?.role !== 'admin')
      throw new HttpsError('permission-denied', 'An active administrator must commit this review.');
    const [fresh, duplicate] = await Promise.all([tx.get(jobDoc), tx.get(commandDoc)]);
    if (duplicate.exists) {
      if (duplicate.get('inputHash') !== hash) throw new HttpsError('already-exists', 'Command ID already used.');
      return () => ({ ...duplicate.get('receipt'), state: 'already_accepted' } as DurableCommandReceipt);
    }
    if (input.action !== 'resume_upload')
      await createDurableJobStore({ firestore: db, projectId }).assertCurrentInTransaction(tx, {
        jobId: job.jobId,
        projectId,
      });
    if (input.action !== 'resume_upload' && fresh.get('revision') !== input.expectedRevision)
      throw new HttpsError('aborted', 'Job changed; refresh before acting.');
    if (input.action !== 'resume_upload' && !((fresh.get('actions') ?? []) as string[]).includes(input.action))
      throw new HttpsError('failed-precondition', 'Action is no longer available.');
    const critical = await tx.get(db.collection('durableJobCriticalSections').doc(job.jobId));
    const irreversible =
      critical.exists &&
      critical.get('projectId') === projectId &&
      critical.get('jobId') === job.jobId &&
      critical.get('generation') === fresh.get('generation') &&
      critical.get('workflowId') === job.workflowId;
    if (input.action === 'cancel' && (irreversible || job.kind === 'provider.orphan_review'))
      throw new HttpsError(
        'failed-precondition',
        'This operation has begun irreversible cleanup and must finish or be reviewed.'
      );
    const nextRevision =
        input.action === 'resume_upload' ? Number(fresh.get('revision')) : Number(fresh.get('revision')) + 1,
      ref = { jobId: job.jobId, projectId };
    const receipt: DurableCommandReceipt = {
      ...ref,
      requestId: input.requestId,
      acceptedRevision: nextRevision,
      state: 'accepted',
      ...(replacementJobRef ? { replacementJobRef } : {}),
    };
    let signal: { name: string; args: unknown[] } | undefined;
    if (job.kind.startsWith('search.') && input.action !== 'cancel') signal = { name: 'search.resume', args: [] };
    else if (job.kind === 'email.deliver') signal = { name: 'emailResume', args: [] };
    else if (job.kind.startsWith('image.') && input.action !== 'cancel') signal = { name: 'image.resume', args: [] };
    else if (job.kind === 'audio.process')
      signal =
        input.action === 'cancel'
          ? { name: 'media.cancel', args: [job.jobId] }
          : { name: 'media.request', args: [ref] };
    else if (input.action !== 'cancel')
      signal = {
        name: job.kind.startsWith('sermon.')
          ? 'publishingResume'
          : job.kind.startsWith('invite.') ||
            job.kind === 'role.resolve' ||
            job.kind === 'role.assign' ||
            job.kind === 'speaker.resolve'
          ? 'accountResume'
          : 'publishingResume',
        args: [],
      };
    if (resolutionSignal) signal = resolutionSignal;
    const localCancel = input.action === 'cancel' && job.kind === 'upload.create';
    const publishing = jobDomain === 'publishing';
    const cancellationDoc = db.collection('durableJobCancellationIntents').doc(job.jobId);
    const cancellation = publishing ? await tx.get(cancellationDoc) : undefined;
    if (
      cancellation?.exists &&
      (cancellation.get('projectId') !== projectId ||
        cancellation.get('workflowId') !== job.workflowId ||
        cancellation.get('generation') !== fresh.get('generation'))
    )
      throw new HttpsError('failed-precondition', 'Cancellation authority does not match this operation.');
    const cleanupOnly =
      publishing &&
      (resolvedCleanupOnly ||
        input.action === 'cancel' ||
        cancellation?.exists === true ||
        fresh.get('state') === 'cancel_requested' ||
        fresh.get('result.resolutionPurpose') === 'cleanup');
    if (
      criticalRepairCertificateId &&
      (!resolvedCleanupOnly ||
        !/^[a-f0-9]{64}$/.test(criticalRepairCertificateId) ||
        input.action !== 'resolve' ||
        currentActor.customClaims?.role !== 'admin')
    )
      throw new HttpsError(
        'permission-denied',
        'Critical cleanup requires a verified administrator repair certificate.'
      );
    let writeImageGrant: (() => void) | undefined;
    if (
      job.kind === 'image.delete' &&
      ['resume', 'cancel'].includes(input.action) &&
      currentActor.customClaims?.role === 'admin'
    ) {
      const imageReceipt = await tx.get(db.collection('temporalImageReceipts').doc(job.jobId));
      if (
        ['confirmed'].includes(imageReceipt.get('deletion.remoteState')) ||
        ['confirmed'].includes(imageReceipt.get('deletion.storageState'))
      ) {
        const { authorizeImageDeletionContinuation } = await import('./images/activities');
        writeImageGrant = await authorizeImageDeletionContinuation(db, tx, ref, {
          actorUid,
          commandId: commandDoc.id,
          expectedRevision: input.expectedRevision,
          assertAdmin: async () => {
            const reviewer = await firebaseAdmin.auth().getUser(actorUid);
            if (reviewer.disabled || reviewer.customClaims?.role !== 'admin')
              throw new HttpsError('permission-denied', 'An active administrator must review this cleanup.');
          },
        });
      }
    }
    return () => {
      writeImageGrant?.();
      if (cleanupOnly && (!cancellation?.exists || input.action === 'resolve'))
        tx.set(cancellationDoc, {
          ...(cancellation?.data() ?? {}),
          schemaVersion: 1,
          ...ref,
          workflowId: job.workflowId,
          generation: fresh.get('generation'),
          actorUid,
          authorizedAt: Date.now(),
          originalActorUid: cancellation?.get('originalActorUid') ?? cancellation?.get('actorUid') ?? job.requestedBy,
          acceptedUserCancellation: cancellation?.exists
            ? cancellation.get('acceptedUserCancellation') ?? cancellation.get('purpose') !== 'critical_repair_cleanup'
            : input.action === 'cancel',
          purpose: criticalRepairCertificateId
            ? 'critical_repair_cleanup'
            : cancellation?.get('purpose') ?? 'user_cancellation',
          ...(input.action === 'resolve' ? { reviewCommandId: commandDoc.id } : {}),
          ...(criticalRepairCertificateId ? { certificateId: criticalRepairCertificateId } : {}),
        });
      tx.create(commandDoc, {
        schemaVersion: 1,
        ...ref,
        actorUid,
        inputHash: hash,
        receipt,
        workflowId: job.workflowId,
        action: input.action,
        expectedRevision: input.expectedRevision,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        state: input.action === 'resume_upload' || localCancel ? 'dispatched' : 'pending',
        attempt: 0,
        nextAttemptAt: 0,
        leaseExpiresAt: 0,
        ...(signal ? { signal } : {}),
      });
      if (input.action !== 'resume_upload')
        tx.update(jobDoc, {
          revision: nextRevision,
          updatedAt: Date.now(),
          ...(replacementJobRef || cleanupOnly
            ? {
                result: {
                  ...fresh.get('result'),
                  ...(replacementJobRef ? { replacementJobId: replacementJobRef.jobId } : {}),
                  ...(cleanupOnly ? { resolutionPurpose: 'cleanup' } : {}),
                },
              }
            : {}),
          ...(input.action === 'cancel'
            ? { state: localCancel ? 'cancelled' : 'cancel_requested', actions: [] }
            : cleanupOnly
            ? { state: 'cancel_requested', actions: [] }
            : {
                state: 'reconciling',
                actions:
                  jobDomain === 'accounts' || irreversible || job.kind === 'provider.orphan_review' ? [] : ['cancel'],
              }),
        });
      if (localCancel)
        tx.update(db.collection('durableUploadSessions').doc(job.jobId), {
          state: 'cancelled',
          cancelledAt: Date.now(),
        });
      return receipt;
    };
  };
  if (input.action === 'resolve') {
    const resolved = await resolveDurableDomain(
      {
        actorUid,
        jobId: job.jobId,
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
        resolution: input.resolution ?? {},
      },
      {
        prepareCommand: async (tx, result) => {
          resolutionSignal = result.signal;
          resolvedCleanupOnly = result.cleanupOnly === true;
          criticalRepairCertificateId = result.criticalRepairCertificateId;
          replacementJobRef = result.replacementJobRef;
          return prepareCommand(tx);
        },
      }
    );
    if (!resolved.commandReceipt) throw new HttpsError('internal', 'Resolution did not commit a command receipt.');
    return resolved.commandReceipt;
  }
  return db.runTransaction(async (tx) => (await prepareCommand(tx))());
}
export const commandDurableJob = onCall<DurableJobCommand>(
  {
    ...options,
    timeoutSeconds: 180,
    secrets: [...new Set([...subsplashSecretsWithRuntimeAlerts, ...soundcloudSecretsWithRuntimeAlerts])],
  },
  (request) => commandServerDurableJob(uid(request), request.data)
);
