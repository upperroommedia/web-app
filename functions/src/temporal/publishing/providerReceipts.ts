import { CRITICAL_REPAIR_SOURCE_CATALOGS, assertCriticalRepairCatalogClaimAllowed } from './criticalRepairCatalog';
import { isPublishingSourceProtocolIntent } from '@upperroom/orchestration/job-store';
import type { DurableJobKind } from '@upperroom/contracts/temporal';
import { createHash, randomUUID } from 'node:crypto';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { HttpsError } from 'firebase-functions/v2/https';
import { FieldPath, type Firestore, type Transaction, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import {
  runDurableTransaction,
  getDurablePublishingJobId,
  isPublishingProviderCreateForbidden,
} from './durableOperationContext';

/** Never expire these receipts: provider objects outlive workflow histories. */
export const PROVIDER_RECEIPTS_COLLECTION = 'temporalProviderReceipts';
export const PROVIDER_ACKNOWLEDGEMENTS_COLLECTION = 'temporalProviderAcknowledgements';
/** Longer than the publishing mutation activity's 20 minute execution window. */
export const PROVIDER_ACTIVE_ATTEMPT_GUARD_MS = 25 * 60 * 1000;
export type ProviderAdoptionAudit = {
  decision: 'adopt_existing_resource' | 'retain_existing_resource';
  duplicateRiskAcknowledged: true;
  evidenceReference: string;
  reason: string;
};
export interface ProviderAccountBinding {
  provider: 'subsplash' | 'soundcloud';
  account: string;
}
export interface ProviderAcknowledgementReview {
  decision: 'retain_after_review' | 'cleanup_verified';
  actorUid: string;
  commandId: string;
  acknowledgementFingerprint: string;
  evidenceReference: string;
  reason: string;
  duplicateRiskAcknowledged: true;
  reviewedAtMillis: number;
}
export interface ProviderAcknowledgementFact {
  schemaVersion: 1;
  providerAccount?: ProviderAccountBinding;
  receiptId: string;
  projectId?: string;
  jobId?: string;
  step: string;
  attemptOwner: string;
  claimRevision: number;
  payloadFingerprint: string;
  remoteId: string;
  disposition: 'orphaned' | 'same_resource';
  acknowledgedAtMillis: number;
  review?: ProviderAcknowledgementReview;
}
export const providerAcknowledgementFingerprint = (fact: ProviderAcknowledgementFact): string => {
  const { review: _review, ...immutableFact } = fact;
  return providerPayloadFingerprint(immutableFact);
};
export const acknowledgementHasReviewedDisposition = (fact: ProviderAcknowledgementFact): boolean => {
  const review = fact.review;
  return Boolean(
    review &&
      ['retain_after_review', 'cleanup_verified'].includes(review.decision) &&
      review.actorUid?.trim() &&
      review.commandId?.trim() &&
      review.evidenceReference?.trim() &&
      review.reason?.trim() &&
      review.duplicateRiskAcknowledged === true &&
      Number.isFinite(review.reviewedAtMillis) &&
      review.reviewedAtMillis >= fact.acknowledgedAtMillis &&
      review.acknowledgementFingerprint === providerAcknowledgementFingerprint(fact)
  );
};
export type ProviderReceipt = {
  providerAccount?: ProviderAccountBinding;
  operationKey: string;
  projectId?: string;
  jobId?: string;
  step: string;
  fingerprint: string;
  intentPayload?: unknown;
  resolvedBy?: string;
  resolutionCommandId?: string;
  resolutionFingerprint?: string;
  adoptionAudit?: ProviderAdoptionAudit;
  cleanupReview?: {
    actorUid: string;
    commandId: string;
    resolutionFingerprint: string;
    audit: ProviderAdoptionAudit;
    verifiedAtMillis: number;
    retainedResourceId?: string;
    providerReceiptFingerprint?: string;
    currentReceiptRevision?: number;
  };
  revision?: number;
  state: 'prepared' | 'executing' | 'confirmed' | 'needs_review';
  owner?: string;
  result?: unknown;
  updatedAtMillis: number;
};

const canonicalize = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalize(item) ?? null);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
};
export const providerPayloadFingerprint = (payload: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)) ?? 'null')
    .digest('hex');
