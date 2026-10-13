import { createHash } from 'node:crypto';
import { Firestore, Timestamp } from 'firebase-admin/firestore';
import type { EmailExpiryPolicy } from './expiry-policy';
import { assertTemporalEmailRelease } from './release';

export function buildEmailAdmission(
  projectId: string,
  jobId: string,
  mailPath: string,
  generation: number,
  payload: Record<string, unknown>,
  createdAt: number,
  expiryPolicy?: EmailExpiryPolicy
) {
  const ref = { projectId, jobId };
  const entity = { type: 'mail', id: mailPath };
  const kind = 'email.deliver';
  const workflowId = `email:${projectId}:${jobId}`;
  const actorUid = 'system:email';
  const requestId = `mail:${jobId}`;
  const dispatch = { workflowType: 'emailDeliveryWorkflow', workflowId, taskQueue: 'urm-email', ref };
  return {
    job: {
      schemaVersion: 1,
      ...ref,
      kind,
      entity,
      workflowId,
      generation,
      revision: 1,
      requestedBy: actorUid,
      requestId,
      state: 'queued',
      createdAt,
      updatedAt: createdAt,
      steps: [],
      actions: ['cancel'],
    },
    intent: {
      schemaVersion: 1,
      ...ref,
      kind,
      entity,
      actorUid,
      payload: { mailPath, payload, ...(expiryPolicy ? { expiryPolicy } : {}) },
      generation,
      createdAt,
    },
    outbox: {
      schemaVersion: 1,
      ...ref,
      dispatch,
      state: 'pending',
      attempt: 0,
      createdAt,
      updatedAt: createdAt,
      nextAttemptAt: 0,
      leaseExpiresAt: 0,
    },
    entity: {
      schemaVersion: 1,
      projectId,
      entity,
      scope: 'email',
      generation,
      activeJobId: jobId,
      updatedAt: createdAt,
    },
    entityKey: createHash('sha256')
      .update(JSON.stringify([projectId, entity.type, entity.id, 'email']))
      .digest('hex'),
  };
}
export function emailAdmissionJobId(projectId: string, mailPath: string): string {
  return `email-${createHash('sha256')
    .update(JSON.stringify([projectId, mailPath]))
    .digest('hex')}`;
}

/** The isolated Firebase kit cannot import an unpublished workspace package. A
 * protocol-parity test compares these writes with createDurableJobStore. */
export async function enqueueTemporalEmail(
  db: Firestore,
  mailPath: string,
  projectId: string,
  expireAt?: (startTime: Timestamp) => Timestamp,
  expiryPolicy?: EmailExpiryPolicy,
  releaseImport?: { revision: number; releaseId: string }
): Promise<void> {
  const jobId = emailAdmissionJobId(projectId, mailPath);
  const now = Date.now();
  const empty = buildEmailAdmission(projectId, jobId, mailPath, 1, {}, now);
  const mail = db.doc(mailPath);
  const job = db.collection('durableJobs').doc(jobId);
  const head = db.collection('durableJobEntities').doc(empty.entityKey);
  await db.runTransaction(async (tx) => {
    const [snapshot, existing, entity] = await Promise.all([tx.get(mail), tx.get(job), tx.get(head)]);
    if (!snapshot.exists || existing.exists) return;
    const input = snapshot.data();
    if (!input) return;
    // Never adopt a non-idempotent legacy send, even if its lease expired.
    if (['PROCESSING', 'SUCCESS', 'ERROR'].includes(input.delivery?.state)) return;
    // A legacy retry with a previous attempt may already have been accepted.
    if ((input.delivery?.attempts || 0) > 0) return;
    if (typeof input.message !== 'object' && !input.template && typeof input.sendGrid !== 'object') return;
    await assertTemporalEmailRelease(tx, db, projectId, input.meta?.temporalParentJobRef, releaseImport);
    const { delivery: _legacy, ...payload } = input;
    const admission = buildEmailAdmission(
      projectId,
      jobId,
      mailPath,
      (entity.get('generation') || 0) + 1,
      payload,
      now,
      expiryPolicy
    );
    tx.create(job, admission.job);
    tx.create(db.collection('durableJobIntents').doc(jobId), admission.intent);
    tx.create(db.collection('durableJobOutbox').doc(jobId), admission.outbox);
    tx.set(head, admission.entity);
    const startTime = Timestamp.fromMillis(now);
    tx.update(mail, {
      delivery: {
        ...(_legacy || {}),
        startTime: _legacy?.startTime || startTime,
        state: 'PENDING',
        attempts: _legacy?.attempts || 0,
        error: null,
        orchestrator: 'temporal',
        jobId,
        ...(expireAt && !_legacy?.expireAt ? { expireAt: expireAt(startTime) } : {}),
      },
    });
  });
}
