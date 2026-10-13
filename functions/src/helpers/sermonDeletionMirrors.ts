import { createHash } from 'node:crypto';
import {
  FieldPath,
  type Firestore,
  type Transaction,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { DurableJobIntent, DurableActivityExecution } from '@upperroom/orchestration/job-store';
import {
  getDurablePublishingJobId,
  getPublishingSourceStepIds,
  getPublishingMutationOperation,
  runDurableTransaction,
  prepareAcknowledgedProjectionPlan,
  isCriticalPublishingRepair,
  publishingMutationRequestFingerprint,
} from '../temporal/publishing/durableOperationContext';
import {
  acknowledgedProjectionDigest,
  assertAcknowledgedProjectionRequestPrepared,
  assertAcknowledgedRepairCandidateVerificationSeal,
  type FrozenProjectionRequest,
  type FrozenProviderVerification,
} from '../temporal/publishing/criticalAcknowledgedRepair';
import {
  PROVIDER_MUTATION_SESSIONS,
  validateProviderMutationOriginalCompletion,
  prepareProviderMutationEffectsClosedFromReadyEvidence,
  providerMutationFingerprint,
  type ProviderMutationSession,
  type ProviderMutationResource,
  type ProviderMutationClosedEvidenceSeal,
  type ProviderMutationReadyCanonicalCompletion,
} from '../temporal/publishing/providerMutationGuard';
import {
  desiredProviderDeletionDocumentFingerprint,
  providerEdgeKey,
} from '../../../packages/orchestration/src/provider-usage';
import { getSeriesSubtitleFromPublishedCount } from './seriesHelpers';
import {
  readSermonDeletionDestinationProgramInTransaction,
  validateSermonDeletionDestinationCompletion,
  type SermonDeletionDestinationRef,
} from './sermonDeletionDestinations';
import { validateLegacySoundCloudRetentionDisposition } from '../temporal/publishing/legacySoundCloudRetention';
import {
  certifiedDeletionDispositionId,
  CERTIFIED_DELETION_DISPOSITIONS,
  validateCertifiedDeletionDisposition,
} from '../temporal/publishing/certifiedDeletionDisposition';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';

export const SERMON_DELETION_MIRROR_PLANS = 'temporalSermonDeletionMirrorPlans';
const PAGE = 400,
  CHUNK = 64,
  CANONICAL_CHUNK = 32;
type Data = Record<string, unknown>;
const object = (value: unknown): Data =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
function fail(): never {
  throw new Error('SERMON_DELETION_MIRROR_PROOF_INVALID');
}
const valid = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 256 && !/[\s/?#]/.test(value);
const digest = desiredProviderDeletionDocumentFingerprint;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export interface SermonDeletionMirrorInput {
  ref: DurableJobRef;
  sermonId: string;
  requests: FrozenProjectionRequest[];
  verifications: FrozenProviderVerification[];
  operation?: string;
  destinationProgram?: SermonDeletionDestinationRef;
}
export interface SermonDeletionMirrorPlan extends DurableJobRef {
  sermonId: string;
  planId: string;
  generation: number;
  workflowId: string;
  operation?: string;
}
export interface MirrorRow {
  canonicalPath: string;
  sourceFingerprint: string;
  expectedDocumentDigest: string;
  kind: 'membership' | 'list' | 'series';
  parentPath?: string;
  published?: boolean;
}
export type SermonDeletionCanonicalPage =
  | { kind: 'root'; path: string; baselineDigests: string[] }
  | { kind: 'mirrors'; rows: MirrorRow[] }
  | { kind: 'counts'; countWrites: Array<{ path: string; expectedFields: Data; patch: Data }> };
export interface SermonDeletionCanonicalCompletionSummary {
  immutableCatalogDigest: string;
  expectedCanonicalPageCount: number;
  completedCanonicalPageCount: number;
  canonicalCompletionDigest: string;
}
interface CanonicalCompletion {
  schemaVersion: 1;
  immutableCatalogDigest: string;
  expectedCanonicalPageCount: number;
  completedCanonicalPageCount: number;
  canonicalCompletionDigest: string;
  completionChainDigest: string;
  closedClaimSetDigest?: string;
  closedClaimSetDigestVersion?: 2;
  originalRequestCount?: number;
}
export interface SermonDeletionCandidateVerification {
  candidateId: string;
  candidateDigest: string;
  observationScope: string;
  currentSeal?: Record<string, unknown>;
  programId?: string;
  programSealDigest?: string;
}
interface Header extends SermonDeletionMirrorPlan {
  schemaVersion: 1;
  sourceStepIds: string[];
  sourceParentRef: DurableJobRef;
  state: 'preparing' | 'prepared' | 'root_removed' | 'completed';
  intentFingerprint: string;
  originalRoot: Data;
  destinationProgram?: SermonDeletionDestinationRef;
  frozenProgramDigest?: string;
  canonicalPageCount?: number;
  canonicalChainDigest?: string;
  immutableCanonicalCatalogDigest?: string;
  canonicalCompletion?: CanonicalCompletion;
  originalRootDigest: string;
  pointerClearRootDigest: string;
  requests: FrozenProjectionRequest[];
  verifications: FrozenProviderVerification[];
  rootRemoval?: {
    schemaVersion: 1;
    originalEvidenceDigest: string;
    rootSourceDigest: string;
    intentFingerprint: string;
    generation: number;
    workflowId: string;
    removedAtMillis: number;
    projectionDigest?: string;
    candidateVerification?: SermonDeletionCandidateVerification;
    destinationEvidenceDigest?: string;
    certifiedDeletion?: {
      originalSessionId: string;
      certifiedSessionId: string;
      sourceProgramDigest: string;
      dispositionDigest: string;
    };
  };
}
const local = (db: Firestore, plan: Pick<SermonDeletionMirrorPlan, 'planId'>) =>
  db.collection(SERMON_DELETION_MIRROR_PLANS).doc(plan.planId);
export const sermonDeletionMirrorPlanId = (ref: DurableJobRef, sermonId: string): string =>
  createHash('sha256')
    .update(JSON.stringify([ref.projectId, ref.jobId, sermonId]))
    .digest('hex');
const owned = (path: string, id: string): boolean => {
  const parts = path.split('/');
  return (
    path === `sermons/${id}` ||
    (parts.length === 4 &&
      ((parts[0] === 'sermons' && parts[1] === id && parts[2] === 'sermonLists') ||
        (parts[0] === 'lists' && parts[2] === 'listItems' && parts[3] === id) ||
        (parts[0] === 'series' && parts[2] === 'seriesItems' && parts[3] === id)))
  );
};
async function* pages(query: Query): AsyncGenerator<QueryDocumentSnapshot[]> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let next = query.orderBy(FieldPath.documentId()).limit(PAGE);
    if (cursor) next = next.startAfter(cursor);
    const page = await next.get();
    if (page.empty) return;
    yield page.docs;
    if (page.size < PAGE) return;
    cursor = page.docs[page.docs.length - 1];
  }
}
async function authority(
  tx: Transaction,
  db: Firestore,
  plan: Pick<SermonDeletionMirrorPlan, 'projectId' | 'jobId' | 'sermonId'>
) {
  const [intentSnap, jobSnap] = await Promise.all([
    tx.get(db.doc(`durableJobIntents/${plan.jobId}`)),
    tx.get(db.doc(`durableJobs/${plan.jobId}`)),
  ]);
  const intent = object(intentSnap.data()),
    job = object(jobSnap.data()),
    entity = object(intent.entity),
    domain = object(intent.payload);
  if (
    intent.schemaVersion !== 1 ||
    intent.projectId !== plan.projectId ||
    intent.jobId !== plan.jobId ||
    intent.kind !== 'sermon.delete' ||
    entity.type !== 'sermon' ||
    entity.id !== plan.sermonId ||
    domain.sermonId !== plan.sermonId ||
    domain.action !== 'delete' ||
    domain.generation !== intent.generation ||
    job.projectId !== plan.projectId ||
    job.jobId !== plan.jobId ||
    job.kind !== intent.kind ||
    digest(job.entity) !== digest(entity) ||
    job.generation !== intent.generation ||
    !Number.isSafeInteger(intent.generation) ||
    Number(intent.generation) < 1 ||
    typeof job.workflowId !== 'string' ||
    !job.workflowId ||
    !['running', 'retrying', 'reconciling', 'needs_attention', 'cancel_requested'].includes(String(job.state))
  )
    fail();
  return {
    intent,
    job,
    generation: Number(intent.generation),
    workflowId: job.workflowId as string,
    intentFingerprint: digest(intent),
  };
}
function pointerClear(original: Data, requests: FrozenProjectionRequest[]): Data {
  const after: Data = { ...original, status: { ...object(original.status) } };
  for (const request of requests) {
    if (request.target?.provider === 'subsplash') {
      delete after.subsplashId;
      (after.status as Data).subsplash = uploadStatus.NOT_UPLOADED;
    } else {
      delete after.soundCloudTrackId;
      delete after.soundCloudTrackUrl;
      delete after.soundCloudPublication;
      (after.status as Data).soundCloud = uploadStatus.NOT_UPLOADED;
    }
  }
  return after;
}
function validateRequests(root: Data, input: SermonDeletionMirrorInput): void {
  const expected = [
    ['subsplash', 'media', 'subsplashId'],
    ['soundcloud', 'track', 'soundCloudTrackId'],
  ] as const;
  for (const [provider, type, field] of expected) {
    const id = root[field],
      requests = input.requests.filter((request) => request.target?.provider === provider);
    if (!id) {
      if (requests.length) fail();
      continue;
    }
    if (!valid(id) || requests.length !== 1) fail();
    const request = requests[0],
      target = request.target!;
    if (
      target.resourceId !== id ||
      target.resourceType !== type ||
      request.method !== 'DELETE' ||
      request.step !== `delete:${provider}:${id}` ||
      Object.keys(object(request.payload)).length !== 1 ||
      object(request.payload).id !== id ||
      request.fingerprint !==
        publishingMutationRequestFingerprint({ method: 'DELETE', target, payload: request.payload }) ||
      (provider === 'subsplash' ? target.account !== 'app:9XTSHD' : !/^soundcloud:users:[0-9]+$/.test(target.account))
    )
      fail();
    const verification = input.verifications.find(
      (v) => v.provider === provider && v.resourceId === id && v.account === target.account && v.resourceType === type
    );
    if (
      !verification ||
      verification.expectedState !== 'absent' ||
      Object.keys(verification.expectedProviderFields).length
    )
      fail();
  }
  if (input.requests.length > 2 || input.verifications.length !== input.requests.length) fail();
}
async function checkedHeader(tx: Transaction, db: Firestore, plan: SermonDeletionMirrorPlan): Promise<Header> {
  const scope = await authority(tx, db, plan),
    snapshot = await tx.get(local(db, plan)),
    header = snapshot.data() as Header | undefined;
  if (
    !header ||
    header.schemaVersion !== 1 ||
    digest(header.sourceParentRef) !== digest({ projectId: header.projectId, jobId: header.jobId }) ||
    !Array.isArray(header.sourceStepIds) ||
    !header.sourceStepIds.length ||
    header.sourceStepIds.length > 32 ||
    header.sourceStepIds.some((step) => !/^[a-z][a-z0-9-]{0,79}$/.test(step)) ||
    digest([...new Set(header.sourceStepIds)].sort()) !== digest(header.sourceStepIds) ||
    header.planId !== plan.planId ||
    header.planId !== sermonDeletionMirrorPlanId(plan, plan.sermonId) ||
    header.projectId !== plan.projectId ||
    header.jobId !== plan.jobId ||
    header.sermonId !== plan.sermonId ||
    header.generation !== scope.generation ||
    header.workflowId !== scope.workflowId ||
    header.intentFingerprint !== scope.intentFingerprint ||
    header.originalRootDigest !== acknowledgedProjectionDigest(header.originalRoot) ||
    header.pointerClearRootDigest !== acknowledgedProjectionDigest(pointerClear(header.originalRoot, header.requests))
  )
    fail();
  if (
    header.destinationProgram &&
    (header.destinationProgram.projectId !== header.projectId ||
      header.destinationProgram.jobId !== header.jobId ||
      header.destinationProgram.sermonId !== header.sermonId ||
      header.destinationProgram.planId !== header.planId ||
      !sha(header.destinationProgram.digest))
  )
    fail();
  if (
    header.state !== 'preparing' &&
    (!Number.isSafeInteger(header.canonicalPageCount) ||
      Number(header.canonicalPageCount) < 1 ||
      !sha(header.canonicalChainDigest) ||
      header.immutableCanonicalCatalogDigest !==
        catalogueDigest(header, Number(header.canonicalPageCount), header.canonicalChainDigest))
  )
    fail();
  return header;
}

