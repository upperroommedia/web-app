import { createHash } from 'node:crypto';
import { FieldPath, type Firestore, type Transaction, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { DurableJobIntent } from '../../../../packages/orchestration/src/job-store';
import {
  desiredProviderDeletionIntentFingerprint,
  prepareDesiredProviderDeletionSettlement,
} from '../../../../packages/orchestration/src/provider-usage';
import {
  PROVIDER_MUTATION_SESSIONS,
  PROVIDER_MUTATION_FACTS,
  providerMutationFingerprint,
  validateProviderMutationOriginalCompletion,
  type ProviderMutationSession,
} from './providerMutationGuard';
import {
  ACKNOWLEDGED_PROJECTION_PLANS,
  assertAcknowledgedProjectionRequestPrepared,
  acknowledgedProjectionDigest,
} from './criticalAcknowledgedRepair';
import { publishingMutationRequestFingerprint } from './durableOperationContext';

const RECEIPTS = 'temporalPublishingDeletionReceipts';
const PAGE_SIZE = 64;
const validId = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 256 && !/[\s/?#]/.test(value);
type Receipt = {
  projectId: string;
  jobId: string;
  sermonId: string;
  provider: 'subsplash' | 'soundcloud';
  remoteId: string;
  originalAccount: string;
  state: string;
  ownershipConfirmedBeforeDelete: true;
  absenceProof: string;
};
interface Store {
  commitCurrent(ref: DurableJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void>;
}
interface OriginalProof {
  sessionId: string;
  requestId: string;
  requestDigest: string;
  factDigest: string;
  sourceRootDigest: string;
}
export class PublishingDeletionSettlementPendingError extends Error {
  readonly code = 'PUBLISHING_DELETION_SETTLEMENT_PENDING';
  constructor(readonly reason: 'canonical_references' | 'original_completion' | 'session_not_closed') {
    super('Provider deletion settlement is awaiting its original completion or canonical cleanup');
  }
}
const invalid = (): never => {
  throw Object.assign(new Error('Original provider deletion proof is required'), {
    code: 'PUBLISHING_DELETION_SETTLEMENT_PROOF_INVALID',
  });
};
const pending = (reason: PublishingDeletionSettlementPendingError['reason']): never => {
  throw new PublishingDeletionSettlementPendingError(reason);
};

function validateReceipt(
  value: Record<string, any> | undefined,
  id: string,
  ref: DurableJobRef,
  intent: DurableJobIntent<unknown>
): Receipt {
  if (
    !value ||
    value.projectId !== ref.projectId ||
    value.jobId !== ref.jobId ||
    value.sermonId !== intent.entity.id ||
    intent.entity.type !== 'sermon' ||
    !validId(value.remoteId) ||
    !['subsplash', 'soundcloud'].includes(value.provider) ||
    !['absence_confirmed', 'reconciled'].includes(value.state) ||
    value.ownershipConfirmedBeforeDelete !== true ||
    value.absenceProof !== 'authenticated_fixed_id_get_404_410' ||
    (value.provider === 'subsplash'
      ? value.originalAccount !== 'app:9XTSHD'
      : typeof value.originalAccount !== 'string' || !/^soundcloud:users:[0-9]+$/.test(value.originalAccount))
  )
    return invalid();
  const expectedId = createHash('sha256')
    .update(JSON.stringify([ref.projectId, ref.jobId, value.provider, value.remoteId]))
    .digest('hex');
  if (id !== expectedId) return invalid();
  return value as Receipt;
}
async function readIntent(tx: Transaction, db: Firestore, ref: DurableJobRef): Promise<DurableJobIntent<unknown>> {
  const [intentDoc, job] = await Promise.all([
    tx.get(db.doc(`durableJobIntents/${ref.jobId}`)),
    tx.get(db.doc(`durableJobs/${ref.jobId}`)),
  ]);
  const intent = intentDoc.data() as DurableJobIntent<unknown>;
  if (
    !intent ||
    intent.schemaVersion !== 1 ||
    intent.projectId !== ref.projectId ||
    intent.jobId !== ref.jobId ||
    !validId(intent.actorUid) ||
    !Number.isSafeInteger(intent.generation) ||
    intent.generation < 1 ||
    job.get('projectId') !== ref.projectId ||
    job.get('jobId') !== ref.jobId ||
    job.get('generation') !== intent.generation ||
    job.get('kind') !== intent.kind ||
    providerMutationFingerprint(job.get('entity')) !== providerMutationFingerprint(intent.entity)
  )
    return invalid();
  return intent;
}
async function readOriginal(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  intent: DurableJobIntent<unknown>,
  receipt: Receipt,
  sessionId: string
): Promise<OriginalProof | undefined> {
  const sessionDoc = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`));
  const data = sessionDoc.data();
  if (
    !data ||
    data.scope?.projectId !== ref.projectId ||
    data.scope?.jobId !== ref.jobId ||
    typeof data.scope.operation !== 'string' ||
    providerMutationFingerprint(data.scope) !== sessionId ||
    !Array.isArray(data.resources)
  )
    return invalid();
  const target = {
    provider: receipt.provider,
    account: receipt.originalAccount,
    resourceType: receipt.provider === 'subsplash' ? 'media' : 'track',
    resourceId: receipt.remoteId,
  };
  if (!data.resources.some((resource) => providerMutationFingerprint(resource) === providerMutationFingerprint(target)))
    return undefined;
  if (data.state !== 'committed' && data.effectsClosed !== true) return pending('session_not_closed');
  const step = `delete:${receipt.provider}:${receipt.remoteId}`,
    requestId = providerMutationFingerprint(step);
  const request = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}/requests/${requestId}`));
  if (!request.exists) return undefined;
  if (!['acknowledged', 'rejected_no_effect'].includes(request.get('state'))) return pending('original_completion');
  const fingerprint = publishingMutationRequestFingerprint({
    method: 'DELETE',
    target,
    payload: { id: receipt.remoteId },
  });
  if (request.get('step') !== step || request.get('method') !== 'DELETE' || request.get('fingerprint') !== fingerprint)
    return invalid();
  const session: ProviderMutationSession = { db, id: sessionId, scope: data.scope, resources: data.resources };
  await assertAcknowledgedProjectionRequestPrepared(tx, session, { step, method: 'DELETE', target, fingerprint });
  await validateProviderMutationOriginalCompletion(tx, session, [request as QueryDocumentSnapshot]);
  const fact = await tx.get(
    db.doc(`${PROVIDER_MUTATION_FACTS}/${providerMutationFingerprint([sessionId, step, request.get('claim')])}`)
  );
  if (request.get('state') === 'rejected_no_effect') {
    const evidence = fact.get('evidence');
    if (
      evidence?.transport !== 'original_http_response' ||
      ![404, 410].includes(evidence.status) ||
      evidence.providerCode !== 'resource_not_found'
    )
      return invalid();
  }
  const source = await tx.get(db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`));
  if (source.get('intentFingerprint') !== desiredProviderDeletionIntentFingerprint(intent)) return invalid();
  return {
    sessionId,
    requestId,
    requestDigest: acknowledgedProjectionDigest(request.data()),
    factDigest: acknowledgedProjectionDigest(fact.data()),
    sourceRootDigest: acknowledgedProjectionDigest(source.data()),
  };
}

/** Final canonical cleanup calls this under the fresh worker SDK fence. No provider RPC
 * is issued, and an authenticated GET never resolves an unknown original DELETE.
 */
export async function settlePublishingDeletionReceipts(db: Firestore, ref: DurableJobRef, store: Store): Promise<void> {
  if (firebaseAdmin.app().options.projectId !== ref.projectId || !validId(ref.jobId)) return invalid();
  const receipts = db
    .collection(RECEIPTS)
    .where('projectId', '==', ref.projectId)
    .where('jobId', '==', ref.jobId)
    .where('state', 'in', ['absence_confirmed', 'reconciled'])
    .orderBy(FieldPath.documentId())
    .limit(PAGE_SIZE);
  let receiptCursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    const page = await (receiptCursor ? receipts.startAfter(receiptCursor) : receipts).get();
    if (page.empty) return;
    for (const row of page.docs) {
      let proof: OriginalProof | undefined, identity: string | undefined;
      const sessions = db
        .collection(PROVIDER_MUTATION_SESSIONS)
        .where('scope.projectId', '==', ref.projectId)
        .where('scope.jobId', '==', ref.jobId)
        .orderBy(FieldPath.documentId())
        .limit(PAGE_SIZE);
      let cursor: QueryDocumentSnapshot | undefined;
      for (;;) {
        const candidates = await (cursor ? sessions.startAfter(cursor) : sessions).get();
        for (const candidate of candidates.docs) {
          // Session resource identities are immutable. Ignore unrelated sessions before
          // entering a fresh fenced transaction; each selected proof is reread below.
          const observed = row.data();
          const observedTarget = {
            provider: observed.provider,
            account: observed.originalAccount,
            resourceType: observed.provider === 'subsplash' ? 'media' : 'track',
            resourceId: observed.remoteId,
          };
          const resources = candidate.get('resources');
          if (!Array.isArray(resources)) return invalid();
          if (
            !resources.some(
              (resource) => providerMutationFingerprint(resource) === providerMutationFingerprint(observedTarget)
            )
          )
            continue;
          await store.commitCurrent(ref, async (tx) => {
            const intent = await readIntent(tx, db, ref),
              fresh = await tx.get(row.ref);
            const receipt = validateReceipt(fresh.data(), row.id, ref, intent),
              digest = desiredProviderDeletionIntentFingerprint(intent);
            if (identity && identity !== digest) return invalid();
            identity = digest;
            const current = await readOriginal(tx, db, ref, intent, receipt, candidate.id);
            if (current) {
              if (proof && acknowledgedProjectionDigest(proof) !== acknowledgedProjectionDigest(current))
                return invalid();
              proof = current;
            }
          });
        }
        if (candidates.size < PAGE_SIZE) break;
        cursor = candidates.docs[candidates.docs.length - 1];
      }
      if (!proof) return pending('original_completion');
      const selected = proof;
      await store.commitCurrent(ref, async (tx) => {
        const intent = await readIntent(tx, db, ref),
          fresh = await tx.get(row.ref);
        const receipt = validateReceipt(fresh.data(), row.id, ref, intent);
        if (desiredProviderDeletionIntentFingerprint(intent) !== identity) return invalid();
        const current = await readOriginal(tx, db, ref, intent, receipt, selected.sessionId);
        if (!current || acknowledgedProjectionDigest(current) !== acknowledgedProjectionDigest(selected))
          return invalid();
        let settle: () => void;
        try {
          settle = await prepareDesiredProviderDeletionSettlement(tx, db, {
            resource: {
              projectId: ref.projectId,
              provider: receipt.provider,
              account: receipt.provider === 'subsplash' ? 'app:9XTSHD' : 'configured-account',
              remoteId: receipt.remoteId,
            },
            jobId: ref.jobId,
            resourceType: receipt.provider === 'subsplash' ? 'media' : 'track',
          });
        } catch (error) {
          if (error instanceof Error && error.message === 'PROVIDER_DESIRED_DELETION_SETTLEMENT_PENDING')
            return pending('canonical_references');
          throw error;
        }
        settle();
        tx.update(row.ref, {
          indexSettlement: 'confirmed_absent',
          indexSettlementIntentFingerprint: identity,
          indexSettlementProof: selected,
        });
      });
    }
    if (page.size < PAGE_SIZE) return;
    receiptCursor = page.docs[page.docs.length - 1];
  }
}
