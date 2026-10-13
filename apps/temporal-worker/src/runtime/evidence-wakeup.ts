import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { isDurableJobTerminal, type PublishingEvidenceRef } from '@upperroom/contracts/temporal';
import { durableEntityKey } from '@upperroom/orchestration/job-store';
import {
  providerMutationFingerprint,
  type ProviderMutationSession,
} from '../../../../functions/src/temporal/publishing/providerMutationGuard';
interface Fact {
  factId: string;
  step: string;
  claim: string;
  executionId: string;
  completion: 'acknowledged' | 'rejected_no_effect';
}
/** Original-response facts retain their own authority; this hook admits only a metadata wake-up. */
export function createPublishingEvidenceWakeup(db: Firestore, projectId: string) {
  return async (tx: Transaction, session: ProviderMutationSession, fact: Fact): Promise<(() => void) | undefined> => {
    if (
      session.db !== db ||
      session.scope.projectId !== projectId ||
      session.id !== providerMutationFingerprint(session.scope) ||
      !/^[a-f0-9]{64}$/.test(fact.factId) ||
      fact.factId !== providerMutationFingerprint([session.id, fact.step, fact.claim])
    )
      return;
    const jobId = session.scope.jobId;
    const [jobSnapshot, intentSnapshot] = await Promise.all([
      tx.get(db.doc(`durableJobs/${jobId}`)),
      tx.get(db.doc(`durableJobIntents/${jobId}`)),
    ]);
    const job = jobSnapshot.data(),
      intent = intentSnapshot.data();
    if (
      !job ||
      !intent ||
      isDurableJobTerminal(job.state) ||
      job.projectId !== projectId ||
      intent.projectId !== projectId ||
      job.jobId !== jobId ||
      intent.jobId !== jobId ||
      job.generation !== intent.generation ||
      !Number.isSafeInteger(job.generation) ||
      job.generation < 1 ||
      typeof job.workflowId !== 'string' ||
      !job.workflowId.split(':').includes(projectId) ||
      job.kind !== intent.kind ||
      providerMutationFingerprint(job.entity) !== providerMutationFingerprint(intent.entity)
    )
      return;
    if (
      !String(intent.kind).startsWith('sermon.') &&
      !String(intent.kind).startsWith('list.') &&
      !String(intent.kind).startsWith('series.') &&
      intent.kind !== 'speaker.mutate' &&
      intent.kind !== 'maintenance.run'
    )
      return;
    const entity = await tx.get(
      db.collection('durableJobEntities').doc(durableEntityKey(projectId, intent.entity, intent.kind))
    );
    if (
      entity.get('projectId') !== projectId ||
      entity.get('generation') !== job.generation ||
      entity.get('activeJobId') !== jobId
    )
      return;
    const target = db
      .collection('durableJobCommands')
      .doc(providerMutationFingerprint(['provider-evidence', projectId, jobId, session.id]));
    const previous = await tx.get(target),
      prior = previous.data();
    if (
      previous.exists &&
      (prior?.projectId !== projectId ||
        prior.jobId !== jobId ||
        prior.workflowId !== job.workflowId ||
        prior.action !== 'evidence_available' ||
        prior.sessionId !== session.id)
    )
      return;
    const payload: PublishingEvidenceRef = {
      projectId,
      jobId,
      sessionId: session.id,
      factId: fact.factId,
      generation: job.generation,
    };
    const now = Date.now(),
      leased = prior?.state === 'dispatching' && Number(prior.leaseExpiresAt) > now;
    const record = {
      ...prior,
      schemaVersion: 1,
      projectId,
      jobId,
      workflowId: job.workflowId,
      generation: job.generation,
      sessionId: session.id,
      action: 'evidence_available',
      signal: { name: 'publishingEvidenceAvailable', args: [payload] },
      evidenceVersion: (Number.isSafeInteger(prior?.evidenceVersion) ? prior!.evidenceVersion : 0) + 1,
      state: leased ? 'dispatching' : 'pending',
      attempt: prior?.attempt ?? 0,
      nextAttemptAt: 0,
      leaseExpiresAt: leased ? prior!.leaseExpiresAt : 0,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    return () => {
      tx.set(target, record);
    };
  };
}