const canonicalPageId = (index: number) => String(index).padStart(12, '0');
function catalogueDigest(header: Header, count: number, chain: string): string {
  return acknowledgedProjectionDigest({
    schemaVersion: 1,
    projectId: header.projectId,
    jobId: header.jobId,
    sermonId: header.sermonId,
    generation: header.generation,
    workflowId: header.workflowId,
    intentFingerprint: header.intentFingerprint,
    sourceStepIds: header.sourceStepIds,
    sourceParentRef: header.sourceParentRef,
    pageCount: count,
    chainDigest: chain,
  });
}
async function canonicalPage(tx: Transaction, db: Firestore, header: Header, index: number) {
  const ref = local(db, header).collection('canonicalPages').doc(canonicalPageId(index)),
    snapshot = await tx.get(ref),
    page = snapshot.get('page') as SermonDeletionCanonicalPage,
    hash = snapshot.get('digest');
  if (
    snapshot.get('schemaVersion') !== 1 ||
    snapshot.get('index') !== index ||
    !sha(hash) ||
    acknowledgedProjectionDigest(page) !== hash
  )
    fail();
  return { index, digest: hash, page };
}
async function pageCompletion(
  tx: Transaction,
  db: Firestore,
  header: Header,
  index: number,
  writeDigest: string
): Promise<{ done: boolean; commit: () => void }> {
  const page = await canonicalPage(tx, db, header, index),
    ref = local(db, header).collection('canonicalPageCompletions').doc(canonicalPageId(index)),
    prior = await tx.get(ref);
  if (prior.exists) {
    if (
      prior.get('schemaVersion') !== 1 ||
      prior.get('index') !== index ||
      prior.get('pageDigest') !== page.digest ||
      !sha(prior.get('writeDigest'))
    )
      fail();
    return { done: true, commit: () => {} };
  }
  if (!sha(writeDigest)) fail();
  return {
    done: false,
    commit: () => tx.create(ref, { schemaVersion: 1, index, pageDigest: page.digest, writeDigest }),
  };
}
async function captureCanonicalCatalogue(
  db: Firestore,
  plan: SermonDeletionMirrorPlan
): Promise<{ canonicalPageCount: number; canonicalChainDigest: string; immutableCanonicalCatalogDigest: string }> {
  let count = 0,
    chain = acknowledgedProjectionDigest([]);
  const capture = async (page: SermonDeletionCanonicalPage) => {
    const index = count,
      pageDigest = acknowledgedProjectionDigest(page);
    await runDurableTransaction(db, async (tx) => {
      const header = await checkedHeader(tx, db, plan);
      if (header.state !== 'preparing') fail();
      const ref = local(db, plan).collection('canonicalPages').doc(canonicalPageId(index)),
        prior = await tx.get(ref);
      if (
        prior.exists &&
        (prior.get('digest') !== pageDigest || acknowledgedProjectionDigest(prior.get('page')) !== pageDigest)
      )
        fail();
      const authorities =
        page.kind === 'counts'
          ? [
              ...new Map(
                page.countWrites.map((write) => {
                  const resourceType = write.path.startsWith('lists/')
                    ? 'list'
                    : write.path.startsWith('series/')
                    ? 'series'
                    : undefined;
                  const resourceId = write.expectedFields.subsplashId;
                  if (!resourceType || !valid(resourceId)) fail();
                  return [providerMutationFingerprint([resourceType, resourceId]), { resourceType, resourceId, write }];
                })
              ).entries(),
            ]
          : [];
      const existingAuthorities = await Promise.all(
        authorities.map(([id]) => tx.get(local(db, plan).collection('countReadTargets').doc(id)))
      );
      existingAuthorities.forEach((doc, i) => {
        if (
          doc.exists &&
          (doc.get('resourceType') !== authorities[i][1].resourceType ||
            doc.get('resourceId') !== authorities[i][1].resourceId ||
            doc.get('destinationDigest') !== header.destinationProgram?.digest)
        )
          fail();
      });
      if (!prior.exists) tx.create(ref, { schemaVersion: 1, index, digest: pageDigest, page });
      authorities.forEach(([id, authority], i) => {
        if (!existingAuthorities[i].exists)
          tx.create(local(db, plan).collection('countReadTargets').doc(id), {
            schemaVersion: 1,
            projectId: header.projectId,
            jobId: header.jobId,
            sermonId: header.sermonId,
            destinationDigest: header.destinationProgram!.digest,
            pageIndex: index,
            pageDigest,
            resourceType: authority.resourceType,
            resourceId: authority.resourceId,
            writeDigest: acknowledgedProjectionDigest(authority.write),
          });
      });
    });
    chain = acknowledgedProjectionDigest([chain, index, pageDigest]);
    count++;
  };
  const header = await runDurableTransaction(db, (tx) => checkedHeader(tx, db, plan));
  await capture({
    kind: 'root',
    path: `sermons/${plan.sermonId}`,
    baselineDigests: [header.originalRootDigest, header.pointerClearRootDigest],
  });
  for await (const docs of pages(local(db, plan).collection('rows')))
    for (let offset = 0; offset < docs.length; offset += CANONICAL_CHUNK)
      await capture({
        kind: 'mirrors',
        rows: docs.slice(offset, offset + CANONICAL_CHUNK).map((doc) => doc.data() as MirrorRow),
      });
  const destination = await runDurableTransaction(
    db,
    async (tx) => (await fullDeletionProgram(tx, db, await checkedHeader(tx, db, plan))).destination
  );
  if (destination)
    for (let offset = 0; offset < destination.countWrites.length; offset += CANONICAL_CHUNK)
      await capture({ kind: 'counts', countWrites: destination.countWrites.slice(offset, offset + CANONICAL_CHUNK) });
  return {
    canonicalPageCount: count,
    canonicalChainDigest: chain,
    immutableCanonicalCatalogDigest: catalogueDigest(header, count, chain),
  };
}

async function fullDeletionProgram(tx: Transaction, db: Firestore, header: Header) {
  const destination = header.destinationProgram
    ? await readSermonDeletionDestinationProgramInTransaction(tx, db, header.destinationProgram)
    : undefined;
  if (
    destination &&
    (destination.operation !== header.operation ||
      destination.mediaId !== header.originalRoot.subsplashId ||
      !header.requests.some(
        (request) => request.target?.provider === 'subsplash' && request.target.resourceId === destination.mediaId
      ))
  )
    fail();
  const requests = [...(destination?.requests ?? []), ...header.requests];
  if (new Set(requests.map((request) => request.step)).size !== requests.length) fail();
  return { requests, destination };
}

