/** A snapshot proof only authorizes the caller to consider deletion. The caller must
 * still validate the receipt revision and resource epoch in its deletion fence.
 * This engine never performs or schedules provider deletion.
 */
export const PUBLISHING_REFERENCE_COLLECTIONS = ['sermons', 'lists', 'series', 'speakers', 'images'] as const;
export const REFERENCE_PROOF_PAGE_SIZE = 200;
export const REFERENCE_PROOF_ACTIVITY_PAGES = 20;
export type PublishingReferenceCollection = (typeof PUBLISHING_REFERENCE_COLLECTIONS)[number];
export type PublishingReferenceProofRef = Readonly<{ jobId: string; projectId: string }>;
export type PublishingReferenceAllocation = Readonly<{
  receiptId: string;
  fingerprint: string;
  revision: number;
  remoteId: string;
}>;
export type PublishingReferenceSnapshot = Readonly<{
  snapshotReadTime: string;
  resourceEpoch: string;
}>;
export type PublishingReferenceProofCheckpoint = Readonly<
  PublishingReferenceSnapshot & {
    allocation: PublishingReferenceAllocation;
    collectionIndex: number;
    cursor?: string;
    outcome: 'scanning' | 'clear' | 'referenced';
  }
>;
export type PublishingReferencePageQuery = Readonly<{
  collection: PublishingReferenceCollection;
  cursor?: string;
  limit: typeof REFERENCE_PROOF_PAGE_SIZE;
}>;
export type PublishingReferencePage = Readonly<{
  documents: readonly Readonly<{ id: string; data: unknown }>[];
  hasMore: boolean;
}>;
export interface PublishingReferenceProofDependencies {
  loadCheckpoint(
    ref: PublishingReferenceProofRef,
    allocation: PublishingReferenceAllocation
  ): Promise<PublishingReferenceProofCheckpoint | undefined>;
  /** Capture a consistent read time and the current opaque writer-coordination epoch. */
  initialize(
    ref: PublishingReferenceProofRef,
    allocation: PublishingReferenceAllocation
  ): Promise<PublishingReferenceSnapshot>;
  /** False if the snapshot expired, writer epoch changed, or receipt no longer matches. */
  revalidate(
    ref: PublishingReferenceProofRef,
    allocation: PublishingReferenceAllocation,
    checkpoint: PublishingReferenceProofCheckpoint
  ): Promise<boolean>;
  /** Read in document-ID order at checkpoint.snapshotReadTime, strictly after cursor. */
  readPage(
    checkpoint: PublishingReferenceProofCheckpoint,
    query: PublishingReferencePageQuery
  ): Promise<PublishingReferencePage>;
  /** Must condition writes on the current receipt/fingerprint/revision and epoch. */
  persistCheckpoint(ref: PublishingReferenceProofRef, checkpoint: PublishingReferenceProofCheckpoint): Promise<void>;
}

const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('/') && value !== '.' && value !== '..';
const sameAllocation = (a: PublishingReferenceAllocation, b: PublishingReferenceAllocation): boolean =>
  a.receiptId === b.receiptId &&
  a.fingerprint === b.fingerprint &&
  a.revision === b.revision &&
  a.remoteId === b.remoteId;

/** Examine nested Firestore maps and arrays without a recursion/record-count ceiling.
 * Only identifier-bearing fields count; prose mentioning an ID is not a reference.
 */
export function containsPublishingReference(data: unknown, remoteId: string): boolean {
  const pending: unknown[] = [data];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'id' || key === 'subsplashId') && child === remoteId) return true;
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return false;
}

