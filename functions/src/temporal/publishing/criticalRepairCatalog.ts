import { createHash } from 'node:crypto';
import { type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { FixedRepairOperation } from './criticalRepair';
import { PUBLISHING_SOURCE_PROTOCOL } from '../../../../packages/orchestration/src/job-store';

export const CRITICAL_REPAIR_SOURCE_CATALOGS = 'temporalPublishingCriticalRepairSourceCatalogs';
export const CRITICAL_REPAIR_CATALOGS = 'temporalPublishingCriticalRepairCatalogs';
const EFFECTS = 'temporalPublishingEffectPlans',
  JOURNALS = 'temporalPublishingDeletionReceipts';
const PAGE_SIZE = 32,
  DOCUMENT_BUDGET = 900_000,
  SOURCE_DOCUMENT_BUDGET = 192 * 1024;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
const fail = (detail?: string): never => {
  throw Object.assign(
    new Error(`Immutable critical repair catalog is not authoritative${detail ? `: ${detail}` : ''}`),
    {
      code: 'PUBLISHING_CRITICAL_REPAIR_CATALOG_REQUIRED',
    }
  );
};
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safe = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s/?#]/.test(value);
const validStep = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value);
function sourceSteps(value: unknown, ref: DurableJobRef, job: ObjectValue): string[] {
  const data = object(value),
    parent = object(data.sourceParentRef);
  if (
    parent.projectId !== ref.projectId ||
    parent.jobId !== ref.jobId ||
    Object.keys(parent).length !== 2 ||
    !Array.isArray(data.sourceStepIds) ||
    data.sourceStepIds.length === 0 ||
    data.sourceStepIds.length > 32 ||
    data.sourceStepIds.some((step) => !validStep(step)) ||
    new Set(data.sourceStepIds).size !== data.sourceStepIds.length ||
    !Array.isArray(job.steps) ||
    job.steps.length > 32
  )
    fail();
  const allowed = new Set((job.steps as unknown[]).map((step) => object(step).id));
  const steps = data.sourceStepIds as string[];
  if (steps.some((step) => !allowed.has(step))) fail();
  return [...steps].sort();
}
const initialDeleteChain = (catalogId: string): string =>
  criticalRepairCatalogDigest({ catalogId, kind: 'provider_delete' });
const appendDeleteDigest = (previousDigest: string, operationDigest: string): string =>
  criticalRepairCatalogDigest({ previousDigest, operationDigest });
const deleteSetDigest = (count: number, operationChainDigest: string): string =>
  criticalRepairCatalogDigest({ count, operationChainDigest });