/** Private complete ledger, never a client supplied list of deletion paths. */
export async function prepareSermonDeletionMirrors(
  db: Firestore,
  input: SermonDeletionMirrorInput
): Promise<SermonDeletionMirrorPlan> {
  if (
    isCriticalPublishingRepair() ||
    getDurablePublishingJobId() !== input.ref.jobId ||
    ![input.sermonId, input.ref.jobId, input.ref.projectId].every(valid)
  )
    fail();
  const planId = sermonDeletionMirrorPlanId(input.ref, input.sermonId),
    operation = input.operation ?? getPublishingMutationOperation(),
    sourceStepIds = getPublishingSourceStepIds(input.ref.jobId);
  let plan!: SermonDeletionMirrorPlan;
  await runDurableTransaction(db, async (tx) => {
    const scope = await authority(tx, db, { ...input.ref, sermonId: input.sermonId });
    plan = {
      ...input.ref,
      sermonId: input.sermonId,
      planId,
      generation: scope.generation,
      workflowId: scope.workflowId,
      ...(operation ? { operation } : {}),
    };
    const [existing, root] = await Promise.all([tx.get(local(db, plan)), tx.get(db.doc(`sermons/${input.sermonId}`))]);
    if (existing.exists) {
      const header = await checkedHeader(tx, db, plan);
      if (
        digest(header.requests) !== digest(input.requests) ||
        digest(header.verifications) !== digest(input.verifications) ||
        digest(header.destinationProgram ?? null) !== digest(input.destinationProgram ?? null) ||
        header.operation !== operation
      )
        fail();
      return;
    }
    if (!root.exists) fail();
    const original = root.data()!;
    validateRequests(original, input);
    if (input.requests.length && !operation) fail();
    const header: Header = {
      schemaVersion: 1,
      ...plan,
      sourceStepIds,
      sourceParentRef: { projectId: input.ref.projectId, jobId: input.ref.jobId },
      state: 'preparing',
      intentFingerprint: scope.intentFingerprint,
      originalRoot: original,
      originalRootDigest: acknowledgedProjectionDigest(original),
      pointerClearRootDigest: acknowledgedProjectionDigest(pointerClear(original, input.requests)),
      requests: input.requests,
      verifications: input.verifications,
      ...(input.destinationProgram ? { destinationProgram: input.destinationProgram } : {}),
    };
    await fullDeletionProgram(tx, db, header);
    tx.create(local(db, plan), header);
  });
  const cached = await local(db, plan).get();
  if (cached.get('state') !== 'preparing') return plan;
  const capture = async (candidates: QueryDocumentSnapshot[]) => {
    for (let offset = 0; offset < candidates.length; offset += CHUNK) {
      const chunk = candidates.slice(offset, offset + CHUNK).filter((doc) => owned(doc.ref.path, input.sermonId));
      if (!chunk.length) continue;
      await runDurableTransaction(db, async (tx) => {
        const header = await checkedHeader(tx, db, plan);
        if (header.state !== 'preparing') fail();
        const snapshots = await tx.getAll(...chunk.map((doc) => doc.ref)),
          ready: Array<{ ref: ReturnType<Firestore['doc']>; row: MirrorRow }> = [];
        for (const snapshot of snapshots) {
          if (!snapshot.exists) continue;
          const parts = snapshot.ref.path.split('/'),
            kind = parts[0] === 'sermons' ? 'membership' : parts[0] === 'lists' ? 'list' : 'series';
          const row: MirrorRow = {
            canonicalPath: snapshot.ref.path,
            sourceFingerprint: digest(snapshot.data()),
            expectedDocumentDigest: acknowledgedProjectionDigest(snapshot.data()),
            kind,
            ...(kind !== 'membership' ? { parentPath: parts.slice(0, 2).join('/') } : {}),
            ...(kind === 'series' ? { published: snapshot.get('publishedToSubsplash') === true } : {}),
          };
          const target = local(db, plan).collection('rows').doc(providerEdgeKey(row.canonicalPath)),
            prior = await tx.get(target);
          if (prior.exists) {
            if (digest(prior.data()) !== digest(row)) fail();
          } else ready.push({ ref: target, row });
        }
        ready.forEach((entry) => tx.create(entry.ref, entry.row));
      });
    }
  };
  for await (const page of pages(db.collection('sermons').doc(input.sermonId).collection('sermonLists')))
    await capture(page);
  // Canonical path and final document ID are authority; copied ID/provider fields
  // never permit deleting another sermon, including legacy mirrors missing fields.
  for (const collection of ['listItems', 'seriesItems'])
    for await (const page of pages(db.collectionGroup(collection))) await capture(page);
  const catalogue = await captureCanonicalCatalogue(db, plan);
  if (input.requests.length) {
    await runDurableTransaction(db, async (tx) => {
      const header = await checkedHeader(tx, db, plan),
        root = await tx.get(db.doc(`sermons/${input.sermonId}`));
      if (
        header.state !== 'preparing' ||
        !root.exists ||
        acknowledgedProjectionDigest(root.data()) !== header.originalRootDigest
      )
        fail();
      const first = await prepareAcknowledgedProjectionPlan(tx, {
        operation: operation!,
        requests: input.requests,
        verifications: input.verifications,
        writes: [
          {
            path: root.ref.path,
            mode: 'delete',
            expectedExists: true,
            expectedDocumentDigest: header.originalRootDigest,
            expectedFields: {},
            patch: {},
            requiredSteps: input.requests.map((r) => r.step),
          },
        ],
        finalFragment: false,
        completesActivity: false,
      });
      first.commit();
    });
    // The only alternate captured baseline is the exact pointer-clear projection
    // of these original DELETEs. Both versions precede every mirror fragment.
    await runDurableTransaction(db, async (tx) => {
      const header = await checkedHeader(tx, db, plan);
      if (header.state !== 'preparing') fail();
      const alternate = await prepareAcknowledgedProjectionPlan(tx, {
        operation: operation!,
        requests: input.requests,
        verifications: input.verifications,
        writes: [
          {
            path: `sermons/${input.sermonId}`,
            mode: 'delete',
            expectedExists: true,
            expectedDocumentDigest: header.pointerClearRootDigest,
            expectedFields: {},
            patch: {},
            requiredSteps: input.requests.map((request) => request.step),
          },
        ],
        finalFragment: false,
        completesActivity: false,
      });
      alternate.commit();
    });
    const destination = await runDurableTransaction(
      db,
      async (tx) => (await fullDeletionProgram(tx, db, await checkedHeader(tx, db, plan))).destination
    );
    if (destination) {
      for (let offset = 0; offset < destination.requests.length; offset += CHUNK) {
        const requests = destination.requests.slice(offset, offset + CHUNK);
        await runDurableTransaction(db, async (tx) => {
          const header = await checkedHeader(tx, db, plan);
          if (header.state !== 'preparing') fail();
          const fragment = await prepareAcknowledgedProjectionPlan(tx, {
            operation: operation!,
            requests,
            writes: [],
            verifications: destination.verifications.filter((verification) =>
              requests.some(
                (request) =>
                  request.target?.provider === verification.provider &&
                  request.target.account === verification.account &&
                  request.target.resourceType === verification.resourceType &&
                  request.target.resourceId === verification.resourceId
              )
            ),
            finalFragment: false,
            completesActivity: false,
          });
          fragment.commit();
        });
      }
      for (let offset = 0; offset < destination.countWrites.length; offset += CHUNK) {
        const writes = destination.countWrites.slice(offset, offset + CHUNK);
        await runDurableTransaction(db, async (tx) => {
          await checkedHeader(tx, db, plan);
          const fragment = await prepareAcknowledgedProjectionPlan(tx, {
            operation: operation!,
            requests: input.requests,
            writes: writes.map((write) => ({
              ...write,
              mode: 'update' as const,
              expectedExists: true,
              requiredSteps: input.requests.map((request) => request.step),
            })),
            verifications: [],
            finalFragment: false,
            completesActivity: false,
          });
          fragment.commit();
        });
      }
    }
    for await (const page of pages(local(db, plan).collection('rows')))
      for (let offset = 0; offset < page.length; offset += CHUNK) {
        const chunk = page.slice(offset, offset + CHUNK);
        await runDurableTransaction(db, async (tx) => {
          const header = await checkedHeader(tx, db, plan);
          if (header.state !== 'preparing') fail();
          const rows = chunk.map((doc) => doc.data() as MirrorRow),
            snapshots = await tx.getAll(...rows.map((row) => db.doc(row.canonicalPath)));
          snapshots.forEach((snapshot, index) => {
            if (!snapshot.exists || digest(snapshot.data()) !== rows[index].sourceFingerprint) fail();
          });
          const frozen = await prepareAcknowledgedProjectionPlan(tx, {
            operation: operation!,
            requests: input.requests,
            verifications: [],
            writes: rows.map((row) => ({
              path: row.canonicalPath,
              mode: 'delete',
              expectedExists: true,
              expectedDocumentDigest: row.expectedDocumentDigest,
              expectedFields: {},
              patch: {},
              requiredSteps: input.requests.map((r) => r.step),
            })),
            finalFragment: false,
            completesActivity: false,
          });
          frozen.commit();
        });
      }
    if (destination)
      for (let offset = 0; offset < destination.requests.length; offset += CHUNK) {
        const requests = destination.requests.slice(offset, offset + CHUNK);
        await runDurableTransaction(db, async (tx) => {
          await checkedHeader(tx, db, plan);
          const ready = await prepareAcknowledgedProjectionPlan(tx, {
            operation: operation!,
            requests,
            writes: [],
            verifications: [],
            finalFragment: true,
            completesActivity: false,
          });
          ready.commit();
        });
      }
    await runDurableTransaction(db, async (tx) => {
      await checkedHeader(tx, db, plan);
      const ready = await prepareAcknowledgedProjectionPlan(tx, {
        operation: operation!,
        requests: input.requests,
        writes: [],
        verifications: input.verifications,
        finalFragment: true,
        completesActivity: false,
      });
      ready.commit();
      tx.update(local(db, plan), { state: 'prepared', frozenProgramDigest: ready.projectionDigest, ...catalogue });
    });
  } else
    await runDurableTransaction(db, async (tx) => {
      await checkedHeader(tx, db, plan);
      tx.update(local(db, plan), { state: 'prepared', ...catalogue });
    });
  return plan;
}