export const providerReceiptId = (operationKey: string, step: string): string =>
  providerPayloadFingerprint([operationKey, step]);

/** Only exact qualified operation keys establish job ownership for retention/review queries. */
export const inferProviderReceiptScope = (operationKey: string): { projectId: string; jobId: string } | undefined => {
  if (!operationKey.startsWith('durable:')) return undefined;
  const match = /^durable:([A-Za-z0-9][A-Za-z0-9_-]{0,127}):([A-Za-z0-9][A-Za-z0-9_-]{0,127}):([^\s/]{1,1024})$/.exec(
    operationKey
  );
  if (!match)
    throw new HttpsError(
      'invalid-argument',
      'Durable provider operation keys require a qualified project, job and step.'
    );
  return { projectId: match[1], jobId: match[2] };
};

/** Complete, project/job-scoped proof scan. Call only behind the drained-work/cancellation barrier.
 * Receipt routing is immutable; state changes during the scan can only make unknown evidence fail closed. */
export const listProviderReceiptsForJob = async (
  ref: { projectId: string; jobId: string },
  firestore: Firestore = firebaseAdmin.firestore()
): Promise<Array<{ receiptId: string; receipt: ProviderReceipt }>> => {
  const scope = inferProviderReceiptScope(`durable:${ref.projectId}:${ref.jobId}:retention-proof`);
  if (!scope) throw new HttpsError('invalid-argument', 'A qualified provider receipt job is required.');
  const query = firestore
    .collection(PROVIDER_RECEIPTS_COLLECTION)
    .where('projectId', '==', scope.projectId)
    .where('jobId', '==', scope.jobId)
    .orderBy(FieldPath.documentId())
    .limit(400);
  const proofs: Array<{ receiptId: string; receipt: ProviderReceipt }> = [];
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    const page = await (cursor ? query.startAfter(cursor) : query).get();
    for (const doc of page.docs) {
      const receipt = doc.data() as ProviderReceipt;
      const routing =
        typeof receipt.operationKey === 'string' ? inferProviderReceiptScope(receipt.operationKey) : undefined;
      if (
        receipt.projectId !== scope.projectId ||
        receipt.jobId !== scope.jobId ||
        routing?.projectId !== scope.projectId ||
        routing?.jobId !== scope.jobId ||
        typeof receipt.step !== 'string' ||
        providerReceiptId(receipt.operationKey, receipt.step) !== doc.id ||
        !['prepared', 'executing', 'confirmed', 'needs_review'].includes(receipt.state)
      ) {
        throw new HttpsError(
          'failed-precondition',
          'A provider receipt has inconsistent private routing or state. Retain the job sources pending review.'
        );
      }
      if (cursor && doc.id <= cursor.id)
        throw new HttpsError(
          'failed-precondition',
          'The provider receipt cursor did not advance. Retain the job sources pending review.'
        );
      proofs.push({ receiptId: doc.id, receipt });
    }
    if (page.docs.length < 400) return proofs;
    cursor = page.docs[page.docs.length - 1];
  }
};