function ordered(value: unknown): unknown {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) fail();
    return value.getTime();
  }
  if (value && typeof value === 'object' && 'toMillis' in value && typeof value.toMillis === 'function') {
    const millis = value.toMillis();
    if (!Number.isFinite(millis)) fail();
    return millis;
  }
  if (Array.isArray(value)) return value.map((entry) => (entry === undefined ? null : ordered(entry)));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, ordered(entry)])
    );
  if ((typeof value === 'number' && !Number.isFinite(value)) || ['function', 'symbol', 'bigint'].includes(typeof value))
    fail();
  return value;
}
export const criticalRepairCatalogDigest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex');
const bounded = (value: unknown, budget = DOCUMENT_BUDGET): void => {
  const serialized = JSON.stringify(ordered(value));
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') * 4 + 2048 > budget) fail();
};
const ordinal = (index: number): string => {
  if (!Number.isSafeInteger(index) || index < 0) fail();
  return String(index).padStart(16, '0');
};
export function criticalRepairCatalogSourceProjection(path: string, value: unknown): ObjectValue {
  const data = object(value),
    keys = path.startsWith(`${EFFECTS}/`)
      ? [
          'schemaVersion',
          'projectId',
          'jobId',
          'reasonCode',
          'provider',
          'resourceType',
          'resourceId',
          'accountId',
          'method',
          'canonicalPaths',
          'requestFingerprint',
          'plannedAtMillis',
          'sourceStepIds',
          'sourceParentRef',
        ]
      : path.startsWith(`${JOURNALS}/`)
      ? [
          'projectId',
          'jobId',
          'sermonId',
          'provider',
          'remoteId',
          'originalAccount',
          'authorizedAtMillis',
          'ownershipConfirmedBeforeDelete',
          'sourceStepIds',
          'sourceParentRef',
        ]
      : fail();
  return Object.fromEntries(keys.map((key) => [key, data[key]]));
}
interface Binding {
  projectId: string;
  jobId: string;
  generation: number;
  workflowId: string;
  intentDigest: string;
}
interface SourceRoot extends Binding {
  producerProtocol: typeof PUBLISHING_SOURCE_PROTOCOL;
  sourceProgramChainDigest: string;
  schemaVersion: 1;
  count: number;
  revision: number;
  sealed: boolean;
  criticalDigest?: string;
  acceptedUserCancellation?: boolean;
  sealDigest?: string;
}
export interface CriticalRepairCatalogRoot extends Binding {
  schemaVersion: 1;
  criticalDigest: string;
  acceptedUserCancellation: boolean;
  sourceCatalogSealDigest: string;
  sourceCount: number;
  sourceCursor: number;
  sourceCursorDigest: string;
  operationCount: number;
  sourceParentRef: DurableJobRef;
  sourceStepIds: string[];
  deleteCount: number;
  deletePageCount: number;
  deleteChainDigest: string;
  deleteOperationChainDigest: string;
  deleteSetDigest: string;
  pageCount: number;
  chainDigest: string;
  ready: boolean;
  catalogId: string;
}
export interface CertifiedCriticalRepairOperation {
  operation: FixedRepairOperation;
  operationDigest: string;
  sourcePath: string;
  sourceDigest: string;
}
interface CandidatePage {
  schemaVersion: 1;
  catalogId: string;
  ordinal: number;
  previousDigest: string;
  entries: CertifiedCriticalRepairOperation[];
  digest: string;
}
export interface CriticalRepairCatalogFence {
  commitCurrent(ref: DurableJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void>;
}
async function binding(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef
): Promise<{ binding: Binding; intent: ObjectValue; critical: ObjectValue; cancelled: boolean; job: ObjectValue }> {
  if (!safe(ref.projectId) || !safe(ref.jobId)) fail();
  const [jobDoc, intentDoc, criticalDoc, cancelDoc] = await tx.getAll(
    db.doc(`durableJobs/${ref.jobId}`),
    db.doc(`durableJobIntents/${ref.jobId}`),
    db.doc(`durableJobCriticalSections/${ref.jobId}`),
    db.doc(`durableJobCancellationIntents/${ref.jobId}`)
  );
  const job = object(jobDoc.data()),
    intent = object(intentDoc.data()),
    critical = object(criticalDoc.data()),
    cancel = object(cancelDoc.data());
  if (
    !jobDoc.exists ||
    !intentDoc.exists ||
    intent.publishingSourceProtocol !== PUBLISHING_SOURCE_PROTOCOL ||
    job.projectId !== ref.projectId ||
    job.jobId !== ref.jobId ||
    intent.projectId !== ref.projectId ||
    intent.jobId !== ref.jobId ||
    !Number.isSafeInteger(job.generation) ||
    Number(job.generation) < 1 ||
    job.generation !== intent.generation ||
    !safe(job.workflowId) ||
    ['succeeded', 'failed', 'cancelled', 'superseded'].includes(String(job.state))
  )
    fail();
  return {
    binding: {
      ...ref,
      generation: Number(job.generation),
      workflowId: String(job.workflowId),
      intentDigest: criticalRepairCatalogDigest(intent),
    },
    intent,
    critical,
    job,
    cancelled:
      cancelDoc.exists && (cancel.purpose !== 'critical_repair_cleanup' || cancel.acceptedUserCancellation === true),
  };
}
const initialSourceChain = (binding: Binding): string =>
  criticalRepairCatalogDigest({ protocol: PUBLISHING_SOURCE_PROTOCOL, binding });
const emptySourceRoot = (binding: Binding): SourceRoot => ({
  schemaVersion: 1,
  ...binding,
  count: 0,
  revision: 0,
  sealed: false,
  producerProtocol: PUBLISHING_SOURCE_PROTOCOL,
  sourceProgramChainDigest: initialSourceChain(binding),
});
const matches = (left: Binding, right: Binding): boolean =>
  ['projectId', 'jobId', 'generation', 'workflowId', 'intentDigest'].every(
    (key) => left[key as keyof Binding] === right[key as keyof Binding]
  );
function sourceRoot(value: unknown, expected: Binding): SourceRoot {
  const root = object(value) as unknown as SourceRoot;
  if (
    root.schemaVersion !== 1 ||
    root.producerProtocol !== PUBLISHING_SOURCE_PROTOCOL ||
    !sha(root.sourceProgramChainDigest) ||
    !matches(root, expected) ||
    !Number.isSafeInteger(root.count) ||
    root.count < 0 ||
    root.revision !== root.count ||
    typeof root.sealed !== 'boolean'
  )
    fail();
  return root;
}
/** Original producer calls commit beside its source create, in the same fresh SDK/actor transaction, BEFORE HTTP. */
export async function prepareCriticalRepairCatalogSourceAppend(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  input: { sourcePath: string; source: unknown }
): Promise<{ commit: () => void }> {
  bounded(input.source, SOURCE_DOCUMENT_BUDGET);
  const authority = await binding(tx, db, ref),
    projection = criticalRepairCatalogSourceProjection(input.sourcePath, input.source),
    digest = criticalRepairCatalogDigest(projection);
  const effectPrefix = `${EFFECTS}/${ref.jobId}/operations/`,
    journalPrefix = `${JOURNALS}/`;
  if (
    projection.projectId !== ref.projectId ||
    projection.jobId !== ref.jobId ||
    !(
      (input.sourcePath.startsWith(effectPrefix) && sha(input.sourcePath.slice(effectPrefix.length))) ||
      (input.sourcePath.startsWith(journalPrefix) && sha(input.sourcePath.slice(journalPrefix.length)))
    )
  )
    fail();
  const target = db.collection(CRITICAL_REPAIR_SOURCE_CATALOGS).doc(ref.jobId),
    member = target.collection('members').doc(criticalRepairCatalogDigest(input.sourcePath));
  const [rootDoc, memberDoc] = await tx.getAll(target, member),
    root = rootDoc.exists ? sourceRoot(rootDoc.data(), authority.binding) : emptySourceRoot(authority.binding);
  if (memberDoc.exists) {
    const old = object(memberDoc.data());
    if (old.sourcePath !== input.sourcePath || old.sourceDigest !== digest) fail();
    return { commit: () => {} };
  }
  if (root.sealed || root.count === Number.MAX_SAFE_INTEGER) fail();
  operations(input.sourcePath, input.source, authority.intent, authority.cancelled);
  sourceSteps(input.source, ref, authority.job);
  const unsignedEntry = {
    sourcePath: input.sourcePath,
    sourceDigest: digest,
    ordinal: root.count,
    previousDigest: root.sourceProgramChainDigest,
  };
  const entry = { ...unsignedEntry, entryDigest: criticalRepairCatalogDigest(unsignedEntry) };
  bounded(entry);
  return {
    commit: () => {
      tx.create(member, entry);
      tx.create(target.collection('entries').doc(ordinal(root.count)), entry);
      tx.set(target, {
        ...root,
        count: root.count + 1,
        revision: root.revision + 1,
        sourceProgramChainDigest: entry.entryDigest,
      });
    },
  };
}
/** Every desired first-claim transaction must read this gate AFTER an exact cached-ACK replay lookup.
 * The seal writes this same root, so Firestore serializes first claim versus freeze. */
export async function assertCriticalRepairCatalogClaimAllowed(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef
): Promise<void> {
  const authority = await binding(tx, db, ref),
    snapshot = await tx.get(db.collection(CRITICAL_REPAIR_SOURCE_CATALOGS).doc(ref.jobId));
  if (snapshot.exists && sourceRoot(snapshot.data(), authority.binding).sealed) fail();
}
/** This catalog covers fixed effect descriptors and deletion journals only. Create/allocation receipts,
 * late original create ACKs, and orphan retention remain in their separate complete receipt machinery.
 * V1's server-authored enrollment excludes old jobs. Every original fixed descriptor is validated
 * and enrolled atomically before HTTP; the immutable ordinal/hash chain is maintained only by that
 * producer. The seal freezes ALL subsequent first claims and appends, rather than pretending a
 * stopped SDK or an empty query proves in-flight requests completed. Existing send facts remain unknown. */
export async function assertV1PublishingSourceProducerBarrier(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef
): Promise<{ allSourceWritersEnrolled: true; originalSourceProgramsFrozen: true }> {
  const authority = await binding(tx, db, ref),
    snapshot = await tx.get(db.collection(CRITICAL_REPAIR_SOURCE_CATALOGS).doc(ref.jobId)),
    root = snapshot.exists ? sourceRoot(snapshot.data(), authority.binding) : emptySourceRoot(authority.binding);
  if (root.count === 0) {
    if (root.sourceProgramChainDigest !== initialSourceChain(authority.binding)) fail();
  } else {
    const last = await tx.get(
        db
          .collection(CRITICAL_REPAIR_SOURCE_CATALOGS)
          .doc(ref.jobId)
          .collection('entries')
          .doc(ordinal(root.count - 1))
      ),
      entry = object(last.data()),
      { entryDigest, ...unsignedEntry } = entry;
    if (
      !last.exists ||
      entry.ordinal !== root.count - 1 ||
      typeof entry.sourcePath !== 'string' ||
      !sha(entry.sourceDigest) ||
      !sha(entry.previousDigest) ||
      entryDigest !== root.sourceProgramChainDigest ||
      criticalRepairCatalogDigest(unsignedEntry) !== entryDigest
    )
      fail();
    const original = await tx.get(db.doc(String(entry.sourcePath)));
    bounded(original.data(), SOURCE_DOCUMENT_BUDGET);
    if (
      !original.exists ||
      criticalRepairCatalogDigest(criticalRepairCatalogSourceProjection(String(entry.sourcePath), original.data())) !==
        entry.sourceDigest
    )
      fail();
    operations(String(entry.sourcePath), original.data(), authority.intent, authority.cancelled);
    sourceSteps(original.data(), ref, authority.job);
  }
  return { allSourceWritersEnrolled: true, originalSourceProgramsFrozen: true };
}
/** The producer barrier must attest EVERY effect/journal writer enrolled; an empty/truncated query is never a barrier. */
export async function prepareCriticalRepairCatalogSourceSeal(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  assertProducerBarrier: (
    tx: Transaction
  ) => Promise<{ allSourceWritersEnrolled: true; originalSourceProgramsFrozen: true }>
): Promise<{ sealDigest: string; commit: () => void }> {
  const authority = await binding(tx, db, ref);
  await assertV1PublishingSourceProducerBarrier(tx, db, ref);
  const proof = await assertProducerBarrier(tx);
  if (
    proof.allSourceWritersEnrolled !== true ||
    proof.originalSourceProgramsFrozen !== true ||
    authority.critical.projectId !== ref.projectId ||
    authority.critical.jobId !== ref.jobId ||
    authority.critical.generation !== authority.binding.generation ||
    authority.critical.workflowId !== authority.binding.workflowId
  )
    fail();
  const target = db.collection(CRITICAL_REPAIR_SOURCE_CATALOGS).doc(ref.jobId),
    snapshot = await tx.get(target),
    root = snapshot.exists ? sourceRoot(snapshot.data(), authority.binding) : emptySourceRoot(authority.binding);
  const { sealDigest: previousSeal, ...unsealedRoot } = root;
  const sealed = {
      ...unsealedRoot,
      sealed: true,
      criticalDigest: criticalRepairCatalogDigest(authority.critical),
      acceptedUserCancellation: authority.cancelled,
    },
    sealDigest = criticalRepairCatalogDigest(sealed);
  const cancellationAdvanced =
    root.sealed &&
    root.acceptedUserCancellation === false &&
    sealed.acceptedUserCancellation === true &&
    root.criticalDigest === sealed.criticalDigest;
  if (
    root.sealed &&
    !cancellationAdvanced &&
    (root.sealDigest !== sealDigest ||
      root.criticalDigest !== sealed.criticalDigest ||
      root.acceptedUserCancellation !== sealed.acceptedUserCancellation)
  )
    fail();
  return {
    sealDigest,
    commit: () => {
      if (!root.sealed || cancellationAdvanced) tx.set(target, { ...sealed, sealDigest });
    },
  };
}
async function readAuthority(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef
): Promise<{ source: SourceRoot; authority: Awaited<ReturnType<typeof binding>> }> {
  const authority = await binding(tx, db, ref),
    doc = await tx.get(db.collection(CRITICAL_REPAIR_SOURCE_CATALOGS).doc(ref.jobId)),
    source = sourceRoot(doc.data(), authority.binding);
  const { sealDigest, ...withoutSeal } = source;
  if (!source.sealed || !sha(sealDigest) || criticalRepairCatalogDigest(withoutSeal) !== sealDigest)
    fail('original source seal changed');
  if (source.criticalDigest !== criticalRepairCatalogDigest(authority.critical))
    fail('original critical marker changed');
  if (source.acceptedUserCancellation !== authority.cancelled) fail('accepted user cancellation changed');
  return { source, authority };
}
function operations(path: string, value: unknown, intent: ObjectValue, cancelled: boolean): FixedRepairOperation[] {
  const data = object(value),
    sermon = object(object(object(intent.payload).payload).sermon),
    entity = object(intent.entity);
  if (path.startsWith(`${EFFECTS}/`)) {
    if (
      data.schemaVersion !== 1 ||
      typeof data.reasonCode !== 'string' ||
      !/^[A-Z0-9_]{1,100}$/.test(data.reasonCode) ||
      !Number.isFinite(data.plannedAtMillis) ||
      Number(data.plannedAtMillis) < 0 ||
      (data.requestFingerprint !== undefined && !sha(data.requestFingerprint)) ||
      (data.canonicalPaths !== undefined &&
        (!Array.isArray(data.canonicalPaths) ||
          !data.canonicalPaths.every(
            (path) =>
              typeof path === 'string' &&
              /^((sermons|lists|series|speakers)\/[^/]+)(\/(sermonLists|listItems|seriesItems)\/[^/]+)?$/.test(path)
          ))) ||
      !['PATCH', 'PUT', 'DELETE'].includes(String(data.method))
    )
      fail();
    const result = {
      kind: 'provider_read',
      provider: data.provider,
      resourceType: data.resourceType,
      resourceId: data.resourceId,
      accountId: data.accountId,
      method: 'GET',
    };
    validateProvider(result);
    return [result as FixedRepairOperation];
  }
  if (
    !Number.isFinite(data.authorizedAtMillis) ||
    Number(data.authorizedAtMillis) < 0 ||
    typeof data.ownershipConfirmedBeforeDelete !== 'boolean'
  )
    fail();
  const provider = data.provider,
    field = provider === 'subsplash' ? 'subsplashId' : 'soundCloudTrackId';
  if (
    entity.type !== 'sermon' ||
    !safe(entity.id) ||
    data.sermonId !== entity.id ||
    sermon[field] !== data.remoteId ||
    !['authorized', 'observed_absent', 'absence_confirmed', 'reconciled'].includes(String(data.state))
  )
    fail();
  const read = {
    kind: 'provider_read',
    provider,
    resourceType: provider === 'subsplash' ? 'media' : 'track',
    resourceId: data.remoteId,
    accountId: data.originalAccount,
    method: 'GET',
  };
  validateProvider(read);
  const result: FixedRepairOperation[] = [read as FixedRepairOperation];
  if (data.ownershipConfirmedBeforeDelete === true) {
    const approved =
      provider === 'subsplash'
        ? intent.kind === 'sermon.delete'
        : ['sermon.delete', 'sermon.unpublish', 'sermon.update'].includes(String(intent.kind));
    if (!cancelled && approved && data.state === 'authorized')
      result.push({ ...read, kind: 'provider_delete', method: 'DELETE' } as FixedRepairOperation);
    result.push({
      kind: 'canonical_repair',
      path: `sermons/${entity.id}`,
      field,
      expectedProviderId: String(data.remoteId),
    });
  }
  return result;
}
function validateProvider(op: ObjectValue): void {
  if (
    !safe(op.resourceId) ||
    !(op.provider === 'subsplash'
      ? op.accountId === 'app:9XTSHD' &&
        ['media', 'audio', 'series', 'list', 'list-row', 'tag'].includes(String(op.resourceType))
      : op.provider === 'soundcloud' &&
        op.resourceType === 'track' &&
        typeof op.accountId === 'string' &&
        /^soundcloud:users:[0-9]+$/.test(op.accountId))
  )
    fail();
}
function catalog(value: unknown, source: SourceRoot): CriticalRepairCatalogRoot {
  const root = object(value) as unknown as CriticalRepairCatalogRoot;
  if (
    root.schemaVersion !== 1 ||
    !matches(root, source) ||
    root.sourceCatalogSealDigest !== source.sealDigest ||
    root.criticalDigest !== source.criticalDigest ||
    root.acceptedUserCancellation !== source.acceptedUserCancellation ||
    root.sourceCount !== source.count ||
    !Number.isSafeInteger(root.sourceCursor) ||
    root.sourceCursor < 0 ||
    root.sourceCursor > source.count ||
    !Number.isSafeInteger(root.pageCount) ||
    root.pageCount < 0 ||
    !Number.isSafeInteger(root.operationCount) ||
    root.operationCount < 0 ||
    object(root.sourceParentRef).projectId !== source.projectId ||
    object(root.sourceParentRef).jobId !== source.jobId ||
    !Array.isArray(root.sourceStepIds) ||
    root.sourceStepIds.length > 32 ||
    root.sourceStepIds.some((step) => !validStep(step)) ||
    new Set(root.sourceStepIds).size !== root.sourceStepIds.length ||
    !Number.isSafeInteger(root.deleteCount) ||
    root.deleteCount < 0 ||
    !Number.isSafeInteger(root.deletePageCount) ||
    root.deletePageCount < 0 ||
    !sha(root.deleteChainDigest) ||
    !sha(root.deleteOperationChainDigest) ||
    root.deleteSetDigest !== deleteSetDigest(root.deleteCount, root.deleteOperationChainDigest) ||
    !sha(root.chainDigest) ||
    !sha(root.sourceCursorDigest) ||
    (root.sourceCursor === source.count && root.sourceCursorDigest !== source.sourceProgramChainDigest) ||
    root.catalogId !== source.sealDigest ||
    root.ready !== (root.sourceCursor === source.count)
  )
    fail();
  return root;
}
/** One invocation advances at most 32 original sources / 96 fixed operations. All checkpoint/page writes are atomic and replayable. */
export async function compileCriticalRepairCatalogPage(
  db: Firestore,
  ref: DurableJobRef,
  fence: CriticalRepairCatalogFence
): Promise<{ state: 'pending' | 'ready'; root: CriticalRepairCatalogRoot }> {
  let result: CriticalRepairCatalogRoot | undefined;
  await fence.commitCurrent(ref, async (tx) => {
    const { source, authority } = await readAuthority(tx, db, ref),
      target = db.collection(CRITICAL_REPAIR_CATALOGS).doc(source.sealDigest!),
      snapshot = await tx.get(target);
    const root = snapshot.exists
      ? catalog(snapshot.data(), source)
      : {
          schemaVersion: 1 as const,
          ...authority.binding,
          criticalDigest: source.criticalDigest!,
          acceptedUserCancellation: source.acceptedUserCancellation!,
          sourceCatalogSealDigest: source.sealDigest!,
          sourceCount: source.count,
          sourceCursor: 0,
          sourceCursorDigest: initialSourceChain(authority.binding),
          operationCount: 0,
          sourceParentRef: { ...ref },
          sourceStepIds: [] as string[],
          deleteCount: 0,
          deletePageCount: 0,
          deleteChainDigest: initialDeleteChain(source.sealDigest!),
          deleteOperationChainDigest: initialDeleteChain(source.sealDigest!),
          deleteSetDigest: deleteSetDigest(0, initialDeleteChain(source.sealDigest!)),
          pageCount: 0,
          chainDigest: criticalRepairCatalogDigest({ sourceSeal: source.sealDigest }),
          ready: source.count === 0,
          catalogId: source.sealDigest!,
        };
    if (root.ready) {
      result = root;
      if (!snapshot.exists) tx.create(target, root);
      return;
    }
    const end = Math.min(root.sourceCursor + PAGE_SIZE, source.count),
      entryRefs = Array.from({ length: end - root.sourceCursor }, (_, offset) =>
        db
          .collection(CRITICAL_REPAIR_SOURCE_CATALOGS)
          .doc(ref.jobId)
          .collection('entries')
          .doc(ordinal(root.sourceCursor + offset))
      ),
      entries = await tx.getAll(...entryRefs);
    let sourceCursorDigest = root.sourceCursorDigest;
    const descriptors = entries.map((entry, index) => {
      const data = object(entry.data());
      if (
        !entry.exists ||
        data.ordinal !== root.sourceCursor + index ||
        typeof data.sourcePath !== 'string' ||
        !sha(data.sourceDigest)
      )
        fail();
      const { entryDigest, ...unsignedEntry } = data;
      if (
        data.previousDigest !== sourceCursorDigest ||
        !sha(entryDigest) ||
        criticalRepairCatalogDigest(unsignedEntry) !== entryDigest
      )
        fail();
      sourceCursorDigest = String(entryDigest);
      return data as { sourcePath: string; sourceDigest: string; ordinal: number };
    });
    const sourceDocs = await tx.getAll(...descriptors.map((entry) => db.doc(String(entry.sourcePath)))),
      candidates: CertifiedCriticalRepairOperation[] = [];
    const sourceStepIds = new Set(root.sourceStepIds);
    sourceDocs.forEach((doc, index) => {
      bounded(doc.data(), SOURCE_DOCUMENT_BUDGET);
      const entry = descriptors[index],
        projection = criticalRepairCatalogSourceProjection(entry.sourcePath, doc.data());
      if (
        !doc.exists ||
        projection.projectId !== ref.projectId ||
        projection.jobId !== ref.jobId ||
        criticalRepairCatalogDigest(projection) !== entry.sourceDigest
      )
        fail();
      for (const step of sourceSteps(doc.data(), ref, authority.job)) sourceStepIds.add(step);
      if (sourceStepIds.size > 32) fail();
      for (const operation of operations(entry.sourcePath, doc.data(), authority.intent, authority.cancelled))
        candidates.push({
          operation,
          operationDigest: criticalRepairCatalogDigest(operation),
          sourcePath: entry.sourcePath,
          sourceDigest: entry.sourceDigest,
        });
    });
    const distinct = [...new Map(candidates.map((entry) => [entry.operationDigest, entry])).values()],
      indexes = distinct.length
        ? await tx.getAll(...distinct.map((entry) => target.collection('members').doc(entry.operationDigest)))
        : [],
      fresh = distinct.filter((entry, index) => {
        if (indexes[index].exists) {
          const existing = object(indexes[index].data());
          if (existing.operationDigest !== entry.operationDigest) fail();
          return false;
        }
        return true;
      });
    let chain = root.chainDigest,
      pages = root.pageCount;
    for (let offset = 0; offset < fresh.length; offset += PAGE_SIZE) {
      const pageEntries = fresh.slice(offset, offset + PAGE_SIZE),
        unsigned = {
          schemaVersion: 1 as const,
          catalogId: root.catalogId,
          ordinal: pages,
          previousDigest: chain,
          entries: pageEntries,
        },
        page: CandidatePage = { ...unsigned, digest: criticalRepairCatalogDigest(unsigned) };
      bounded(page);
      tx.create(target.collection('pages').doc(ordinal(pages)), page);
      pageEntries.forEach((entry, index) =>
        tx.create(target.collection('members').doc(entry.operationDigest), {
          operationDigest: entry.operationDigest,
          pageOrdinal: pages,
          entryOffset: index,
          pageDigest: page.digest,
        })
      );
      chain = page.digest;
      pages++;
    }
    const deletions = fresh.filter((entry) => entry.operation.kind === 'provider_delete');
    let deleteChain = root.deleteChainDigest,
      deleteOperationChain = root.deleteOperationChainDigest,
      deletePages = root.deletePageCount;
    for (let offset = 0; offset < deletions.length; offset += PAGE_SIZE) {
      const pageEntries = deletions.slice(offset, offset + PAGE_SIZE),
        unsigned = {
          schemaVersion: 1 as const,
          catalogId: root.catalogId,
          ordinal: deletePages,
          previousDigest: deleteChain,
          entries: pageEntries,
        },
        page: CandidatePage = { ...unsigned, digest: criticalRepairCatalogDigest(unsigned) };
      bounded(page);
      tx.create(target.collection('deletePages').doc(ordinal(deletePages)), page);
      pageEntries.forEach((entry, index) =>
        tx.create(target.collection('deletionMembers').doc(entry.operationDigest), {
          operationDigest: entry.operationDigest,
          pageOrdinal: deletePages,
          entryOffset: index,
          pageDigest: page.digest,
        })
      );
      for (const entry of pageEntries)
        deleteOperationChain = appendDeleteDigest(deleteOperationChain, entry.operationDigest);
      deleteChain = page.digest;
      deletePages++;
    }
    result = {
      ...root,
      sourceCursor: end,
      sourceCursorDigest,
      operationCount: root.operationCount + fresh.length,
      sourceParentRef: { ...ref },
      sourceStepIds: [...sourceStepIds].sort(),
      deleteCount: root.deleteCount + deletions.length,
      deletePageCount: deletePages,
      deleteChainDigest: deleteChain,
      deleteOperationChainDigest: deleteOperationChain,
      deleteSetDigest: deleteSetDigest(root.deleteCount + deletions.length, deleteOperationChain),
      pageCount: pages,
      chainDigest: chain,
      ready: end === source.count,
    };
    if (end === source.count && sourceCursorDigest !== source.sourceProgramChainDigest) fail();
    bounded(result);
    tx.set(target, result);
  });
  if (!result) return fail();
  return { state: result.ready ? 'ready' : 'pending', root: result };
}
export async function prepareCriticalRepairCatalog(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef
): Promise<CriticalRepairCatalogRoot> {
  const { source } = await readAuthority(tx, db, ref),
    doc = await tx.get(db.collection(CRITICAL_REPAIR_CATALOGS).doc(source.sealDigest!)),
    root = catalog(doc.data(), source);
  if (!root.ready) fail();
  return root;
}
/** A cursor is a page ordinal, not a user supplied collection/path. Exactly one bounded immutable page is returned. */
export async function readCertifiedCriticalRepairOperations(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  pinned: CriticalRepairCatalogRoot,
  cursor: number
): Promise<{ entries: CertifiedCriticalRepairOperation[]; nextCursor: number | null }> {
  const root = await prepareCriticalRepairCatalog(tx, db, ref);
  if (
    criticalRepairCatalogDigest(root) !== criticalRepairCatalogDigest(pinned) ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor > root.pageCount
  )
    fail();
  if (cursor === root.pageCount) return { entries: [], nextCursor: null };
  const doc = await tx.get(
      db.collection(CRITICAL_REPAIR_CATALOGS).doc(root.catalogId).collection('pages').doc(ordinal(cursor))
    ),
    page = object(doc.data()) as unknown as CandidatePage;
  const { digest, ...unsigned } = page;
  if (
    !doc.exists ||
    page.catalogId !== root.catalogId ||
    page.ordinal !== cursor ||
    !Array.isArray(page.entries) ||
    page.entries.length === 0 ||
    page.entries.length > PAGE_SIZE ||
    !sha(digest) ||
    criticalRepairCatalogDigest(unsigned) !== digest
  )
    fail();
  if (cursor === root.pageCount - 1 && digest !== root.chainDigest) fail();
  if (cursor === 0) {
    if (page.previousDigest !== criticalRepairCatalogDigest({ sourceSeal: root.sourceCatalogSealDigest })) fail();
  } else {
    const previous = object(
      (
        await tx.get(
          db
            .collection(CRITICAL_REPAIR_CATALOGS)
            .doc(root.catalogId)
            .collection('pages')
            .doc(ordinal(cursor - 1))
        )
      ).data()
    );
    if (previous.digest !== page.previousDigest) fail();
  }
  return { entries: page.entries, nextCursor: cursor + 1 === root.pageCount ? null : cursor + 1 };
}
/** Exact immutable membership plus original source reread; the caller still performs its fresh administrator grant check. */
export async function validateCertifiedCriticalRepairOperation(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  pinned: CriticalRepairCatalogRoot,
  operation: FixedRepairOperation,
  phase: 'acquire' | 'replay' | 'claim' | 'close' | 'settle' = 'claim'
): Promise<void> {
  const root = await prepareCriticalRepairCatalog(tx, db, ref);
  if (
    criticalRepairCatalogDigest(root) !== criticalRepairCatalogDigest(pinned) ||
    (root.acceptedUserCancellation && operation.kind === 'provider_delete')
  )
    fail();
  const digest = criticalRepairCatalogDigest(operation),
    target = db.collection(CRITICAL_REPAIR_CATALOGS).doc(root.catalogId),
    memberDoc = await tx.get(target.collection('members').doc(digest)),
    member = object(memberDoc.data());
  if (
    !memberDoc.exists ||
    member.operationDigest !== digest ||
    !Number.isSafeInteger(member.pageOrdinal) ||
    Number(member.pageOrdinal) < 0 ||
    Number(member.pageOrdinal) >= root.pageCount ||
    !Number.isSafeInteger(member.entryOffset)
  )
    fail();
  const pageDoc = await tx.get(target.collection('pages').doc(ordinal(Number(member.pageOrdinal))));
  if (object(pageDoc.data()).digest !== member.pageDigest) fail();
  const pageResult = await readCertifiedCriticalRepairOperations(tx, db, ref, pinned, Number(member.pageOrdinal)),
    entry = pageResult.entries[Number(member.entryOffset)];
  if (!entry || entry.operationDigest !== digest || criticalRepairCatalogDigest(entry.operation) !== digest) fail();
  const source = await tx.get(db.doc(String(entry.sourcePath)));
  if (
    !source.exists ||
    criticalRepairCatalogDigest(criticalRepairCatalogSourceProjection(entry.sourcePath, source.data())) !==
      entry.sourceDigest
  )
    fail();
  const authority = await binding(tx, db, ref);
  if (
    operation.kind === 'provider_delete' &&
    ['acquire', 'replay', 'close', 'settle'].includes(phase) &&
    !['authorized', 'observed_absent', 'absence_confirmed', 'reconciled'].includes(String(object(source.data()).state))
  )
    fail();
  const sourceForPhase =
    operation.kind === 'provider_delete' && ['acquire', 'replay', 'close', 'settle'].includes(phase)
      ? { ...object(source.data()), state: 'authorized' }
      : source.data();
  if (
    !operations(entry.sourcePath, sourceForPhase, authority.intent, authority.cancelled).some(
      (candidate) => criticalRepairCatalogDigest(candidate) === digest
    )
  )
    fail();
}

export type CertifiedCriticalRepairDeletion = Extract<FixedRepairOperation, { kind: 'provider_delete' }>;
export interface CertifiedCriticalRepairDeleteSet {
  operations: CertifiedCriticalRepairDeletion[];
  count: number;
  digest: string;
}
/** Original compiler order is preserved. Only DELETE pages are read; readonly effect pages are never scanned. */
export async function readCertifiedCriticalRepairDeleteSet(
  db: Firestore,
  ref: DurableJobRef,
  pinned: CriticalRepairCatalogRoot
): Promise<CertifiedCriticalRepairDeleteSet> {
  const operations: CertifiedCriticalRepairDeletion[] = [];
  let operationChain = initialDeleteChain(pinned.catalogId),
    pageChain = initialDeleteChain(pinned.catalogId);
  for (let cursor = 0; cursor < pinned.deletePageCount; cursor++) {
    const entries = await db.runTransaction(async (tx) => {
      const root = await prepareCriticalRepairCatalog(tx, db, ref);
      if (criticalRepairCatalogDigest(root) !== criticalRepairCatalogDigest(pinned)) fail();
      const snapshot = await tx.get(
          db.collection(CRITICAL_REPAIR_CATALOGS).doc(root.catalogId).collection('deletePages').doc(ordinal(cursor))
        ),
        page = object(snapshot.data()) as unknown as CandidatePage,
        { digest, ...unsigned } = page;
      if (
        !snapshot.exists ||
        page.catalogId !== root.catalogId ||
        page.ordinal !== cursor ||
        page.previousDigest !== pageChain ||
        !Array.isArray(page.entries) ||
        page.entries.length === 0 ||
        page.entries.length > PAGE_SIZE ||
        criticalRepairCatalogDigest(unsigned) !== digest ||
        (cursor === root.deletePageCount - 1 && digest !== root.deleteChainDigest)
      )
        fail();
      pageChain = digest;
      return page.entries;
    });
    for (const entry of entries) {
      if (
        entry.operation.kind !== 'provider_delete' ||
        entry.operation.method !== 'DELETE' ||
        criticalRepairCatalogDigest(entry.operation) !== entry.operationDigest
      )
        fail();
      validateProvider(object(entry.operation));
      operations.push(entry.operation as CertifiedCriticalRepairDeletion);
      operationChain = appendDeleteDigest(operationChain, entry.operationDigest);
    }
  }
  const set = { operations, count: operations.length, digest: deleteSetDigest(operations.length, operationChain) };
  await db.runTransaction((tx) => validateCertifiedCriticalRepairDeleteSet(tx, db, ref, pinned, set));
  return set;
}
/** Scalar immutable full-set equality. Caller preserves original compiler order from the reader. */
export async function validateCertifiedCriticalRepairDeleteSet(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  pinned: CriticalRepairCatalogRoot,
  set: CertifiedCriticalRepairDeleteSet | CertifiedCriticalRepairDeletion[]
): Promise<void> {
  const root = await prepareCriticalRepairCatalog(tx, db, ref);
  if (criticalRepairCatalogDigest(root) !== criticalRepairCatalogDigest(pinned)) fail();
  const operations = Array.isArray(set) ? set : set.operations;
  if (!Array.isArray(operations) || operations.length !== root.deleteCount) fail();
  let chain = initialDeleteChain(root.catalogId);
  const members = new Set<string>();
  for (const operation of operations) {
    if (operation.kind !== 'provider_delete' || operation.method !== 'DELETE') fail();
    validateProvider(object(operation));
    const digest = criticalRepairCatalogDigest(operation);
    if (members.has(digest)) fail();
    members.add(digest);
    chain = appendDeleteDigest(chain, digest);
  }
  const digest = deleteSetDigest(operations.length, chain);
  if (
    digest !== root.deleteSetDigest ||
    (!Array.isArray(set) && (set.count !== operations.length || set.digest !== digest))
  )
    fail();
}
/** Replay/closure retains ORIGINAL immutable DELETE authority; it is never a provider-read fallback.
 * Caller additionally verifies exact existing guard facts and source final settlement proof in this transaction. */
export async function validateCertifiedCriticalRepairDeletionPhase(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  pinned: CriticalRepairCatalogRoot,
  operation: CertifiedCriticalRepairDeletion,
  phase: 'acquire' | 'replay' | 'claim' | 'close' | 'settle'
): Promise<void> {
  if (operation.kind !== 'provider_delete' || !['acquire', 'replay', 'claim', 'close', 'settle'].includes(phase))
    fail();
  await validateCertifiedCriticalRepairOperation(tx, db, ref, pinned, operation, phase);
}
/** O(1) READY summary, pinned to all original source bytes through the compiled source chain. */
export async function readCriticalRepairCatalogStepAuthority(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  pinned: CriticalRepairCatalogRoot
): Promise<{ sourceParentRef: DurableJobRef; sourceStepIds: string[]; sourceCount: number }> {
  const root = await prepareCriticalRepairCatalog(tx, db, ref);
  if (criticalRepairCatalogDigest(root) !== criticalRepairCatalogDigest(pinned)) fail();
  const authority = await binding(tx, db, ref);
  if (root.sourceStepIds.length) sourceSteps(root, ref, authority.job);
  else if (root.sourceCount > 0) fail();
  return {
    sourceParentRef: { ...root.sourceParentRef },
    sourceStepIds: [...root.sourceStepIds],
    sourceCount: root.sourceCount,
  };
}