async function originalEvidence(
  tx: Transaction,
  db: Firestore,
  header: Header,
  allowActiveAcknowledged = false,
  allowActiveKnown = false
): Promise<string> {
  if (header.rootRemoval?.candidateVerification) {
    const witness = header.rootRemoval.candidateVerification;
    const expected = {
      sourceProgramDigest: await sourceProgramDigest(tx, db, header),
      sourceRequestCount: header.requests.length + (await destinationSourceRequestCount(tx, db, header)),
    };
    const sessionId = providerMutationFingerprint({
      projectId: header.projectId,
      jobId: header.jobId,
      operation: header.operation,
    });
    const verified = await assertAcknowledgedRepairCandidateVerificationSeal(tx, db, {
      ref: header,
      sessionId,
      projectionDigest: header.rootRemoval.projectionDigest!,
      ...witness,
      currentSeal: undefined,
      requireCurrentProgram: false,
      sourceProgramExpectation: expected,
    });
    const session = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`));
    if (
      !['active', 'committed'].includes(session.get('state')) ||
      session.get('effectsClosed') !== true ||
      session.get('effectsClosedSourceProgramDigest') !== expected.sourceProgramDigest
    )
      fail();
    const destinationEvidenceDigest = header.destinationProgram
      ? (await validateSermonDeletionDestinationCompletion(tx, db, header.destinationProgram)).evidenceDigest
      : undefined;
    if (destinationEvidenceDigest !== header.rootRemoval.destinationEvidenceDigest) fail();
    const absences = [];
    for (const request of header.requests) absences.push(await qualifiedAbsenceEvidence(tx, db, header, request));
    return digest({
      candidateId: witness.candidateId,
      candidateDigest: witness.candidateDigest,
      programId: verified.programId,
      programSealDigest: verified.programSealDigest,
      ...expected,
      absences,
      ...(destinationEvidenceDigest ? { destinationEvidenceDigest } : {}),
    });
  }
  if (header.requests.length) {
    const originalSessionId = providerMutationFingerprint({
      projectId: header.projectId,
      jobId: header.jobId,
      operation: header.operation,
    });
    const old = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${originalSessionId}`));
    if (old.get('state') === 'aborted' && (await hasSermonCertifiedDisposition(tx, db, header)))
      return (await certifiedSermonDeletionSourceProof(tx, db, header)).dispositionDigest;
  }
  const program = await fullDeletionProgram(tx, db, header);
  if (!program.requests.length) return digest({ localOnly: true, intentFingerprint: header.intentFingerprint });
  const scope = { projectId: header.projectId, jobId: header.jobId, operation: header.operation! },
    id = providerMutationFingerprint(scope),
    sessionSnap = await tx.get(db.collection(PROVIDER_MUTATION_SESSIONS).doc(id));
  const sessionData = object(sessionSnap.data());
  if (
    !(
      ['committed', 'aborted'].includes(String(sessionData.state)) ||
      ((allowActiveAcknowledged ||
        allowActiveKnown ||
        (sessionData.effectsClosed === true &&
          sessionData.effectsClosedSourceProgramDigest === (await sourceProgramDigest(tx, db, header)))) &&
        sessionData.state === 'active')
    ) ||
    digest(sessionData.scope) !== digest(scope)
  )
    fail();
  const requests = await tx.get(sessionSnap.ref.collection('requests'));
  const session: ProviderMutationSession = {
    db,
    id,
    scope,
    resources: sessionData.resources as ProviderMutationSession['resources'],
  };
  if (requests.size) await validateProviderMutationOriginalCompletion(tx, session, requests.docs);
  if (
    allowActiveAcknowledged &&
    (requests.size !== program.requests.length || requests.docs.some((doc) => doc.get('state') !== 'acknowledged'))
  )
    fail();
  if (requests.docs.some((doc) => !program.requests.some((expected) => expected.step === doc.get('step')))) fail();
  const evidence: unknown[] = [];
  for (const expected of program.requests) {
    const actual = requests.docs.find((doc) => doc.get('step') === expected.step);
    if (actual) {
      if (
        actual.get('method') !== expected.method ||
        actual.get('fingerprint') !== expected.fingerprint ||
        !['acknowledged', 'rejected_no_effect'].includes(actual.get('state'))
      )
        fail();
      if (actual.get('state') === 'rejected_no_effect') {
        const fact = await tx.get(
            db
              .collection('temporalProviderMutationFacts')
              .doc(providerMutationFingerprint([id, expected.step, actual.get('claim')]))
          ),
          rejection = object(fact.get('evidence'));
        if (
          ![404, 410].includes(Number(rejection.status)) ||
          rejection.transport !== 'original_http_response' ||
          rejection.providerCode !== 'resource_not_found'
        )
          fail();
      }
      evidence.push({
        step: expected.step,
        method: actual.get('method'),
        fingerprint: actual.get('fingerprint'),
        claim: actual.get('claim'),
        executionId: actual.get('executionId'),
        state: actual.get('state'),
        result: actual.get('result') ?? null,
        ...(header.requests.some((root) => root.step === expected.step)
          ? { absence: await qualifiedAbsenceEvidence(tx, db, header, expected) }
          : {}),
      });
    } else {
      if (allowActiveAcknowledged || !header.requests.some((root) => root.step === expected.step)) fail();
      const retained =
        expected.target?.provider === 'soundcloud'
          ? await validateLegacySoundCloudRetentionDisposition(tx, db, {
              ref: header,
              trackId: expected.target.resourceId,
            })
          : undefined;
      evidence.push(
        retained
          ? {
              step: expected.step,
              disposition: 'remote_retained',
              certificateId: retained.certificateId,
              sealedProofDigest: retained.sealedProofDigest,
            }
          : { step: expected.step, absence: await qualifiedAbsenceEvidence(tx, db, header, expected) }
      );
    }
  }
  const destinationCompletion = header.destinationProgram
    ? await validateSermonDeletionDestinationCompletion(tx, db, header.destinationProgram)
    : undefined;
  if (
    destinationCompletion &&
    (!sha(destinationCompletion.evidenceDigest) ||
      digest([...destinationCompletion.countWrites].sort((a, b) => a.path.localeCompare(b.path))) !==
        digest([...(program.destination?.countWrites ?? [])].sort((a, b) => a.path.localeCompare(b.path))))
  )
    fail();
  return digest({
    session: id,
    evidence,
    ...(destinationCompletion ? { destinationEvidenceDigest: destinationCompletion.evidenceDigest } : {}),
  });
}
async function qualifiedAbsenceEvidence(
  tx: Transaction,
  db: Firestore,
  header: Header,
  request: FrozenProjectionRequest
): Promise<Data> {
  const target = request.target!,
    journalId = createHash('sha256')
      .update(JSON.stringify([header.projectId, header.jobId, target.provider, target.resourceId]))
      .digest('hex'),
    journal = await tx.get(db.collection('temporalPublishingDeletionReceipts').doc(journalId));
  const evidence = {
    schemaVersion: 1,
    projectId: journal.get('projectId'),
    jobId: journal.get('jobId'),
    sermonId: journal.get('sermonId'),
    provider: journal.get('provider'),
    remoteId: journal.get('remoteId'),
    originalAccount: journal.get('originalAccount'),
    absenceProof: journal.get('absenceProof'),
    ownershipConfirmedBeforeDelete: journal.get('ownershipConfirmedBeforeDelete'),
  };
  if (
    journal.get('state') !== 'absence_confirmed' ||
    evidence.projectId !== header.projectId ||
    evidence.jobId !== header.jobId ||
    evidence.sermonId !== header.sermonId ||
    evidence.provider !== target.provider ||
    evidence.remoteId !== target.resourceId ||
    evidence.originalAccount !== target.account ||
    evidence.absenceProof !== 'authenticated_fixed_id_get_404_410' ||
    evidence.ownershipConfirmedBeforeDelete !== true
  )
    fail();
  // Mutable phase, bookkeeping, and timestamps are deliberately not root authority.
  return evidence;
}
async function rootCheckpoint(
  tx: Transaction,
  db: Firestore,
  plan: SermonDeletionMirrorPlan,
  projectionDigest?: string
): Promise<{ commit: () => void; rootExists: boolean }> {
  const header = await checkedHeader(tx, db, plan),
    root = await tx.get(db.doc(`sermons/${plan.sermonId}`)),
    evidence = await originalEvidence(tx, db, header, projectionDigest !== undefined);
  if (header.rootRemoval) {
    if (
      header.rootRemoval.originalEvidenceDigest !== evidence ||
      header.rootRemoval.intentFingerprint !== header.intentFingerprint ||
      header.rootRemoval.generation !== header.generation ||
      header.rootRemoval.workflowId !== header.workflowId ||
      root.exists
    )
      fail();
    const progress = await tx.get(local(db, header).collection('canonicalPageCompletions').doc(canonicalPageId(0)));
    if (!progress.exists) fail();
    return { commit: () => {}, rootExists: false };
  }
  if (
    header.state !== 'prepared' ||
    !root.exists ||
    ![header.originalRootDigest, header.pointerClearRootDigest].includes(acknowledgedProjectionDigest(root.data()))
  )
    fail();
  const originalSessionId = providerMutationFingerprint({
    projectId: header.projectId,
    jobId: header.jobId,
    operation: header.operation,
  });
  const originalSession = header.requests.length
    ? await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${originalSessionId}`))
    : undefined;
  const certified =
    originalSession?.get('state') === 'aborted' ? await certifiedSermonDeletionSourceProof(tx, db, header) : undefined;
  const checkpoint = {
    schemaVersion: 1 as const,
    ...(certified
      ? {
          certifiedDeletion: {
            originalSessionId,
            certifiedSessionId: certified.session.id,
            sourceProgramDigest: certified.sourceProgramDigest,
            dispositionDigest: certified.dispositionDigest,
          },
        }
      : {}),
    originalEvidenceDigest: evidence,
    rootSourceDigest: acknowledgedProjectionDigest(root.data()),
    intentFingerprint: header.intentFingerprint,
    generation: header.generation,
    workflowId: header.workflowId,
    removedAtMillis: Date.now(),
    ...(projectionDigest ? { projectionDigest } : {}),
  };
  const rootPage = await pageCompletion(
    tx,
    db,
    header,
    0,
    acknowledgedProjectionDigest({
      kind: 'root',
      path: `sermons/${plan.sermonId}`,
      rootSourceDigest: checkpoint.rootSourceDigest,
    })
  );
  return {
    rootExists: true,
    commit: () => {
      rootPage.commit();
      tx.update(local(db, plan), { state: 'root_removed', rootRemoval: checkpoint });
    },
  };
}
/** Called only by the ACK repair adapter after its original facts and fresh fixed
 * absence verifier. The checkpoint and canonical root DELETE share one transaction. */
export async function prepareSermonRootRemovalCheckpointFromAcknowledgedRepair(
  tx: Transaction,
  db: Firestore,
  input: {
    ref: DurableJobRef;
    sessionId: string;
    sermonId: string;
    projectionDigest: string;
    requests?: Array<Pick<FrozenProjectionRequest, 'step' | 'method' | 'target' | 'fingerprint'>>;
    acknowledgedSteps?: string[];
    candidateVerification?: SermonDeletionCandidateVerification;
  }
): Promise<() => void> {
  if (!sha(input.projectionDigest)) fail();
  const header = (await tx.get(local(db, { planId: sermonDeletionMirrorPlanId(input.ref, input.sermonId) }))).data() as
    | Header
    | undefined;
  if (input.candidateVerification) {
    if (
      !header ||
      input.sessionId !==
        providerMutationFingerprint({ projectId: header.projectId, jobId: header.jobId, operation: header.operation })
    )
      fail();
    await checkedHeader(tx, db, header);
    const root = await tx.get(db.doc(`sermons/${header.sermonId}`));
    if (header.rootRemoval) {
      const pinned = header.rootRemoval.candidateVerification;
      if (
        root.exists ||
        !pinned ||
        pinned.candidateId !== input.candidateVerification.candidateId ||
        pinned.candidateDigest !== input.candidateVerification.candidateDigest ||
        pinned.observationScope !== input.candidateVerification.observationScope ||
        (input.candidateVerification.programId !== undefined &&
          pinned.programId !== input.candidateVerification.programId) ||
        (input.candidateVerification.programSealDigest !== undefined &&
          pinned.programSealDigest !== input.candidateVerification.programSealDigest)
      )
        fail();
      await originalEvidence(tx, db, header);
      return () => {};
    }
    if (
      !input.candidateVerification.currentSeal ||
      header.state !== 'prepared' ||
      !root.exists ||
      ![header.originalRootDigest, header.pointerClearRootDigest].includes(acknowledgedProjectionDigest(root.data())) ||
      header.frozenProgramDigest !== input.projectionDigest
    )
      fail();
    const expectation = {
      sourceProgramDigest: await sourceProgramDigest(tx, db, header),
      sourceRequestCount: header.requests.length + (await destinationSourceRequestCount(tx, db, header)),
    };
    const verified = await assertAcknowledgedRepairCandidateVerificationSeal(tx, db, {
      ref: header,
      sessionId: input.sessionId,
      projectionDigest: input.projectionDigest,
      ...input.candidateVerification,
      sourceProgramExpectation: expectation,
    });
    let destinationEvidenceDigest: string | undefined;
    if (header.destinationProgram) {
      const completion = await validateSermonDeletionDestinationCompletion(tx, db, header.destinationProgram);
      const original = await readSermonDeletionDestinationProgramInTransaction(tx, db, header.destinationProgram);
      if (
        !sha(completion.evidenceDigest) ||
        digest([...completion.countWrites].sort((a, b) => a.path.localeCompare(b.path))) !==
          digest([...original.countWrites].sort((a, b) => a.path.localeCompare(b.path)))
      )
        fail();
      destinationEvidenceDigest = completion.evidenceDigest;
    }
    const absences = [];
    for (const request of header.requests) absences.push(await qualifiedAbsenceEvidence(tx, db, header, request));
    const sessionSnap = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${input.sessionId}`));
    const session: ProviderMutationSession = {
      db,
      id: input.sessionId,
      scope: { projectId: header.projectId, jobId: header.jobId, operation: header.operation! },
      resources: sessionSnap.get('resources'),
    };
    const closed = await prepareProviderMutationEffectsClosedFromReadyEvidence(tx, session, async () => ({
      sourceProgramDigest: expectation.sourceProgramDigest,
      expectedRequestCount: expectation.sourceRequestCount,
      actualRequestCount: verified.originalRequestCount,
      claimSetDigest: verified.terminalClaimSetDigest,
      claimSetDigestVersion: 2,
    }));
    const witness: SermonDeletionCandidateVerification = {
      candidateId: input.candidateVerification.candidateId,
      candidateDigest: input.candidateVerification.candidateDigest,
      observationScope: input.candidateVerification.observationScope,
      programId: verified.programId,
      programSealDigest: verified.programSealDigest,
    };
    const checkpoint = {
      schemaVersion: 1 as const,
      originalEvidenceDigest: digest({
        candidateId: witness.candidateId,
        candidateDigest: witness.candidateDigest,
        programId: verified.programId,
        programSealDigest: verified.programSealDigest,
        ...expectation,
        absences,
        ...(destinationEvidenceDigest ? { destinationEvidenceDigest } : {}),
      }),
      rootSourceDigest: acknowledgedProjectionDigest(root.data()),
      intentFingerprint: header.intentFingerprint,
      generation: header.generation,
      workflowId: header.workflowId,
      removedAtMillis: Date.now(),
      projectionDigest: input.projectionDigest,
      candidateVerification: witness,
      ...(destinationEvidenceDigest ? { destinationEvidenceDigest } : {}),
    };
    const rootPage = await pageCompletion(
      tx,
      db,
      header,
      0,
      acknowledgedProjectionDigest({
        kind: 'root',
        path: `sermons/${header.sermonId}`,
        rootSourceDigest: checkpoint.rootSourceDigest,
      })
    );
    return () => {
      closed.commit();
      rootPage.commit();
      tx.update(local(db, header), { state: 'root_removed', rootRemoval: checkpoint });
    };
  }
  const program = header ? await fullDeletionProgram(tx, db, header) : undefined;
  if (
    !header ||
    !program ||
    input.sessionId !==
      providerMutationFingerprint({ projectId: header.projectId, jobId: header.jobId, operation: header.operation }) ||
    program.requests.some(
      (expected) =>
        !input.acknowledgedSteps?.includes(expected.step) ||
        !input.requests?.some(
          (actual) =>
            actual.step === expected.step &&
            actual.method === expected.method &&
            actual.fingerprint === expected.fingerprint &&
            digest(actual.target) === digest(expected.target)
        )
    )
  )
    fail();
  const frozen = await tx.get(db.doc(`temporalPublishingAcknowledgedProjections/${input.sessionId}`));
  if (
    !frozen.exists ||
    acknowledgedProjectionDigest(frozen.data()) !== input.projectionDigest ||
    header.frozenProgramDigest !== input.projectionDigest
  )
    fail();
  const prepared = await rootCheckpoint(tx, db, header, input.projectionDigest);
  return prepared.commit;
}
/** Root first suppresses membership listeners from rewriting an already deleted
 * sermon's counters while bounded cleanup proceeds under the private proof. */