/** Private complete ACK scan behind the same drained-work barrier as receipt proofs. */
export const listProviderAcknowledgementsForJob = async (
  ref: { projectId: string; jobId: string },
  firestore: Firestore = firebaseAdmin.firestore()
): Promise<Array<{ acknowledgementId: string; acknowledgement: ProviderAcknowledgementFact }>> => {
  const scope = inferProviderReceiptScope(`durable:${ref.projectId}:${ref.jobId}:acknowledgement-proof`);
  if (!scope) throw new HttpsError('invalid-argument', 'A qualified acknowledgement job is required.');
  const query = firestore
    .collection(PROVIDER_ACKNOWLEDGEMENTS_COLLECTION)
    .where('projectId', '==', scope.projectId)
    .where('jobId', '==', scope.jobId)
    .orderBy(FieldPath.documentId())
    .limit(400);
  const facts: Array<{ acknowledgementId: string; acknowledgement: ProviderAcknowledgementFact }> = [];
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    const page = await (cursor ? query.startAfter(cursor) : query).get();
    for (const doc of page.docs) {
      const fact = doc.data() as ProviderAcknowledgementFact;
      if (
        fact.schemaVersion !== 1 ||
        fact.projectId !== scope.projectId ||
        fact.jobId !== scope.jobId ||
        !/^[a-f0-9]{64}$/.test(fact.receiptId) ||
        typeof fact.step !== 'string' ||
        !fact.step ||
        typeof fact.attemptOwner !== 'string' ||
        !fact.attemptOwner ||
        !Number.isInteger(fact.claimRevision) ||
        fact.claimRevision < 1 ||
        !/^[a-f0-9]{64}$/.test(fact.payloadFingerprint) ||
        providerIdentity(fact.remoteId) !== fact.remoteId ||
        !['same_resource', 'orphaned'].includes(fact.disposition) ||
        !Number.isFinite(fact.acknowledgedAtMillis) ||
        fact.acknowledgedAtMillis < 0 ||
        providerPayloadFingerprint([fact.receiptId, fact.attemptOwner, fact.claimRevision, fact.remoteId]) !== doc.id
      )
        throw new HttpsError(
          'failed-precondition',
          'An acknowledgement has inconsistent private claim proof. Retain the job sources pending review.'
        );
      if (cursor && doc.id <= cursor.id)
        throw new HttpsError('failed-precondition', 'The acknowledgement cursor did not advance.');
      facts.push({ acknowledgementId: doc.id, acknowledgement: fact });
    }
    if (page.docs.length < 400) return facts;
    cursor = page.docs[page.docs.length - 1];
  }
};

/** Source-fetch proof only. Matching a late ACK never grants authority to delete an adopted resource. */
export const sameResourceAcknowledgementProvesReceipt = (
  fact: ProviderAcknowledgementFact,
  receipt: ProviderReceipt
): boolean =>
  Boolean(
    fact.schemaVersion === 1 &&
      !!fact.projectId &&
      !!fact.jobId &&
      typeof fact.remoteId === 'string' &&
      providerIdentity(fact.remoteId) === fact.remoteId &&
      fact.disposition === 'same_resource' &&
      receipt.state === 'confirmed' &&
      (receipt.step !== 'soundcloud-track' ||
        (fact.providerAccount?.provider === 'soundcloud' &&
          /^soundcloud:users:[0-9]+$/.test(fact.providerAccount.account))) &&
      fact.receiptId === providerReceiptId(receipt.operationKey, receipt.step) &&
      fact.projectId === receipt.projectId &&
      fact.jobId === receipt.jobId &&
      fact.step === receipt.step &&
      fact.attemptOwner === receipt.owner &&
      fact.payloadFingerprint === receipt.fingerprint &&
      providerPayloadFingerprint(fact.providerAccount) === providerPayloadFingerprint(receipt.providerAccount) &&
      Number.isInteger(fact.claimRevision) &&
      fact.claimRevision >= 1 &&
      (receipt.revision ?? 0) >= fact.claimRevision + 1 &&
      providerIdentity(receipt.result) === fact.remoteId
  );

/** Transactional adapter is injected in pure tests; production always uses private Admin Firestore. */
export interface ProviderReceiptStore {
  update<T>(
    id: string,
    fn: (
      existing: ProviderReceipt | undefined,
      transaction?: Transaction
    ) => { record?: ProviderReceipt; value: T } | Promise<{ record?: ProviderReceipt; value: T }>
  ): Promise<T>;
}
const firestoreStore: ProviderReceiptStore = {
  async update(id, fn) {
    const db = firebaseAdmin.firestore();
    const ref = db.collection(PROVIDER_RECEIPTS_COLLECTION).doc(id);
    return runDurableTransaction(db, async (tx) => {
      const snapshot = await tx.get(ref);
      const next = await fn(snapshot.exists ? (snapshot.data() as ProviderReceipt) : undefined, tx);
      if (
        next.record?.state === 'executing' &&
        snapshot.get('state') !== 'executing' &&
        next.record.projectId &&
        next.record.jobId
      ) {
        // This read conflicts atomically with the source seal. A cached positive
        // receipt returned above remains factual replay and never claims a POST.
        const catalog = await tx.get(db.collection(CRITICAL_REPAIR_SOURCE_CATALOGS).doc(next.record.jobId));
        if (
          catalog.exists &&
          (catalog.get('projectId') !== next.record.projectId || catalog.get('jobId') !== next.record.jobId)
        )
          throw new HttpsError('failed-precondition', 'The publishing source catalog belongs to a different job.');
        if (catalog.get('sealed') === true)
          throw new HttpsError(
            'failed-precondition',
            'Original publishing requests are frozen for reviewed recovery.',
            { code: 'PUBLISHING_SOURCE_CLAIMS_FROZEN' }
          );
        const intent = await tx.get(db.collection('durableJobIntents').doc(next.record.jobId));
        const kind = intent.get('kind') as DurableJobKind;
        if (typeof kind === 'string' && isPublishingSourceProtocolIntent(kind, intent.get('payload') ?? {}))
          await assertCriticalRepairCatalogClaimAllowed(tx, db, {
            projectId: next.record.projectId,
            jobId: next.record.jobId,
          });
      }
      if (next.record) tx.set(ref, next.record);
      return next.value;
    });
  },
};

