import { FieldPath, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import { acknowledgedProjectionDigest, type FrozenProjectionRequest } from './criticalAcknowledgedRepair';
import {
  providerMutationFingerprint,
  providerMutationClaimSetSeed,
  providerMutationClaimSetFold,
  validateProviderMutationOriginalCompletion,
  type ProviderMutationClaimSummary,
  type ProviderMutationSession,
  type ProviderMutationClosedEvidenceSeal,
  type ProviderMutationReadyCanonicalCompletion,
} from './providerMutationGuard';
export const RETAINED_DELETION_READY = 'temporalRetainedDeletionReady';
const LIMIT = 32;
type Data = Record<string, any>;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (): never => {
  throw Object.assign(new Error('RETAINED_DELETION_READY_REQUIRED'), { code: 'RETAINED_DELETION_READY_REQUIRED' });
};
const object = (value: unknown): Data =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
export interface RetainedDeletionReadyAuthority extends DurableJobRef {
  certificateId: string;
  planId: string;
  sermonId: string;
  trackId: string;
  generation: number;
  workflowId: string;
  intentFingerprint: string;
}
export interface RetainedDeletionReadySource {
  readExpectedRequests(
    tx: Transaction,
    cursor?: string
  ): Promise<{
    requests: FrozenProjectionRequest[];
    nextCursor?: string;
    sourceProgramDigest: string;
    sourceRequestCount: number;
  }>;
  readCanonicalInventory(
    tx: Transaction,
    cursor?: string
  ): Promise<{
    pages: Array<{ index: number; digest: string }>;
    nextCursor?: string;
    immutableCatalogDigest: string;
    expectedCanonicalPageCount: number;
  }>;
  validateCanonicalPage(
    tx: Transaction,
    input: { index: number; digest: string }
  ): Promise<{ complete: boolean; completionDigest?: string }>;
  validateCanonicalCompletion(tx: Transaction): Promise<{
    immutableCatalogDigest: string;
    expectedCanonicalPageCount: number;
    completedCanonicalPageCount: number;
    canonicalCompletionDigest: string;
  }>;
}
export interface RetainedDeletionReadyDependencies {
  firestore: Firestore;
  commitCurrent(ref: DurableJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void>;
  authorize(tx: Transaction): Promise<void>;
}
// Shared with the original closure's v2 claim catalogue. It includes immutable
// original execution/claim identity, never response bodies or current GET evidence.
export const retainedClaimSetSeed = providerMutationClaimSetSeed;
export const retainedClaimSetFold = providerMutationClaimSetFold;
const authorityDigest = (authority: RetainedDeletionReadyAuthority, session: ProviderMutationSession) =>
  acknowledgedProjectionDigest({ authority, scope: session.scope, sessionId: session.id });
const readyProjection = (data: Data) =>
  Object.fromEntries(
    [
      'schemaVersion',
      'hashChainVersion',
      'authorityDigest',
      'sourceProgramDigest',
      'expectedRequestCount',
      'retainedRequestStep',
      'originalRequestCount',
      'claimPageCount',
      'closedClaimSetDigest',
      'immutableCatalogDigest',
      'expectedCanonicalPageCount',
      'capturedCanonicalPageCount',
    ].map((key) => [key, data[key]])
  );
/** Separate bounded original-source compiler; every page shares fresh operator/SDK
 * authorization, and only sealed source inventory can become a READY catalogue. */
export async function compileRetainedDeletionReady(
  authority: RetainedDeletionReadyAuthority,
  session: ProviderMutationSession,
  source: RetainedDeletionReadySource,
  deps: RetainedDeletionReadyDependencies
): Promise<void> {
  if (
    session.id !== providerMutationFingerprint(session.scope) ||
    session.scope.projectId !== authority.projectId ||
    session.scope.jobId !== authority.jobId ||
    !sha(authority.certificateId) ||
    !Number.isSafeInteger(authority.generation) ||
    authority.generation < 1
  )
    fail();
  const ref = { projectId: authority.projectId, jobId: authority.jobId },
    db = deps.firestore,
    root = db.doc(`${RETAINED_DELETION_READY}/${session.id}`),
    digest = authorityDigest(authority, session);
  await deps.commitCurrent(ref, async (tx) => {
    await deps.authorize(tx);
    const current = await tx.get(root);
    if (current.exists) {
      if (current.get('authorityDigest') !== digest || current.get('hashChainVersion') !== 2) fail();
      return;
    }
    tx.create(root, {
      schemaVersion: 1,
      hashChainVersion: 2,
      authorityDigest: digest,
      stage: 'expected',
      expectedCapturedCount: 0,
      retainedCount: 0,
      originalRequestCount: 0,
      closedClaimSetDigest: retainedClaimSetSeed(session.id),
      claimPageCount: 0,
      capturedCanonicalPageCount: 0,
    });
  });
  for (;;) {
    let done = false;
    await deps.commitCurrent(ref, async (tx) => {
      await deps.authorize(tx);
      const snapshot = await tx.get(root),
        current = object(snapshot.data());
      if (!snapshot.exists || current.authorityDigest !== digest || current.hashChainVersion !== 2) fail();
      if (current.stage === 'ready') {
        if (current.readyDigest !== acknowledgedProjectionDigest(readyProjection(current))) fail();
        done = true;
        return;
      }
      if (current.stage === 'expected') {
        const page = await source.readExpectedRequests(tx, current.expectedCursor);
        if (
          page.requests.length > LIMIT ||
          !sha(page.sourceProgramDigest) ||
          !Number.isSafeInteger(page.sourceRequestCount) ||
          page.sourceRequestCount < 1 ||
          (current.sourceProgramDigest !== undefined && current.sourceProgramDigest !== page.sourceProgramDigest) ||
          (current.expectedRequestCount !== undefined && current.expectedRequestCount !== page.sourceRequestCount)
        )
          fail();
        const entries = page.requests.map((request) => ({
          id: providerMutationFingerprint(request.step),
          request: {
            step: request.step,
            method: request.method,
            fingerprint: request.fingerprint,
            target: request.target,
          },
        }));
        if (new Set(entries.map((entry) => entry.id)).size !== entries.length) fail();
        const previous = entries.length
          ? await tx.getAll(...entries.map((entry) => root.collection('expected').doc(entry.id)))
          : [];
        if (previous.some((row) => row.exists)) fail();
        let retainedCount = current.retainedCount,
          retainedRequestStep = current.retainedRequestStep;
        for (const entry of entries) {
          const request = entry.request,
            target = request.target;
          if (!target || !sha(request.fingerprint)) return fail();
          if (target.provider === 'soundcloud') {
            if (
              target.resourceType !== 'track' ||
              target.resourceId !== authority.trackId ||
              request.method !== 'DELETE'
            )
              fail();
            retainedCount++;
            retainedRequestStep = request.step;
          } else if (target.provider !== 'subsplash' || target.account !== 'app:9XTSHD') fail();
        }
        const captured = current.expectedCapturedCount + entries.length;
        if (!page.nextCursor && (captured !== page.sourceRequestCount || retainedCount !== 1)) fail();
        for (const entry of entries)
          tx.create(root.collection('expected').doc(entry.id), {
            request: entry.request,
            sourceProgramDigest: page.sourceProgramDigest,
          });
        tx.update(root, {
          sourceProgramDigest: page.sourceProgramDigest,
          expectedRequestCount: page.sourceRequestCount,
          expectedCapturedCount: captured,
          retainedCount,
          retainedRequestStep: retainedRequestStep ?? null,
          ...(page.nextCursor ? { expectedCursor: page.nextCursor } : { stage: 'claims' }),
        });
      } else if (current.stage === 'claims') {
        let query = db
          .doc(`temporalProviderMutationSessions/${session.id}`)
          .collection('requests')
          .orderBy(FieldPath.documentId())
          .limit(LIMIT);
        if (current.claimCursor) query = query.startAfter(current.claimCursor);
        const page = await tx.get(query),
          expected = page.size
            ? await tx.getAll(...page.docs.map((row) => root.collection('expected').doc(row.id)))
            : [];
        await validateProviderMutationOriginalCompletion(tx, session, page.docs);
        let checksum = current.closedClaimSetDigest;
        const claims: ProviderMutationClaimSummary[] = [];
        for (let index = 0; index < page.size; index++) {
          const row = page.docs[index],
            request = object(row.data()),
            captured = object(expected[index].get('request'));
          if (
            !expected[index].exists ||
            request.state !== 'acknowledged' ||
            request.step !== captured.step ||
            request.method !== captured.method ||
            request.fingerprint !== captured.fingerprint ||
            captured.target?.provider === 'soundcloud' ||
            row.id !== providerMutationFingerprint(request.step)
          )
            fail();
          const claim: ProviderMutationClaimSummary = {
            requestId: row.id,
            step: request.step,
            method: request.method,
            fingerprint: request.fingerprint,
            claim: request.claim,
            executionId: request.executionId,
            state: request.state,
          };
          claims.push(claim);
          checksum = retainedClaimSetFold(checksum, claim);
        }
        const count = current.originalRequestCount + page.size;
        if (page.size < LIMIT && count !== current.expectedRequestCount - 1) fail();
        if (claims.length)
          tx.create(root.collection('claimPages').doc(String(current.claimPageCount).padStart(12, '0')), {
            schemaVersion: 1,
            index: current.claimPageCount,
            startChecksum: current.closedClaimSetDigest,
            endChecksum: checksum,
            claims,
          });
        tx.update(root, {
          closedClaimSetDigest: checksum,
          originalRequestCount: count,
          claimPageCount: current.claimPageCount + Number(claims.length > 0),
          ...(page.size === LIMIT ? { claimCursor: page.docs[page.size - 1].id } : { stage: 'canonical' }),
        });
      } else if (current.stage === 'canonical') {
        const page = await source.readCanonicalInventory(tx, current.canonicalCursor);
        if (
          page.pages.length > LIMIT ||
          !sha(page.immutableCatalogDigest) ||
          !Number.isSafeInteger(page.expectedCanonicalPageCount) ||
          page.expectedCanonicalPageCount < 1 ||
          (current.immutableCatalogDigest !== undefined &&
            current.immutableCatalogDigest !== page.immutableCatalogDigest) ||
          (current.expectedCanonicalPageCount !== undefined &&
            current.expectedCanonicalPageCount !== page.expectedCanonicalPageCount) ||
          page.pages.some(
            (entry, index) => entry.index !== current.capturedCanonicalPageCount + index || !sha(entry.digest)
          )
        )
          fail();
        const captured = current.capturedCanonicalPageCount + page.pages.length;
        if (!page.nextCursor && captured !== page.expectedCanonicalPageCount) fail();
        const next = {
          ...current,
          immutableCatalogDigest: page.immutableCatalogDigest,
          expectedCanonicalPageCount: page.expectedCanonicalPageCount,
          capturedCanonicalPageCount: captured,
        };
        const previous = page.pages.length
          ? await tx.getAll(
              ...page.pages.map((entry) => root.collection('canonicalPages').doc(String(entry.index).padStart(12, '0')))
            )
          : [];
        if (previous.some((row) => row.exists)) fail();
        for (const entry of page.pages)
          tx.create(root.collection('canonicalPages').doc(String(entry.index).padStart(12, '0')), entry);
        tx.update(root, {
          immutableCatalogDigest: next.immutableCatalogDigest,
          expectedCanonicalPageCount: next.expectedCanonicalPageCount,
          capturedCanonicalPageCount: captured,
          ...(page.nextCursor
            ? { canonicalCursor: page.nextCursor }
            : { stage: 'ready', readyDigest: acknowledgedProjectionDigest(readyProjection(next)) }),
        });
      } else fail();
    });
    if (done) return;
  }
}
/** Refresh actual completed source pages in separate fenced transactions. */
export async function refreshRetainedDeletionReadyCanonicalCompletion(
  authority: RetainedDeletionReadyAuthority,
  session: ProviderMutationSession,
  source: RetainedDeletionReadySource,
  deps: RetainedDeletionReadyDependencies
): Promise<void> {
  const ref = { projectId: authority.projectId, jobId: authority.jobId },
    root = deps.firestore.doc(`${RETAINED_DELETION_READY}/${session.id}`),
    identity = authorityDigest(authority, session);
  await deps.commitCurrent(ref, async (tx) => {
    await deps.authorize(tx);
    const current = object((await tx.get(root)).data());
    if (
      current.stage !== 'ready' ||
      current.authorityDigest !== identity ||
      current.readyDigest !== acknowledgedProjectionDigest(readyProjection(current))
    )
      fail();
    tx.update(root, {
      validatedCanonicalPageCount: 0,
      validatedCanonicalChainDigest: acknowledgedProjectionDigest({
        catalog: current.immutableCatalogDigest,
        source: 'retained-canonical-validation',
      }),
      canonicalValidationComplete: false,
    });
  });
  let cursor: string | undefined;
  for (;;) {
    let descriptors: Array<{ index: number; digest: string }> = [],
      next: string | undefined;
    await deps.commitCurrent(ref, async (tx) => {
      await deps.authorize(tx);
      let query = root.collection('canonicalPages').orderBy(FieldPath.documentId()).limit(LIMIT);
      if (cursor) query = query.startAfter(cursor);
      const page = await tx.get(query);
      descriptors = page.docs.map((row) => row.data() as { index: number; digest: string });
      next = page.size === LIMIT ? page.docs[page.size - 1].id : undefined;
    });
    for (const descriptor of descriptors)
      await deps.commitCurrent(ref, async (tx) => {
        await deps.authorize(tx);
        const current = object((await tx.get(root)).data());
        if (
          current.stage !== 'ready' ||
          current.authorityDigest !== identity ||
          current.validatedCanonicalPageCount !== descriptor.index
        )
          fail();
        const result = await source.validateCanonicalPage(tx, descriptor);
        if (!result.complete || !sha(result.completionDigest)) fail();
        tx.update(root, {
          validatedCanonicalPageCount: descriptor.index + 1,
          validatedCanonicalChainDigest: acknowledgedProjectionDigest([
            current.validatedCanonicalChainDigest,
            descriptor,
            result.completionDigest,
          ]),
        });
      });
    if (!next) break;
    cursor = next;
  }
  await deps.commitCurrent(ref, async (tx) => {
    await deps.authorize(tx);
    const current = object((await tx.get(root)).data()),
      completion = await source.validateCanonicalCompletion(tx);
    if (
      current.authorityDigest !== identity ||
      current.validatedCanonicalPageCount !== current.expectedCanonicalPageCount ||
      completion.immutableCatalogDigest !== current.immutableCatalogDigest ||
      completion.completedCanonicalPageCount !== current.expectedCanonicalPageCount ||
      completion.expectedCanonicalPageCount !== current.expectedCanonicalPageCount ||
      !sha(completion.canonicalCompletionDigest)
    )
      fail();
    tx.update(root, {
      canonicalValidationComplete: true,
      validatedSourceCompletionDigest: completion.canonicalCompletionDigest,
    });
  });
}
/** The authoritative closure is compared with an independently compiled original
 * checksum. Canonical completion comes from actual source page completion records. */
export async function validateRetainedDeletionReadyCompletion(
  tx: Transaction,
  authority: RetainedDeletionReadyAuthority,
  session: ProviderMutationSession,
  seal: ProviderMutationClosedEvidenceSeal,
  source: RetainedDeletionReadySource,
  db: Firestore
): Promise<ProviderMutationReadyCanonicalCompletion> {
  const snapshot = await tx.get(db.doc(`${RETAINED_DELETION_READY}/${session.id}`)),
    root = object(snapshot.data());
  if (
    !snapshot.exists ||
    root.stage !== 'ready' ||
    root.hashChainVersion !== 2 ||
    root.authorityDigest !== authorityDigest(authority, session) ||
    root.readyDigest !== acknowledgedProjectionDigest(readyProjection(root)) ||
    seal.claimSetDigestVersion !== 2 ||
    root.closedClaimSetDigest !== seal.claimSetDigest ||
    root.originalRequestCount !== seal.actualRequestCount ||
    root.sourceProgramDigest !== seal.sourceProgramDigest ||
    root.expectedRequestCount !== seal.expectedRequestCount
  )
    fail();
  const completion = await source.validateCanonicalCompletion(tx);
  if (
    root.canonicalValidationComplete !== true ||
    root.validatedCanonicalPageCount !== root.expectedCanonicalPageCount ||
    !sha(root.validatedCanonicalChainDigest) ||
    completion.canonicalCompletionDigest !== root.validatedSourceCompletionDigest ||
    completion.immutableCatalogDigest !== root.immutableCatalogDigest ||
    completion.expectedCanonicalPageCount !== root.expectedCanonicalPageCount ||
    completion.completedCanonicalPageCount !== root.expectedCanonicalPageCount ||
    !sha(completion.canonicalCompletionDigest)
  )
    fail();
  return {
    closedClaimSetDigest: root.closedClaimSetDigest,
    originalRequestCount: root.originalRequestCount,
    immutableCatalogDigest: root.immutableCatalogDigest,
    canonicalCompletionDigest: completion.canonicalCompletionDigest,
    expectedCanonicalPageCount: root.expectedCanonicalPageCount,
    completedCanonicalPageCount: completion.completedCanonicalPageCount,
  };
}