export async function removeSermonDeletionMirrors(
  db: Firestore,
  plan: SermonDeletionMirrorPlan,
  options: { assertOriginalProviderEffects: (tx: Transaction, plan: SermonDeletionMirrorPlan) => Promise<void> }
): Promise<void> {
  if (getDurablePublishingJobId() !== plan.jobId) fail();
  let completed = false;
  await runDurableTransaction(db, async (tx) => {
    await options.assertOriginalProviderEffects(tx, plan);
    const header = await checkedHeader(tx, db, plan);
    completed = header.state === 'completed';
    const root = await rootCheckpoint(tx, db, plan);
    root.commit();
    if (root.rootExists) tx.delete(db.doc(`sermons/${plan.sermonId}`));
  });
  if (completed) return;
  for await (const page of pages(local(db, plan).collection('canonicalPages')))
    for (const captured of page) {
      const index = captured.get('index'),
        body = captured.get('page') as SermonDeletionCanonicalPage;
      if (body.kind === 'root') continue;
      await runDurableTransaction(db, async (tx) => {
        await options.assertOriginalProviderEffects(tx, plan);
        const header = await checkedHeader(tx, db, plan);
        if (
          !header.rootRemoval ||
          header.rootRemoval.originalEvidenceDigest !== (await originalEvidence(tx, db, header)) ||
          (await tx.get(db.doc(`sermons/${plan.sermonId}`))).exists
        )
          fail();
        const source = await canonicalPage(tx, db, header, index),
          prior = await tx.get(local(db, header).collection('canonicalPageCompletions').doc(canonicalPageId(index)));
        if (prior.exists) {
          if (prior.get('pageDigest') !== source.digest || !sha(prior.get('writeDigest'))) fail();
          return;
        }
        const updates: Array<{ path: string; patch: Data }> = [],
          deletes: Array<ReturnType<Firestore['doc']>> = [];
        if (source.page.kind === 'mirrors') {
          const rows = source.page.rows;
          if (rows.length > CHUNK) fail();
          const snapshots = await tx.getAll(...rows.map((row) => db.doc(row.canonicalPath)));
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i],
              snapshot = snapshots[i];
            if (
              !owned(row.canonicalPath, plan.sermonId) ||
              (snapshot.exists && digest(snapshot.data()) !== row.sourceFingerprint)
            )
              fail();
            if (snapshot.exists) deletes.push(snapshot.ref);
            if (!row.parentPath) continue;
            const parent = await tx.get(db.doc(row.parentPath));
            if (!parent.exists) continue;
            if (row.kind === 'list' && !parent.get('subsplashId')) {
              const count = await tx.get(parent.ref.collection('listItems').count());
              updates.push({
                path: row.parentPath,
                patch: { count: Math.max(0, count.data().count - (snapshot.exists ? 1 : 0)) },
              });
            }
            if (row.kind === 'series') {
              const all = await tx.get(parent.ref.collection('seriesItems').count()),
                published = await tx.get(
                  parent.ref.collection('seriesItems').where('publishedToSubsplash', '==', true).count()
                ),
                remaining = Math.max(0, published.data().count - (snapshot.exists && row.published ? 1 : 0));
              updates.push({
                path: row.parentPath,
                patch: {
                  itemCount: Math.max(0, all.data().count - (snapshot.exists ? 1 : 0)),
                  publishedItemCount: remaining,
                  subtitle: getSeriesSubtitleFromPublishedCount(remaining),
                },
              });
            }
          }
        } else if (source.page.kind === 'counts') {
          if (!header.destinationProgram) fail();
          const verified = (await validateSermonDeletionDestinationCompletion(tx, db, header.destinationProgram))
              .countWrites,
            chunk = source.page.countWrites;
          if (chunk.length > CHUNK || chunk.some((write) => !verified.some((value) => digest(value) === digest(write))))
            fail();
          const snapshots = await tx.getAll(...chunk.map((write) => db.doc(write.path)));
          snapshots.forEach((snapshot, i) => {
            const write = chunk[i];
            if (
              !/^(lists|series)\/[^/]+$/.test(write.path) ||
              !snapshot.exists ||
              Object.keys(write.expectedFields).length !== 1 ||
              !valid(write.expectedFields.subsplashId) ||
              snapshot.get('subsplashId') !== write.expectedFields.subsplashId ||
              Object.entries(write.patch).some(
                ([key, value]) =>
                  !['count', 'logicalCount', 'publishedItemCount', 'subtitle'].includes(key) ||
                  (key === 'subtitle'
                    ? typeof value !== 'string' || value.length > 1024
                    : !Number.isSafeInteger(value) || Number(value) < 0)
              )
            )
              fail();
            updates.push({ path: write.path, patch: write.patch });
          });
        } else fail();
        const done = await pageCompletion(
          tx,
          db,
          header,
          index,
          acknowledgedProjectionDigest({
            sourcePageDigest: source.digest,
            deletes: deletes.map((ref) => ref.path),
            updates,
          })
        );
        deletes.forEach((ref) => tx.delete(ref));
        updates.forEach((update) => tx.update(db.doc(update.path), update.patch));
        done.commit();
      });
    }
  await runDurableTransaction(db, async (tx) => {
    await options.assertOriginalProviderEffects(tx, plan);
    const header = await checkedHeader(tx, db, plan);
    if (!header.rootRemoval) fail();
    let cursor: QueryDocumentSnapshot | undefined,
      index = 0,
      chain = acknowledgedProjectionDigest([]);
    for (;;) {
      let query = local(db, header).collection('canonicalPageCompletions').orderBy(FieldPath.documentId()).limit(PAGE);
      if (cursor) query = query.startAfter(cursor);
      const result = await tx.get(query);
      for (const progress of result.docs) {
        const source = await canonicalPage(tx, db, header, index);
        if (
          progress.id !== canonicalPageId(index) ||
          progress.get('schemaVersion') !== 1 ||
          progress.get('index') !== index ||
          progress.get('pageDigest') !== source.digest ||
          !sha(progress.get('writeDigest'))
        )
          fail();
        chain = acknowledgedProjectionDigest([chain, index, acknowledgedProjectionDigest(progress.data())]);
        index++;
      }
      if (result.size < PAGE) break;
      cursor = result.docs[result.size - 1];
    }
    if (index !== header.canonicalPageCount) fail();
    const sessionId = providerMutationFingerprint({
        projectId: header.projectId,
        jobId: header.jobId,
        operation: header.operation,
      }),
      session = header.requests.length
        ? await tx.get(
            db.doc(
              `${PROVIDER_MUTATION_SESSIONS}/${header.rootRemoval.certifiedDeletion?.certifiedSessionId ?? sessionId}`
            )
          )
        : undefined;
    const originalRequestCount = session?.get('effectsClosedActualRequestCount'),
      closedClaimSetDigest = session?.get('effectsClosedClaimSetDigest');
    const proof: CanonicalCompletion = {
      schemaVersion: 1,
      immutableCatalogDigest: header.immutableCanonicalCatalogDigest!,
      expectedCanonicalPageCount: index,
      completedCanonicalPageCount: index,
      completionChainDigest: chain,
      canonicalCompletionDigest: acknowledgedProjectionDigest({
        immutableCatalogDigest: header.immutableCanonicalCatalogDigest,
        completedCanonicalPageCount: index,
        completionChainDigest: chain,
        rootRemoval: header.rootRemoval,
      }),
      ...(sha(closedClaimSetDigest) &&
      session?.get('effectsClosedClaimSetDigestVersion') === 2 &&
      Number.isSafeInteger(originalRequestCount) &&
      originalRequestCount >= 0
        ? { closedClaimSetDigest, closedClaimSetDigestVersion: 2 as const, originalRequestCount }
        : {}),
    };
    tx.update(local(db, plan), { state: 'completed', canonicalCompletion: proof });
  });
}