type ProviderAcknowledgementClaim = {
  providerAccount?: ProviderAccountBinding;
  receiptId: string;
  operationKey: string;
  step: string;
  fingerprint: string;
  owner: string;
  revision: number;
  projectId?: string;
  jobId?: string;
};
const providerIdentity = (result: unknown): string | undefined => {
  const candidate =
    typeof result === 'string'
      ? result
      : result && typeof result === 'object'
      ? (result as Record<string, unknown>).id ??
        (result as Record<string, unknown>).trackIdentifier ??
        (result as Record<string, unknown>).tagId ??
        (result as Record<string, unknown>).listId
      : undefined;
  return typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 256 && !/[\s/?#]/.test(candidate)
    ? candidate
    : undefined;
};
const matchesClaim = (
  receipt: ProviderReceipt | undefined,
  claim: ProviderAcknowledgementClaim
): receipt is ProviderReceipt =>
  Boolean(
    receipt &&
      receipt.operationKey === claim.operationKey &&
      receipt.step === claim.step &&
      receipt.fingerprint === claim.fingerprint &&
      receipt.projectId === claim.projectId &&
      receipt.jobId === claim.jobId &&
      receipt.owner === claim.owner &&
      providerPayloadFingerprint(receipt.providerAccount) === providerPayloadFingerprint(claim.providerAccount)
  );

/** A provider ACK is a private fact, not a canonical authorization decision. The first POST claim stays fenced.
 * Raw transaction recording preserves the known allocation even if its actor/generation was cancelled meanwhile. */
const recordAcknowledgement = async (
  claim: ProviderAcknowledgementClaim,
  result: unknown
): Promise<'confirmed' | 'same_resource' | 'orphaned'> => {
  const db = firebaseAdmin.firestore();
  const receiptRef = db.collection(PROVIDER_RECEIPTS_COLLECTION).doc(claim.receiptId);
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(receiptRef);
    const receipt = snapshot.exists ? (snapshot.data() as ProviderReceipt) : undefined;
    if (matchesClaim(receipt, claim) && receipt.state === 'executing' && receipt.revision === claim.revision) {
      tx.set(receiptRef, {
        ...receipt,
        state: 'confirmed',
        result: canonicalize(result),
        revision: claim.revision + 1,
        updatedAtMillis: Date.now(),
      });
      return 'confirmed';
    }
    // Idempotent retry of a factual write whose transaction response was lost.
    if (
      matchesClaim(receipt, claim) &&
      receipt.state === 'confirmed' &&
      receipt.revision === claim.revision + 1 &&
      !receipt.resolutionCommandId &&
      providerPayloadFingerprint(receipt.result) === providerPayloadFingerprint(result)
    )
      return 'confirmed';
    const remoteId = providerIdentity(result);
    if (!remoteId)
      throw new HttpsError(
        'failed-precondition',
        'The late provider acknowledgement did not contain a bounded resource identity.'
      );
    const sameResource =
      matchesClaim(receipt, claim) && receipt.state === 'confirmed' && providerIdentity(receipt.result) === remoteId;
    const journalId = providerPayloadFingerprint([claim.receiptId, claim.owner, claim.revision, remoteId]);
    const journalRef = db.collection(PROVIDER_ACKNOWLEDGEMENTS_COLLECTION).doc(journalId);
    const previous = await tx.get(journalRef);
    if (!previous.exists) {
      const fact: ProviderAcknowledgementFact = {
        schemaVersion: 1,
        ...(claim.providerAccount ? { providerAccount: claim.providerAccount } : {}),
        receiptId: claim.receiptId,
        ...(claim.projectId ? { projectId: claim.projectId } : {}),
        ...(claim.jobId ? { jobId: claim.jobId } : {}),
        step: claim.step,
        attemptOwner: claim.owner,
        claimRevision: claim.revision,
        payloadFingerprint: claim.fingerprint,
        remoteId,
        disposition: sameResource ? 'same_resource' : 'orphaned',
        acknowledgedAtMillis: Date.now(),
      };
      tx.create(journalRef, fact);
    }
    // Never rewrite an operator's selected receipt or put the provider response/URLs in this journal.
    return sameResource ? 'same_resource' : 'orphaned';
  });
};