export function createPublishingReferenceProofScanner(deps: PublishingReferenceProofDependencies) {
  return {
    async run(
      ref: PublishingReferenceProofRef,
      allocation: PublishingReferenceAllocation
    ): Promise<'referenced' | 'clear' | 'pending'> {
      if (
        !validId(allocation.receiptId) ||
        !validId(allocation.remoteId) ||
        typeof allocation.fingerprint !== 'string' ||
        !allocation.fingerprint ||
        !Number.isSafeInteger(allocation.revision) ||
        allocation.revision < 0
      )
        throw new Error('Invalid reference proof allocation.');
      // Do not allow the caller to change the identity while an awaited read is in flight.
      const identity = Object.freeze({ ...allocation });
      const job = Object.freeze({ ...ref });
      const reset = async (): Promise<PublishingReferenceProofCheckpoint> => {
        const snapshot = await deps.initialize(job, identity);
        if (!snapshot.snapshotReadTime || !snapshot.resourceEpoch) throw new Error('Invalid reference proof snapshot.');
        const fresh: PublishingReferenceProofCheckpoint = {
          allocation: identity,
          snapshotReadTime: snapshot.snapshotReadTime,
          resourceEpoch: snapshot.resourceEpoch,
          collectionIndex: 0,
          outcome: 'scanning',
        };
        await deps.persistCheckpoint(job, fresh);
        return fresh;
      };
      let checkpoint = await deps.loadCheckpoint(job, identity);
      if (
        !checkpoint ||
        !sameAllocation(checkpoint.allocation, identity) ||
        !Number.isInteger(checkpoint.collectionIndex) ||
        checkpoint.collectionIndex < 0 ||
        checkpoint.collectionIndex > PUBLISHING_REFERENCE_COLLECTIONS.length ||
        !['scanning', 'clear', 'referenced'].includes(checkpoint.outcome) ||
        (checkpoint.outcome === 'clear' &&
          (checkpoint.collectionIndex !== PUBLISHING_REFERENCE_COLLECTIONS.length ||
            checkpoint.cursor !== undefined)) ||
        (checkpoint.cursor !== undefined && !validId(checkpoint.cursor)) ||
        !(await deps.revalidate(job, identity, checkpoint))
      )
        checkpoint = await reset();
      if (checkpoint.outcome === 'referenced') return 'referenced';
      if (checkpoint.outcome === 'clear') return 'clear';

      for (let pageIndex = 0; pageIndex < REFERENCE_PROOF_ACTIVITY_PAGES; pageIndex += 1) {
        const collection = PUBLISHING_REFERENCE_COLLECTIONS[checkpoint.collectionIndex];
        if (!collection) break;
        const query: PublishingReferencePageQuery = {
          collection,
          limit: REFERENCE_PROOF_PAGE_SIZE,
          ...(checkpoint.cursor ? { cursor: checkpoint.cursor } : {}),
        };
        const page = await deps.readPage(checkpoint, query);
        if (page.documents.length > REFERENCE_PROOF_PAGE_SIZE || (page.hasMore && !page.documents.length))
          throw new Error('Invalid reference proof page.');
        let previousId: string | undefined = checkpoint.cursor;
        for (const document of page.documents) {
          // UTF-8 ordering matches Firestore document ID ordering, including non-ASCII IDs.
          if (
            !validId(document.id) ||
            (previousId !== undefined && Buffer.compare(Buffer.from(document.id), Buffer.from(previousId)) <= 0)
          )
            throw new Error('Reference proof page must advance in document ID order.');
          previousId = document.id;
          if (containsPublishingReference(document.data, identity.remoteId)) {
            checkpoint = { ...checkpoint, cursor: document.id, outcome: 'referenced' };
            await deps.persistCheckpoint(job, checkpoint);
            return 'referenced';
          }
        }
        checkpoint = page.hasMore
          ? { ...checkpoint, cursor: previousId }
          : {
              allocation: identity,
              snapshotReadTime: checkpoint.snapshotReadTime,
              resourceEpoch: checkpoint.resourceEpoch,
              collectionIndex: checkpoint.collectionIndex + 1,
              outcome: 'scanning',
            };
        await deps.persistCheckpoint(job, checkpoint);
        if (checkpoint.collectionIndex === PUBLISHING_REFERENCE_COLLECTIONS.length) break;
      }
      if (checkpoint.collectionIndex < PUBLISHING_REFERENCE_COLLECTIONS.length) return 'pending';
      // A late writer or expired read time invalidates every earlier page. Start a new proof
      // rather than carrying a stale clear result across a retry or activity boundary.
      if (!(await deps.revalidate(job, identity, checkpoint))) {
        await reset();
        return 'pending';
      }
      checkpoint = { ...checkpoint, outcome: 'clear' };
      await deps.persistCheckpoint(job, checkpoint);
      return 'clear';
    },
  };
}