/** Missing-root permission is a fixed cleanup continuation, never new desire. */
export async function validateDeletedSermonCleanup(
  db: Firestore,
  intent: DurableJobIntent<unknown>,
  execution: DurableActivityExecution,
  tx?: Transaction
): Promise<{ uploaderId: string }> {
  if (
    ![
      'commitPublishingProjection',
      'releasePublishingAudio',
      'repairPublishingCritical',
      'cleanupCancelledPublishing',
    ].includes(execution.activityType) ||
    intent.kind !== 'sermon.delete' ||
    intent.entity.type !== 'sermon'
  )
    fail();
  const validate = async (transaction: Transaction) => {
    const headerSnap = await transaction.get(
        local(db, { planId: sermonDeletionMirrorPlanId(intent, intent.entity.id) })
      ),
      header = headerSnap.data() as Header | undefined;
    if (!header) fail();
    await checkedHeader(transaction, db, header);
    if (
      !header.rootRemoval ||
      !['root_removed', 'completed'].includes(header.state) ||
      header.intentFingerprint !== digest(intent) ||
      header.workflowId !== execution.workflowId ||
      header.rootRemoval.intentFingerprint !== header.intentFingerprint ||
      header.rootRemoval.generation !== intent.generation ||
      header.rootRemoval.workflowId !== execution.workflowId ||
      header.rootRemoval.originalEvidenceDigest !== (await originalEvidence(transaction, db, header)) ||
      (await transaction.get(db.doc(`sermons/${intent.entity.id}`))).exists
    )
      fail();
    return { uploaderId: typeof header.originalRoot.uploaderId === 'string' ? header.originalRoot.uploaderId : '' };
  };
  return tx ? validate(tx) : db.runTransaction(validate);
}

async function destinationSourceRequestCount(tx: Transaction, db: Firestore, header: Header): Promise<number> {
  if (!header.destinationProgram) return 0;
  const ref = header.destinationProgram,
    snapshot = await tx.get(db.doc(`${SERMON_DELETION_MIRROR_PLANS}/${ref.planId}/destinationPlan/header`)),
    data = snapshot.data() as Data | undefined;
  if (
    !data ||
    data.schemaVersion !== 1 ||
    data.projectId !== header.projectId ||
    data.jobId !== header.jobId ||
    data.sermonId !== header.sermonId ||
    data.generation !== header.generation ||
    data.intentDigest !==
      acknowledgedProjectionDigest((await tx.get(db.doc(`durableJobIntents/${header.jobId}`))).data()) ||
    data.operation !== header.operation ||
    data.mediaId !== header.originalRoot.subsplashId ||
    data.digest !== ref.digest ||
    !Number.isSafeInteger(data.requestCount) ||
    Number(data.requestCount) < 0
  )
    fail();
  return Number(data.requestCount);
}

async function sourceProgramDigest(tx: Transaction, db: Firestore, header: Header): Promise<string> {
  const requestCount = header.requests.length + (await destinationSourceRequestCount(tx, db, header));
  const sessionId = providerMutationFingerprint({
    projectId: header.projectId,
    jobId: header.jobId,
    operation: header.operation,
  });
  const frozen = await tx.get(db.doc(`temporalPublishingAcknowledgedProjections/${sessionId}`));
  if (
    !frozen.exists ||
    frozen.get('projectId') !== header.projectId ||
    frozen.get('jobId') !== header.jobId ||
    frozen.get('sessionId') !== sessionId ||
    frozen.get('operation') !== header.operation ||
    frozen.get('intentFingerprint') !==
      acknowledgedProjectionDigest((await tx.get(db.doc(`durableJobIntents/${header.jobId}`))).data()) ||
    frozen.get('requestCount') !== requestCount ||
    !sha(header.frozenProgramDigest) ||
    acknowledgedProjectionDigest(frozen.data()) !== header.frozenProgramDigest
  )
    fail();
  return digest({
    schemaVersion: 1,
    projectId: header.projectId,
    jobId: header.jobId,
    generation: header.generation,
    workflowId: header.workflowId,
    intentFingerprint: header.intentFingerprint,
    sermonId: header.sermonId,
    originalRootDigest: header.originalRootDigest,
    pointerClearRootDigest: header.pointerClearRootDigest,
    sourceStepIds: header.sourceStepIds,
    sourceParentRef: header.sourceParentRef,
    requests: header.requests,
    verifications: header.verifications,
    destinationProgram: header.destinationProgram ?? null,
    immutableCanonicalCatalogDigest: header.immutableCanonicalCatalogDigest,
    canonicalPageCount: header.canonicalPageCount,
    frozenProgramDigest: acknowledgedProjectionDigest(frozen.data()),
  });
}

/** Source-owned closure proof. Reads the complete immutable expected DELETE program;
 * closing transport admission holds resource ownership throughout root-first cleanup. */
export async function validateSermonDeletionEffectsForClosing(
  tx: Transaction,
  db: Firestore,
  plan: SermonDeletionMirrorPlan
): Promise<{ sourceProgramDigest: string; expectedRequestSteps: string[]; qualifiedNoSendSteps: string[] }> {
  const header = await checkedHeader(tx, db, plan);
  if (!['prepared', 'root_removed', 'completed'].includes(header.state) || !header.operation || !header.requests.length)
    fail();
  validateRequests(header.originalRoot, {
    ref: header,
    sermonId: header.sermonId,
    requests: header.requests,
    verifications: header.verifications,
    operation: header.operation,
  });
  const program = await fullDeletionProgram(tx, db, header);
  const scope = { projectId: header.projectId, jobId: header.jobId, operation: header.operation },
    id = providerMutationFingerprint(scope),
    record = await tx.get(db.collection(PROVIDER_MUTATION_SESSIONS).doc(id));
  const requests = await tx.get(record.ref.collection('requests'));
  const session: ProviderMutationSession = { db, id, scope, resources: record.get('resources') };
  for (const expected of program.requests) await assertAcknowledgedProjectionRequestPrepared(tx, session, expected);
  await originalEvidence(tx, db, header, false, true);
  return {
    sourceProgramDigest: await sourceProgramDigest(tx, db, header),
    expectedRequestSteps: program.requests.map((request) => request.step).sort(),
    qualifiedNoSendSteps: header.requests
      .filter((expected) => !requests.docs.some((actual) => actual.get('step') === expected.step))
      .map((request) => request.step)
      .sort(),
  };
}

export async function loadSermonDeletionMirrorPlan(
  db: Firestore,
  ref: DurableJobRef,
  sermonId: string,
  tx?: Transaction
): Promise<SermonDeletionMirrorPlan> {
  const read = async (transaction: Transaction) => {
    const record = await transaction.get(local(db, { planId: sermonDeletionMirrorPlanId(ref, sermonId) })),
      header = record.data() as Header | undefined;
    if (!header) fail();
    await checkedHeader(transaction, db, header);
    return {
      projectId: header.projectId,
      jobId: header.jobId,
      sermonId: header.sermonId,
      planId: header.planId,
      generation: header.generation,
      workflowId: header.workflowId,
      ...(header.operation ? { operation: header.operation } : {}),
    };
  };
  return tx ? read(tx) : db.runTransaction(read);
}

/** Final session release uses the private completed cleanup checkpoint, never a
 * missing root alone. The checkpoint is written only after all captured pages
 * passed their original-row CAS and the fenced counter updates completed. */
export function validateSermonDeletionCompletion(
  tx: Transaction,
  db: Firestore,
  plan: SermonDeletionMirrorPlan
): Promise<void>;
export function validateSermonDeletionCompletion(
  tx: Transaction,
  db: Firestore,
  plan: SermonDeletionMirrorPlan,
  closedSeal: ProviderMutationClosedEvidenceSeal
): Promise<ProviderMutationReadyCanonicalCompletion>;
export function validateSermonDeletionCompletion(
  tx: Transaction,
  db: Firestore,
  plan: SermonDeletionMirrorPlan,
  closedSeal?: ProviderMutationClosedEvidenceSeal
): Promise<void | ProviderMutationReadyCanonicalCompletion>;
export async function validateSermonDeletionCompletion(
  tx: Transaction,
  db: Firestore,
  plan: SermonDeletionMirrorPlan,
  closedSeal?: ProviderMutationClosedEvidenceSeal
): Promise<void | ProviderMutationReadyCanonicalCompletion> {
  const header = await checkedHeader(tx, db, plan);
  if (
    header.state !== 'completed' ||
    !header.rootRemoval ||
    (await tx.get(db.doc(`sermons/${header.sermonId}`))).exists
  )
    fail();
  if (closedSeal) {
    const proof = header.canonicalCompletion,
      sessionId =
        header.rootRemoval.certifiedDeletion?.certifiedSessionId ??
        providerMutationFingerprint({
          projectId: header.projectId,
          jobId: header.jobId,
          operation: header.operation,
        });
    if (
      !proof ||
      closedSeal.sessionId !== sessionId ||
      closedSeal.sourceDispositionValidated !== true ||
      proof.closedClaimSetDigest !== closedSeal.claimSetDigest ||
      proof.closedClaimSetDigestVersion !== 2 ||
      closedSeal.claimSetDigestVersion !== 2 ||
      proof.originalRequestCount !== closedSeal.actualRequestCount
    )
      fail();
    const actual = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`));
    if (
      actual.get('effectsClosed') !== true ||
      actual.get('effectsClosedClaimSetDigest') !== proof.closedClaimSetDigest ||
      actual.get('effectsClosedClaimSetDigestVersion') !== 2 ||
      actual.get('effectsClosedActualRequestCount') !== proof.originalRequestCount ||
      !['active', 'committed'].includes(actual.get('state'))
    )
      fail();
    const source = header.rootRemoval.certifiedDeletion
      ? (await certifiedSermonDeletionSourceProof(tx, db, header)).sourceProgramDigest
      : await sourceProgramDigest(tx, db, header);
    if (closedSeal.sourceProgramDigest !== undefined && closedSeal.sourceProgramDigest !== source) fail();
    const summary = await readSermonDeletionCanonicalCompletionSummary(tx, db, header);
    return {
      closedClaimSetDigest: proof.closedClaimSetDigest!,
      originalRequestCount: proof.originalRequestCount!,
      ...summary,
    };
  }
  if (header.rootRemoval.originalEvidenceDigest !== (await originalEvidence(tx, db, header))) fail();
  if (!header.requests.length) return;
  const sessionId = providerMutationFingerprint({
      projectId: header.projectId,
      jobId: header.jobId,
      operation: header.operation,
    }),
    session = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`));
  if (session.get('state') !== 'active') return;
  const closure = await validateSermonDeletionEffectsForClosing(tx, db, header);
  if (
    session.get('effectsClosed') !== true ||
    session.get('effectsClosedSourceProgramDigest') !== closure.sourceProgramDigest
  )
    fail();
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = local(db, header).collection('rows').orderBy(FieldPath.documentId()).limit(PAGE);
    if (cursor) query = query.startAfter(cursor);
    const page = await tx.get(query);
    for (let offset = 0; offset < page.size; offset += CHUNK) {
      const rows = page.docs.slice(offset, offset + CHUNK).map((doc) => doc.data() as MirrorRow);
      if (rows.some((row) => !owned(row.canonicalPath, header.sermonId))) fail();
      const mirrors = await tx.getAll(...rows.map((row) => db.doc(row.canonicalPath)));
      if (mirrors.some((doc) => doc.exists)) fail();
    }
    if (page.size < PAGE) break;
    cursor = page.docs[page.docs.length - 1];
  }
  if (header.destinationProgram) {
    const counts = (await validateSermonDeletionDestinationCompletion(tx, db, header.destinationProgram)).countWrites;
    for (let offset = 0; offset < counts.length; offset += CHUNK) {
      const chunk = counts.slice(offset, offset + CHUNK),
        snapshots = await tx.getAll(...chunk.map((write) => db.doc(write.path)));
      snapshots.forEach((snapshot, index) => {
        const write = chunk[index];
        if (
          !snapshot.exists ||
          Object.entries({ ...write.expectedFields, ...write.patch }).some(
            ([field, value]) => digest(snapshot.get(field) ?? null) !== digest(value ?? null)
          )
        )
          fail();
      });
    }
  }
}