export const executeProviderCreate = async <T>(options: {
  operationKey: string;
  step: string;
  payload: unknown;
  execute: () => Promise<T>;
  /** Safe source reads only; never dispatched for confirmed/unresolved receipts. */
  prepare?: () => Promise<void>;
  getProviderAccount?: () => ProviderAccountBinding | undefined;
  store?: ProviderReceiptStore;
}): Promise<T> => {
  if (isPublishingProviderCreateForbidden())
    throw new HttpsError('permission-denied', 'Critical repair cannot allocate provider resources.');
  const { operationKey, step, payload, execute, store = firestoreStore } = options;
  if (!operationKey?.trim() || !step?.trim())
    throw new HttpsError('invalid-argument', 'Provider creation requires an operation key and step.');
  const scope = inferProviderReceiptScope(operationKey);
  if (scope && !options.store) {
    if (getDurablePublishingJobId() !== scope.jobId)
      throw new HttpsError(
        'permission-denied',
        'Reserved durable provider keys require the matching trusted worker job context.'
      );
    const projectId = typeof firebaseAdmin.app === 'function' ? firebaseAdmin.app().options.projectId : undefined;
    if (projectId && projectId !== scope.projectId)
      throw new HttpsError('permission-denied', 'The durable provider key does not belong to this configured project.');
  }
  const id = providerReceiptId(operationKey, step);
  const fingerprint = providerPayloadFingerprint(payload);
  const owner = randomUUID();
  const ambiguity = () =>
    new HttpsError(
      'failed-precondition',
      'The provider may have completed this operation. Verify its result before resuming.',
      {
        reason: 'PROVIDER_RESULT_AMBIGUOUS',
        receiptId: id,
        operationKey,
        step,
      }
    );
  // Preparing is safe to replay. No remote side effect is permitted before executing is durable.
  const initial = await store.update<{ replay: boolean; result?: T }>(id, (existing) => {
    if (existing && existing.fingerprint !== fingerprint)
      throw new HttpsError('failed-precondition', 'An operation key cannot be reused with different content.', {
        reason: 'PROVIDER_PAYLOAD_CHANGED',
        receiptId: id,
      });
    if (existing?.state === 'confirmed') return { value: { replay: true, result: existing.result as T } };
    if (existing && existing.state !== 'prepared') throw ambiguity();
    return {
      record: existing
        ? undefined
        : {
            operationKey,
            ...(scope ?? {}),
            step,
            fingerprint,
            intentPayload: canonicalize(payload),
            revision: 0,
            state: 'prepared',
            updatedAtMillis: Date.now(),
          },
      value: { replay: false },
    };
  });
  if (initial.replay) return initial.result as T;
  // Preparation errors leave the receipt prepared: no remote POST has started, so retries remain safe.
  await options.prepare?.();
  const providerAccount =
    options.getProviderAccount?.() ??
    ([
      'subsplash-audio',
      'subsplash-transcode',
      'subsplash-media-item',
      'subsplash-series',
      'speaker-tag-create',
      'list-create',
      'overflow-list-create',
      'image-create',
    ].includes(step)
      ? { provider: 'subsplash' as const, account: 'app:9XTSHD' }
      : undefined);
  if (
    providerAccount &&
    (!['subsplash', 'soundcloud'].includes(providerAccount.provider) ||
      !providerAccount.account ||
      providerAccount.account.length > 256 ||
      /[\s/?#]/.test(providerAccount.account))
  )
    throw new HttpsError('failed-precondition', 'Provider account binding is invalid.');
  const claim = await store.update<{ replay: boolean; result: T | undefined; revision?: number }>(id, (existing) => {
    if (
      !existing ||
      existing.fingerprint !== fingerprint ||
      existing.operationKey !== operationKey ||
      existing.step !== step ||
      existing.projectId !== scope?.projectId ||
      existing.jobId !== scope?.jobId
    )
      throw new HttpsError('failed-precondition', 'Provider receipt changed.');
    if (existing.state === 'confirmed') return { value: { replay: true, result: existing.result as T } };
    if (existing.state !== 'prepared') throw ambiguity();
    return {
      record: {
        ...existing,
        state: 'executing',
        ...(providerAccount ? { providerAccount } : {}),
        owner,
        revision: (existing.revision ?? 0) + 1,
        updatedAtMillis: Date.now(),
      },
      value: { replay: false, result: undefined as T | undefined, revision: (existing.revision ?? 0) + 1 },
    };
  });
  if (claim.replay) return claim.result as T;
  try {
    const result = await execute();
    if (result === undefined) throw new Error('Provider creation did not return a durable result.');
    if (typeof claim.revision !== 'number') throw ambiguity();
    const acknowledgement: ProviderAcknowledgementClaim = {
      receiptId: id,
      operationKey,
      step,
      fingerprint,
      owner,
      revision: claim.revision,
      ...(scope ?? {}),
      ...(providerAccount ? { providerAccount } : {}),
    };
    if (options.store) {
      // Injected test adapters preserve the same exact claim CAS without external SDK access.
      await store.update(id, (existing) => {
        if (
          !matchesClaim(existing, acknowledgement) ||
          existing.state !== 'executing' ||
          existing.revision !== acknowledgement.revision
        )
          throw ambiguity();
        return {
          record: {
            ...existing,
            state: 'confirmed',
            result: canonicalize(result),
            revision: acknowledgement.revision + 1,
            updatedAtMillis: Date.now(),
          },
          value: undefined,
        };
      });
    } else if ((await recordAcknowledgement(acknowledgement, result)) === 'orphaned') {
      throw ambiguity();
    }
    return result;
  } catch {
    // A rejected request, lost response, process death, or failed receipt write is never proof of absence.
    // Do not copy provider errors/credentials into the receipt or automatically retry a POST.
    await store
      .update(id, (existing) => ({
        record:
          existing?.state === 'executing' &&
          existing.owner === owner &&
          existing.operationKey === operationKey &&
          existing.step === step &&
          existing.fingerprint === fingerprint &&
          existing.projectId === scope?.projectId &&
          existing.jobId === scope?.jobId &&
          existing.revision === claim.revision &&
          providerPayloadFingerprint(existing.providerAccount) === providerPayloadFingerprint(providerAccount)
            ? {
                ...existing,
                state: 'needs_review',
                revision: (existing.revision ?? 0) + 1,
                updatedAtMillis: Date.now(),
              }
            : undefined,
        value: undefined,
      }))
      .catch(() => undefined);
    throw ambiguity();
  }
};

export const readProviderReceipt = (
  receiptId: string,
  store: ProviderReceiptStore = firestoreStore
): Promise<ProviderReceipt | undefined> => store.update(receiptId, (existing) => ({ value: existing }));

/** Caller must authorize the job/resource owner before invoking this privileged server-only function. */
export const resolveProviderReceipt = async (options: {
  receiptId: string;
  actorUid: string;
  resolution: { type: 'adopt'; remoteId: string } | { type: 'prove_absence' };
  verifyRemoteResource: (receipt: ProviderReceipt, remoteId: string) => Promise<unknown>;
  verifyAuthoritativeAbsence: (receipt: ProviderReceipt) => Promise<boolean>;
  store?: ProviderReceiptStore;
  commandId?: string;
  cleanupOnly?: boolean;
  expectedJobRef?: { projectId: string; jobId: string };
  adoptionAudit?: ProviderAdoptionAudit;
  assertCurrentInTransaction?: (transaction: Transaction) => Promise<void>;
  /** Called after all receipt/fence reads, before the receipt write, in the same transaction. */
  onResolutionCommit?: (transaction: Transaction) => Promise<void>;
}): Promise<void> => {
  const store = options.store ?? firestoreStore;
  if (!options.actorUid?.trim() || !/^[a-f0-9]{64}$/.test(options.receiptId))
    throw new HttpsError('invalid-argument', 'A verified actor and valid receipt are required.');
  const receipt = await readProviderReceipt(options.receiptId, store);
  if (receipt?.step === 'image-create' && options.cleanupOnly !== true)
    throw new HttpsError(
      'failed-precondition',
      'An uncertain shared image allocation cannot be adopted for PUT overwrite. Retain it during cleanup and submit a fresh owned image intent.'
    );
  const commandId = options.commandId?.trim();
  const resolutionFingerprint = providerPayloadFingerprint({
    resolution: options.resolution,
    adoptionAudit: options.adoptionAudit,
  });
  if (options.commandId !== undefined && (!commandId || commandId.length > 200))
    throw new HttpsError('invalid-argument', 'A valid resolution command ID is required.');
  const assertCurrent = async (transaction?: Transaction): Promise<void> => {
    if (options.assertCurrentInTransaction) {
      if (!transaction)
        throw new HttpsError('failed-precondition', 'Resolution requires an atomic job generation guard.');
      await options.assertCurrentInTransaction(transaction);
    }
  };
  const commitResolution = async (transaction?: Transaction): Promise<void> => {
    if (!options.onResolutionCommit) return;
    if (!transaction)
      throw new HttpsError('failed-precondition', 'Resolution requires an atomic resume command transaction.');
    await options.onResolutionCommit(transaction);
  };
  if (options.cleanupOnly && receipt?.state === 'confirmed') {
    const scope = options.expectedJobRef;
    if (
      !scope ||
      receipt.projectId !== scope.projectId ||
      receipt.jobId !== scope.jobId ||
      !receipt.operationKey.startsWith(`durable:${scope.projectId}:${scope.jobId}:`)
    )
      throw new HttpsError(
        'permission-denied',
        'The confirmed cleanup receipt does not belong to this exact operation.'
      );
    if (
      !commandId ||
      !options.adoptionAudit ||
      options.resolution.type !== 'adopt' ||
      !options.assertCurrentInTransaction ||
      !options.onResolutionCommit
    )
      throw new HttpsError(
        'failed-precondition',
        'Confirmed-resource cleanup requires an audited atomic cancellation command.'
      );
    const selectedId = options.resolution.remoteId.trim();
    const resultIds = (value: unknown): string[] => {
      if (typeof value === 'string') return [value];
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const result = value as Record<string, unknown>;
      return ['id', 'audioId', 'listId', 'tagId', 'trackIdentifier', 'soundCloudTrackId'].flatMap((key) =>
        typeof result[key] === 'string' ? [result[key] as string] : []
      );
    };
    if (!selectedId || !resultIds(receipt.result).includes(selectedId))
      throw new HttpsError(
        'failed-precondition',
        'Cleanup review must select the exact already confirmed provider resource.'
      );
    if (
      receipt.cleanupReview?.commandId === commandId &&
      (receipt.cleanupReview.actorUid !== options.actorUid ||
        receipt.cleanupReview.resolutionFingerprint !== resolutionFingerprint)
    )
      throw new HttpsError('failed-precondition', 'A cleanup command cannot be reused with a different selection.');
    const before = providerPayloadFingerprint(receipt);
    const verified = await options.verifyRemoteResource(receipt, selectedId);
    if (!resultIds(verified).includes(selectedId))
      throw new HttpsError(
        'failed-precondition',
        'The confirmed cleanup resource could not be authoritatively verified.'
      );
    await store.update(options.receiptId, async (existing, transaction) => {
      await assertCurrent(transaction);
      if (!existing || providerPayloadFingerprint(existing) !== before)
        throw new HttpsError('aborted', 'The confirmed receipt changed during cleanup verification.');
      await commitResolution(transaction);
      if (existing.cleanupReview?.commandId === commandId) return { value: undefined };
      return {
        record: {
          ...existing,
          revision: (existing.revision ?? 0) + 1,
          cleanupReview: {
            actorUid: options.actorUid,
            commandId,
            resolutionFingerprint,
            audit: options.adoptionAudit!,
            verifiedAtMillis: Date.now(),
            ...(options.adoptionAudit!.decision === 'retain_existing_resource'
              ? {
                  retainedResourceId: selectedId,
                  providerReceiptFingerprint: existing.fingerprint,
                  currentReceiptRevision: (existing.revision ?? 0) + 1,
                }
              : {}),
          },
        },
        value: undefined,
      };
    });
    return;
  }
  if (
    receipt?.state === 'confirmed' &&
    commandId &&
    receipt.resolutionCommandId === commandId &&
    receipt.resolvedBy === options.actorUid
  ) {
    if (receipt.resolutionFingerprint !== resolutionFingerprint)
      throw new HttpsError('failed-precondition', 'A resolution command cannot be reused with a different selection.');
    await store.update(options.receiptId, async (existing, transaction) => {
      await assertCurrent(transaction);
      if (
        existing?.state !== 'confirmed' ||
        existing.resolutionCommandId !== commandId ||
        existing.resolvedBy !== options.actorUid
      )
        throw new HttpsError('aborted', 'The resolution receipt changed.');
      await commitResolution(transaction);
      return { value: undefined };
    });
    return;
  }
  if (options.adoptionAudit?.decision === 'retain_existing_resource')
    throw new HttpsError('failed-precondition', 'Retention requires a confirmed same-resource cancellation review.');
  if (!receipt || !['executing', 'needs_review'].includes(receipt.state))
    throw new HttpsError('failed-precondition', 'Only an unresolved creation receipt can be resolved.');
  if (receipt.state === 'executing' && Date.now() < receipt.updatedAtMillis + PROVIDER_ACTIVE_ATTEMPT_GUARD_MS)
    throw new HttpsError(
      'failed-precondition',
      'The original provider attempt may still be active. Wait for its execution window to end before resolving.',
      { retryAfterMillis: receipt.updatedAtMillis + PROVIDER_ACTIVE_ATTEMPT_GUARD_MS - Date.now() }
    );
  const before = providerPayloadFingerprint(receipt);
  let result: unknown;
  if (options.resolution.type === 'adopt') {
    const remoteId = options.resolution.remoteId?.trim();
    if (!remoteId || remoteId.length > 200 || /[\s/?#]/.test(remoteId))
      throw new HttpsError('invalid-argument', 'A known provider resource ID is required.');
    result = await options.verifyRemoteResource(receipt, remoteId);
    if (result === undefined || result === null)
      throw new HttpsError('failed-precondition', 'The provider resource could not be authoritatively verified.');
  } else if (!(await options.verifyAuthoritativeAbsence(receipt))) {
    throw new HttpsError(
      'failed-precondition',
      'The provider cannot authoritatively prove absence for this operation. Cancel the job or adopt a verified remote resource; creation cannot be retried safely.'
    );
  }
  await store.update(options.receiptId, async (existing, transaction) => {
    await assertCurrent(transaction);
    // Validate the complete revision, owner, state and fingerprint again after the remote GET.
    if (!existing || providerPayloadFingerprint(existing) !== before)
      throw new HttpsError(
        'aborted',
        'The receipt changed during verification. Review its current state before resolving.'
      );
    const record: ProviderReceipt = {
      ...existing,
      state: options.resolution.type === 'adopt' ? 'confirmed' : 'prepared',
      revision: (existing.revision ?? 0) + 1,
      resolvedBy: options.actorUid,
      resolutionFingerprint,
      updatedAtMillis: Date.now(),
    };
    if (commandId) record.resolutionCommandId = commandId;
    if (options.adoptionAudit) record.adoptionAudit = options.adoptionAudit;
    if (options.resolution.type === 'adopt') record.result = canonicalize(result);
    else {
      delete record.result;
      delete record.owner;
    }
    await commitResolution(transaction);
    return { record, value: undefined };
  });
};

/** Retention is an exact audited disposition, never authorization to DELETE or proof of exclusive ownership. */
export function isProviderReceiptExplicitlyRetained(receipt: ProviderReceipt, remoteId: string): boolean {
  const review = receipt.cleanupReview;
  return (
    receipt.state === 'confirmed' &&
    review?.audit?.decision === 'retain_existing_resource' &&
    review.retainedResourceId === remoteId &&
    review.providerReceiptFingerprint === receipt.fingerprint &&
    review.currentReceiptRevision === receipt.revision &&
    Boolean(review.actorUid && review.commandId && review.audit.evidenceReference && review.audit.reason)
  );
}
