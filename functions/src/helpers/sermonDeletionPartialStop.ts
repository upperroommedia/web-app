import { FieldPath, FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import { PUBLISHING_SOURCE_PROTOCOL } from '../../../packages/orchestration/src/job-store';
import {
  prepareDesiredProviderDeletionSettlement,
  prepareDesiredProviderDeletionPartialStopAbort,
  desiredProviderDeletionDocumentFingerprint,
} from '../../../packages/orchestration/src/provider-usage';
import {
  ACKNOWLEDGED_PROJECTION_PLANS,
  acknowledgedProjectionDigest as hash,
  validateAcknowledgedRepairCandidateEvidence,
  assertAcknowledgedProjectionRequestPrepared,
  type FrozenProjectionRequest,
} from '../temporal/publishing/criticalAcknowledgedRepair';
import {
  ACKNOWLEDGED_REPAIR_CANDIDATES,
  type AcknowledgedRepairCandidateRoot,
  type CandidateRequestEvidence,
} from '../temporal/publishing/acknowledgedRepairCandidate';
import {
  CRITICAL_REPAIR_SOURCE_CATALOGS,
  criticalRepairCatalogDigest,
} from '../temporal/publishing/criticalRepairCatalog';
import {
  PROVIDER_MUTATION_SESSIONS,
  providerMutationFingerprint,
  validateProviderMutationOriginalCompletion,
  prepareProviderMutationEffectsClosedFromReadyEvidence,
  prepareProviderMutationSessionCommitFromClosedEvidence,
  type ProviderMutationSession,
  type ProviderMutationResource,
  type ProviderMutationClosedEvidenceSeal,
  type ProviderMutationReadyCanonicalCompletion,
} from '../temporal/publishing/providerMutationGuard';
import {
  SERMON_DELETION_MIRROR_PLANS,
  sermonDeletionMirrorPlanId,
  assertSermonDeletionCountReadInTransaction,
} from './sermonDeletionMirrors';
import { localSermonDeletionHeaderProjection } from '../temporal/publishing/localSermonDeletionRepair';
import { preparePublishingAllocationRetirement } from '../temporal/publishing/allocationBarrier';
import { authenticateSubsplash } from '../subsplashUtils';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import type { SermonDeletionDestinationRef, SermonDeletionDestinationCountWrite } from './sermonDeletionDestinations';

export const SERMON_DELETION_PARTIAL_STOPS = 'temporalSermonDeletionPartialStops';
export type SermonDeletionPartialStopOperation = Readonly<{
  kind: 'sermon_deletion_partial_stop';
  planId: string;
  sessionId: string;
}>;
export type PartialStopRead = {
  provider: 'subsplash' | 'soundcloud';
  resourceType: string;
  resourceId: string;
  accountId: string;
  method: 'GET';
};
type Data = Record<string, any>;
const object = (v: unknown): Data => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : {});
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const safe = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 256 && !/[\s/?#]/.test(v);
const fail: () => never = () => {
  throw Object.assign(Error('Sermon deletion partial-stop source proof is required'), {
    code: 'SERMON_DELETION_PARTIAL_STOP_PROOF_REQUIRED',
  });
};
const sequence = (n: number) => String(n).padStart(12, '0');
const local = (db: Firestore, id: string) => db.doc(`${SERMON_DELETION_PARTIAL_STOPS}/${id}`);
interface Write {
  path: string;
  baselineDigest: string;
  afterDigest: string;
  patch: Data;
  deleteFields: string[];
  expectedFields?: Data;
}
interface Effect {
  positive?: boolean;
  request: FrozenProjectionRequest;
  evidence: CandidateRequestEvidence;
  kind: 'root' | 'row' | 'unlink' | 'subtitle';
  rowId?: string;
  rootPath?: string;
  nodePath?: string;
  seriesPath?: string;
  seriesId?: string;
}
interface Source {
  identity: Data;
  operation: SermonDeletionPartialStopOperation;
  sourceEvidence: { path: string; digest: string };
  sourceEvidenceDigest: string;
  session: ProviderMutationSession;
  candidate: AcknowledgedRepairCandidateRoot;
  header: Data;
  intent: Data;
  root: Data;
  record: Data;
  stored: boolean;
  commit(): void;
}
interface Store {
  commitCurrent<T>(ref: DurableJobRef, mutate: (tx: Transaction) => Promise<T>): Promise<T>;
}
export interface SermonDeletionPartialStopDependencies {
  firestore: Firestore;
  commitCurrent(ref: DurableJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void>;
  authorizeInTransaction(
    tx: Transaction,
    ref: DurableJobRef,
    operation: SermonDeletionPartialStopOperation
  ): Promise<void>;
  authorizeRead(read: PartialStopRead): Promise<void>;
  readProvider(read: PartialStopRead): Promise<{
    state: 'present' | 'absent';
    providerId: string;
    accountId: string;
    originalHttpStatus?: number;
    body?: Data;
  }>;
  /** SDK/index adapter proves each original reserved target independently UNCLAIMED after full transport closure. */
  prepareUnclaimedReservationDisposition(
    tx: Transaction,
    input: {
      ref: DurableJobRef;
      operation: SermonDeletionPartialStopOperation;
      session: ProviderMutationSession;
      target: ProviderMutationResource;
      sourceEvidence: { path: string; digest: string };
    }
  ): Promise<() => void>;
}
export function validateSermonDeletionPartialStopOperation(v: unknown): v is SermonDeletionPartialStopOperation {
  const d = object(v);
  return Object.keys(d).length === 3 && d.kind === 'sermon_deletion_partial_stop' && sha(d.planId) && sha(d.sessionId);
}
function put(data: Data, path: string, value: any, remove = false) {
  const keys = path.split('.');
  let target = data;
  for (const key of keys.slice(0, -1)) {
    target[key] = object(target[key]);
    target = target[key];
  }
  if (remove) delete target[keys.at(-1)!];
  else target[keys.at(-1)!] = value;
}
function after(before: Data, write: Pick<Write, 'patch' | 'deleteFields'>): Data {
  const clone = (value: any): any =>
    Array.isArray(value)
      ? value.map(clone)
      : value && typeof value === 'object'
      ? value instanceof Date || typeof value.toMillis === 'function'
        ? value
        : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]))
      : value;
  const result = clone(before);
  for (const [key, value] of Object.entries(write.patch)) put(result, key, value);
  for (const key of write.deleteFields) put(result, key, undefined, true);
  return result;
}
function write(path: string, before: Data, patch: Data, deleteFields: string[] = []): Write {
  return {
    path,
    baselineDigest: hash(before),
    afterDigest: hash(after(before, { patch, deleteFields })),
    patch,
    deleteFields,
  };
}
function evidenceDigest(identity: Data, record: Data): string {
  return ['ready', 'completed'].includes(record.state)
    ? hash({
        identity,
        immutableCatalogueDigest: record.immutableCatalogueDigest,
        effectChainDigest: record.effectChainDigest,
        canonicalPageCount: record.canonicalPageCount,
        canonicalChainDigest: record.canonicalChainDigest,
      })
    : hash(identity);
}
function headerIdentity(header: Data) {
  return {
    ...localSermonDeletionHeaderProjection(header),
    destinationProgram: header.destinationProgram ?? null,
    frozenProgramDigest: header.frozenProgramDigest,
    canonicalPageCount: header.canonicalPageCount,
    canonicalChainDigest: header.canonicalChainDigest,
    immutableCanonicalCatalogDigest: header.immutableCanonicalCatalogDigest,
  };
}
async function source(tx: Transaction, db: Firestore, ref: DurableJobRef, sessionId: string): Promise<Source> {
  if (!safe(ref.projectId) || !safe(ref.jobId) || !sha(sessionId)) fail();
  const [intentDoc, jobDoc, frozenDoc, heldDoc, catalogDoc, criticalDoc] = await Promise.all([
    tx.get(db.doc(`durableJobIntents/${ref.jobId}`)),
    tx.get(db.doc(`durableJobs/${ref.jobId}`)),
    tx.get(db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`)),
    tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)),
    tx.get(db.doc(`${CRITICAL_REPAIR_SOURCE_CATALOGS}/${ref.jobId}`)),
    tx.get(db.doc(`durableJobCriticalSections/${ref.jobId}`)),
  ]);
  const intent = object(intentDoc.data()),
    job = object(jobDoc.data()),
    frozen = object(frozenDoc.data()),
    held = object(heldDoc.data()),
    catalog = object(catalogDoc.data()),
    sermonId = intent.entity?.id;
  if (
    intent.kind !== 'sermon.delete' ||
    intent.entity?.type !== 'sermon' ||
    intent.payload?.sermonId !== sermonId ||
    intent.payload?.action !== 'delete' ||
    intent.payload?.generation !== intent.generation ||
    intent.publishingSourceProtocol !== PUBLISHING_SOURCE_PROTOCOL ||
    !safe(sermonId) ||
    intent.projectId !== ref.projectId ||
    intent.jobId !== ref.jobId ||
    job.projectId !== ref.projectId ||
    job.jobId !== ref.jobId ||
    job.generation !== intent.generation ||
    hash(job.entity) !== hash(intent.entity) ||
    !safe(job.workflowId) ||
    !Number.isSafeInteger(intent.generation) ||
    intent.generation < 1
  )
    fail();
  const { sealDigest, ...body } = catalog;
  if (
    catalog.schemaVersion !== 1 ||
    catalog.producerProtocol !== PUBLISHING_SOURCE_PROTOCOL ||
    catalog.sealed !== true ||
    !sha(sealDigest) ||
    sealDigest !== criticalRepairCatalogDigest(body) ||
    catalog.projectId !== ref.projectId ||
    catalog.jobId !== ref.jobId ||
    catalog.generation !== intent.generation ||
    catalog.workflowId !== job.workflowId ||
    catalog.intentDigest !== criticalRepairCatalogDigest(intent) ||
    catalog.criticalDigest !== criticalRepairCatalogDigest(criticalDoc.data()) ||
    !Number.isSafeInteger(catalog.count) ||
    catalog.count < 0 ||
    !sha(catalog.sourceProgramChainDigest)
  )
    fail();
  const mirrorId = sermonDeletionMirrorPlanId(ref, sermonId),
    headerDoc = await tx.get(db.doc(`${SERMON_DELETION_MIRROR_PLANS}/${mirrorId}`)),
    header = object(headerDoc.data());
  if (
    header.state !== 'prepared' ||
    hash(header.sourceParentRef) !== hash(ref) ||
    !Array.isArray(header.sourceStepIds) ||
    !header.sourceStepIds.length ||
    header.sourceStepIds.length > 32 ||
    header.sourceStepIds.some((step: unknown) => typeof step !== 'string' || !/^[a-z][a-z0-9_-]{0,99}$/.test(step)) ||
    header.rootRemoval ||
    header.projectId !== ref.projectId ||
    header.jobId !== ref.jobId ||
    header.sermonId !== sermonId ||
    header.generation !== intent.generation ||
    header.workflowId !== job.workflowId ||
    header.intentFingerprint !== desiredProviderDeletionDocumentFingerprint(intent) ||
    header.originalRootDigest !== hash(header.originalRoot) ||
    header.frozenProgramDigest !== hash(frozen) ||
    !sha(header.immutableCanonicalCatalogDigest) ||
    frozen.schemaVersion !== 2 ||
    frozen.sessionId !== sessionId ||
    frozen.intentFingerprint !== hash(intent) ||
    frozen.requestCount < 1 ||
    held.scope?.projectId !== ref.projectId ||
    held.scope?.jobId !== ref.jobId ||
    providerMutationFingerprint(held.scope) !== sessionId ||
    held.scope?.operation !== header.operation ||
    !Array.isArray(held.resources) ||
    !['active', 'committed'].includes(held.state)
  )
    fail();
  if (!Array.isArray(header.requests) || !header.requests.length || header.requests.length > 2) fail();
  for (const request of header.requests as FrozenProjectionRequest[]) {
    const t = request.target,
      field = t?.provider === 'subsplash' ? 'subsplashId' : 'soundCloudTrackId';
    if (
      !t ||
      request.method !== 'DELETE' ||
      t.resourceId !== header.originalRoot[field] ||
      t.resourceType !== (t.provider === 'subsplash' ? 'media' : 'track') ||
      (t.provider === 'subsplash' ? t.account !== 'app:9XTSHD' : !/^soundcloud:users:[0-9]+$/.test(t.account)) ||
      object(request.payload).id !== t.resourceId
    )
      fail();
  }
  const candidateId = hash([ref.projectId, ref.jobId, sessionId, hash(frozen)]),
    candidateDoc = await tx.get(db.doc(`${ACKNOWLEDGED_REPAIR_CANDIDATES}/${candidateId}`)),
    candidate = candidateDoc.data() as AcknowledgedRepairCandidateRoot;
  if (
    !candidate ||
    candidate.phase !== 'ready' ||
    candidate.originalRequestCount < 1 ||
    candidate.acknowledgedRequestCount + candidate.rejectedRequestCount !== candidate.originalRequestCount ||
    candidate.originalRequestCount > frozen.requestCount ||
    !sha(candidate.terminalClaimSetDigest)
  )
    fail();
  const candidateEvidence = { path: candidateDoc.ref.path, digest: hash(candidate) };
  await validateAcknowledgedRepairCandidateEvidence(tx, db, ref, candidateEvidence);
  const rootDoc = await tx.get(db.doc(`sermons/${sermonId}`));
  if (!rootDoc.exists) fail();
  const planId = hash(['sermon-deletion-partial-stop', ref, sessionId, candidateEvidence.digest]),
    operation: SermonDeletionPartialStopOperation = { kind: 'sermon_deletion_partial_stop', planId, sessionId },
    saved = await tx.get(local(db, planId)),
    record = object(saved.data());
  const refs = await tx.get(db.doc(`temporalMediaCanonicalRefs/${sermonId}`));
  const identity = {
    schemaVersion: 1,
    ...ref,
    planId,
    sessionId,
    sermonId,
    generation: intent.generation,
    workflowId: job.workflowId,
    intentFingerprint: hash(intent),
    headerPath: headerDoc.ref.path,
    headerDigest: hash(headerIdentity(header)),
    sourceCatalogSealDigest: sealDigest,
    candidateEvidence,
    sessionScopeDigest: hash({ scope: held.scope, resources: held.resources }),
    sourceRequestCount: frozen.requestCount,
    originalRequestCount: candidate.originalRequestCount,
    terminalClaimSetDigest: candidate.terminalClaimSetDigest,
    canonicalRefsDigest: record.identity?.canonicalRefsDigest ?? hash(refs.exists ? refs.data() : null),
  };
  if (saved.exists && hash(record.identity) !== hash(identity)) fail();
  if (record.state !== 'completed' && hash(refs.exists ? refs.data() : null) !== identity.canonicalRefsDigest) fail();
  const session: ProviderMutationSession = { db, id: sessionId, scope: held.scope, resources: held.resources };
  return {
    identity,
    operation,
    sourceEvidence: { path: local(db, planId).path, digest: evidenceDigest(identity, record) },
    sourceEvidenceDigest: evidenceDigest(identity, record),
    session,
    candidate,
    header,
    intent,
    root: rootDoc.data()!,
    record,
    stored: saved.exists,
    commit: () => {
      if (!saved.exists)
        tx.create(local(db, planId), {
          identity,
          state: 'compiling',
          phase: 'effects',
          effectCount: 0,
          effectChainDigest: hash([]),
          canonicalPageCount: 0,
          canonicalChainDigest: hash([]),
        });
    },
  };
}
async function appendWrites(
  tx: Transaction,
  db: Firestore,
  s: Source,
  writes: Write[]
): Promise<{ count: number; chain: string; commit(): void }> {
  if (writes.length > 32) fail();
  const index = s.record.canonicalPageCount ?? 0,
    chain = s.record.canonicalChainDigest ?? hash([]);
  if (!writes.length) return { count: index, chain, commit: () => {} };
  const body = { schemaVersion: 1, index, writes },
    digest = hash(body),
    target = local(db, s.operation.planId).collection('canonicalPages').doc(sequence(index)),
    prior = await tx.get(target);
  if (prior.exists && prior.get('digest') !== digest) fail();
  const authorities = await Promise.all(
    writes.map((record) =>
      tx.get(
        local(db, s.operation.planId).collection('canonicalWriteIndex').doc(providerMutationFingerprint(record.path))
      )
    )
  );
  authorities.forEach((doc, i) => {
    if (doc.exists && (doc.get('pageDigest') !== digest || hash(doc.get('write')) !== hash(writes[i]))) fail();
  });
  return {
    count: index + 1,
    chain: hash([chain, index, digest]),
    commit: () => {
      if (!prior.exists) tx.create(target, { ...body, digest });
      writes.forEach((record, i) => {
        if (!authorities[i].exists)
          tx.create(
            local(db, s.operation.planId)
              .collection('canonicalWriteIndex')
              .doc(providerMutationFingerprint(record.path)),
            { schemaVersion: 1, pageIndex: index, pageDigest: digest, write: record }
          );
      });
    },
  };
}
async function classify(
  tx: Transaction,
  db: Firestore,
  s: Source,
  request: FrozenProjectionRequest,
  evidence: CandidateRequestEvidence
): Promise<Effect> {
  if (!request.target) fail();
  if ((s.header.requests as FrozenProjectionRequest[]).some((root) => hash(root) === hash(request)))
    return { request, evidence, kind: 'root' };
  const destination = s.header.destinationProgram as SermonDeletionDestinationRef;
  if (!destination) fail();
  const base = db.doc(`${SERMON_DELETION_MIRROR_PLANS}/${destination.planId}/destinationPlan/header`),
    dest = await tx.get(base),
    planned = await tx.get(base.collection('requests').where('request.step', '==', request.step).limit(2));
  if (
    dest.get('digest') !== destination.digest ||
    dest.get('projectId') !== s.identity.projectId ||
    dest.get('jobId') !== s.identity.jobId ||
    planned.size !== 1 ||
    hash(planned.docs[0].get('request')) !== hash(request)
  )
    fail();
  if (request.method === 'DELETE' && request.target.resourceType === 'list-row') {
    const listId = object(request.payload).listId,
      nodes = await tx.get(base.collection('nodes').where('listId', '==', listId).limit(2));
    if (nodes.size !== 1 || !nodes.docs[0].get('removedRowIds')?.includes(request.target.resourceId)) fail();
    return {
      request,
      evidence,
      kind: 'row',
      rowId: request.target.resourceId,
      rootPath: nodes.docs[0].get('rootPath'),
      nodePath: nodes.docs[0].get('path'),
    };
  }
  const series = object(dest.get('series'));
  if (!safe(series.seriesId) || !/^series\/[^/]+$/.test(String(series.path))) fail();
  if (
    request.method === 'PATCH' &&
    request.step === `sermon-delete-series:${s.header.originalRoot.subsplashId}:${series.seriesId}` &&
    object(object(request.payload)._embedded)['media-series'] === null
  )
    return { request, evidence, kind: 'unlink', seriesPath: series.path, seriesId: series.seriesId };
  if (
    request.method === 'PATCH' &&
    request.target.resourceType === 'series' &&
    request.target.resourceId === series.seriesId &&
    typeof object(request.payload).subtitle === 'string'
  )
    return { request, evidence, kind: 'subtitle', seriesPath: series.path, seriesId: series.seriesId };
  fail();
}
/** One bounded compiler transaction; only immutable private facts/pages are written. */
export async function compileSermonDeletionPartialStopPage(
  db: Firestore,
  ref: DurableJobRef,
  sessionId: string,
  store: Store
): Promise<{
  state: 'pending' | 'ready';
  operation: SermonDeletionPartialStopOperation;
  sourceEvidence: { path: string; digest: string };
}> {
  return store.commitCurrent(ref, async (tx) => {
    const s = await source(tx, db, ref, sessionId),
      target = local(db, s.operation.planId);
    if (s.record.state === 'ready' || s.record.state === 'completed')
      return { state: 'ready', operation: s.operation, sourceEvidence: s.sourceEvidence };
    const phase = s.record.phase ?? 'effects',
      pending: Array<() => void> = [];
    let update: Data = {};
    if (phase === 'effects') {
      let query = db
        .doc(s.identity.candidateEvidence.path)
        .collection('requestEvidence')
        .orderBy(FieldPath.documentId())
        .limit(32);
      if (s.record.cursor) query = query.startAfter(s.record.cursor);
      const page = await tx.get(query);
      let effectChainDigest = s.record.effectChainDigest ?? hash([]);
      for (const doc of page.docs) {
        const evidence = doc.data() as CandidateRequestEvidence,
          current = await tx.get(db.doc(evidence.sourceRequestPath)),
          index = await tx.get(db.doc(evidence.plannedRequestPath)),
          request = index.get('request') as FrozenProjectionRequest;
        if (
          !current.exists ||
          hash(current.data()) !== evidence.sourceRequestDigest ||
          hash(request) !== evidence.plannedRequestDigest
        )
          fail();
        await validateProviderMutationOriginalCompletion(tx, s.session, [
          current as FirebaseFirestore.QueryDocumentSnapshot,
        ]);
        await assertAcknowledgedProjectionRequestPrepared(tx, s.session, request);
        const effect = await classify(tx, db, s, request, evidence),
          fact = await tx.get(db.doc(evidence.factPath)),
          rejection = object(fact.get('evidence'));
        effect.positive =
          evidence.state === 'acknowledged' ||
          (request.method === 'DELETE' &&
            [404, 410].includes(rejection.status) &&
            rejection.transport === 'original_http_response' &&
            rejection.providerCode === 'resource_not_found');
        pending.push(() => tx.create(target.collection('effects').doc(doc.id), { ...effect, digest: hash(effect) }));
        effectChainDigest = hash([effectChainDigest, doc.id, hash(effect)]);
      }
      const effectCount = (s.record.effectCount ?? 0) + page.size;
      if (page.size < 32 && effectCount !== s.candidate.originalRequestCount) fail();
      update = {
        effectCount,
        effectChainDigest,
        ...(page.size === 32 ? { cursor: page.docs.at(-1)!.id } : { phase: 'root', cursor: FieldValue.delete() }),
      };
    } else if (phase === 'root') {
      const effects = await tx.get(
          target.collection('effects').where('kind', '==', 'root').where('positive', '==', true).limit(3)
        ),
        unlink = await tx.get(
          target.collection('effects').where('kind', '==', 'unlink').where('positive', '==', true).limit(2)
        ),
        patch: Data = {},
        deletes: string[] = [];
      for (const doc of effects.docs) {
        const effect = doc.data() as Effect,
          provider = effect.request.target!.provider;
        if (effect.evidence.state !== 'acknowledged' && effect.evidence.state !== 'rejected_no_effect') fail();
        const subsplash = provider === 'subsplash';
        patch[subsplash ? 'status.subsplash' : 'status.soundCloud'] = uploadStatus.NOT_UPLOADED;
        deletes.push(
          ...(subsplash ? ['subsplashId'] : ['soundCloudTrackId', 'soundCloudTrackUrl', 'soundCloudPublication'])
        );
      }
      if (unlink.size > 1) fail();
      if (unlink.size) patch.seriesPublishedToSubsplash = false;
      const records = Object.keys(patch).length
        ? [write(`sermons/${s.identity.sermonId}`, s.header.originalRoot, patch, deletes)]
        : [];
      if (records.length && ![records[0].baselineDigest, records[0].afterDigest].includes(hash(s.root))) fail();
      const appended = await appendWrites(tx, db, s, records);
      pending.push(appended.commit);
      update = { phase: 'mirrors', canonicalPageCount: appended.count, canonicalChainDigest: appended.chain };
    } else if (phase === 'mirrors') {
      let query = db.doc(s.identity.headerPath).collection('rows').orderBy(FieldPath.documentId()).limit(32);
      if (s.record.cursor) query = query.startAfter(s.record.cursor);
      const page = await tx.get(query),
        records: Write[] = [],
        roots = await tx.get(
          target.collection('effects').where('kind', '==', 'root').where('positive', '==', true).limit(3)
        ),
        unlinks = await tx.get(
          target.collection('effects').where('kind', '==', 'unlink').where('positive', '==', true).limit(2)
        );
      for (const captured of page.docs) {
        const path = captured.get('canonicalPath'),
          doc = await tx.get(db.doc(path));
        if (!doc.exists || hash(doc.data()) !== captured.get('expectedDocumentDigest')) fail();
        const before = doc.data()!,
          patch: Data = {},
          deletes: string[] = [];
        for (const root of roots.docs) {
          const r = root.get('request') as FrozenProjectionRequest,
            field = r.target!.provider === 'subsplash' ? 'subsplashId' : 'soundCloudTrackId';
          const aliases =
            field === 'subsplashId' ? ['sermonSubsplashId', 'mediaItem.subsplashId'] : ['mediaItem.soundCloudTrackId'];
          for (const alias of aliases) {
            const value = alias.split('.').reduce((v: any, key) => v?.[key], before);
            if (value === r.target!.resourceId) {
              deletes.push(alias);
              if (alias.startsWith('mediaItem.'))
                patch[field === 'subsplashId' ? 'mediaItem.status.subsplash' : 'mediaItem.status.soundCloud'] =
                  uploadStatus.NOT_UPLOADED;
              if (field === 'subsplashId' && path.startsWith('series/')) patch.publishedToSubsplash = false;
            }
          }
          if (before[field] === r.target!.resourceId) {
            patch[r.target!.provider === 'subsplash' ? 'status.subsplash' : 'status.soundCloud'] =
              uploadStatus.NOT_UPLOADED;
            deletes.push(
              field,
              ...(field === 'soundCloudTrackId' ? ['soundCloudTrackUrl', 'soundCloudPublication'] : [])
            );
          }
        }
        const rowId = before.uploadStatus?.listItemId;
        if (safe(rowId)) {
          const rows = await tx.get(
            target.collection('effects').where('rowId', '==', rowId).where('positive', '==', true).limit(2)
          );
          if (rows.size === 1) {
            const effect = rows.docs[0].data() as Effect,
              rootId = effect.rootPath!.split('/')[1];
            if (
              path === `sermons/${s.identity.sermonId}/sermonLists/${rootId}` ||
              path === `${effect.rootPath}/listItems/${s.identity.sermonId}` ||
              path === `${effect.nodePath}/listItems/${s.identity.sermonId}`
            ) {
              patch['uploadStatus.status'] = uploadStatus.NOT_UPLOADED;
              deletes.push('uploadStatus.listItemId');
            }
          } else if (rows.size > 1) fail();
        }
        if (unlinks.size && path === `${unlinks.docs[0].get('seriesPath')}/seriesItems/${s.identity.sermonId}`)
          patch.publishedToSubsplash = false;
        if (Object.keys(patch).length || deletes.length) records.push(write(path, before, patch, deletes));
      }
      const appended = await appendWrites(tx, db, s, records);
      pending.push(appended.commit);
      update = {
        canonicalPageCount: appended.count,
        canonicalChainDigest: appended.chain,
        ...(page.size === 32
          ? { cursor: page.docs.at(-1)!.id }
          : {
              phase: 'ready',
              state: 'ready',
              cursor: FieldValue.delete(),
              immutableCatalogueDigest: hash({
                identity: s.identity,
                effectCount: s.record.effectCount,
                effectChainDigest: s.record.effectChainDigest,
                canonicalPageCount: appended.count,
                canonicalChainDigest: appended.chain,
              }),
            }),
      };
    } else fail();
    s.commit();
    pending.forEach((commit) => commit());
    tx.update(target, update);
    return {
      state: update.state === 'ready' ? 'ready' : 'pending',
      operation: s.operation,
      sourceEvidence: { path: s.sourceEvidence.path, digest: evidenceDigest(s.identity, { ...s.record, ...update }) },
    };
  });
}
export async function prepareSermonDeletionPartialStop(
  tx: Transaction,
  db: Firestore,
  input: { ref: DurableJobRef; expectedRevision?: number }
): Promise<{
  operation: SermonDeletionPartialStopOperation;
  sourceEvidence: { path: string; digest: string };
  partialStop: true;
  commit(): void;
}> {
  const intent = await tx.get(db.doc(`durableJobIntents/${input.ref.jobId}`)),
    job = await tx.get(db.doc(`durableJobs/${input.ref.jobId}`));
  if (input.expectedRevision !== undefined && job.get('revision') !== input.expectedRevision) fail();
  const header = await tx.get(
      db.doc(`${SERMON_DELETION_MIRROR_PLANS}/${sermonDeletionMirrorPlanId(input.ref, intent.get('entity.id'))}`)
    ),
    sessionId = providerMutationFingerprint({
      projectId: input.ref.projectId,
      jobId: input.ref.jobId,
      operation: header.get('operation'),
    }),
    s = await source(tx, db, input.ref, sessionId);
  if (!['ready', 'completed'].includes(s.record.state) || !sha(s.record.immutableCatalogueDigest)) fail();
  return { operation: s.operation, sourceEvidence: s.sourceEvidence, partialStop: true, commit: () => {} };
}
export async function validateSermonDeletionPartialStopEvidence(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  evidence: { path: string; digest: string }
): Promise<void> {
  const doc = await tx.get(db.doc(evidence.path)),
    s = await source(tx, db, ref, doc.get('identity.sessionId'));
  if (
    !s.stored ||
    s.sourceEvidence.path !== evidence.path ||
    s.sourceEvidence.digest !== evidence.digest ||
    !['ready', 'completed'].includes(s.record.state)
  )
    fail();
}
export async function validateSermonDeletionPartialStopRead(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  operation: SermonDeletionPartialStopOperation,
  read: PartialStopRead
): Promise<void> {
  if (!validateSermonDeletionPartialStopOperation(operation) || read.method !== 'GET') fail();
  const s = await source(tx, db, ref, operation.sessionId);
  if (s.operation.planId !== operation.planId || !['ready', 'completed'].includes(s.record.state)) fail();
  const root = await tx.get(
    local(db, operation.planId).collection('effects').where('kind', '==', 'root').where('positive', '==', true).limit(3)
  );
  if (
    root.docs.some((doc) => {
      const t = doc.get('request.target');
      return (
        t.provider === read.provider &&
        t.account === read.accountId &&
        t.resourceType === read.resourceType &&
        t.resourceId === read.resourceId
      );
    })
  )
    return;
  if (read.provider !== 'subsplash' || read.accountId !== 'app:9XTSHD') fail();
  if (read.resourceType === 'list' || read.resourceType === 'series') {
    await assertSermonDeletionCountReadInTransaction(tx, db, {
      ref,
      sermonId: s.identity.sermonId,
      sessionId: operation.sessionId,
      sourceRootDigest: s.header.frozenProgramDigest,
      resourceType: read.resourceType,
      resourceId: read.resourceId,
      account: 'app:9XTSHD',
    });
    return;
  }
  const unlink = await tx.get(
    local(db, operation.planId)
      .collection('effects')
      .where('kind', '==', 'unlink')
      .where('positive', '==', true)
      .limit(2)
  );
  if (
    read.resourceType === 'media' &&
    unlink.size === 1 &&
    unlink.docs[0].get('request.target.resourceId') === read.resourceId
  )
    return;
  fail();
}

async function authorized(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  operation: SermonDeletionPartialStopOperation,
  deps: SermonDeletionPartialStopDependencies
): Promise<Source> {
  await deps.authorizeInTransaction(tx, ref, operation);
  const s = await source(tx, db, ref, operation.sessionId);
  if (
    s.operation.planId !== operation.planId ||
    !['ready', 'completed'].includes(s.record.state) ||
    !sha(s.record.immutableCatalogueDigest)
  )
    fail();
  const grant = await tx.get(db.doc(`durableJobCriticalRepairGrants/${ref.jobId}`));
  if (
    grant.get('projectId') !== ref.projectId ||
    grant.get('jobId') !== ref.jobId ||
    grant.get('generation') !== s.identity.generation ||
    grant.get('workflowId') !== s.identity.workflowId ||
    grant.get('intentFingerprint') !== s.identity.intentFingerprint ||
    !safe(grant.get('actorUid')) ||
    !safe(grant.get('commandId')) ||
    !sha(grant.get('certificateId')) ||
    !grant.get('operations')?.some((op: unknown) => hash(op) === hash(operation)) ||
    !grant.get('sourceEvidenceDigests')?.includes(s.sourceEvidenceDigest)
  )
    fail();
  return s;
}
async function* documents(query: FirebaseFirestore.Query) {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = query.orderBy(FieldPath.documentId()).limit(32);
    if (cursor) q = q.startAfter(cursor);
    const page = await q.get();
    if (page.empty) return;
    yield page.docs;
    if (page.size < 32) return;
    cursor = page.docs.at(-1);
  }
}
async function validatePartialCompletion(
  tx: Transaction,
  db: Firestore,
  s: Source,
  seal: ProviderMutationClosedEvidenceSeal
): Promise<ProviderMutationReadyCanonicalCompletion> {
  const current = await tx.get(local(db, s.operation.planId)),
    completion = object(current.get('completion'));
  if (
    current.get('state') !== 'completed' ||
    completion.closedClaimSetDigest !== s.identity.terminalClaimSetDigest ||
    seal.claimSetDigestVersion !== 2 ||
    seal.claimSetDigest !== s.identity.terminalClaimSetDigest ||
    seal.actualRequestCount !== s.identity.originalRequestCount ||
    completion.originalRequestCount !== s.identity.originalRequestCount ||
    !sha(completion.immutableCatalogDigest) ||
    !sha(completion.canonicalCompletionDigest) ||
    !Number.isSafeInteger(completion.expectedCanonicalPageCount) ||
    completion.completedCanonicalPageCount !== completion.expectedCanonicalPageCount ||
    !(await tx.get(db.doc(`sermons/${s.identity.sermonId}`))).exists
  )
    fail();
  return completion as ProviderMutationReadyCanonicalCompletion;
}
/** Project original known facts and source-qualified reads. Never dispatches a mutable provider RPC. */
export async function runSermonDeletionPartialStop(
  ref: DurableJobRef,
  operation: SermonDeletionPartialStopOperation,
  deps: SermonDeletionPartialStopDependencies
): Promise<{
  state: 'completed';
  mode: 'partial_stop';
  contentPreserved: true;
  sessionId: string;
  planId: string;
  settledMutationSessionIds: string[];
}> {
  if (
    !validateSermonDeletionPartialStopOperation(operation) ||
    !deps.authorizeRead ||
    !deps.readProvider ||
    !deps.prepareUnclaimedReservationDisposition
  )
    fail();
  const db = deps.firestore,
    target = local(db, operation.planId);
  let cached = false;
  await deps.commitCurrent(ref, async (tx) => {
    const s = await authorized(tx, db, ref, operation, deps);
    if (s.record.state === 'completed') {
      const final = await prepareProviderMutationSessionCommitFromClosedEvidence(
        tx,
        s.session,
        (inner, _session, seal) => validatePartialCompletion(inner, db, s, seal)
      );
      if (final.alreadyCommitted) cached = true;
      return;
    }
    const closure = await prepareProviderMutationEffectsClosedFromReadyEvidence(tx, s.session, async () => ({
      sourceProgramDigest: s.sourceEvidenceDigest,
      expectedRequestCount: s.identity.sourceRequestCount,
      actualRequestCount: s.identity.originalRequestCount,
      claimSetDigest: s.identity.terminalClaimSetDigest,
      claimSetDigestVersion: 2,
    }));
    closure.commit();
  });
  const result = {
    state: 'completed' as const,
    mode: 'partial_stop' as const,
    contentPreserved: true as const,
    sessionId: operation.sessionId,
    planId: operation.planId,
    settledMutationSessionIds: [operation.sessionId],
  };
  if (cached) return result;
  const known: Effect[] = [];
  let effectChainDigest = hash([]),
    effectCount = 0;
  for await (const page of documents(target.collection('effects')))
    for (const doc of page) {
      const effect = doc.data() as Effect;
      if (doc.get('digest') !== hash({ ...effect, digest: undefined })) fail();
      effectChainDigest = hash([effectChainDigest, doc.id, doc.get('digest')]);
      effectCount++;
      if (effect.positive) known.push(effect);
    }
  const frozenSource = await db.runTransaction((tx) => source(tx, db, ref, operation.sessionId));
  if (
    effectChainDigest !== frozenSource.record.effectChainDigest ||
    effectCount !== frozenSource.identity.originalRequestCount
  )
    fail();
  const rootEffects = known.filter((effect) => effect.kind === 'root');
  for (const effect of rootEffects) {
    const t = effect.request.target!,
      read: PartialStopRead = {
        provider: t.provider,
        resourceType: t.resourceType,
        resourceId: t.resourceId,
        accountId: t.account,
        method: 'GET',
      };
    await deps.authorizeRead(read);
    const observed = await deps.readProvider(read);
    if (
      observed.state !== 'absent' ||
      observed.providerId !== t.resourceId ||
      observed.accountId !== t.account ||
      ![404, 410].includes(Number(observed.originalHttpStatus))
    )
      fail();
    await deps.commitCurrent(ref, async (tx) => {
      const s = await authorized(tx, db, ref, operation, deps),
        journalId = (await import('node:crypto'))
          .createHash('sha256')
          .update(JSON.stringify([ref.projectId, ref.jobId, t.provider, t.resourceId]))
          .digest('hex'),
        journal = await tx.get(db.doc(`temporalPublishingDeletionReceipts/${journalId}`));
      if (
        journal.get('projectId') !== ref.projectId ||
        journal.get('jobId') !== ref.jobId ||
        journal.get('sermonId') !== s.identity.sermonId ||
        journal.get('remoteId') !== t.resourceId ||
        journal.get('provider') !== t.provider ||
        journal.get('originalAccount') !== t.account ||
        journal.get('ownershipConfirmedBeforeDelete') !== true
      )
        fail();
      tx.set(target.collection('observations').doc(providerMutationFingerprint(effect.request.step)), {
        schemaVersion: 1,
        step: effect.request.step,
        requestFingerprint: effect.request.fingerprint,
        kind: 'root',
        state: 'absent',
        originalAccount: t.account,
        originalHttpStatus: observed.originalHttpStatus,
      });
    });
  }
  const initial = await db.runTransaction((tx) => source(tx, db, ref, operation.sessionId));
  let counts: SermonDeletionDestinationCountWrite[] = [];
  const destinationKnown = known.filter((effect) => effect.kind !== 'root');
  if (destinationKnown.length) {
    if (!initial.header.destinationProgram) fail();
    const { readSermonDeletionPartialDestinationCounts } = await import('./sermonDeletionDestinations'),
      token = await authenticateSubsplash(),
      snapshot = await readSermonDeletionPartialDestinationCounts(db, initial.header.destinationProgram, token, {
        knownRequestSteps: destinationKnown.map((effect) => effect.request.step),
        authorizeRead: async (targetRead) =>
          deps.authorizeRead({
            provider: targetRead.provider,
            resourceType: targetRead.resourceType,
            resourceId: targetRead.resourceId,
            accountId: targetRead.account,
            method: 'GET',
          }),
      });
    if (
      !sha(snapshot.evidenceDigest) ||
      snapshot.observations.length !== destinationKnown.length ||
      snapshot.observations.some(
        (value) => !value.matchesFrozenRequest || !['absent', 'unlinked', 'present'].includes(value.state)
      )
    )
      fail();
    const nodes = new Set(destinationKnown.filter((effect) => effect.kind === 'row').map((effect) => effect.nodePath)),
      roots = new Set(destinationKnown.filter((effect) => effect.kind === 'row').map((effect) => effect.rootPath)),
      series = new Set(
        destinationKnown
          .filter((effect) => effect.kind === 'unlink' || effect.kind === 'subtitle')
          .map((effect) => effect.seriesPath)
      );
    counts = snapshot.countWrites.flatMap((count) => {
      if (count.path.startsWith('series/')) return series.has(count.path) ? [count] : [];
      const patch: Data = {};
      if (nodes.has(count.path) && count.patch.count !== undefined) patch.count = count.patch.count;
      if (roots.has(count.path) && count.patch.logicalCount !== undefined)
        patch.logicalCount = count.patch.logicalCount;
      return Object.keys(patch).length ? [{ ...count, patch }] : [];
    });
  }
  counts = [
    ...counts
      .reduce((map, count) => {
        const prior = map.get(count.path);
        if (prior && hash(prior.expectedFields) !== hash(count.expectedFields)) fail();
        map.set(count.path, prior ? { ...count, patch: { ...prior.patch, ...count.patch } } : count);
        return map;
      }, new Map<string, SermonDeletionDestinationCountWrite>())
      .values(),
  ];
  // Fresh counts are captured in bounded source-fenced pages, then sealed before projection.
  await deps.commitCurrent(ref, async (tx) => {
    const s = await authorized(tx, db, ref, operation, deps),
      existing = await tx.get(target.collection('runtime').doc('counts'));
    if (existing.exists) {
      if (existing.get('snapshotDigest') !== hash(counts) || existing.get('countWriteCount') !== counts.length) fail();
      return;
    }
    tx.create(existing.ref, {
      schemaVersion: 1,
      snapshotDigest: hash(counts),
      countWriteCount: counts.length,
      countOffset: 0,
      canonicalPageCount: s.record.canonicalPageCount,
      canonicalChainDigest: s.record.canonicalChainDigest,
      state: 'preparing',
    });
  });
  for (let offset = 0; offset < counts.length; offset += 32) {
    await deps.commitCurrent(ref, async (tx) => {
      await authorized(tx, db, ref, operation, deps);
      const runtime = await tx.get(target.collection('runtime').doc('counts'));
      if (runtime.get('snapshotDigest') !== hash(counts)) fail();
      if (runtime.get('countOffset') > offset) return;
      if (runtime.get('countOffset') !== offset) fail();
      const writes: Write[] = [];
      for (const count of counts.slice(offset, offset + 32)) {
        const doc = await tx.get(db.doc(count.path));
        if (
          !doc.exists ||
          Object.entries(count.expectedFields).some(([key, value]) => doc.get(key) !== value) ||
          Object.keys(count.patch).some(
            (key) => !['count', 'logicalCount', 'publishedItemCount', 'subtitle'].includes(key)
          )
        )
          fail();
        writes.push(write(count.path, doc.data()!, count.patch));
      }
      const index = runtime.get('canonicalPageCount'),
        body = { schemaVersion: 1, index, writes },
        digest = hash(body);
      const authorities = await Promise.all(
        writes.map((record) =>
          tx.get(target.collection('canonicalWriteIndex').doc(providerMutationFingerprint(record.path)))
        )
      );
      if (authorities.some((doc) => doc.exists)) fail();
      tx.create(target.collection('canonicalPages').doc(sequence(index)), { ...body, digest });
      writes.forEach((record) =>
        tx.create(target.collection('canonicalWriteIndex').doc(providerMutationFingerprint(record.path)), {
          schemaVersion: 1,
          pageIndex: index,
          pageDigest: digest,
          write: record,
        })
      );
      tx.update(runtime.ref, {
        countOffset: offset + writes.length,
        canonicalPageCount: index + 1,
        canonicalChainDigest: hash([runtime.get('canonicalChainDigest'), index, digest]),
      });
    });
  }
  await deps.commitCurrent(ref, async (tx) => {
    const s = await authorized(tx, db, ref, operation, deps),
      runtime = await tx.get(target.collection('runtime').doc('counts'));
    if (runtime.get('countOffset') !== counts.length || runtime.get('snapshotDigest') !== hash(counts)) fail();
    const immutableCatalogDigest = hash({
      preparedCatalogue: s.record.immutableCatalogueDigest,
      countSnapshotDigest: hash(counts),
      canonicalPageCount: runtime.get('canonicalPageCount'),
      canonicalChainDigest: runtime.get('canonicalChainDigest'),
    });
    if (runtime.get('state') === 'ready') {
      if (runtime.get('immutableCatalogDigest') !== immutableCatalogDigest) fail();
      return;
    }
    tx.update(runtime.ref, { state: 'ready', immutableCatalogDigest });
  });
  for await (const page of documents(target.collection('canonicalPages')))
    for (const captured of page) {
      await deps.commitCurrent(ref, async (tx) => {
        const s = await authorized(tx, db, ref, operation, deps),
          body = { schemaVersion: 1, index: captured.get('index'), writes: captured.get('writes') },
          digest = hash(body);
        if (captured.get('digest') !== digest || body.writes.length > 32) fail();
        const prior = await tx.get(target.collection('completedPages').doc(sequence(body.index)));
        if (prior.exists) {
          if (prior.get('pageDigest') !== digest) fail();
          return;
        }
        const snapshots = await tx.getAll(...(body.writes as Write[]).map((record) => db.doc(record.path))),
          updates: Array<{ path: string; patch: Data }> = [],
          retirements: Array<() => void> = [];
        for (let i = 0; i < snapshots.length; i++) {
          const current = snapshots[i],
            record = (body.writes as Write[])[i];
          if (!current.exists || ![record.baselineDigest, record.afterDigest].includes(hash(current.data()))) fail();
          if (hash(current.data()) === record.afterDigest) continue;
          const next = after(current.data()!, record);
          if (hash(next) !== record.afterDigest) fail();
          updates.push({
            path: record.path,
            patch: {
              ...record.patch,
              ...Object.fromEntries(record.deleteFields.map((field) => [field, FieldValue.delete()])),
            },
          });
          if (record.path === `sermons/${s.identity.sermonId}`)
            for (const effect of rootEffects)
              retirements.push(
                await preparePublishingAllocationRetirement(
                  tx,
                  db,
                  { ref, sermonId: s.identity.sermonId, provider: effect.request.target!.provider },
                  effect.request.target!.resourceId
                )
              );
        }
        updates.forEach((update) => tx.update(db.doc(update.path), update.patch));
        retirements.forEach((commit) => commit());
        tx.create(target.collection('completedPages').doc(sequence(body.index)), {
          schemaVersion: 1,
          index: body.index,
          pageDigest: digest,
          completionDigest: hash({
            pageDigest: digest,
            canonicalAfterDigests: (body.writes as Write[]).map((record) => record.afterDigest),
          }),
        });
      });
    }
  // EOF is independently recomputed from real source pages and actual completion checkpoints.
  let cursor: string | undefined,
    index = 0,
    chain = hash([]),
    completionChain = hash([]);
  for (;;) {
    let output: { done: boolean; cursor?: string; index: number; chain: string; completionChain: string } | undefined;
    await deps.commitCurrent(ref, async (tx) => {
      await authorized(tx, db, ref, operation, deps);
      let query = target.collection('canonicalPages').orderBy(FieldPath.documentId()).limit(32);
      if (cursor) query = query.startAfter(cursor);
      const page = await tx.get(query);
      let pageIndex = index,
        pageChain = chain,
        pageCompletionChain = completionChain;
      for (const doc of page.docs) {
        if (doc.id !== sequence(pageIndex) || doc.get('index') !== pageIndex) fail();
        const proof = await tx.get(target.collection('completedPages').doc(doc.id));
        if (proof.get('pageDigest') !== doc.get('digest') || !sha(proof.get('completionDigest'))) fail();
        pageChain = hash([pageChain, pageIndex, doc.get('digest')]);
        pageCompletionChain = hash([pageCompletionChain, pageIndex, proof.get('completionDigest')]);
        pageIndex++;
      }
      output = {
        done: page.size < 32,
        ...(page.size === 32 ? { cursor: page.docs.at(-1)!.id } : {}),
        index: pageIndex,
        chain: pageChain,
        completionChain: pageCompletionChain,
      };
    });
    index = output!.index;
    chain = output!.chain;
    completionChain = output!.completionChain;
    if (output!.done) break;
    cursor = output!.cursor;
  }
  await deps.commitCurrent(ref, async (tx) => {
    const s = await authorized(tx, db, ref, operation, deps),
      runtime = await tx.get(target.collection('runtime').doc('counts'));
    if (index !== runtime.get('canonicalPageCount') || chain !== runtime.get('canonicalChainDigest')) fail();
    const completion: ProviderMutationReadyCanonicalCompletion = {
      closedClaimSetDigest: s.identity.terminalClaimSetDigest,
      originalRequestCount: s.identity.originalRequestCount,
      immutableCatalogDigest: runtime.get('immutableCatalogDigest'),
      canonicalCompletionDigest: hash({
        identity: s.identity,
        canonicalCompletionChain: completionChain,
        canonicalPageCount: index,
      }),
      expectedCanonicalPageCount: index,
      completedCanonicalPageCount: index,
    };
    tx.update(target, { state: 'completed', completion });
  });
  await deps.commitCurrent(ref, async (tx) => {
    const s = await authorized(tx, db, ref, operation, deps),
      final = await prepareProviderMutationSessionCommitFromClosedEvidence(tx, s.session, (inner, _session, seal) =>
        validatePartialCompletion(inner, db, s, seal)
      ),
      settlements: Array<() => void> = [];
    for (const request of s.header.requests as FrozenProjectionRequest[]) {
      const effect = await tx.get(target.collection('effects').doc(providerMutationFingerprint(request.step)));
      if (effect.get('positive') === true)
        settlements.push(
          await prepareDesiredProviderDeletionSettlement(tx, db, {
            resource: {
              projectId: ref.projectId,
              provider: request.target!.provider,
              account: request.target!.provider === 'subsplash' ? 'app:9XTSHD' : 'configured-account',
              remoteId: request.target!.resourceId,
            },
            jobId: ref.jobId,
            resourceType: request.target!.resourceType as 'media' | 'track',
          })
        );
      else
        settlements.push(
          await deps.prepareUnclaimedReservationDisposition(tx, {
            ref,
            operation,
            session: s.session,
            target: request.target!,
            sourceEvidence: s.sourceEvidence,
          })
        );
    }
    const media = await tx.get(db.doc(`temporalMediaState/${s.identity.sermonId}`));
    if (
      media.get('deletionParentRef.projectId') !== ref.projectId ||
      media.get('deletionParentRef.jobId') !== ref.jobId
    )
      fail();
    settlements.forEach((commit) => commit());
    tx.update(media.ref, { deletionParentRef: FieldValue.delete() });
    tx.delete(db.doc(`temporalMediaDeletionEffects/${ref.jobId}`));
    final.commit();
  });
  return result;
}

/** Narrow index callback: this ORIGINAL root DELETE is permanently non-positive,
 * while sibling original requests may have positive facts. No operator assertion
 * and no current provider GET supplies this proof. */
export async function assertSermonDeletionPartialStopUnclaimedTarget(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  operation: SermonDeletionPartialStopOperation,
  target: ProviderMutationResource
): Promise<{
  sessionId: string;
  sourceEvidenceDigest: string;
  originalRequestStep: string;
  originalRequestFingerprint: string;
  disposition: 'unclaimed' | 'rejected_no_effect';
}> {
  if (!validateSermonDeletionPartialStopOperation(operation)) fail();
  const s = await source(tx, db, ref, operation.sessionId);
  if (s.operation.planId !== operation.planId || !['ready', 'completed'].includes(s.record.state)) fail();
  const expected = (s.header.requests as FrozenProjectionRequest[]).find(
    (request) => hash(request.target) === hash(target)
  );
  if (!expected) fail();
  const index = await tx.get(
    db.doc(
      `${ACKNOWLEDGED_PROJECTION_PLANS}/${operation.sessionId}/requestIndex/${providerMutationFingerprint(
        expected.step
      )}`
    )
  );
  if (index.get('ready') !== true || hash(index.get('request')) !== hash(expected)) fail();
  const session = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${operation.sessionId}`));
  if (
    session.get('state') !== 'active' ||
    session.get('effectsClosed') !== true ||
    session.get('effectsClosedSourceProgramDigest') !== s.sourceEvidenceDigest ||
    session.get('effectsClosedClaimSetDigestVersion') !== 2 ||
    session.get('effectsClosedClaimSetDigest') !== s.identity.terminalClaimSetDigest ||
    session.get('effectsClosedActualRequestCount') !== s.identity.originalRequestCount
  )
    fail();
  const actual = await tx.get(session.ref.collection('requests').doc(providerMutationFingerprint(expected.step))),
    effect = await tx.get(
      local(db, operation.planId).collection('effects').doc(providerMutationFingerprint(expected.step))
    );
  if (actual.exists) {
    if (
      actual.get('state') !== 'rejected_no_effect' ||
      effect.get('positive') !== false ||
      effect.get('evidence.sourceRequestDigest') !== hash(actual.data())
    )
      fail();
    await validateProviderMutationOriginalCompletion(tx, s.session, [
      actual as FirebaseFirestore.QueryDocumentSnapshot,
    ]);
  } else if (effect.exists) fail();
  const field = target.provider === 'subsplash' ? 'subsplashId' : 'soundCloudTrackId';
  if (s.root[field] !== target.resourceId) fail();
  return {
    sessionId: operation.sessionId,
    sourceEvidenceDigest: s.sourceEvidenceDigest,
    originalRequestStep: expected.step,
    originalRequestFingerprint: expected.fingerprint,
    disposition: actual.exists ? 'rejected_no_effect' : 'unclaimed',
  };
}

/** SDK adapter uses the exact source proof again in this same transaction. */
export async function prepareSermonDeletionPartialStopUnclaimedReservation(
  tx: Transaction,
  input: {
    ref: DurableJobRef;
    operation: SermonDeletionPartialStopOperation;
    session: ProviderMutationSession;
    target: ProviderMutationResource;
    sourceEvidence: { path: string; digest: string };
  }
): Promise<() => void> {
  const { ref, operation, target, session } = input,
    db = session.db;
  const proof = await assertSermonDeletionPartialStopUnclaimedTarget(tx, db, ref, operation, target);
  if (
    input.sourceEvidence.digest !== proof.sourceEvidenceDigest ||
    input.sourceEvidence.path !== local(db, operation.planId).path ||
    session.id !== operation.sessionId ||
    !['media', 'track'].includes(target.resourceType)
  )
    fail();
  return prepareDesiredProviderDeletionPartialStopAbort(
    tx,
    db,
    {
      resource: {
        projectId: ref.projectId,
        provider: target.provider,
        account: target.provider === 'subsplash' ? 'app:9XTSHD' : 'configured-account',
        remoteId: target.resourceId,
      },
      jobId: ref.jobId,
      resourceType: target.resourceType as 'media' | 'track',
    },
    proof,
    async (transaction, issued, scope) => {
      if (
        issued !== proof ||
        scope.projectId !== ref.projectId ||
        scope.jobId !== ref.jobId ||
        scope.resource.provider !== target.provider ||
        scope.resource.remoteId !== target.resourceId ||
        scope.resourceType !== target.resourceType
      )
        fail();
      const current = await assertSermonDeletionPartialStopUnclaimedTarget(transaction, db, ref, operation, target);
      if (hash(current) !== hash(proof)) fail();
    }
  );
}

/** Native indexed commit callback: only this source's exact already frozen factual
 * before/after pair may preserve an existing reference while its deletion is reserved. */
export async function validatePartialStopReservedCanonicalReference(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  operation: SermonDeletionPartialStopOperation,
  change: { projectId: string; canonicalPath: string; before: unknown; after: unknown },
  resource: { projectId: string; provider: 'subsplash' | 'soundcloud'; account: string; remoteId: string }
): Promise<void> {
  const s = await source(tx, db, ref, operation.sessionId);
  if (
    s.operation.planId !== operation.planId ||
    change.projectId !== ref.projectId ||
    resource.projectId !== ref.projectId ||
    !['ready', 'completed'].includes(s.record.state)
  )
    fail();
  const session = await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${operation.sessionId}`));
  if (
    session.get('state') !== 'active' ||
    session.get('effectsClosed') !== true ||
    session.get('effectsClosedSourceProgramDigest') !== s.sourceEvidenceDigest ||
    session.get('effectsClosedClaimSetDigestVersion') !== 2 ||
    session.get('effectsClosedClaimSetDigest') !== s.identity.terminalClaimSetDigest
  )
    fail();
  const indexed = await tx.get(
      local(db, operation.planId)
        .collection('canonicalWriteIndex')
        .doc(providerMutationFingerprint(change.canonicalPath))
    ),
    record = indexed.get('write') as Write | undefined;
  if (
    indexed.get('schemaVersion') !== 1 ||
    !record ||
    record.path !== change.canonicalPath ||
    hash(change.before) !== record.baselineDigest ||
    hash(change.after) !== record.afterDigest ||
    hash(after(object(change.before), record)) !== record.afterDigest
  )
    fail();
  const page = await tx.get(
    local(db, operation.planId)
      .collection('canonicalPages')
      .doc(sequence(indexed.get('pageIndex')))
  );
  if (
    page.get('digest') !== indexed.get('pageDigest') ||
    page.get('digest') !== hash({ schemaVersion: 1, index: page.get('index'), writes: page.get('writes') }) ||
    !page.get('writes')?.some((value: Write) => hash(value) === hash(record))
  )
    fail();
  const { extractProviderResources } = await import('../../../packages/orchestration/src/provider-usage');
  const contains = (data: unknown) =>
    extractProviderResources(ref.projectId, change.canonicalPath, data).some((value) => hash(value) === hash(resource));
  if (!contains(change.before) || !contains(change.after)) fail();
}