/** Bounded read-only compiler evidence. Only the private fully prepared source
 * catalogue can expand a sermon root's verification dependencies. */
export async function readSermonDeletionRootMutationTargetsPage(
  tx: Transaction,
  db: Firestore,
  input: { ref: DurableJobRef; sermonId: string; cursor?: string; limit?: number }
): Promise<{
  targets: Array<{ target: ProviderMutationResource; requestStep: string }>;
  nextCursor?: string;
  sourceProgramDigest: string;
  sourceRequestCount: number;
}> {
  const limit = input.limit ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 || (input.cursor !== undefined && !sha(input.cursor)))
    fail();
  const planId = sermonDeletionMirrorPlanId(input.ref, input.sermonId),
    snapshot = await tx.get(local(db, { planId })),
    data = snapshot.data() as Header | undefined;
  if (
    !data ||
    data.projectId !== input.ref.projectId ||
    data.jobId !== input.ref.jobId ||
    data.sermonId !== input.sermonId ||
    !['prepared', 'root_removed', 'completed'].includes(data.state)
  )
    fail();
  const header = await checkedHeader(tx, db, data),
    programDigest = await sourceProgramDigest(tx, db, header),
    sourceRequestCount = header.requests.length + (await destinationSourceRequestCount(tx, db, header)),
    scope = { projectId: header.projectId, jobId: header.jobId, operation: header.operation! },
    sessionId = providerMutationFingerprint(scope),
    sessionDoc = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`));
  if (
    digest(sessionDoc.get('scope')) !== digest(scope) ||
    !['active', 'committed', 'aborted'].includes(sessionDoc.get('state'))
  )
    fail();
  const session: ProviderMutationSession = { db, id: sessionId, scope, resources: sessionDoc.get('resources') };
  let query = db
    .doc(`temporalPublishingAcknowledgedProjections/${sessionId}`)
    .collection('requestIndex')
    .orderBy(FieldPath.documentId())
    .limit(limit);
  if (input.cursor) query = query.startAfter(input.cursor);
  const page = await tx.get(query),
    targets: Array<{ target: ProviderMutationResource; requestStep: string }> = [];
  for (const index of page.docs) {
    const request = index.get('request') as FrozenProjectionRequest | undefined;
    if (!request || index.id !== providerMutationFingerprint(request.step) || !request.target) fail();
    const root = header.requests.find((expected) => expected.step === request.step);
    if (root) {
      if (acknowledgedProjectionDigest(root) !== acknowledgedProjectionDigest(request)) fail();
    } else {
      if (!header.destinationProgram) fail();
      const source = await tx.get(
        db
          .doc(`${SERMON_DELETION_MIRROR_PLANS}/${header.planId}/destinationPlan/header`)
          .collection('requests')
          .where('request.step', '==', request.step)
          .limit(2)
      );
      if (
        source.size !== 1 ||
        acknowledgedProjectionDigest(source.docs[0].get('request')) !== acknowledgedProjectionDigest(request)
      )
        fail();
    }
    await assertAcknowledgedProjectionRequestPrepared(tx, session, request);
    targets.push({ target: request.target, requestStep: request.step });
  }
  return {
    targets,
    ...(page.size === limit ? { nextCursor: page.docs[page.docs.length - 1].id } : {}),
    sourceProgramDigest: programDigest,
    sourceRequestCount,
  };
}

export async function readSermonDeletionCanonicalCompletionSummary(
  tx: Transaction,
  db: Firestore,
  plan: SermonDeletionMirrorPlan
): Promise<SermonDeletionCanonicalCompletionSummary> {
  const header = await checkedHeader(tx, db, plan),
    proof = header.canonicalCompletion;
  if (
    header.state !== 'completed' ||
    !header.rootRemoval ||
    !proof ||
    proof.schemaVersion !== 1 ||
    !sha(proof.immutableCatalogDigest) ||
    proof.immutableCatalogDigest !== header.immutableCanonicalCatalogDigest ||
    !sha(proof.completionChainDigest) ||
    proof.canonicalCompletionDigest !==
      acknowledgedProjectionDigest({
        immutableCatalogDigest: header.immutableCanonicalCatalogDigest,
        completedCanonicalPageCount: proof.completedCanonicalPageCount,
        completionChainDigest: proof.completionChainDigest,
        rootRemoval: header.rootRemoval,
      }) ||
    !sha(proof.canonicalCompletionDigest) ||
    proof.expectedCanonicalPageCount !== header.canonicalPageCount ||
    proof.completedCanonicalPageCount !== header.canonicalPageCount ||
    !Number.isSafeInteger(proof.expectedCanonicalPageCount) ||
    proof.expectedCanonicalPageCount < 1
  )
    fail();
  return {
    immutableCatalogDigest: proof.immutableCatalogDigest,
    expectedCanonicalPageCount: proof.expectedCanonicalPageCount,
    completedCanonicalPageCount: proof.completedCanonicalPageCount,
    canonicalCompletionDigest: proof.canonicalCompletionDigest,
  };
}
export async function readSermonDeletionCanonicalInventoryPage(
  tx: Transaction,
  db: Firestore,
  input: { ref: DurableJobRef; sermonId: string; cursor?: string; limit?: number }
): Promise<{
  pages: Array<{ index: number; digest: string; page: SermonDeletionCanonicalPage }>;
  nextCursor?: string;
  immutableCatalogDigest: string;
  expectedCanonicalPageCount: number;
}> {
  const limit = input.limit ?? 32;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 32 ||
    (input.cursor !== undefined && !/^\d{12}$/.test(input.cursor))
  )
    fail();
  const header = (await tx.get(local(db, { planId: sermonDeletionMirrorPlanId(input.ref, input.sermonId) }))).data() as
    | Header
    | undefined;
  if (!header) fail();
  await checkedHeader(tx, db, header);
  if (
    header.projectId !== input.ref.projectId ||
    header.jobId !== input.ref.jobId ||
    header.sermonId !== input.sermonId ||
    !sha(header.immutableCanonicalCatalogDigest) ||
    !Number.isSafeInteger(header.canonicalPageCount) ||
    Number(header.canonicalPageCount) < 1
  )
    fail();
  let query = local(db, header).collection('canonicalPages').orderBy(FieldPath.documentId()).limit(limit);
  if (input.cursor) query = query.startAfter(input.cursor);
  const result = await tx.get(query),
    pages = result.docs.map((doc) => {
      const page = doc.get('page') as SermonDeletionCanonicalPage,
        index = doc.get('index'),
        digest = doc.get('digest');
      if (
        doc.id !== String(index).padStart(12, '0') ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= Number(header.canonicalPageCount) ||
        !sha(digest) ||
        acknowledgedProjectionDigest(page) !== digest
      )
        fail();
      return { index, digest, page };
    });
  return {
    pages,
    ...(result.size === limit ? { nextCursor: result.docs[result.size - 1].id } : {}),
    immutableCatalogDigest: header.immutableCanonicalCatalogDigest,
    expectedCanonicalPageCount: Number(header.canonicalPageCount),
  };
}

export async function validateSermonDeletionCanonicalInventoryPage(
  tx: Transaction,
  db: Firestore,
  input: { ref: DurableJobRef; sermonId: string; index: number; digest: string }
): Promise<{ complete: boolean; completionDigest?: string }> {
  if (!Number.isSafeInteger(input.index) || input.index < 0 || !sha(input.digest)) fail();
  const header = (await tx.get(local(db, { planId: sermonDeletionMirrorPlanId(input.ref, input.sermonId) }))).data() as
    | Header
    | undefined;
  if (
    !header ||
    header.projectId !== input.ref.projectId ||
    header.jobId !== input.ref.jobId ||
    header.sermonId !== input.sermonId
  )
    fail();
  await checkedHeader(tx, db, header);
  const source = await canonicalPage(tx, db, header, input.index);
  if (source.digest !== input.digest) fail();
  const progress = await tx.get(
    local(db, header).collection('canonicalPageCompletions').doc(canonicalPageId(input.index))
  );
  if (!progress.exists) return { complete: false };
  if (
    progress.get('schemaVersion') !== 1 ||
    progress.get('index') !== input.index ||
    progress.get('pageDigest') !== source.digest ||
    !sha(progress.get('writeDigest')) ||
    !header.rootRemoval
  )
    fail();
  if (source.page.kind === 'root') {
    if ((await tx.get(db.doc(source.page.path))).exists) fail();
  } else if (source.page.kind === 'mirrors') {
    if (
      source.page.rows.length > CANONICAL_CHUNK ||
      source.page.rows.some((row) => !owned(row.canonicalPath, header.sermonId))
    )
      fail();
    const snapshots = await tx.getAll(...source.page.rows.map((row) => db.doc(row.canonicalPath)));
    if (snapshots.some((doc) => doc.exists)) fail();
  } else if (source.page.kind === 'counts') {
    const snapshots = await tx.getAll(...source.page.countWrites.map((write) => db.doc(write.path)));
    snapshots.forEach((snapshot, index) => {
      if (source.page.kind !== 'counts') fail();
      const write = source.page.countWrites[index];
      if (
        !snapshot.exists ||
        Object.entries({ ...write.expectedFields, ...write.patch }).some(
          ([field, value]) => digest(snapshot.get(field) ?? null) !== digest(value ?? null)
        )
      )
        fail();
    });
  }
  return { complete: true, completionDigest: acknowledgedProjectionDigest(progress.data()) };
}

/** Derivative count GET authority: the exact original server capture and frozen count
 * page must agree. This grants no mutable transport or general provider reads. */
export async function assertSermonDeletionCountReadInTransaction(
  tx: Transaction,
  db: Firestore,
  input: {
    ref: DurableJobRef;
    sermonId: string;
    sessionId: string;
    sourceRootDigest: string;
    destinationProgram?: SermonDeletionDestinationRef;
    resourceType: 'list' | 'series';
    resourceId: string;
    account: 'app:9XTSHD';
  }
): Promise<void> {
  if (
    input.account !== 'app:9XTSHD' ||
    !['list', 'series'].includes(input.resourceType) ||
    !valid(input.resourceId) ||
    !sha(input.sourceRootDigest)
  )
    fail();
  const snapshot = await tx.get(local(db, { planId: sermonDeletionMirrorPlanId(input.ref, input.sermonId) })),
    data = snapshot.data() as Header | undefined;
  if (
    !data ||
    data.projectId !== input.ref.projectId ||
    data.jobId !== input.ref.jobId ||
    data.sermonId !== input.sermonId
  )
    fail();
  const header = await checkedHeader(tx, db, data),
    destination = header.destinationProgram;
  if (
    !destination ||
    header.frozenProgramDigest !== input.sourceRootDigest ||
    input.sessionId !==
      providerMutationFingerprint({ projectId: header.projectId, jobId: header.jobId, operation: header.operation }) ||
    (input.destinationProgram && digest(input.destinationProgram) !== digest(destination))
  )
    fail();
  await sourceProgramDigest(tx, db, header);
  await destinationSourceRequestCount(tx, db, header);
  const source = await tx.get(db.doc(`${SERMON_DELETION_MIRROR_PLANS}/${destination.planId}/destinationPlan/header`));
  let originalPath: string;
  if (input.resourceType === 'list') {
    const nodes = await tx.get(source.ref.collection('nodes').where('listId', '==', input.resourceId).limit(2));
    if (
      nodes.size !== 1 ||
      !sha(nodes.docs[0].get('sourceDigest')) ||
      !sha(nodes.docs[0].get('remainingDigest')) ||
      !/^lists\/[^/]+$/.test(nodes.docs[0].get('path')) ||
      !/^lists\/[^/]+$/.test(nodes.docs[0].get('rootPath'))
    )
      fail();
    originalPath = nodes.docs[0].get('path');
  } else {
    const series = object(source.get('series'));
    if (
      series.seriesId !== input.resourceId ||
      !sha(series.sourceDigest) ||
      !sha(series.remainingDigest) ||
      !/^series\/[^/]+$/.test(String(series.path))
    )
      fail();
    originalPath = String(series.path);
  }
  const index = await tx.get(
    local(db, header)
      .collection('countReadTargets')
      .doc(providerMutationFingerprint([input.resourceType, input.resourceId]))
  );
  if (
    index.get('schemaVersion') !== 1 ||
    index.get('projectId') !== header.projectId ||
    index.get('jobId') !== header.jobId ||
    index.get('sermonId') !== header.sermonId ||
    index.get('destinationDigest') !== destination.digest ||
    index.get('resourceType') !== input.resourceType ||
    index.get('resourceId') !== input.resourceId ||
    !Number.isSafeInteger(index.get('pageIndex')) ||
    index.get('pageIndex') < 0 ||
    index.get('pageIndex') >= Number(header.canonicalPageCount)
  )
    fail();
  const page = await canonicalPage(tx, db, header, index.get('pageIndex'));
  if (
    page.digest !== index.get('pageDigest') ||
    page.page.kind !== 'counts' ||
    !page.page.countWrites.some(
      (write) =>
        write.path === originalPath &&
        write.expectedFields.subsplashId === input.resourceId &&
        write.path.startsWith(input.resourceType === 'list' ? 'lists/' : 'series/') &&
        acknowledgedProjectionDigest(write) === index.get('writeDigest')
    )
  )
    fail();
}

/** Original source callback for the distinct certified DELETE protocol. Captured
 * immutable source fields remain stable while canonical cleanup advances. */
export async function readSermonDeletionCertifiedSourceHeaderInTransaction(
  tx: Transaction,
  db: Firestore,
  input: { ref: DurableJobRef; sermonId: string; originalSessionId: string; originalRequest: FrozenProjectionRequest }
): Promise<import('../temporal/publishing/certifiedDeletionDisposition').CertifiedDeletionSourceHeader> {
  const data = (await tx.get(local(db, { planId: sermonDeletionMirrorPlanId(input.ref, input.sermonId) }))).data() as
    | Header
    | undefined;
  if (!data) fail();
  const header = await checkedHeader(tx, db, data);
  if (
    header.projectId !== input.ref.projectId ||
    header.jobId !== input.ref.jobId ||
    header.sermonId !== input.sermonId ||
    input.originalSessionId !==
      providerMutationFingerprint({ projectId: header.projectId, jobId: header.jobId, operation: header.operation }) ||
    input.originalRequest.method !== 'DELETE' ||
    !header.requests.some(
      (request) => acknowledgedProjectionDigest(request) === acknowledgedProjectionDigest(input.originalRequest)
    )
  )
    fail();
  await assertCertifiedEmptySermonDestination(tx, db, header);
  const program = await sourceProgramDigest(tx, db, header),
    intentFingerprint = acknowledgedProjectionDigest(
      (await tx.get(db.doc(`durableJobIntents/${header.jobId}`))).data()
    );
  const immutable = {
    schemaVersion: header.schemaVersion,
    projectId: header.projectId,
    jobId: header.jobId,
    sermonId: header.sermonId,
    planId: header.planId,
    generation: header.generation,
    workflowId: header.workflowId,
    operation: header.operation,
    intentFingerprint: header.intentFingerprint,
    sourceStepIds: header.sourceStepIds,
    sourceParentRef: header.sourceParentRef,
    originalRoot: header.originalRoot,
    originalRootDigest: header.originalRootDigest,
    pointerClearRootDigest: header.pointerClearRootDigest,
    destinationProgram: header.destinationProgram ?? null,
    requests: header.requests,
    verifications: header.verifications,
    frozenProgramDigest: header.frozenProgramDigest,
    canonicalPageCount: header.canonicalPageCount,
    canonicalChainDigest: header.canonicalChainDigest,
    immutableCanonicalCatalogDigest: header.immutableCanonicalCatalogDigest,
  };
  return {
    headerPath: local(db, header).path,
    headerDigest: acknowledgedProjectionDigest(immutable),
    sourceProgramDigest: program,
    intentFingerprint,
    generation: header.generation,
    workflowId: header.workflowId,
  };
}

async function certifiedSermonDeletionSourceProof(
  tx: Transaction,
  db: Firestore,
  header: Header,
  allowUnclosed = false
): Promise<{
  session: ProviderMutationSession;
  sourceProgramDigest: string;
  dispositionDigest: string;
  expectedRequestSteps: string[];
}> {
  if (!header.requests.length) fail();
  await assertCertifiedEmptySermonDestination(tx, db, header);
  const originalSessionId = providerMutationFingerprint({
    projectId: header.projectId,
    jobId: header.jobId,
    operation: header.operation,
  });
  const original = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${originalSessionId}`));
  if (
    original.get('state') !== 'aborted' ||
    original.get('effectsClosed') === true ||
    (await tx.get(original.ref.collection('requests').limit(1))).size
  )
    fail();
  const dispositions = [];
  for (const originalRequest of header.requests) {
    const proof = await validateCertifiedDeletionDisposition(tx, db, {
      ref: header,
      originalSessionId,
      originalRequest,
      validateSourceHeaderInTransaction: (inner, request) =>
        readSermonDeletionCertifiedSourceHeaderInTransaction(inner, db, {
          ref: header,
          sermonId: header.sermonId,
          originalSessionId,
          originalRequest: request,
        }),
    });
    if (!proof) fail();
    dispositions.push(proof);
  }
  const certifiedSessionId = dispositions[0].disposition.certifiedSessionId;
  if (dispositions.some((proof) => proof.disposition.certifiedSessionId !== certifiedSessionId)) fail();
  const current = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${certifiedSessionId}`)),
    resources = current.get('resources') as ProviderMutationResource[];
  if (
    !Array.isArray(resources) ||
    !Array.isArray(original.get('resources')) ||
    digest(resources.map((resource) => digest(resource)).sort()) !==
      digest((original.get('resources') as ProviderMutationResource[]).map((resource) => digest(resource)).sort())
  )
    fail();
  const actual = (await tx.get(current.ref.collection('requests').count())).data().count;
  if (actual !== dispositions.length) fail();
  const certifiedProgramDigest = digest({
    kind: 'certified_fixed_delete_original_nosend',
    originalSourceProgramDigest: await sourceProgramDigest(tx, db, header),
    originalSessionId,
    certifiedSessionId,
    dispositions: dispositions.map((proof) => ({ id: proof.dispositionId, digest: proof.digest })),
  });
  const dispositionDigest = digest({
    originalSessionId,
    certifiedSessionId,
    sourceProgramDigest: certifiedProgramDigest,
  });
  if (
    !allowUnclosed &&
    (current.get('effectsClosed') !== true ||
      current.get('effectsClosedSourceProgramDigest') !== certifiedProgramDigest)
  )
    fail();
  if (
    header.rootRemoval?.certifiedDeletion &&
    digest(header.rootRemoval.certifiedDeletion) !==
      digest({ originalSessionId, certifiedSessionId, sourceProgramDigest: certifiedProgramDigest, dispositionDigest })
  )
    fail();
  return {
    session: { db, id: certifiedSessionId, scope: current.get('scope'), resources },
    sourceProgramDigest: certifiedProgramDigest,
    dispositionDigest,
    expectedRequestSteps: dispositions.map((proof) => proof.disposition.certifiedStep),
  };
}

/** Only distinct certified facts qualify; original zero-request scope stays aborted.
 * Destination PATCH/count cleanup awaits its own protocol and is deliberately rejected. */
export async function validateSermonDeletionCertifiedEffectsForClosing(
  tx: Transaction,
  db: Firestore,
  input: { plan: SermonDeletionMirrorPlan; session: ProviderMutationSession }
): Promise<{ sourceProgramDigest: string; expectedRequestSteps: string[]; qualifiedNoSendSteps: string[] }> {
  const header = await checkedHeader(tx, db, input.plan),
    proof = await certifiedSermonDeletionSourceProof(tx, db, header, true);
  if (
    proof.session.id !== input.session.id ||
    digest(proof.session.scope) !== digest(input.session.scope) ||
    digest(proof.session.resources) !== digest(input.session.resources)
  )
    fail();
  return {
    sourceProgramDigest: proof.sourceProgramDigest,
    expectedRequestSteps: proof.expectedRequestSteps,
    qualifiedNoSendSteps: [],
  };
}

async function hasSermonCertifiedDisposition(tx: Transaction, db: Firestore, header: Header): Promise<boolean> {
  if (header.rootRemoval?.certifiedDeletion) return true;
  const originalSessionId = providerMutationFingerprint({
    projectId: header.projectId,
    jobId: header.jobId,
    operation: header.operation,
  });
  const docs = await Promise.all(
    header.requests.map((request) =>
      tx.get(
        db
          .collection(CERTIFIED_DELETION_DISPOSITIONS)
          .doc(certifiedDeletionDispositionId(header, originalSessionId, request.step))
      )
    )
  );
  return docs.some((doc) => doc.exists);
}

async function assertCertifiedEmptySermonDestination(tx: Transaction, db: Firestore, header: Header): Promise<void> {
  if (!header.destinationProgram) return;
  const original = await readSermonDeletionDestinationProgramInTransaction(tx, db, header.destinationProgram);
  if (
    original.requests.length ||
    original.countWrites.length ||
    original.operation !== header.operation ||
    original.mediaId !== header.originalRoot.subsplashId
  )
    fail();
}
