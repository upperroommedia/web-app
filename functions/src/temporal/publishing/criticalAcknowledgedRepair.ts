import { prepareListRootRemovalCheckpointFromAcknowledgedRepair } from '../../helpers/listDeletionMirrors';
import type {
  AcknowledgedRepairCandidateRoot,
  CandidateCanonicalProgram,
  CandidateRequestEvidence,
  CandidateVerificationProgram,
} from './acknowledgedRepairCandidate';
import {
  acknowledgedProjectionDigest,
  normalizeAcknowledgedProjectionValue as ordered,
} from './acknowledgedProjectionDigest';
export { acknowledgedProjectionDigest } from './acknowledgedProjectionDigest';
import {
  FieldValue,
  FieldPath,
  type Firestore,
  type Transaction,
  type DocumentSnapshot,
  type QuerySnapshot,
} from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import {
  PROVIDER_MUTATION_SESSIONS,
  providerMutationFingerprint,
  prepareProviderMutationSessionCommit,
  prepareProviderMutationSessionCommitFromClosedEvidence,
  prepareProviderMutationEffectsClosedFromReadyEvidence,
  validateProviderMutationOriginalCompletion,
  type ProviderMutationSession,
  type ProviderMutationResource,
  type ProviderMutationReadyCanonicalCompletion,
  type ProviderMutationClosedEvidenceSeal,
} from './providerMutationGuard';
import { extractProviderResources, providerResourceKey } from '../../../../packages/orchestration/src/provider-usage';
import { isCriticalPublishingRepair } from './durableOperationContext';
import { preparePublishingAllocationRetirement } from './allocationBarrier';
import {
  assertSermonDeletionCountReadInTransaction,
  prepareSermonRootRemovalCheckpointFromAcknowledgedRepair,
  SERMON_DELETION_MIRROR_PLANS,
  sermonDeletionMirrorPlanId,
} from '../../helpers/sermonDeletionMirrors';
import {
  assertPublishingMutationTargetProofForSession,
  type PublishingMutationTargetProof,
} from './mutationTargetProof';

export const ACKNOWLEDGED_PROJECTION_PLANS = 'temporalPublishingAcknowledgedProjections';
export const ACKNOWLEDGED_PROJECTION_PROGRESS = 'temporalPublishingAcknowledgedProjectionProgress';
export interface AcknowledgedProjectionOperation {
  kind: 'acknowledged_projection';
  sessionId: string;
  projectionDigest: string;
}
export interface FrozenListRowBinding {
  field: 'uploadStatus.listItemId' | 'physicalPlacement.listItemId' | 'listItemId';
  requestStep: string;
  listId: string;
  mediaId: string;
}
export interface FrozenProjectionWrite {
  path: string;
  requiredSteps?: string[];
  requiredAnySteps?: string[];
  listRowBindings?: FrozenListRowBinding[];
  mode?: 'update' | 'set' | 'delete';
  expectedExists?: boolean;
  expectedDocumentDigest?: string;
  expectedFields: Record<string, unknown>;
  absentFields?: string[];
  patch: Record<string, unknown>;
  deleteFields?: string[];
}
export interface FrozenProjectionRequest {
  step: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  fingerprint: string;
  target?: ProviderMutationResource;
  payload?: unknown;
}
export interface FrozenProviderVerification {
  provider: 'subsplash' | 'soundcloud';
  account: string;
  resourceType: 'media' | 'audio' | 'track' | 'series' | 'list' | 'list-row' | 'tag';
  resourceId: string;
  requiredSteps?: string[];
  expectedState?: 'present' | 'absent';
  expectedProviderFields: Record<string, unknown>;
}
export interface AcknowledgedProviderObservation {
  provider: FrozenProviderVerification['provider'];
  account: string;
  resourceType: FrozenProviderVerification['resourceType'];
  resourceId: string;
  state: 'present' | 'absent';
  body?: Record<string, unknown>;
}
export interface FrozenTargetAuthority {
  kind: PublishingMutationTargetProof['kind'];
  target: ProviderMutationResource;
  rootResource: ProviderMutationResource;
  proofHash: string;
  canonicalPaths: string[];
  receiptId?: string;
}
export interface FrozenAcknowledgedProjection {
  schemaVersion: 1;
  projectId: string;
  jobId: string;
  sessionId: string;
  operation: string;
  intentFingerprint: string;
  requests: FrozenProjectionRequest[];
  writes: FrozenProjectionWrite[];
  verifications: FrozenProviderVerification[];
  uiStepIds?: string[];
  pageDigests?: string[];
  completesActivity?: boolean;
  finalFragment?: boolean;
  targetAuthorities?: FrozenTargetAuthority[];
}
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function fail(): never {
  throw Object.assign(new Error('Original acknowledged projection proof is required'), {
    code: 'PUBLISHING_CRITICAL_ACK_PROJECTION_REQUIRED',
  });
}
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const field = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z_][A-Za-z_0-9]*(\.[A-Za-z_][A-Za-z_0-9]*)*$/.test(value) &&
  value.length <= 160 &&
  !value.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part));
// Provider JSON names include hyphenated HAL relationships; these paths never address Firestore writes.
const providerField = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z_][A-Za-z_0-9-]*(\.[A-Za-z_][A-Za-z_0-9-]*)*$/.test(value) &&
  value.length <= 160 &&
  !value.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part));
const path = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(?:(?:sermons|lists|series|speakers)\/[^/]+(?:\/(?:sermonLists|listItems|seriesItems)\/[^/]+)?|temporalPublishingPublications\/[^/]+|temporalPublishingAudioReplacements\/[^/]+)$/.test(
    value
  ) &&
  value.length <= 1000;
export function validateWrite(write: FrozenProjectionWrite): void {
  if (
    !plain(write) ||
    Object.keys(write).some(
      (key) =>
        ![
          'path',
          'requiredSteps',
          'requiredAnySteps',
          'listRowBindings',
          'mode',
          'expectedExists',
          'expectedDocumentDigest',
          'expectedFields',
          'absentFields',
          'patch',
          'deleteFields',
        ].includes(key)
    ) ||
    !path(write.path) ||
    !plain(write.expectedFields) ||
    !plain(write.patch) ||
    (write.mode !== undefined && !['update', 'set', 'delete'].includes(write.mode)) ||
    (write.expectedExists !== undefined && typeof write.expectedExists !== 'boolean') ||
    (write.expectedDocumentDigest !== undefined && !sha(write.expectedDocumentDigest))
  )
    fail();
  const fields = [
    ...Object.keys(write.expectedFields),
    ...Object.keys(write.patch),
    ...(write.absentFields ?? []),
    ...(write.deleteFields ?? []),
  ];
  if (
    fields.some((key) => !field(key)) ||
    fields.length > 200 ||
    (write.mode !== 'delete' && !Object.keys(write.patch).length && !write.deleteFields?.length) ||
    write.deleteFields?.some((key) => key in write.patch) ||
    write.absentFields?.some((key) => key in write.expectedFields)
  )
    fail();
  if (
    (write.mode === 'delete' &&
      (!sha(write.expectedDocumentDigest) ||
        write.expectedExists === false ||
        Object.keys(write.patch).length ||
        write.deleteFields?.length)) ||
    (write.mode === 'set' &&
      ((write.expectedExists !== false && !sha(write.expectedDocumentDigest)) ||
        Object.keys(write.patch).some((key) => key.includes('.')) ||
        write.deleteFields?.length)) ||
    (write.expectedExists === false &&
      (write.mode !== 'set' || Object.keys(write.expectedFields).length || write.expectedDocumentDigest !== undefined))
  )
    fail();
  ordered(write);
  if (
    write.listRowBindings !== undefined &&
    (!Array.isArray(write.listRowBindings) ||
      write.listRowBindings.length > 10 ||
      write.listRowBindings.some(
        (binding) =>
          !plain(binding) ||
          Object.keys(binding).some((key) => !['field', 'requestStep', 'listId', 'mediaId'].includes(key)) ||
          !['uploadStatus.listItemId', 'physicalPlacement.listItemId', 'listItemId'].includes(binding.field) ||
          typeof binding.requestStep !== 'string' ||
          ![binding.listId, binding.mediaId].every(
            (value) => typeof value === 'string' && !!value && value.length <= 256 && !/[\s/?#]/.test(value)
          ) ||
          binding.field in write.patch ||
          write.deleteFields?.includes(binding.field)
      ) ||
      write.mode === 'delete')
  )
    fail();
}
export function validateVerification(value: FrozenProviderVerification): void {
  if (
    !plain(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'provider',
          'account',
          'resourceType',
          'resourceId',
          'requiredSteps',
          'expectedState',
          'expectedProviderFields',
        ].includes(key)
    ) ||
    typeof value.resourceId !== 'string' ||
    !value.resourceId ||
    value.resourceId.length > 256 ||
    /[\s/?#]/.test(value.resourceId) ||
    !plain(value.expectedProviderFields) ||
    (value.expectedState !== undefined && !['present', 'absent'].includes(value.expectedState)) ||
    (value.expectedState === 'absent'
      ? !!Object.keys(value.expectedProviderFields).length
      : !Object.keys(value.expectedProviderFields).length) ||
    Object.keys(value.expectedProviderFields).some((key) => !providerField(key))
  )
    fail();
  if (
    value.provider === 'subsplash'
      ? value.account !== 'app:9XTSHD' ||
        !['media', 'audio', 'series', 'list', 'list-row', 'tag'].includes(value.resourceType)
      : value.provider !== 'soundcloud' ||
        value.resourceType !== 'track' ||
        !/^soundcloud:users:[0-9]+$/.test(value.account)
  )
    fail();
  ordered(value);
}
export function validateAcknowledgedProjectionOperation(value: unknown): value is AcknowledgedProjectionOperation {
  return (
    plain(value) &&
    Object.keys(value).length === 3 &&
    value.kind === 'acknowledged_projection' &&
    sha(value.sessionId) &&
    sha(value.projectionDigest)
  );
}
export interface AcknowledgedProjectionRoot {
  schemaVersion: 2;
  projectId: string;
  jobId: string;
  sessionId: string;
  operation: string;
  intentFingerprint: string;
  pageCount: number;
  requestCount: number;
  chainDigest: string;
  completesActivity: boolean;
  uiStepIds: string[];
}
const fragmentId = (index: number) => String(index).padStart(16, '0');
function validateRoot(value: unknown, ref: DurableJobRef, id: string): asserts value is AcknowledgedProjectionRoot {
  if (
    !plain(value) ||
    value.schemaVersion !== 2 ||
    value.projectId !== ref.projectId ||
    value.jobId !== ref.jobId ||
    value.sessionId !== id ||
    !sha(id) ||
    !sha(value.intentFingerprint) ||
    !sha(value.chainDigest) ||
    typeof value.operation !== 'string' ||
    !Number.isSafeInteger(value.pageCount) ||
    Number(value.pageCount) < 1 ||
    !Number.isSafeInteger(value.requestCount) ||
    Number(value.requestCount) < 1 ||
    typeof value.completesActivity !== 'boolean' ||
    !Array.isArray(value.uiStepIds) ||
    value.uiStepIds.length > 30
  )
    fail();
}
/** Small immutable ordered fragment descriptors; callers can scan a bounded window without loading the catalog. */
export async function readAcknowledgedProjectionFragments(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  sessionId: string,
  offset: number,
  limit = 32
): Promise<{
  root: AcknowledgedProjectionRoot;
  fragments: Array<{ index: number; digest: string; plan: FrozenAcknowledgedProjection }>;
  nextOffset: number;
}> {
  const root = (await tx.get(db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`))).data();
  validateRoot(root, ref, sessionId);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > root.pageCount ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 64
  )
    fail();
  const indices = Array.from({ length: Math.min(limit, root.pageCount - offset) }, (_, index) => offset + index);
  const descriptors = indices.length
    ? await tx.getAll(
        ...indices.map((index) =>
          db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}/fragments/${fragmentId(index)}`)
        )
      )
    : [];
  const fragments = await Promise.all(
    descriptors.map(async (descriptor, index) => {
      const digest = descriptor.get('digest');
      if (!sha(digest) || descriptor.get('index') !== indices[index]) fail();
      const value = (await tx.get(db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}/pages/${digest}`))).data();
      if (
        !plain(value) ||
        acknowledgedProjectionDigest(value) !== digest ||
        value.intentFingerprint !== root.intentFingerprint ||
        value.sessionId !== sessionId
      )
        fail();
      return { index: indices[index], digest, plan: value as unknown as FrozenAcknowledgedProjection };
    })
  );
  return { root, fragments, nextOffset: offset + fragments.length };
}
/** Exact first-RPC authorization is a bounded lookup, and requires the original source fragment to be sealed ready. */
export async function assertAcknowledgedProjectionRequestPrepared(
  tx: Transaction,
  session: ProviderMutationSession,
  request: {
    step: string;
    method: FrozenProjectionRequest['method'];
    target?: ProviderMutationResource;
    fingerprint: string;
  }
): Promise<void> {
  const root = (await tx.get(session.db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}`))).data();
  if (plain(root) && root.schemaVersion === 1) {
    validatePlan(root, session.scope, session.id);
    const planned = root.requests.find((value) => value.step === request.step);
    if (
      !planned ||
      planned.method !== request.method ||
      planned.fingerprint !== request.fingerprint ||
      (planned.target && providerMutationFingerprint(planned.target) !== providerMutationFingerprint(request.target))
    )
      fail();
    return;
  }
  validateRoot(root, session.scope, session.id);
  const index = await tx.get(
      session.db.doc(
        `${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}/requestIndex/${providerMutationFingerprint(request.step)}`
      )
    ),
    planned = index.get('request') as FrozenProjectionRequest;
  if (
    index.get('ready') !== true ||
    index.get('intentFingerprint') !== root.intentFingerprint ||
    !planned ||
    planned.step !== request.step ||
    planned.method !== request.method ||
    planned.fingerprint !== request.fingerprint ||
    (planned.target && providerMutationFingerprint(planned.target) !== providerMutationFingerprint(request.target)) ||
    !sha(index.get('pageDigest'))
  )
    fail();
  const page = (
    await tx.get(session.db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}/pages/${index.get('pageDigest')}`))
  ).data();
  if (
    !plain(page) ||
    acknowledgedProjectionDigest(page) !== index.get('pageDigest') ||
    !Array.isArray(page.requests) ||
    !page.requests.some((value) => acknowledgedProjectionDigest(value) === acknowledgedProjectionDigest(planned))
  )
    fail();
  const sealedDigest = index.get('readyPageDigest');
  if (!sha(sealedDigest)) fail();
  const sealed = (
    await tx.get(session.db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}/pages/${sealedDigest}`))
  ).data();
  if (
    !plain(sealed) ||
    sealed.finalFragment !== true ||
    acknowledgedProjectionDigest(sealed) !== sealedDigest ||
    !Array.isArray(sealed.requests) ||
    !sealed.requests.some((value) => acknowledgedProjectionDigest(value) === acknowledgedProjectionDigest(planned))
  )
    fail();
}
async function materializePlan(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  id: string,
  data: unknown
): Promise<FrozenAcknowledgedProjection> {
  if (plain(data) && data.schemaVersion === 1) {
    validatePlan(data, ref, id);
    return data;
  }
  validateRoot(data, ref, id);
  const pages: FrozenAcknowledgedProjection[] = [],
    digests: string[] = [];
  let chain = acknowledgedProjectionDigest([]);
  for (let offset = 0; offset < data.pageCount; ) {
    const window = await readAcknowledgedProjectionFragments(tx, db, ref, id, offset, 64);
    for (const fragment of window.fragments) {
      pages.push(fragment.plan);
      digests.push(fragment.digest);
      chain = acknowledgedProjectionDigest([chain, fragment.index, fragment.digest]);
    }
    offset = window.nextOffset;
  }
  if (chain !== data.chainDigest) fail();
  const requests = [
    ...new Map(pages.flatMap((page) => page.requests).map((request) => [request.step, request])).values(),
  ];
  if (requests.length !== data.requestCount) fail();
  const result: FrozenAcknowledgedProjection = {
    schemaVersion: 1,
    projectId: data.projectId,
    jobId: data.jobId,
    sessionId: id,
    operation: data.operation,
    intentFingerprint: data.intentFingerprint,
    requests,
    writes: pages.flatMap((page) => page.writes),
    verifications: pages.flatMap((page) => page.verifications),
    targetAuthorities: pages.flatMap((page) => page.targetAuthorities ?? []),
    pageDigests: digests,
    completesActivity: data.completesActivity,
    uiStepIds: data.uiStepIds,
  };
  for (const page of pages) validatePlan(page, ref, id, requests);
  return result;
}
interface ReplaySnapshots {
  intent: DocumentSnapshot;
  held: DocumentSnapshot;
  requests: Pick<QuerySnapshot, 'docs' | 'size'>;
  existing: DocumentSnapshot;
}
async function readSelectedClaims(
  tx: Transaction,
  session: ProviderMutationSession,
  steps: string[]
): Promise<Pick<QuerySnapshot, 'docs' | 'size'>> {
  const snapshots = steps.length
    ? await tx.getAll(
        ...[...new Set(steps)].map((step) =>
          session.db.doc(`${PROVIDER_MUTATION_SESSIONS}/${session.id}/requests/${providerMutationFingerprint(step)}`)
        )
      )
    : [];
  const docs = snapshots.filter((snapshot) => snapshot.exists) as FirebaseFirestore.QueryDocumentSnapshot[];
  return { docs, size: docs.length };
}
async function originalProgramReplay(
  tx: Transaction,
  session: ProviderMutationSession,
  input: { requests: FrozenProjectionRequest[] },
  snapshots: ReplaySnapshots
): Promise<{ projectionDigest: string; commit: () => void } | undefined> {
  const { intent, held, requests, existing } = snapshots,
    ref = session.scope;
  if (
    !intent.exists ||
    intent.get('projectId') !== ref.projectId ||
    intent.get('jobId') !== ref.jobId ||
    !['active', 'committed'].includes(held.get('state')) ||
    providerMutationFingerprint(held.get('scope')) !== providerMutationFingerprint(session.scope) ||
    providerMutationFingerprint(held.get('resources')) !== providerMutationFingerprint(session.resources)
  )
    fail();
  if (!existing.exists) return undefined;
  const stored = existing.data();
  let original: Pick<
    FrozenAcknowledgedProjection,
    'operation' | 'intentFingerprint' | 'requests' | 'targetAuthorities'
  >;
  if (plain(stored) && stored.schemaVersion === 2) {
    validateRoot(stored, ref, session.id);
    const planned: FrozenProjectionRequest[] = [],
      authorities: FrozenTargetAuthority[] = [];
    for (const request of input.requests) {
      const index = await tx.get(
        session.db.doc(
          `${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}/requestIndex/${providerMutationFingerprint(request.step)}`
        )
      );
      if (!index.exists) return undefined;
      const value = index.get('request') as FrozenProjectionRequest;
      if (!value || !sha(index.get('pageDigest'))) fail();
      const page = (
        await tx.get(session.db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}/pages/${index.get('pageDigest')}`))
      ).data();
      if (
        !plain(page) ||
        acknowledgedProjectionDigest(page) !== index.get('pageDigest') ||
        page.intentFingerprint !== stored.intentFingerprint ||
        !Array.isArray(page.requests) ||
        !page.requests.some((entry) => acknowledgedProjectionDigest(entry) === acknowledgedProjectionDigest(value))
      )
        fail();
      planned.push(value);
      authorities.push(...((page.targetAuthorities ?? []) as FrozenTargetAuthority[]));
    }
    original = {
      operation: stored.operation,
      intentFingerprint: stored.intentFingerprint,
      requests: planned,
      targetAuthorities: authorities,
    };
  } else original = await materializePlan(tx, session.db, ref, session.id, stored);
  if (
    original.operation !== session.scope.operation ||
    original.intentFingerprint !== acknowledgedProjectionDigest(intent.data())
  )
    fail();
  const selected: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  if (!input.requests.length) return undefined;
  for (const request of input.requests) {
    const planned = original.requests.find((value) => value.step === request.step),
      claimed = requests.docs.find((doc) => doc.get('step') === request.step);
    if (
      !planned ||
      !claimed ||
      planned.method !== request.method ||
      planned.fingerprint !== request.fingerprint ||
      (planned.target && providerMutationFingerprint(planned.target) !== providerMutationFingerprint(request.target)) ||
      claimed.get('state') !== 'acknowledged' ||
      claimed.get('method') !== request.method ||
      claimed.get('fingerprint') !== request.fingerprint
    )
      return undefined;
    if (
      request.target &&
      !session.resources.some(
        (resource) => providerMutationFingerprint(resource) === providerMutationFingerprint(request.target)
      ) &&
      !original.targetAuthorities?.some(
        (authority) =>
          providerMutationFingerprint(authority.target) === providerMutationFingerprint(request.target) &&
          sha(authority.proofHash) &&
          session.resources.some(
            (resource) => providerMutationFingerprint(resource) === providerMutationFingerprint(authority.rootResource)
          )
      )
    )
      fail();
    selected.push(claimed);
  }
  await validateProviderMutationOriginalCompletion(tx, session, selected);
  return { projectionDigest: acknowledgedProjectionDigest(existing.data()), commit: () => {} };
}
/** Read-only original-program replay; a caller's fresh projection is never substituted for the frozen program. */
export async function prepareOriginalAcknowledgedProjectionReplay(
  tx: Transaction,
  session: ProviderMutationSession,
  input: { requests: FrozenProjectionRequest[] }
): Promise<{ projectionDigest: string; commit: () => void } | undefined> {
  const [intent, held, requests, existing] = await Promise.all([
    tx.get(session.db.doc(`durableJobIntents/${session.scope.jobId}`)),
    tx.get(session.db.doc(`${PROVIDER_MUTATION_SESSIONS}/${session.id}`)),
    readSelectedClaims(
      tx,
      session,
      input.requests.map((request) => request.step)
    ),
    tx.get(session.db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}`)),
  ]);
  return originalProgramReplay(tx, session, input, { intent, held, requests, existing });
}
/** A later GET is never used to authenticate a previously acknowledged RPC, including a deleted descendant. */
export async function validateOriginalAcknowledgedMutation(
  tx: Transaction,
  session: ProviderMutationSession,
  request: {
    step: string;
    method: FrozenProjectionRequest['method'];
    fingerprint: string;
    target: ProviderMutationResource;
  }
): Promise<{ result: unknown } | undefined> {
  const replay = await prepareOriginalAcknowledgedProjectionReplay(tx, session, { requests: [request] });
  if (!replay) return undefined;
  const claimed = await tx.get(
    session.db.doc(`${PROVIDER_MUTATION_SESSIONS}/${session.id}/requests/${providerMutationFingerprint(request.step)}`)
  );
  return { result: claimed.get('result') };
}
function validatePlan(
  value: unknown,
  ref: DurableJobRef,
  id: string,
  knownRequests: FrozenProjectionRequest[] = []
): asserts value is FrozenAcknowledgedProjection {
  if (
    !plain(value) ||
    value.schemaVersion !== 1 ||
    value.projectId !== ref.projectId ||
    value.jobId !== ref.jobId ||
    value.sessionId !== id ||
    !sha(id) ||
    typeof value.operation !== 'string' ||
    !sha(value.intentFingerprint) ||
    !Array.isArray(value.requests) ||
    !value.requests.length ||
    value.requests.length > 450 ||
    !Array.isArray(value.writes) ||
    value.writes.length > 2000
  )
    fail();
  const record = value as Record<string, unknown>,
    requests = record.requests as FrozenProjectionRequest[],
    writes = record.writes as FrozenProjectionWrite[];
  const allRequests = [...new Map([...knownRequests, ...requests].map((request) => [request.step, request])).values()];
  if (
    record.uiStepIds !== undefined &&
    (!Array.isArray(record.uiStepIds) ||
      record.uiStepIds.length > 30 ||
      record.uiStepIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,150}$/.test(id)) ||
      new Set(record.uiStepIds).size !== record.uiStepIds.length)
  )
    fail();
  if (
    record.pageDigests !== undefined &&
    (!Array.isArray(record.pageDigests) ||
      record.pageDigests.length > 400 ||
      !record.pageDigests.every(sha) ||
      new Set(record.pageDigests).size !== record.pageDigests.length)
  )
    fail();
  if (
    (record.completesActivity !== undefined && typeof record.completesActivity !== 'boolean') ||
    (record.finalFragment !== undefined && typeof record.finalFragment !== 'boolean')
  )
    fail();
  if (
    record.targetAuthorities !== undefined &&
    (!Array.isArray(record.targetAuthorities) ||
      record.targetAuthorities.length > 450 ||
      record.targetAuthorities.some(
        (authority) =>
          !plain(authority) ||
          !['planned', 'list_row', 'created_overflow'].includes(String(authority.kind)) ||
          !sha(authority.proofHash) ||
          !plain(authority.target) ||
          !plain(authority.rootResource) ||
          !Array.isArray(authority.canonicalPaths) ||
          authority.canonicalPaths.some((value) => typeof value !== 'string' || !value || value.length > 1000) ||
          (authority.receiptId !== undefined && !sha(authority.receiptId))
      ))
  )
    fail();
  if (
    requests.some(
      (request) =>
        !plain(request) ||
        Object.keys(request).some((key) => !['step', 'method', 'fingerprint', 'target', 'payload'].includes(key)) ||
        typeof request.step !== 'string' ||
        !request.step ||
        !['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) ||
        !sha(request.fingerprint) ||
        (request.target !== undefined &&
          (!plain(request.target) ||
            Object.keys(request.target).sort().join(',') !== 'account,provider,resourceId,resourceType' ||
            !['subsplash', 'soundcloud'].includes(request.target.provider) ||
            Object.values(request.target).some(
              (value) => typeof value !== 'string' || !value || value.length > 1024 || /[\r\n]/.test(value)
            ))) ||
        (request.payload !== undefined &&
          (!request.target ||
            providerMutationFingerprint([request.method, { target: request.target, body: request.payload }]) !==
              request.fingerprint))
    ) ||
    new Set(requests.map((request) => request.step)).size !== requests.length
  )
    fail();
  if (!Array.isArray(record.verifications) || record.verifications.length > 400) fail();
  const verifications = record.verifications as FrozenProviderVerification[];
  for (const projection of [...writes, ...verifications])
    if (
      projection.requiredSteps !== undefined &&
      (!Array.isArray(projection.requiredSteps) ||
        !projection.requiredSteps.length ||
        new Set(projection.requiredSteps).size !== projection.requiredSteps.length ||
        projection.requiredSteps.some((step) => !allRequests.some((request) => request.step === step)))
    )
      fail();
  for (const write of writes)
    if (
      write.requiredAnySteps !== undefined &&
      (!Array.isArray(write.requiredAnySteps) ||
        !write.requiredAnySteps.length ||
        new Set(write.requiredAnySteps).size !== write.requiredAnySteps.length ||
        write.requiredAnySteps.some((step) => !allRequests.some((request) => request.step === step)))
    )
      fail();
  for (const write of writes)
    for (const binding of write.listRowBindings ?? [])
      if (
        !allRequests.some((request) => request.step === binding.requestStep && request.method === 'PATCH') ||
        !(write.requiredSteps ?? allRequests.map((request) => request.step)).includes(binding.requestStep) ||
        !verifications.some(
          (verification) =>
            verification.provider === 'subsplash' &&
            verification.resourceType === 'list' &&
            verification.resourceId === binding.listId &&
            (verification.requiredSteps ?? allRequests.map((request) => request.step)).includes(binding.requestStep)
        )
      )
        fail();
  for (const write of writes)
    for (const binding of write.listRowBindings ?? []) {
      const request = allRequests.find((value) => value.step === binding.requestStep)!;
      if (
        request.target?.provider !== 'subsplash' ||
        request.target.account !== 'app:9XTSHD' ||
        request.target.resourceType !== 'list' ||
        request.target.resourceId !== binding.listId ||
        !plain(request.payload) ||
        request.payload.id !== binding.listId ||
        !plain(request.payload._embedded) ||
        !Array.isArray(request.payload._embedded['list-rows'])
      )
        fail();
      const payload = request.payload as Record<string, unknown>,
        rows = (payload._embedded as Record<string, unknown>)['list-rows'] as unknown[];
      if (
        rows.filter(
          (value) =>
            plain(value) &&
            value.type === 'media-item' &&
            plain(value._embedded) &&
            plain(value._embedded['media-item']) &&
            value._embedded['media-item'].id === binding.mediaId
        ).length !== 1
      )
        fail();
    }
  verifications.forEach(validateVerification);
  writes.forEach(validateWrite);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 700_000) fail();
}
/** Append an immutable server-derived page BEFORE its step's first claim; never reconstruct from a later GET. */
export async function prepareAcknowledgedProjectionPlan(
  tx: Transaction,
  session: ProviderMutationSession,
  input: {
    requests: FrozenProjectionRequest[];
    writes: FrozenProjectionWrite[];
    verifications: FrozenProviderVerification[];
    uiStepIds?: string[];
    completesActivity?: boolean;
    finalFragment?: boolean;
  },
  options: { targetProofs?: readonly PublishingMutationTargetProof[] } = {}
): Promise<{ projectionDigest: string; commit: () => void }> {
  if (isCriticalPublishingRepair()) fail();
  const { db } = session,
    ref = { projectId: session.scope.projectId, jobId: session.scope.jobId };
  const [intent, held, requests, existing] = await Promise.all([
    tx.get(db.doc(`durableJobIntents/${ref.jobId}`)),
    tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${session.id}`)),
    readSelectedClaims(
      tx,
      session,
      input.requests.map((request) => request.step)
    ),
    tx.get(db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}`)),
  ]);
  if (
    !intent.exists ||
    intent.get('projectId') !== ref.projectId ||
    intent.get('jobId') !== ref.jobId ||
    !['active', 'committed'].includes(held.get('state')) ||
    providerMutationFingerprint(held.get('scope')) !== providerMutationFingerprint(session.scope) ||
    providerMutationFingerprint(held.get('resources')) !== providerMutationFingerprint(session.resources)
  )
    fail();
  const replay = await originalProgramReplay(tx, session, input, { intent, held, requests, existing });
  if (replay) return replay;
  if (held.get('state') !== 'active' || held.get('effectsClosed') === true) fail();
  const unsettled = await tx.get(
    db
      .doc(`${PROVIDER_MUTATION_SESSIONS}/${session.id}`)
      .collection('requests')
      .where('state', 'in', ['sending', 'unknown', 'acknowledged_unprojectable'])
      .limit(1)
  );
  if (unsettled.size) fail();
  const targets = [
    ...input.verifications.map((verification) => ({
      provider: verification.provider,
      account: verification.account,
      resourceType: verification.resourceType,
      resourceId: verification.resourceId,
    })),
    ...input.requests.flatMap((request) => (request.target ? [request.target] : [])),
  ];
  const authorities: FrozenTargetAuthority[] = [];
  for (const target of new Map(targets.map((value) => [providerMutationFingerprint(value), value])).values()) {
    if (
      session.resources.some(
        (resource) => providerMutationFingerprint(resource) === providerMutationFingerprint(target)
      )
    )
      continue;
    const proof = options.targetProofs?.find(
      (value) =>
        providerMutationFingerprint(value.target) === providerMutationFingerprint(target) &&
        session.resources.some(
          (resource) => providerMutationFingerprint(resource) === providerMutationFingerprint(value.rootResource)
        )
    );
    if (!proof) fail();
    await assertPublishingMutationTargetProofForSession(tx, proof, session);
    authorities.push({
      kind: proof.kind,
      target: { ...proof.target },
      rootResource: { ...proof.rootResource },
      proofHash: proof.proofHash,
      canonicalPaths: [...proof.canonicalPaths],
      ...(proof.receiptId ? { receiptId: proof.receiptId } : {}),
    });
  }
  const steps = input.requests.map((request) => request.step).sort();
  const page: FrozenAcknowledgedProjection = {
    schemaVersion: 1,
    ...ref,
    sessionId: session.id,
    operation: session.scope.operation,
    intentFingerprint: acknowledgedProjectionDigest(intent.data()),
    requests: input.requests.map((request) => ({ ...request })).sort((a, b) => a.step.localeCompare(b.step)),
    writes: input.writes
      .map((write) => ({
        ...write,
        ...(write.requiredAnySteps ? {} : { requiredSteps: write.requiredSteps ?? steps }),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    verifications: input.verifications.map((value) => ({ ...value, requiredSteps: value.requiredSteps ?? steps })),
    completesActivity: input.completesActivity ?? true,
    finalFragment: input.finalFragment ?? true,
    targetAuthorities: authorities,
    ...(input.uiStepIds ? { uiStepIds: [...input.uiStepIds].sort() } : {}),
  };
  const previous = existing.data();
  let old: AcknowledgedProjectionRoot | undefined;
  if (existing.exists) {
    validateRoot(previous, ref, session.id);
    old = previous;
    if (old.intentFingerprint !== page.intentFingerprint) fail();
  }
  const prerequisiteSteps = [
    ...new Set([
      ...page.requests.map((request) => request.step),
      ...page.writes.flatMap((write) => [
        ...(write.requiredSteps ?? []),
        ...(write.requiredAnySteps ?? []),
        ...(write.listRowBindings ?? []).map((binding) => binding.requestStep),
      ]),
      ...page.verifications.flatMap((value) => value.requiredSteps ?? []),
    ]),
  ];
  const indices = await tx.getAll(
    ...prerequisiteSteps.map((step) =>
      db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}/requestIndex/${providerMutationFingerprint(step)}`)
    )
  );
  for (const snapshot of indices)
    if (snapshot.exists && snapshot.get('intentFingerprint') !== page.intentFingerprint) fail();
  const known = indices.flatMap((snapshot) =>
    snapshot.exists ? [snapshot.get('request') as FrozenProjectionRequest] : []
  );
  validatePlan(page, ref, session.id, known);
  const pageDigest = acknowledgedProjectionDigest(page),
    pageRef = db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}/pages/${pageDigest}`),
    oldPage = await tx.get(pageRef);
  const newRequests = page.requests.filter((request) => !known.some((prior) => prior.step === request.step));
  for (const request of page.requests) {
    const prior = known.find((value) => value.step === request.step);
    if (prior && acknowledgedProjectionDigest(prior) !== acknowledgedProjectionDigest(request)) fail();
  }
  if (
    requests.docs.some(
      (doc) => steps.includes(doc.get('step')) || !['acknowledged', 'rejected_no_effect'].includes(doc.get('state'))
    )
  )
    fail();
  if (oldPage.exists && acknowledgedProjectionDigest(oldPage.data()) !== pageDigest) fail();
  const index = old?.pageCount ?? 0,
    append = !oldPage.exists;
  const record: AcknowledgedProjectionRoot = {
    schemaVersion: 2,
    ...ref,
    sessionId: session.id,
    operation: session.scope.operation,
    intentFingerprint: page.intentFingerprint,
    pageCount: index + (append ? 1 : 0),
    requestCount: (old?.requestCount ?? 0) + newRequests.length,
    chainDigest: append
      ? acknowledgedProjectionDigest([old?.chainDigest ?? acknowledgedProjectionDigest([]), index, pageDigest])
      : old!.chainDigest,
    uiStepIds: [...new Set([...(old?.uiStepIds ?? []), ...(input.uiStepIds ?? [])])].sort(),
    completesActivity: input.completesActivity ?? true,
  };
  const projectionDigest = acknowledgedProjectionDigest(record);
  return {
    projectionDigest,
    commit: () => {
      if (append) {
        tx.create(pageRef, page);
        tx.create(db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}/fragments/${fragmentId(index)}`), {
          index,
          digest: pageDigest,
        });
      }
      for (const request of page.requests) {
        const snapshot = indices[prerequisiteSteps.indexOf(request.step)],
          previous = snapshot.exists ? snapshot.data() : undefined;
        tx.set(
          db.doc(
            `${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}/requestIndex/${providerMutationFingerprint(request.step)}`
          ),
          {
            ...previous,
            request,
            intentFingerprint: page.intentFingerprint,
            pageDigest: previous?.pageDigest ?? pageDigest,
            ready: input.finalFragment !== false,
            readyPageDigest: input.finalFragment !== false ? pageDigest : null,
          }
        );
      }
      tx.set(db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}`), record);
    },
  };
}
/** Only the original desired final-commit adapter may invoke this, under its original actor and SDK epoch fence. */
export async function prepareAcknowledgedProjectionSeal(
  tx: Transaction,
  session: ProviderMutationSession
): Promise<{ commit: () => void }> {
  if (isCriticalPublishingRepair()) fail();
  const target = session.db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}`),
    snapshot = await tx.get(target),
    stored = snapshot.data();
  const intent = await tx.get(session.db.doc(`durableJobIntents/${session.scope.jobId}`));
  if (!intent.exists) fail();
  const actual = await tx.get(session.db.doc(`${PROVIDER_MUTATION_SESSIONS}/${session.id}`).collection('requests'));
  let expected: Map<string, { method: string; fingerprint: string }>;
  let completesActivity: boolean | undefined;
  if (plain(stored) && stored.schemaVersion === 2) {
    validateRoot(stored, session.scope, session.id);
    if (
      stored.intentFingerprint !== acknowledgedProjectionDigest(intent.data()) ||
      stored.operation !== session.scope.operation
    )
      fail();
    // Only bounded request descriptors are needed to seal the original desired commit, never canonical mirror bodies.
    const indices = await tx.get(
      target
        .collection('requestIndex')
        .select('request.step', 'request.method', 'request.fingerprint', 'ready', 'intentFingerprint')
    );
    if (
      indices.size !== stored.requestCount ||
      indices.docs.some(
        (index) => index.get('ready') !== true || index.get('intentFingerprint') !== stored.intentFingerprint
      )
    )
      fail();
    expected = new Map(
      indices.docs.map((index) => [
        index.get('request.step') as string,
        { method: index.get('request.method') as string, fingerprint: index.get('request.fingerprint') as string },
      ])
    );
    if (expected.size !== stored.requestCount) fail();
    completesActivity = stored.completesActivity;
  } else {
    const plan = await materializePlan(tx, session.db, session.scope, session.id, stored);
    if (plan.intentFingerprint !== acknowledgedProjectionDigest(intent.data())) fail();
    expected = new Map(plan.requests.map((request) => [request.step, request]));
    completesActivity = plan.completesActivity;
  }
  if (
    !actual.size ||
    actual.size !== expected.size ||
    actual.docs.some((doc) => {
      const match = expected.get(doc.get('step'));
      return (
        !match ||
        doc.get('state') !== 'acknowledged' ||
        doc.get('method') !== match.method ||
        doc.get('fingerprint') !== match.fingerprint
      );
    })
  )
    fail();
  await prepareProviderMutationSessionCommit(tx, session);
  return {
    commit: () => {
      if (completesActivity === false) tx.update(target, { completesActivity: true });
    },
  };
}
const CANDIDATES = 'temporalPublishingAcknowledgedRepairCandidates';
const validatedProgramSeals = new WeakSet<object>();
const candidatePending = (): never => {
  throw Object.assign(new Error('Original repair evidence is still being compiled'), {
    code: 'PUBLISHING_CRITICAL_ACK_CANDIDATE_PENDING',
  });
};
async function readReadyCandidate(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  sessionId: string,
  expectedDigest?: string,
  allowCommittedCompletionSeal = false
) {
  const source = await tx.get(db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`));
  let sourceRoot = source.data();
  validateRoot(sourceRoot, ref, sessionId);
  let digest = acknowledgedProjectionDigest(sourceRoot),
    restoredCompletion = false;
  if (expectedDigest !== undefined && digest !== expectedDigest) {
    const restored = { ...sourceRoot, completesActivity: false };
    if (
      !allowCommittedCompletionSeal ||
      sourceRoot.completesActivity !== true ||
      acknowledgedProjectionDigest(restored) !== expectedDigest
    )
      fail();
    sourceRoot = restored;
    digest = expectedDigest;
    restoredCompletion = true;
  }
  const candidateId = acknowledgedProjectionDigest([ref.projectId, ref.jobId, sessionId, digest]),
    candidateRef = db.doc(`${CANDIDATES}/${candidateId}`);
  const [candidate, intent, job, held] = await Promise.all([
    tx.get(candidateRef),
    tx.get(db.doc(`durableJobIntents/${ref.jobId}`)),
    tx.get(db.doc(`durableJobs/${ref.jobId}`)),
    tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)),
  ]);
  if (restoredCompletion && held.get('state') !== 'committed') fail();
  const root = candidate.data() as AcknowledgedRepairCandidateRoot | undefined;
  if (!root || root.phase !== 'ready') return candidatePending();
  if (
    root.schemaVersion !== 1 ||
    root.projectId !== ref.projectId ||
    root.jobId !== ref.jobId ||
    root.sessionId !== sessionId ||
    root.sourceRootDigest !== digest ||
    root.intentFingerprint !== sourceRoot.intentFingerprint ||
    root.intentFingerprint !== acknowledgedProjectionDigest(intent.data()) ||
    root.generation !== job.get('generation') ||
    root.generation !== intent.get('generation') ||
    acknowledgedProjectionDigest(root.entity) !== acknowledgedProjectionDigest(intent.get('entity')) ||
    acknowledgedProjectionDigest(root.entity) !== acknowledgedProjectionDigest(job.get('entity')) ||
    root.sourceChainDigest !== sourceRoot.chainDigest ||
    root.sourcePageCount !== sourceRoot.pageCount ||
    root.sourceRequestCount !== sourceRoot.requestCount ||
    root.sessionScopeDigest !==
      acknowledgedProjectionDigest({ scope: held.get('scope'), resources: held.get('resources') }) ||
    !['active', 'committed'].includes(held.get('state'))
  )
    fail();
  const count = (
    await tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`).collection('requests').count())
  ).data().count;
  if (count !== root.originalRequestCount) fail();
  const session: ProviderMutationSession = {
    db,
    id: sessionId,
    scope: held.get('scope'),
    resources: held.get('resources'),
  };
  return {
    root,
    candidateId,
    candidateRef,
    intentKind: intent.get('kind') as string,
    candidateDigest: acknowledgedProjectionDigest(root),
    digest,
    sourceRoot,
    held,
    session,
  };
}
/** Bounded fixed-read descriptors for certificate construction and source membership checks. */
export async function readAcknowledgedRepairVerifications(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  operation: AcknowledgedProjectionOperation,
  cursor?: string
): Promise<{
  verifications: FrozenProviderVerification[];
  nextCursor?: string;
  candidateId: string;
  candidateDigest: string;
}> {
  const proof = await readReadyCandidate(tx, db, ref, operation.sessionId, operation.projectionDigest);
  let query = proof.candidateRef.collection('verifications').orderBy(FieldPath.documentId()).limit(32);
  if (cursor) {
    if (!sha(cursor)) fail();
    query = query.startAfter(cursor);
  }
  const page = await tx.get(query);
  const verifications = page.docs.map((doc) => {
    const record = doc.data() as CandidateVerificationProgram;
    validateVerification(record.verification);
    if (
      doc.id !== record.resourceKey ||
      record.compiledDigest !== acknowledgedProjectionDigest(record.verification) ||
      record.resourceKey !==
        providerMutationFingerprint([
          record.verification.provider,
          record.verification.account,
          record.verification.resourceType,
          record.verification.resourceId,
        ])
    )
      fail();
    return record.verification;
  });
  return {
    verifications,
    ...(page.size === 32 ? { nextCursor: page.docs[page.docs.length - 1].id } : {}),
    candidateId: proof.candidateId,
    candidateDigest: proof.candidateDigest,
  };
}
export async function validateAcknowledgedRepairProviderRead(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  operation: AcknowledgedProjectionOperation,
  fixedRead: {
    provider: 'subsplash' | 'soundcloud';
    resourceType: string;
    resourceId: string;
    accountId: string;
    method: 'GET';
  }
): Promise<void> {
  if (fixedRead.method !== 'GET' || !validateAcknowledgedProjectionOperation(operation)) fail();
  const proof = await readReadyCandidate(tx, db, ref, operation.sessionId, operation.projectionDigest);
  const key = providerMutationFingerprint([
      fixedRead.provider,
      fixedRead.accountId,
      fixedRead.resourceType,
      fixedRead.resourceId,
    ]),
    snapshot = await tx.get(proof.candidateRef.collection('verifications').doc(key));
  if (!snapshot.exists) {
    if (
      proof.intentKind !== 'sermon.delete' ||
      !plain(proof.root.entity) ||
      proof.root.entity.type !== 'sermon' ||
      typeof proof.root.entity.id !== 'string' ||
      proof.root.rootTargetComplete !== true ||
      fixedRead.provider !== 'subsplash' ||
      fixedRead.accountId !== 'app:9XTSHD' ||
      (fixedRead.resourceType !== 'list' && fixedRead.resourceType !== 'series') ||
      !sha(proof.root.rootTargetSourceProgramDigest) ||
      proof.root.rootTargetSourceCount !== proof.root.sourceRequestCount
    )
      fail();
    await assertSermonDeletionCountReadInTransaction(tx, db, {
      ref,
      sermonId: proof.root.entity.id,
      sessionId: operation.sessionId,
      sourceRootDigest: operation.projectionDigest,
      resourceType: fixedRead.resourceType,
      resourceId: fixedRead.resourceId,
      account: 'app:9XTSHD',
    });
    return;
  }
  const record = snapshot.data() as CandidateVerificationProgram;
  if (record.resourceKey !== key || record.compiledDigest !== acknowledgedProjectionDigest(record.verification)) fail();
  validateVerification(record.verification);
  if (
    record.verification.provider !== fixedRead.provider ||
    record.verification.account !== fixedRead.accountId ||
    record.verification.resourceType !== fixedRead.resourceType ||
    record.verification.resourceId !== fixedRead.resourceId
  )
    fail();
}
export async function validateAcknowledgedRepairCandidateEvidence(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  evidence: { path: string; digest: string }
): Promise<void> {
  const match = evidence.path.match(new RegExp(`^${CANDIDATES}/([a-f0-9]{64})$`));
  if (!match || !sha(evidence.digest)) fail();
  const snapshot = await tx.get(db.doc(evidence.path));
  if (!snapshot.exists || acknowledgedProjectionDigest(snapshot.data()) !== evidence.digest) fail();
  const proof = await readReadyCandidate(tx, db, ref, snapshot.get('sessionId'), snapshot.get('sourceRootDigest'));
  if (proof.candidateId !== match[1] || proof.candidateDigest !== evidence.digest) fail();
}
async function readProof(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  sessionId: string,
  expectedDigest?: string
) {
  const target = db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`),
    snapshot = await tx.get(target);
  if (snapshot.get('schemaVersion') === 2) return fail();
  const plan = await materializePlan(tx, db, ref, sessionId, snapshot.data());
  const digest = acknowledgedProjectionDigest(snapshot.data());
  if (expectedDigest !== undefined && expectedDigest !== digest) fail();
  const [intent, held, requests] = await Promise.all([
    tx.get(db.doc(`durableJobIntents/${ref.jobId}`)),
    tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`)),
    tx.get(db.doc(`${PROVIDER_MUTATION_SESSIONS}/${sessionId}`).collection('requests')),
  ]);
  if (
    !intent.exists ||
    acknowledgedProjectionDigest(intent.data()) !== plan.intentFingerprint ||
    held.get('scope.projectId') !== ref.projectId ||
    held.get('scope.jobId') !== ref.jobId ||
    held.get('scope.operation') !== plan.operation
  )
    fail();
  const expected = new Map(plan.requests.map((request) => [request.step, request]));
  if (
    !requests.size ||
    requests.docs.some((doc) => {
      const match = expected.get(doc.get('step'));
      return (
        !match ||
        doc.get('method') !== match.method ||
        doc.get('fingerprint') !== match.fingerprint ||
        !['acknowledged', 'rejected_no_effect'].includes(doc.get('state'))
      );
    })
  )
    fail();
  const session: ProviderMutationSession = {
    db,
    id: sessionId,
    scope: held.get('scope'),
    resources: held.get('resources'),
  };
  if (held.get('state') === 'committed') await validateProviderMutationOriginalCompletion(tx, session, requests.docs);
  const settle = await prepareProviderMutationSessionCommit(tx, session);
  const positive = requests.docs.filter((doc) => doc.get('state') === 'acknowledged');
  if (!positive.length) fail();
  const acknowledged = new Set(positive.map((doc) => doc.get('step') as string));
  const eligible = (projection: { requiredSteps?: string[]; requiredAnySteps?: string[] }) =>
    (
      projection.requiredSteps ?? (projection.requiredAnySteps ? [] : plan.requests.map((request) => request.step))
    ).every((step) => acknowledged.has(step)) &&
    (!projection.requiredAnySteps || projection.requiredAnySteps.some((step) => acknowledged.has(step)));
  const verifications = reduceVerificationPrograms(plan.verifications.filter(eligible));
  const programs = reduceCanonicalPrograms(plan.writes.filter(eligible)),
    writes = programs.map((program) => program.write),
    baselines = new Map(programs.map((program) => [program.write.path, program.baselines]));
  return {
    plan,
    digest,
    settle,
    writes,
    baselines,
    verifications,
    partialStop: requests.size < expected.size || positive.length !== requests.size || plan.completesActivity === false,
    acknowledgements: new Map(positive.map((doc) => [doc.get('step') as string, doc.get('result') as unknown])),
    acknowledgementFingerprint: providerMutationFingerprint(
      requests.docs
        .map((doc) => ({
          step: doc.get('step'),
          claim: doc.get('claim'),
          executionId: doc.get('executionId'),
          fingerprint: doc.get('fingerprint'),
        }))
        .sort((a, b) => a.step.localeCompare(b.step))
    ),
  };
}
function flattened(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const visit = (item: unknown, key: string) => {
    if (plain(item) && Object.keys(item).length) {
      for (const [child, entry] of Object.entries(item)) visit(entry, `${key}.${child}`);
    } else result[key] = item;
  };
  for (const [key, item] of Object.entries(value)) visit(item, key);
  return result;
}
/** Page order is original preclaim execution order. A later field replaces only that field's earlier truth. */
export function reduceVerificationPrograms(values: FrozenProviderVerification[]): FrozenProviderVerification[] {
  const programs = new Map<string, FrozenProviderVerification>();
  for (const value of values) {
    const key = providerMutationFingerprint([value.provider, value.account, value.resourceType, value.resourceId]),
      prior = programs.get(key);
    programs.set(key, {
      ...value,
      expectedProviderFields:
        value.expectedState === 'absent'
          ? {}
          : {
              ...(prior?.expectedState !== 'absent' ? prior?.expectedProviderFields : {}),
              ...flattened(value.expectedProviderFields),
            },
    });
  }
  return [...programs.values()];
}
function overlayUpdates(
  patch: Record<string, unknown>,
  deleted: Set<string>,
  next: Record<string, unknown>,
  remove: readonly string[]
): void {
  for (const [key, value] of Object.entries(next)) {
    const deletedParent = [...deleted].find((parent) => key.startsWith(`${parent}.`));
    if (deletedParent) {
      deleted.delete(deletedParent);
      patch[deletedParent] = {};
    }
    for (const previous of Object.keys(patch))
      if (previous === key || previous.startsWith(`${key}.`)) delete patch[previous];
    for (const previous of [...deleted])
      if (previous === key || previous.startsWith(`${key}.`)) deleted.delete(previous);
    const parent = Object.keys(patch).find((previous) => key.startsWith(`${previous}.`));
    if (parent) {
      if (!plain(patch[parent])) patch[parent] = {};
      const nested = { ...(patch[parent] as Record<string, unknown>) };
      put(nested, key.slice(parent.length + 1), value);
      patch[parent] = nested;
    } else patch[key] = value;
  }
  for (const key of remove) {
    for (const previous of Object.keys(patch))
      if (previous === key || previous.startsWith(`${key}.`)) delete patch[previous];
    const parent = Object.keys(patch).find((previous) => key.startsWith(`${previous}.`));
    if (parent && plain(patch[parent])) {
      const nested = { ...patch[parent] };
      put(nested, key.slice(parent.length + 1), undefined, true);
      patch[parent] = nested;
    } else deleted.add(key);
  }
}
export function reduceCanonicalPrograms(
  values: FrozenProjectionWrite[]
): Array<{ write: FrozenProjectionWrite; baselines: FrozenProjectionWrite[] }> {
  const programs = new Map<string, { write: FrozenProjectionWrite; baselines: FrozenProjectionWrite[] }>();
  for (const value of values) {
    const prior = programs.get(value.path);
    if (!prior) {
      programs.set(value.path, {
        write: { ...value, patch: { ...value.patch }, deleteFields: [...(value.deleteFields ?? [])] },
        baselines: [value],
      });
      continue;
    }
    const baselines = [...prior.baselines, value];
    if (value.mode === 'set' || value.mode === 'delete') {
      programs.set(value.path, { write: { ...value, patch: { ...value.patch } }, baselines });
      continue;
    }
    if (prior.write.mode === 'delete') fail();
    const patch = { ...prior.write.patch },
      deleted = new Set(prior.write.deleteFields ?? []);
    if (prior.write.mode === 'set') {
      for (const [key, item] of Object.entries(value.patch)) put(patch, key, item);
      for (const key of value.deleteFields ?? []) put(patch, key, undefined, true);
      deleted.clear();
    } else overlayUpdates(patch, deleted, value.patch, value.deleteFields ?? []);
    const bindings = new Map((prior.write.listRowBindings ?? []).map((binding) => [binding.field, binding]));
    for (const key of [...Object.keys(value.patch), ...(value.deleteFields ?? [])])
      for (const previous of [...bindings.keys()])
        if (previous === key || previous.startsWith(`${key}.`)) bindings.delete(previous);
    for (const binding of value.listRowBindings ?? []) bindings.set(binding.field, binding);
    programs.set(value.path, {
      write: {
        ...value,
        mode: prior.write.mode === 'set' ? 'set' : value.mode,
        patch,
        deleteFields: [...deleted],
        listRowBindings: [...bindings.values()],
      },
      baselines,
    });
  }
  return [...programs.values()];
}
export async function prepareAcknowledgedRepair(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  sessionId: string,
  options: { verificationCursor?: string } = {}
): Promise<{
  operation: AcknowledgedProjectionOperation;
  sourceEvidence: Array<{ path: string; digest: string }>;
  verifications: FrozenProviderVerification[];
  partialStop: boolean;
  nextVerificationCursor?: string;
  candidateId?: string;
  candidateDigest?: string;
}> {
  const source = await tx.get(db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`));
  if (source.get('schemaVersion') === 2) {
    const proof = await readReadyCandidate(tx, db, ref, sessionId);
    if (!proof.root.acknowledgedRequestCount) fail();
    const operation: AcknowledgedProjectionOperation = {
      kind: 'acknowledged_projection',
      sessionId,
      projectionDigest: proof.digest,
    };
    const page = await readAcknowledgedRepairVerifications(tx, db, ref, operation, options.verificationCursor);
    return {
      operation,
      sourceEvidence: [
        { path: `${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`, digest: proof.digest },
        { path: proof.candidateRef.path, digest: proof.candidateDigest },
      ],
      verifications: page.verifications,
      partialStop: proof.root.partialStop === true,
      ...(page.nextCursor ? { nextVerificationCursor: page.nextCursor } : {}),
      candidateId: proof.candidateId,
      candidateDigest: proof.candidateDigest,
    };
  }
  const proof = await readProof(tx, db, ref, sessionId);
  const sourceEvidence = [{ path: `${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`, digest: proof.digest }];
  for (const evidence of sourceEvidence) await validateAcknowledgedProjectionEvidence(tx, db, ref, evidence);
  return {
    operation: { kind: 'acknowledged_projection', sessionId, projectionDigest: proof.digest },
    sourceEvidence,
    verifications: proof.verifications,
    partialStop: proof.partialStop,
  };
}
/** Certificate loaders call this inside the same fresh authority transaction. Original facts are checked again at execution. */
export async function validateAcknowledgedProjectionEvidence(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  evidence: { path: string; digest: string }
): Promise<void> {
  if (evidence.path.startsWith(`${CANDIDATES}/`))
    return validateAcknowledgedRepairCandidateEvidence(tx, db, ref, evidence);
  const match = evidence.path.match(
    new RegExp(`^${ACKNOWLEDGED_PROJECTION_PLANS}/([a-f0-9]{64})(?:/pages/([a-f0-9]{64}))?$`)
  );
  if (!match || !sha(evidence.digest) || (match[2] !== undefined && match[2] !== evidence.digest)) fail();
  const id = match![1];
  const snapshot = await tx.get(db.doc(evidence.path)),
    plan = snapshot.data();
  if (!match[2] && plain(plan) && plan.schemaVersion === 2) {
    validateRoot(plan, ref, id);
    if (acknowledgedProjectionDigest(plan) !== evidence.digest) fail();
    return;
  }
  let knownRequests: FrozenProjectionRequest[] = [];
  if (match[2]) {
    const manifest = await tx.get(db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${id}`)),
      root = await materializePlan(tx, db, ref, id, manifest.data());
    if (!root.pageDigests?.includes(evidence.digest)) fail();
    knownRequests = root.requests;
  }
  validatePlan(plan, ref, id, knownRequests);
  if (acknowledgedProjectionDigest(plan) !== evidence.digest) fail();
}
/** The caller supplies fresh admin/certificate/SDK epoch fencing and indexed writes. Canonical projection and lock release are atomic. */
function subset(expected: unknown, actual: unknown, key = ''): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    const remaining = [...actual];
    for (const item of expected) {
      const index = remaining.findIndex((candidate) => subset(item, candidate, key));
      if (index < 0) return false;
      remaining.splice(index, 1);
    }
    return true;
  }
  if (plain(expected))
    return plain(actual) && Object.entries(expected).every(([child, value]) => subset(value, actual[child], child));
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (
    ['published_at', 'created_at', 'updated_at', 'date', 'starts_at', 'ends_at'].includes(key.split('.').pop()!) &&
    typeof expected === 'string' &&
    typeof actual === 'string' &&
    iso.test(expected) &&
    iso.test(actual)
  )
    return Number.isFinite(Date.parse(expected)) && Date.parse(expected) === Date.parse(actual);
  return actual !== undefined && acknowledgedProjectionDigest(expected) === acknowledgedProjectionDigest(actual);
}
/** Exact certified fixed reads must still match the original request subset. They never prove an unknown request completed. */
export function verifyAcknowledgedProviderObservations(
  verifications: FrozenProviderVerification[],
  observations: AcknowledgedProviderObservation[]
): void {
  for (const verification of verifications) {
    const observed = observations.find(
      (value) =>
        value.provider === verification.provider &&
        value.account === verification.account &&
        value.resourceType === verification.resourceType &&
        value.resourceId === verification.resourceId
    );
    if (!observed || observed.state !== (verification.expectedState ?? 'present')) fail();
    if (
      verification.expectedState !== 'absent' &&
      (!observed?.body ||
        !Object.entries(verification.expectedProviderFields).every(([key, value]) =>
          subset(
            value,
            key
              .split('.')
              .reduce<unknown>((current, part) => (plain(current) ? current[part] : undefined), observed.body),
            key
          )
        ))
    )
      fail();
  }
}
function rowId(body: unknown, binding: FrozenListRowBinding): string {
  if (!plain(body) || !plain(body._embedded) || !Array.isArray(body._embedded['list-rows'])) fail();
  const record = body as Record<string, unknown>,
    rows = (record._embedded as Record<string, unknown>)['list-rows'] as unknown[];
  const matches = rows.filter(
    (value) =>
      plain(value) &&
      value.type === 'media-item' &&
      plain(value._embedded) &&
      plain(value._embedded['media-item']) &&
      value._embedded['media-item'].id === binding.mediaId
  );
  if (matches.length !== 1 || !plain(matches[0])) fail();
  const row = matches[0] as Record<string, unknown>,
    embedded = row._embedded as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    !row.id ||
    /[\s/?#]/.test(row.id) ||
    (row.app_key !== undefined && row.app_key !== '9XTSHD') ||
    (embedded['source-list'] !== undefined &&
      (!plain(embedded['source-list']) || embedded['source-list'].id !== binding.listId))
  )
    fail();
  return row.id as string;
}
function put(data: Record<string, unknown>, key: string, value: unknown, remove = false): void {
  const keys = key.split('.');
  let cursor = data;
  for (const part of keys.slice(0, -1)) {
    cursor[part] = plain(cursor[part]) ? { ...cursor[part] } : {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  if (remove) delete cursor[keys[keys.length - 1]];
  else cursor[keys[keys.length - 1]] = value;
}
function bindListRowId(
  patch: Record<string, unknown>,
  binding: FrozenListRowBinding,
  value: string,
  mode: FrozenProjectionWrite['mode']
): void {
  if (mode === 'set') {
    put(patch, binding.field, value);
    return;
  }
  const [parent, child] = binding.field.split('.');
  if (child && Object.hasOwn(patch, parent)) {
    const existing = patch[parent];
    if (!plain(existing) || (existing[child] !== undefined && existing[child] !== value)) fail();
    // An update cannot contain both a map and a descendant field path. Preserve
    // the frozen map and bind the confirmed row inside a copy of that map.
    put(patch, binding.field, value);
  } else patch[binding.field] = value;
}
export interface AcknowledgedRepairExecutionOptions {
  /** Trusted admin certificate + current SDK execution witness; never callable payload. */ observationScope?: string;
  validateSourceCompletion?: (
    tx: Transaction,
    seal?: ProviderMutationClosedEvidenceSeal
  ) => Promise<void | ProviderMutationReadyCanonicalCompletion>;
}
/** The next slice needs only this bounded verifier page. Every stored page is scoped
 * to the same source-injected certificate and SDK execution as its final CAS. */
export async function readAcknowledgedRepairRequiredVerifications(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  operation: AcknowledgedProjectionOperation,
  options: AcknowledgedRepairExecutionOptions = {}
): Promise<{
  verifications: FrozenProviderVerification[];
  nextCursor?: string;
  candidateId: string;
  candidateDigest: string;
}> {
  const proof = await readReadyCandidate(tx, db, ref, operation.sessionId, operation.projectionDigest),
    progress = await tx.get(db.doc(`${ACKNOWLEDGED_PROJECTION_PROGRESS}/${operation.sessionId}`));
  let orderQuery = proof.candidateRef.collection('programOrder').orderBy(FieldPath.documentId()).limit(1);
  if (progress.get('programCursor')) orderQuery = orderQuery.startAfter(progress.get('programCursor'));
  const order = await tx.get(orderQuery);
  if (order.empty) return { verifications: [], candidateId: proof.candidateId, candidateDigest: proof.candidateDigest };
  const programRef = proof.candidateRef.collection('programs').doc(order.docs[0].get('programId'));
  const cursor =
    progress.exists &&
    progress.get('candidateDigest') === proof.candidateDigest &&
    progress.get('observationScope') === options.observationScope
      ? progress.get('verificationCursor')
      : undefined;
  let query = programRef.collection('dependencies').orderBy(FieldPath.documentId()).limit(32);
  if (typeof cursor === 'string') query = query.startAfter(cursor);
  const page = await tx.get(query);
  const verifications: FrozenProviderVerification[] = [];
  for (const dependency of page.docs) {
    const target = dependency.get('target') as ProviderMutationResource;
    if (
      dependency.get('digest') !== acknowledgedProjectionDigest(target) ||
      dependency.id !== dependency.get('verifierKey')
    )
      fail();
    let verifier = await tx.get(proof.candidateRef.collection('verifications').doc(dependency.id));
    if (!verifier.exists) {
      const authority = await tx.get(
        proof.candidateRef.collection('targetAuthorities').doc(providerMutationFingerprint(target))
      );
      const parent = authority.get('authority.rootResource') as ProviderMutationResource;
      if (!parent || authority.get('digest') !== acknowledgedProjectionDigest(authority.get('authority'))) fail();
      verifier = await tx.get(
        proof.candidateRef
          .collection('verifications')
          .doc(providerMutationFingerprint([parent.provider, parent.account, parent.resourceType, parent.resourceId]))
      );
    }
    const record = verifier.data() as CandidateVerificationProgram;
    if (!verifier.exists || record.compiledDigest !== acknowledgedProjectionDigest(record.verification)) fail();
    validateVerification(record.verification);
    if (
      !verifications.some(
        (value) => acknowledgedProjectionDigest(value) === acknowledgedProjectionDigest(record.verification)
      )
    )
      verifications.push(record.verification);
  }
  return {
    verifications,
    ...(page.size === 32 ? { nextCursor: page.docs[page.docs.length - 1].id } : {}),
    candidateId: proof.candidateId,
    candidateDigest: proof.candidateDigest,
  };
}

export async function assertReadyAcknowledgedRepairCanonicalCompletion(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  session: ProviderMutationSession,
  seal: { claimSetDigest: string; claimSetDigestVersion?: 2; actualRequestCount: number }
): Promise<{
  closedClaimSetDigest: string;
  originalRequestCount: number;
  immutableCatalogDigest: string;
  canonicalCompletionDigest: string;
  expectedCanonicalPageCount: number;
  completedCanonicalPageCount: number;
}> {
  const proof = await readReadyCandidate(tx, db, ref, session.id),
    progress = await tx.get(db.doc(`${ACKNOWLEDGED_PROJECTION_PROGRESS}/${session.id}`));
  const closedClaimSetDigest = proof.root.terminalClaimSetDigest;
  if (
    !closedClaimSetDigest ||
    closedClaimSetDigest !== seal.claimSetDigest ||
    seal.claimSetDigestVersion !== 2 ||
    proof.held.get('effectsClosedClaimSetDigestVersion') !== 2 ||
    proof.held.get('effectsClosedClaimSetDigest') !== closedClaimSetDigest ||
    proof.held.get('effectsClosedActualRequestCount') !== seal.actualRequestCount ||
    proof.root.originalRequestCount !== seal.actualRequestCount ||
    progress.get('candidateId') !== proof.candidateId ||
    progress.get('candidateDigest') !== proof.candidateDigest ||
    progress.get('projectionDigest') !== proof.digest ||
    progress.get('programIndex') !== proof.root.programCount ||
    progress.get('claimsVerified') !== true ||
    progress.get('claimCount') !== proof.root.originalRequestCount ||
    progress.get('claimEvidenceDigest') !== proof.root.requestEvidenceDigest ||
    typeof progress.get('observationScope') !== 'string'
  )
    return fail();
  return {
    closedClaimSetDigest,
    originalRequestCount: proof.root.originalRequestCount,
    immutableCatalogDigest: proof.root.sourceRootDigest,
    canonicalCompletionDigest: acknowledgedProjectionDigest(progress.data()),
    expectedCanonicalPageCount: proof.root.programCount,
    completedCanonicalPageCount: progress.get('programIndex'),
  };
}
export async function assertAcknowledgedRepairCandidateVerificationSeal(
  tx: Transaction,
  db: Firestore,
  input: {
    ref: DurableJobRef;
    sessionId: string;
    candidateId: string;
    candidateDigest: string;
    projectionDigest: string;
    observationScope: string;
    requiredTargets?: ProviderMutationResource[];
    sourceProgramExpectation?: { sourceProgramDigest: string; sourceRequestCount: number };
    currentSeal?: Record<string, unknown>;
    requireCurrentProgram?: boolean;
    programId?: string;
    programSealDigest?: string;
    requireAllAbsent?: boolean;
  }
): Promise<{
  programId: string;
  programSealDigest: string;
  seal: Record<string, unknown>;
  terminalClaimSetDigest: string;
  originalRequestCount: number;
}> {
  const operation: AcknowledgedProjectionOperation = {
      kind: 'acknowledged_projection',
      sessionId: input.sessionId,
      projectionDigest: input.projectionDigest,
    },
    proof = await readReadyCandidate(
      tx,
      db,
      input.ref,
      input.sessionId,
      input.projectionDigest,
      input.requireCurrentProgram === false
    );
  if (
    proof.candidateId !== input.candidateId ||
    proof.candidateDigest !== input.candidateDigest ||
    !input.observationScope
  )
    fail();
  const progress = await tx.get(db.doc(`${ACKNOWLEDGED_PROJECTION_PROGRESS}/${input.sessionId}`));
  let programId = input.programId;
  if (input.requireCurrentProgram !== false) {
    let orderQuery = proof.candidateRef.collection('programOrder').orderBy(FieldPath.documentId()).limit(1);
    if (progress.get('programCursor')) orderQuery = orderQuery.startAfter(progress.get('programCursor'));
    const order = await tx.get(orderQuery);
    if (order.empty) fail();
    const selected = order.docs[0].get('programId');
    if (programId && programId !== selected) fail();
    programId = selected;
  }
  if (!sha(programId)) fail();
  const program = await tx.get(proof.candidateRef.collection('programs').doc(programId));
  if (
    !program.exists ||
    program.get('compiledDigest') !== acknowledgedProjectionDigest([program.get('write'), program.get('orderKey')])
  )
    fail();
  if (input.currentSeal && !validatedProgramSeals.has(input.currentSeal)) fail();
  const stored =
    input.currentSeal ??
    (
      await tx.get(
        db.doc(
          `${ACKNOWLEDGED_PROJECTION_PROGRESS}/${input.sessionId}/programSeals/${providerMutationFingerprint([
            input.observationScope,
            programId,
          ])}`
        )
      )
    ).data();
  let targetSetDigest = acknowledgedProjectionDigest([]);
  const targets = (input.requiredTargets ?? [])
    .map((target) => ({
      key: providerMutationFingerprint([target.provider, target.account, target.resourceType, target.resourceId]),
      digest: acknowledgedProjectionDigest(target),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const target of targets)
    targetSetDigest = acknowledgedProjectionDigest([targetSetDigest, target.key, target.digest]);
  if (
    !stored ||
    stored.schemaVersion !== 1 ||
    stored.projectId !== input.ref.projectId ||
    stored.jobId !== input.ref.jobId ||
    stored.candidateId !== proof.candidateId ||
    stored.candidateDigest !== proof.candidateDigest ||
    stored.sourceRootDigest !== operation.projectionDigest ||
    stored.observationScope !== input.observationScope ||
    stored.programId !== programId ||
    stored.canonicalPath !== program.get('canonicalPath') ||
    (input.requiredTargets !== undefined &&
      (stored.targetCount !== targets.length || stored.targetSetDigest !== targetSetDigest)) ||
    stored.allOriginalACK !== true ||
    stored.allExpectedProviderStateVerified !== true ||
    stored.targetCount !== program.get('dependencyCount')
  )
    fail();
  if (input.sourceProgramExpectation) {
    const expected = input.sourceProgramExpectation;
    if (
      !sha(expected.sourceProgramDigest) ||
      !Number.isSafeInteger(expected.sourceRequestCount) ||
      expected.sourceRequestCount < 1 ||
      proof.root.rootTargetProgramId !== programId ||
      proof.root.rootTargetComplete !== true ||
      proof.root.rootTargetSourceProgramDigest !== expected.sourceProgramDigest ||
      proof.root.rootTargetSourceCount !== expected.sourceRequestCount ||
      proof.root.originalRequestCount !== expected.sourceRequestCount ||
      proof.root.acknowledgedRequestCount !== expected.sourceRequestCount ||
      proof.root.rejectedRequestCount !== 0 ||
      stored.sourceProgramDigest !== expected.sourceProgramDigest ||
      stored.sourceRequestCount !== expected.sourceRequestCount ||
      stored.rootTargetComplete !== true ||
      !sha(stored.targetSetDigest) ||
      stored.targetSetDigest !== program.get('dependencyCatalogueDigest') ||
      stored.targetSetDigest !== proof.root.rootDependencyCatalogueDigest
    )
      fail();
  } else if (input.requiredTargets === undefined) fail();
  if (input.requireAllAbsent && stored.allFixedAbsent !== true) fail();
  const programSealDigest = acknowledgedProjectionDigest(stored);
  if (input.programSealDigest !== undefined && input.programSealDigest !== programSealDigest) fail();
  if (
    !sha(proof.root.terminalClaimSetDigest) ||
    !Number.isSafeInteger(proof.root.originalRequestCount) ||
    proof.root.originalRequestCount < 1
  )
    fail();
  return {
    programId,
    programSealDigest,
    seal: stored,
    terminalClaimSetDigest: proof.root.terminalClaimSetDigest,
    originalRequestCount: proof.root.originalRequestCount,
  };
}
async function commitReadyCandidate(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  operation: AcknowledgedProjectionOperation,
  observations: AcknowledgedProviderObservation[],
  options: AcknowledgedRepairExecutionOptions
) {
  const proof = await readReadyCandidate(tx, db, ref, operation.sessionId, operation.projectionDigest);
  if (!proof.root.acknowledgedRequestCount) fail();
  const progressRef = db.doc(`${ACKNOWLEDGED_PROJECTION_PROGRESS}/${operation.sessionId}`),
    stored = await tx.get(progressRef);
  let progress: Record<string, any> = stored.exists ? stored.data()! : { programIndex: 0 };
  if (
    stored.exists &&
    (progress.candidateId !== proof.candidateId ||
      progress.candidateDigest !== proof.candidateDigest ||
      progress.projectionDigest !== operation.projectionDigest)
  )
    fail();
  const sameScope = !!options.observationScope && progress.observationScope === options.observationScope;
  if (!sameScope)
    progress = {
      programIndex: progress.programIndex ?? 0,
      ...(progress.programCursor ? { programCursor: progress.programCursor } : {}),
      ...(proof.held.get('effectsClosedClaimSetDigestVersion') === 2 &&
      proof.held.get('effectsClosedClaimSetDigest') === proof.root.terminalClaimSetDigest &&
      progress.claimsVerified
        ? { claimsVerified: true, claimCount: progress.claimCount, claimEvidenceDigest: progress.claimEvidenceDigest }
        : {}),
      phase: 'verify',
    };
  const scope = options.observationScope;
  if (scope !== undefined && (typeof scope !== 'string' || !scope || scope.length > 1024)) fail();
  const pending = async (next: Record<string, unknown>) => {
    if (!scope)
      throw Object.assign(
        new Error('Paged repair observations require current certificate and SDK execution authority'),
        { code: 'PUBLISHING_CRITICAL_ACK_EXECUTION_SCOPE_REQUIRED' }
      );
    const pageId = providerMutationFingerprint([
      scope,
      progress.programIndex,
      'observations',
      progress.verificationCursor ?? 'start',
    ]);
    const records = verifications.verifications.map((verification) => {
      const observed = observations.find(
        (value) =>
          value.provider === verification.provider &&
          value.account === verification.account &&
          value.resourceType === verification.resourceType &&
          value.resourceId === verification.resourceId
      );
      if (!observed) fail();
      const key = providerMutationFingerprint([
        scope,
        progress.programIndex,
        verification.provider,
        verification.account,
        verification.resourceType,
        verification.resourceId,
      ]);
      const body = {
        candidateDigest: proof.candidateDigest,
        sourceRootDigest: operation.projectionDigest,
        observationScope: scope,
        programIndex: progress.programIndex,
        verificationDigest: acknowledgedProjectionDigest(verification),
        observationDigest: acknowledgedProjectionDigest(observed),
        observedState: observed.state,
      };
      return { key, body, digest: acknowledgedProjectionDigest(body) };
    });
    const pageRef = progressRef.collection('observationPages').doc(pageId),
      marker = {
        candidateDigest: proof.candidateDigest,
        sourceRootDigest: operation.projectionDigest,
        observationScope: scope,
        programIndex: progress.programIndex,
        entries: records.map((record) => ({ key: record.key, digest: record.digest })),
      };
    const prior = await tx.get(pageRef);
    if (prior.exists && acknowledgedProjectionDigest(prior.data()) !== acknowledgedProjectionDigest(marker)) fail();
    const receipts = records.length
      ? await tx.getAll(...records.map((record) => progressRef.collection('observations').doc(record.key)))
      : [];
    records.forEach((record, index) => {
      if (receipts[index].exists) {
        const saved = receipts[index].data()!;
        const { pageId: _page, proofDigest: _digest, ...body } = saved;
        if (acknowledgedProjectionDigest(body) !== record.digest || saved.proofDigest !== record.digest) fail();
      } else tx.create(receipts[index].ref, { ...record.body, pageId, proofDigest: record.digest });
    });
    if (!prior.exists) tx.create(pageRef, marker);
    tx.set(
      progressRef,
      Object.fromEntries(
        Object.entries({
          schemaVersion: 2,
          ...ref,
          candidateId: proof.candidateId,
          candidateDigest: proof.candidateDigest,
          projectionDigest: operation.projectionDigest,
          observationScope: scope,
          ...progress,
          ...next,
          updatedAtMillis: Date.now(),
        }).filter(([, value]) => value !== undefined)
      )
    );
    return {
      alreadyCommitted: false,
      writesCompleted: 0,
      needsContinuation: true as const,
      ...(proof.root.partialStop ? { partialStop: true as const } : {}),
    };
  };
  let orderQuery = proof.candidateRef.collection('programOrder').orderBy(FieldPath.documentId()).limit(1);
  if (progress.programCursor) orderQuery = orderQuery.startAfter(progress.programCursor);
  const order = await tx.get(orderQuery);
  if (
    !Number.isSafeInteger(progress.programIndex) ||
    progress.programIndex < 0 ||
    progress.programIndex > proof.root.programCount ||
    (order.empty && progress.programIndex !== proof.root.programCount)
  )
    fail();
  // A page of current fixed reads is validated before source claim and baseline checks.
  const verifications = await readAcknowledgedRepairRequiredVerifications(tx, db, ref, operation, options);
  verifyAcknowledgedProviderObservations(verifications.verifications, observations);
  if (verifications.nextCursor) return pending({ verificationCursor: verifications.nextCursor, phase: 'verify' });
  // Original terminal claims/facts are immutable, but their exact digests are reread
  // in bounded pages under the same execution scope before any canonical projection.
  const committedReplay = proof.held.get('state') === 'committed',
    replayContinuation = committedReplay && progress.phase === 'idempotent_claims';
  let evidenceQuery = proof.candidateRef.collection('requestEvidence').orderBy(FieldPath.documentId()).limit(32);
  const evidenceCursor = committedReplay
    ? replayContinuation
      ? progress.idempotentEvidenceCursor
      : undefined
    : progress.evidenceCursor;
  if (evidenceCursor) evidenceQuery = evidenceQuery.startAfter(evidenceCursor);
  const evidence = !committedReplay && progress.claimsVerified ? { docs: [], size: 0 } : await tx.get(evidenceQuery);
  const acknowledgements = new Map<string, unknown>(),
    requests: FrozenProjectionRequest[] = [];
  let claimCount = committedReplay
      ? replayContinuation
        ? progress.idempotentClaimCount ?? 0
        : 0
      : progress.claimCount ?? 0,
    claimEvidenceDigest = committedReplay
      ? replayContinuation
        ? progress.idempotentClaimEvidenceDigest ?? acknowledgedProjectionDigest([])
        : acknowledgedProjectionDigest([])
      : progress.claimEvidenceDigest ?? acknowledgedProjectionDigest([]);
  for (const recordDoc of evidence.docs) {
    const record = recordDoc.data() as CandidateRequestEvidence;
    if (recordDoc.id !== providerMutationFingerprint(record.step)) fail();
    const [request, fact, planned] = await Promise.all([
      tx.get(db.doc(record.sourceRequestPath)),
      tx.get(db.doc(record.factPath)),
      tx.get(db.doc(record.plannedRequestPath)),
    ]);
    if (
      record.sourceRequestPath !== `${PROVIDER_MUTATION_SESSIONS}/${operation.sessionId}/requests/${recordDoc.id}` ||
      record.plannedRequestPath !==
        `${ACKNOWLEDGED_PROJECTION_PLANS}/${operation.sessionId}/requestIndex/${recordDoc.id}` ||
      acknowledgedProjectionDigest(request.data()) !== record.sourceRequestDigest ||
      acknowledgedProjectionDigest(fact.data()) !== record.factDigest ||
      acknowledgedProjectionDigest(planned.get('request')) !== record.plannedRequestDigest ||
      planned.get('pageDigest') !== record.plannedPageDigest
    )
      fail();
    await validateProviderMutationOriginalCompletion(tx, proof.session, [
      request as FirebaseFirestore.QueryDocumentSnapshot,
    ]);
    claimCount++;
    claimEvidenceDigest = acknowledgedProjectionDigest([
      claimEvidenceDigest,
      recordDoc.id,
      record.sourceRequestDigest,
      record.factDigest,
      record.plannedRequestDigest,
    ]);
    if (record.state === 'acknowledged') {
      acknowledgements.set(record.step, request.get('result'));
      requests.push(planned.get('request'));
    }
  }
  if (evidence.size === 32)
    return pending(
      committedReplay
        ? {
            idempotentClaimCount: claimCount,
            idempotentClaimEvidenceDigest: claimEvidenceDigest,
            idempotentEvidenceCursor: evidence.docs[evidence.docs.length - 1].id,
            phase: 'idempotent_claims',
            verificationCursor: progress.verificationCursor ?? null,
          }
        : {
            claimCount,
            claimEvidenceDigest,
            evidenceCursor: evidence.docs[evidence.docs.length - 1].id,
            phase: 'claims',
            verificationCursor: progress.verificationCursor ?? null,
          }
    );
  if (claimCount !== proof.root.originalRequestCount || claimEvidenceDigest !== proof.root.requestEvidenceDigest)
    fail();
  // A restarted repair Activity may arrive after the last canonical page. There
  // are no remaining provider verifications to persist its new observation scope,
  // but the bounded original-claim pass above still authorizes this execution.
  progress = { ...progress, observationScope: scope, claimsVerified: true, claimCount, claimEvidenceDigest };
  if (order.empty) {
    if (['list.delete', 'sermon.delete'].includes(proof.intentKind)) {
      if (!options.validateSourceCompletion)
        return {
          alreadyCommitted: false,
          writesCompleted: 0,
          needsSourceCompletion: true as const,
          ...(proof.root.partialStop ? { partialStop: true as const } : {}),
        };
      const entity = proof.root.entity as { id: string };
      if (proof.intentKind === 'sermon.delete') {
        const source = await tx.get(
          db.collection(SERMON_DELETION_MIRROR_PLANS).doc(sermonDeletionMirrorPlanId(ref, entity.id))
        );
        if (source.get('state') !== 'completed')
          return {
            alreadyCommitted: false,
            writesCompleted: 0,
            needsSourceCompletion: true as const,
            ...(proof.root.partialStop ? { partialStop: true as const } : {}),
          };
      } else {
        const source = await tx.get(
          db
            .collection('temporalListDeletionMirrorPlans')
            .where('jobId', '==', ref.jobId)
            .where('entity.id', '==', entity.id)
            .limit(2)
        );
        if (source.size !== 1) fail();
        if (!source.docs[0].get('completion'))
          return {
            alreadyCommitted: false,
            writesCompleted: 0,
            needsSourceCompletion: true as const,
            ...(proof.root.partialStop ? { partialStop: true as const } : {}),
          };
      }
    }
    if (!['list.delete', 'sermon.delete'].includes(proof.intentKind) && proof.held.get('effectsClosed') !== true) {
      const terminalClaimSetDigest = proof.root.terminalClaimSetDigest;
      if (
        !scope ||
        progress.observationScope !== scope ||
        progress.programIndex !== proof.root.programCount ||
        (proof.root.originalRequestCount !== proof.root.sourceRequestCount &&
          (proof.root.partialStop !== true ||
            proof.root.destructiveRequestCount !== 0 ||
            proof.root.hasDestructiveCanonicalWrites !== false)) ||
        !sha(terminalClaimSetDigest) ||
        progress.claimCount !== proof.root.originalRequestCount ||
        progress.claimEvidenceDigest !== proof.root.requestEvidenceDigest
      )
        fail();
      const closure = await prepareProviderMutationEffectsClosedFromReadyEvidence(tx, proof.session, async () => ({
        sourceProgramDigest: proof.digest,
        expectedRequestCount: proof.root.sourceRequestCount,
        actualRequestCount: proof.root.originalRequestCount,
        claimSetDigest: terminalClaimSetDigest,
        claimSetDigestVersion: 2,
      }));
      closure.commit();
      return {
        alreadyCommitted: false,
        writesCompleted: 0,
        needsContinuation: true as const,
        ...(proof.root.partialStop ? { partialStop: true as const } : {}),
      };
    }
    const settlement = await prepareProviderMutationSessionCommitFromClosedEvidence(
      tx,
      proof.session,
      async (transaction, session, seal) => {
        const ready = await assertReadyAcknowledgedRepairCanonicalCompletion(transaction, db, ref, session, seal),
          source = await options.validateSourceCompletion?.(transaction, seal);
        if (!source) return ready;
        if (
          source.closedClaimSetDigest !== ready.closedClaimSetDigest ||
          source.originalRequestCount !== ready.originalRequestCount ||
          !sha(source.immutableCatalogDigest) ||
          !sha(source.canonicalCompletionDigest) ||
          !Number.isSafeInteger(source.expectedCanonicalPageCount) ||
          source.expectedCanonicalPageCount < 0 ||
          source.completedCanonicalPageCount !== source.expectedCanonicalPageCount
        )
          fail();
        return {
          ...ready,
          immutableCatalogDigest: acknowledgedProjectionDigest([
            ready.immutableCatalogDigest,
            source.immutableCatalogDigest,
          ]),
          canonicalCompletionDigest: acknowledgedProjectionDigest([
            ready.canonicalCompletionDigest,
            source.canonicalCompletionDigest,
          ]),
          expectedCanonicalPageCount: ready.expectedCanonicalPageCount + source.expectedCanonicalPageCount,
          completedCanonicalPageCount: ready.completedCanonicalPageCount + source.completedCanonicalPageCount,
        };
      }
    );
    const factualNonDestructiveStop =
      proof.root.partialStop === true &&
      proof.root.destructiveRequestCount === 0 &&
      proof.root.hasDestructiveCanonicalWrites === false;
    if (settlement.alreadyCommitted) {
      if (stored.get('phase') === 'idempotent_claims') tx.update(progressRef, { phase: 'settled' });
      return {
        alreadyCommitted: true,
        writesCompleted: 0,
        ...(factualNonDestructiveStop ? { factualNonDestructiveStop: true as const } : {}),
        ...(proof.root.partialStop ? { partialStop: true as const } : { settledUiStepIds: proof.root.uiStepIds }),
      };
    }
    settlement.commit();
    return {
      alreadyCommitted: false,
      writesCompleted: 0,
      ...(factualNonDestructiveStop ? { factualNonDestructiveStop: true as const } : {}),
      ...(proof.root.partialStop ? { partialStop: true as const } : { settledUiStepIds: proof.root.uiStepIds }),
    };
  }
  const ordered = order.docs[0],
    programId = ordered.get('programId'),
    programRef = proof.candidateRef.collection('programs').doc(programId);
  const programDoc = await tx.get(programRef),
    program = programDoc.data() as CandidateCanonicalProgram;
  if (
    !program ||
    ordered.id !== program.orderKey ||
    ordered.get('canonicalPath') !== program.canonicalPath ||
    programId !== providerMutationFingerprint(program.canonicalPath) ||
    program.compiledDigest !== acknowledgedProjectionDigest([program.write, program.orderKey]) ||
    !Number.isSafeInteger(program.baselineCount) ||
    program.baselineCount < 1
  )
    fail();
  if (program.dependencyCount > 32 && !scope) fail();
  let dependencyQuery = programRef.collection('dependencies').orderBy(FieldPath.documentId()).limit(32);
  if (progress.dependencyValidationCursor)
    dependencyQuery = dependencyQuery.startAfter(progress.dependencyValidationCursor);
  const dependencyPage = await tx.get(dependencyQuery);
  let targetCount = progress.targetCount ?? 0,
    targetSetDigest = progress.targetSetDigest ?? acknowledgedProjectionDigest([]),
    allFixedAbsent = progress.allFixedAbsent ?? true;
  for (const dependency of dependencyPage.docs) {
    const target = dependency.get('target') as ProviderMutationResource;
    if (dependency.get('digest') !== acknowledgedProjectionDigest(target)) fail();
    const evidenceDoc = await tx.get(
        proof.candidateRef.collection('requestEvidence').doc(providerMutationFingerprint(dependency.get('requestStep')))
      ),
      record = evidenceDoc.data() as CandidateRequestEvidence;
    if (!record || record.state !== 'acknowledged') fail();
    const request = await tx.get(db.doc(record.sourceRequestPath)),
      fact = await tx.get(db.doc(record.factPath));
    if (
      acknowledgedProjectionDigest(request.data()) !== record.sourceRequestDigest ||
      acknowledgedProjectionDigest(fact.data()) !== record.factDigest
    )
      fail();
    await validateProviderMutationOriginalCompletion(tx, proof.session, [
      request as FirebaseFirestore.QueryDocumentSnapshot,
    ]);
    let verifier = await tx.get(proof.candidateRef.collection('verifications').doc(dependency.id));
    if (!verifier.exists) {
      const authority = await tx.get(
        proof.candidateRef.collection('targetAuthorities').doc(providerMutationFingerprint(target))
      );
      const parent = authority.get('authority.rootResource') as ProviderMutationResource;
      if (!parent) fail();
      verifier = await tx.get(
        proof.candidateRef
          .collection('verifications')
          .doc(providerMutationFingerprint([parent.provider, parent.account, parent.resourceType, parent.resourceId]))
      );
    }
    const verification = verifier.get('verification') as FrozenProviderVerification;
    if (!verification || verifier.get('compiledDigest') !== acknowledgedProjectionDigest(verification)) fail();
    const current = observations.find(
      (value) =>
        value.provider === verification.provider &&
        value.account === verification.account &&
        value.resourceType === verification.resourceType &&
        value.resourceId === verification.resourceId
    );
    let observationDigest: string;
    if (current) {
      verifyAcknowledgedProviderObservations([verification], [current]);
      observationDigest = acknowledgedProjectionDigest(current);
    } else {
      if (!scope) fail();
      const key = providerMutationFingerprint([
          scope,
          progress.programIndex,
          verification.provider,
          verification.account,
          verification.resourceType,
          verification.resourceId,
        ]),
        receipt = await tx.get(progressRef.collection('observations').doc(key));
      if (
        receipt.get('candidateDigest') !== proof.candidateDigest ||
        receipt.get('sourceRootDigest') !== operation.projectionDigest ||
        receipt.get('observationScope') !== scope ||
        receipt.get('programIndex') !== progress.programIndex ||
        receipt.get('verificationDigest') !== acknowledgedProjectionDigest(verification) ||
        receipt.get('observedState') !== (verification.expectedState ?? 'present') ||
        !sha(receipt.get('observationDigest'))
      )
        fail();
      const saved = receipt.data()!;
      const { pageId, proofDigest, ...body } = saved;
      const page = await tx.get(progressRef.collection('observationPages').doc(pageId));
      if (
        proofDigest !== acknowledgedProjectionDigest(body) ||
        !page.exists ||
        !Array.isArray(page.get('entries')) ||
        !page
          .get('entries')
          .some((entry: { key: string; digest: string }) => entry.key === key && entry.digest === proofDigest) ||
        page.get('observationScope') !== scope ||
        page.get('candidateDigest') !== proof.candidateDigest ||
        page.get('sourceRootDigest') !== operation.projectionDigest
      )
        fail();
      observationDigest = receipt.get('observationDigest');
    }
    targetCount++;
    targetSetDigest = acknowledgedProjectionDigest([
      targetSetDigest,
      dependency.id,
      acknowledgedProjectionDigest(target),
    ]);
    allFixedAbsent &&= verification.expectedState === 'absent';
    if (!sha(observationDigest)) fail();
  }
  if (dependencyPage.size === 32)
    return pending({
      dependencyValidationCursor: dependencyPage.docs[dependencyPage.docs.length - 1].id,
      targetCount,
      targetSetDigest,
      allFixedAbsent,
      phase: 'target_seal',
      verificationCursor: progress.verificationCursor ?? null,
      evidenceCursor: progress.evidenceCursor ?? null,
    });
  if (targetCount !== program.dependencyCount) fail();
  const programSeal = {
    schemaVersion: 1,
    ...ref,
    candidateId: proof.candidateId,
    candidateDigest: proof.candidateDigest,
    sourceRootDigest: operation.projectionDigest,
    ...(scope ? { observationScope: scope } : {}),
    programId,
    canonicalPath: program.canonicalPath,
    targetCount,
    targetSetDigest,
    allOriginalACK: true,
    allExpectedProviderStateVerified: true,
    allFixedAbsent,
    ...(proof.root.rootTargetProgramId === programId
      ? {
          sourceProgramDigest: proof.root.rootTargetSourceProgramDigest,
          sourceRequestCount: proof.root.rootTargetSourceCount,
          rootTargetComplete: proof.root.rootTargetComplete,
        }
      : {}),
  };
  validatedProgramSeals.add(programSeal);
  const write = program.write;
  validateWrite(write);
  const snapshot = await tx.get(db.doc(write.path)),
    patch = { ...write.patch };
  // Binding ACKs may be outside the last global evidence window. Fetch only this
  // program's original exact row-assignment facts; never an ancestor claim.
  for (const binding of write.listRowBindings ?? []) {
    const evidenceDoc = await tx.get(
        proof.candidateRef.collection('requestEvidence').doc(providerMutationFingerprint(binding.requestStep))
      ),
      record = evidenceDoc.data() as CandidateRequestEvidence;
    if (!record || record.state !== 'acknowledged') fail();
    const request = await tx.get(db.doc(record.sourceRequestPath));
    if (acknowledgedProjectionDigest(request.data()) !== record.sourceRequestDigest) fail();
    await validateProviderMutationOriginalCompletion(tx, proof.session, [
      request as FirebaseFirestore.QueryDocumentSnapshot,
    ]);
    const response = request.get('result'),
      original =
        plain(response) && plain(response._embedded) && response._embedded['list-rows'] !== undefined
          ? rowId(response, binding)
          : undefined;
    const observed = observations.find(
      (value) =>
        value.provider === 'subsplash' &&
        value.account === 'app:9XTSHD' &&
        value.resourceType === 'list' &&
        value.resourceId === binding.listId
    );
    if (!observed || observed.state !== 'present') fail();
    const current = rowId(observed.body, binding);
    if (original !== undefined && original !== current) fail();
    bindListRowId(patch, binding, current, write.mode);
  }
  const snapshotDigest = acknowledgedProjectionDigest({
    exists: snapshot.exists,
    ...(snapshot.exists ? { data: snapshot.data() } : {}),
  });
  if (progress.baselineSnapshotDigest && progress.baselineSnapshotDigest !== snapshotDigest) {
    progress = {
      ...progress,
      baselineCursor: undefined,
      baselineSeen: 0,
      baselineMatches: false,
      immutableIdentity: true,
    };
  }
  let baselinesQuery = programRef.collection('baselines').orderBy(FieldPath.documentId()).limit(64);
  if (progress.baselineCursor) baselinesQuery = baselinesQuery.startAfter(progress.baselineCursor);
  const baselines = await tx.get(baselinesQuery);
  let baselineMatches = progress.baselineMatches === true,
    immutableIdentity = progress.immutableIdentity !== false,
    baselineSeen = progress.baselineSeen ?? 0;
  const equal = (key: string, value: unknown) =>
    snapshot.get(key) !== undefined &&
    acknowledgedProjectionDigest(snapshot.get(key)) === acknowledgedProjectionDigest(value);
  const changed = (key: string) =>
    write.mode === 'delete' ||
    [...Object.keys(patch), ...(write.deleteFields ?? [])].some(
      (target) => target === key || target.startsWith(`${key}.`) || key.startsWith(`${target}.`)
    );
  for (const baselineDoc of baselines.docs) {
    const baseline = baselineDoc.get('write') as FrozenProjectionWrite;
    validateWrite(baseline);
    if (baseline.path !== write.path || baselineDoc.get('digest') !== acknowledgedProjectionDigest(baseline)) fail();
    baselineSeen++;
    baselineMatches ||=
      snapshot.exists === (baseline.expectedExists ?? true) &&
      (baseline.expectedDocumentDigest === undefined ||
        (snapshot.exists && acknowledgedProjectionDigest(snapshot.data()) === baseline.expectedDocumentDigest)) &&
      Object.entries(baseline.expectedFields).every(([key, value]) => equal(key, value)) &&
      !baseline.absentFields?.some((key) => snapshot.get(key) !== undefined);
    immutableIdentity &&= Object.entries(baseline.expectedFields)
      .filter(([key]) => !changed(key))
      .every(([key, value]) => equal(key, value));
  }
  if (baselines.size === 64)
    return pending({
      baselineCursor: baselines.docs[baselines.docs.length - 1].id,
      baselineSeen,
      baselineMatches,
      immutableIdentity,
      baselineSnapshotDigest: snapshotDigest,
      phase: 'baselines',
      verificationCursor: progress.verificationCursor ?? null,
      evidenceCursor: progress.evidenceCursor ?? null,
    });
  if (baselineSeen !== program.baselineCount) fail();
  let rootCheckpoint: (() => void) | undefined;
  if (write.mode === 'delete' && /^sermons\/[^/]+$/.test(write.path)) {
    const header = await tx.get(
        db.collection(SERMON_DELETION_MIRROR_PLANS).doc(sermonDeletionMirrorPlanId(ref, write.path.split('/')[1]))
      ),
      expected = header.get('requests') as FrozenProjectionRequest[];
    // A sermon owns at most its original media and track. The source journal is the
    // authority; unrelated global claim pages never stand in for either target.
    if (!Array.isArray(expected) || expected.length > 2) fail();
    for (const original of expected) {
      const evidence = await tx.get(
          proof.candidateRef.collection('requestEvidence').doc(providerMutationFingerprint(original.step))
        ),
        record = evidence.data() as CandidateRequestEvidence;
      if (!record || record.state !== 'acknowledged') fail();
      const request = await tx.get(db.doc(record.sourceRequestPath)),
        planned = await tx.get(db.doc(record.plannedRequestPath));
      if (
        acknowledgedProjectionDigest(request.data()) !== record.sourceRequestDigest ||
        acknowledgedProjectionDigest(planned.get('request')) !== record.plannedRequestDigest ||
        planned.get('request.method') !== original.method ||
        planned.get('request.fingerprint') !== original.fingerprint ||
        providerMutationFingerprint(planned.get('request.target')) !== providerMutationFingerprint(original.target)
      )
        fail();
      await validateProviderMutationOriginalCompletion(tx, proof.session, [
        request as FirebaseFirestore.QueryDocumentSnapshot,
      ]);
      if (!requests.some((value) => value.step === original.step)) requests.push(planned.get('request'));
      acknowledgements.set(original.step, request.get('result'));
    }
    if (!scope) fail();
    rootCheckpoint = await prepareSermonRootRemovalCheckpointFromAcknowledgedRepair(tx, db, {
      ref,
      sessionId: operation.sessionId,
      sermonId: write.path.split('/')[1],
      projectionDigest: operation.projectionDigest,
      candidateVerification: {
        candidateId: proof.candidateId,
        candidateDigest: proof.candidateDigest,
        observationScope: scope,
        currentSeal: programSeal,
      },
    });
  }
  if (
    write.mode === 'delete' &&
    /^lists\/[^/]+$/.test(write.path) &&
    plain(proof.root.entity) &&
    proof.root.entity.type === 'list' &&
    proof.root.entity.id === write.path.split('/')[1]
  ) {
    if (!scope) fail();
    rootCheckpoint = await prepareListRootRemovalCheckpointFromAcknowledgedRepair(tx, db, {
      ref,
      sessionId: operation.sessionId,
      listId: write.path.split('/')[1],
      projectionDigest: operation.projectionDigest,
      candidateId: proof.candidateId,
      candidateDigest: proof.candidateDigest,
      observationScope: scope,
      currentSeal: programSeal,
    });
  }
  const expectedMatches = immutableIdentity && (baselineMatches || (!!rootCheckpoint && snapshot.exists));
  const projected =
    write.mode === 'delete'
      ? !snapshot.exists
      : write.mode === 'set'
      ? snapshot.exists && acknowledgedProjectionDigest(snapshot.data()) === acknowledgedProjectionDigest(patch)
      : snapshot.exists &&
        immutableIdentity &&
        Object.entries(patch).every(([key, value]) => equal(key, value)) &&
        !write.deleteFields?.some((key) => snapshot.get(key) !== undefined);
  if (!expectedMatches && !projected) fail();
  const retirements: Array<() => void> = rootCheckpoint ? [rootCheckpoint] : [];
  if (/^sermons\/[^/]+$/.test(write.path))
    for (const [field, provider, resourceType] of [
      ['subsplashId', 'subsplash', 'media'],
      ['soundCloudTrackId', 'soundcloud', 'track'],
    ] as const) {
      const sourceDelete = requests.find(
        (request) =>
          request.method === 'DELETE' &&
          request.target?.provider === provider &&
          request.target.resourceType === resourceType
      );
      if (
        !write.deleteFields?.includes(field) &&
        !(write.mode === 'delete' && (snapshot.get(field) !== undefined || sourceDelete))
      )
        continue;
      const id = write.expectedFields[field] ?? snapshot.get(field) ?? sourceDelete?.target?.resourceId;
      if (typeof id !== 'string' || !id) fail();
      const fixed = requests.find(
        (request) =>
          request.method === 'DELETE' &&
          request.target?.provider === provider &&
          request.target.resourceType === resourceType &&
          request.target.resourceId === id
      );
      const observed = observations.find(
        (value) =>
          value.provider === provider &&
          value.resourceType === resourceType &&
          value.resourceId === id &&
          value.state === 'absent'
      );
      if (
        !fixed ||
        (!observed && !(write.mode === 'delete' && rootCheckpoint && proof.root.rootTargetComplete === true))
      )
        fail();
      retirements.push(
        await preparePublishingAllocationRetirement(tx, db, { ref, sermonId: write.path.split('/')[1], provider }, id)
      );
    }
  if (scope)
    tx.set(progressRef.collection('programSeals').doc(providerMutationFingerprint([scope, programId])), programSeal);
  if (expectedMatches) {
    for (const key of write.deleteFields ?? []) patch[key] = FieldValue.delete();
    if (write.mode === 'delete') tx.delete(db.doc(write.path));
    else if (write.mode === 'set') tx.set(db.doc(write.path), patch);
    else tx.update(db.doc(write.path), patch);
  }
  retirements.forEach((commit) => commit());
  tx.set(progressRef, {
    schemaVersion: 2,
    ...ref,
    candidateId: proof.candidateId,
    candidateDigest: proof.candidateDigest,
    projectionDigest: operation.projectionDigest,
    ...(scope ? { observationScope: scope } : {}),
    programIndex: progress.programIndex + 1,
    programCursor: ordered.id,
    claimsVerified: true,
    claimCount,
    claimEvidenceDigest,
    phase: 'verify',
    updatedAtMillis: Date.now(),
  });
  return {
    alreadyCommitted: false,
    writesCompleted: Number(expectedMatches),
    needsContinuation: true as const,
    ...(proof.root.partialStop ? { partialStop: true as const } : {}),
  };
}

export async function commitAcknowledgedRepair(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  operation: AcknowledgedProjectionOperation,
  observations: AcknowledgedProviderObservation[],
  options: AcknowledgedRepairExecutionOptions = {}
): Promise<{
  alreadyCommitted: boolean;
  writesCompleted: number;
  needsContinuation?: true;
  needsSourceCompletion?: true;
  partialStop?: true;
  factualNonDestructiveStop?: true;
  settledUiStepIds?: string[];
}> {
  if (!validateAcknowledgedProjectionOperation(operation)) fail();
  const source = await tx.get(db.doc(`${ACKNOWLEDGED_PROJECTION_PLANS}/${operation.sessionId}`));
  if (source.get('schemaVersion') === 2) return commitReadyCandidate(tx, db, ref, operation, observations, options);
  const proof = await readProof(tx, db, ref, operation.sessionId, operation.projectionDigest);
  if (proof.settle.alreadyCommitted)
    return {
      alreadyCommitted: true,
      writesCompleted: 0,
      ...(proof.partialStop ? { partialStop: true as const } : { settledUiStepIds: proof.plan.uiStepIds ?? [] }),
    };
  verifyAcknowledgedProviderObservations(proof.verifications, observations);
  const progressRef = db.doc(`${ACKNOWLEDGED_PROJECTION_PROGRESS}/${operation.sessionId}`),
    progress = await tx.get(progressRef);
  const offset = progress.exists ? progress.get('nextIndex') : 0;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > proof.writes.length ||
    (progress.exists &&
      (progress.get('projectionDigest') !== operation.projectionDigest ||
        progress.get('acknowledgementFingerprint') !== proof.acknowledgementFingerprint))
  )
    fail();
  const candidates = proof.writes.slice(offset, offset + 64),
    snapshots = candidates.length ? await tx.getAll(...candidates.map((write) => db.doc(write.path))) : [],
    ready: Array<{ write: FrozenProjectionWrite; patch: Record<string, unknown> }> = [],
    retirements: Array<() => void> = [];
  let budget = 0,
    processed = 0;
  for (let index = 0; index < snapshots.length; index++) {
    const snapshot = snapshots[index],
      write = candidates[index];
    const patch = { ...write.patch };
    for (const binding of write.listRowBindings ?? []) {
      const response = proof.acknowledgements.get(binding.requestStep),
        original =
          plain(response) && plain(response._embedded) && response._embedded['list-rows'] !== undefined
            ? rowId(response, binding)
            : undefined,
        observation = observations.find(
          (value) =>
            value.provider === 'subsplash' &&
            value.account === 'app:9XTSHD' &&
            value.resourceType === 'list' &&
            value.resourceId === binding.listId
        );
      if (!observation || observation.state !== 'present') fail();
      const current = rowId(observation?.body, binding);
      if (original !== undefined && current !== original) fail();
      bindListRowId(patch, binding, current, write.mode);
    }
    const equal = (key: string, value: unknown) =>
      snapshot.get(key) !== undefined &&
      acknowledgedProjectionDigest(snapshot.get(key)) === acknowledgedProjectionDigest(value);
    const changed = (key: string) =>
      write.mode === 'delete' ||
      [...Object.keys(patch), ...(write.deleteFields ?? [])].some(
        (target) => target === key || target.startsWith(`${key}.`) || key.startsWith(`${target}.`)
      );
    const versions = proof.baselines.get(write.path) ?? [write];
    const baselineMatches = (baseline: FrozenProjectionWrite) =>
      snapshot.exists === (baseline.expectedExists ?? true) &&
      (baseline.expectedDocumentDigest === undefined ||
        (snapshot.exists && acknowledgedProjectionDigest(snapshot.data()) === baseline.expectedDocumentDigest)) &&
      Object.entries(baseline.expectedFields).every(([key, value]) => equal(key, value)) &&
      !baseline.absentFields?.some((key) => snapshot.get(key) !== undefined);
    const immutableIdentity = versions.every((baseline) =>
      Object.entries(baseline.expectedFields)
        .filter(([key]) => !changed(key))
        .every(([key, value]) => equal(key, value))
    );
    let rootCheckpoint: (() => void) | undefined;
    if (write.mode === 'delete' && /^sermons\/[^/]+$/.test(write.path))
      rootCheckpoint = await prepareSermonRootRemovalCheckpointFromAcknowledgedRepair(tx, db, {
        ref,
        sessionId: operation.sessionId,
        sermonId: write.path.split('/')[1],
        projectionDigest: operation.projectionDigest,
        requests: proof.plan.requests,
        acknowledgedSteps: [...proof.acknowledgements.keys()],
      });
    // The private root-deletion journal proves exactly the admitted root or its
    // earlier same-job pointer-clear result; it never permits arbitrary snapshots.
    const expectedMatches =
      immutableIdentity && (versions.some(baselineMatches) || (!!rootCheckpoint && snapshot.exists));
    const projected =
      write.mode === 'delete'
        ? !snapshot.exists
        : write.mode === 'set'
        ? snapshot.exists && acknowledgedProjectionDigest(snapshot.data()) === acknowledgedProjectionDigest(patch)
        : snapshot.exists &&
          immutableIdentity &&
          Object.entries(patch).every(([key, value]) => equal(key, value)) &&
          !write.deleteFields?.some((key) => snapshot.get(key) !== undefined);
    if (!expectedMatches && !projected) fail();
    const retiring: Array<() => void> = rootCheckpoint ? [rootCheckpoint] : [];
    if (/^sermons\/[^/]+$/.test(write.path))
      for (const [field, provider, resourceType] of [
        ['subsplashId', 'subsplash', 'media'],
        ['soundCloudTrackId', 'soundcloud', 'track'],
      ] as const) {
        if (
          !write.deleteFields?.includes(field) &&
          !(
            write.mode === 'delete' &&
            ((!!rootCheckpoint &&
              proof.plan.requests.some(
                (request) =>
                  proof.acknowledgements.has(request.step) &&
                  request.method === 'DELETE' &&
                  request.target?.provider === provider &&
                  request.target.resourceType === resourceType
              )) ||
              write.expectedFields[field] !== undefined ||
              snapshot.get(field) !== undefined)
          )
        )
          continue;
        const fixedDeletes = proof.plan.requests.filter(
          (request) =>
            proof.acknowledgements.has(request.step) &&
            request.method === 'DELETE' &&
            request.target?.provider === provider &&
            request.target.resourceType === resourceType
        );
        const id =
          [...versions].reverse().find((version) => version.expectedFields[field] !== undefined)?.expectedFields[
            field
          ] ??
          (write.mode === 'delete' && expectedMatches ? snapshot.get(field) : undefined) ??
          (rootCheckpoint && fixedDeletes.length === 1 ? fixedDeletes[0].target?.resourceId : undefined);
        if (typeof id !== 'string' || !id) fail();
        if (snapshot.get(field) !== undefined && snapshot.get(field) !== id) fail();
        const verification = proof.verifications.find(
          (value) =>
            value.provider === provider &&
            value.resourceType === resourceType &&
            value.resourceId === id &&
            value.expectedState === 'absent'
        );
        const original = proof.plan.requests.find(
          (request) =>
            proof.acknowledgements.has(request.step) &&
            request.method === 'DELETE' &&
            request.target?.provider === provider &&
            request.target.resourceType === resourceType &&
            request.target.resourceId === id &&
            request.target.account === verification?.account
        );
        if (!verification || !original) fail();
        retiring.push(
          await preparePublishingAllocationRetirement(tx, db, { ref, sermonId: write.path.split('/')[1], provider }, id)
        );
      }
    if (!expectedMatches) {
      if (budget + retiring.length > 400) {
        if (!processed) fail();
        break;
      }
      budget += retiring.length;
      retirements.push(...retiring);
      processed++;
      continue;
    }
    const before = snapshot.data(),
      after = write.mode === 'delete' ? undefined : write.mode === 'set' ? patch : { ...before };
    if (after && write.mode !== 'set') for (const [key, value] of Object.entries(patch)) put(after, key, value);
    if (after) for (const key of write.deleteFields ?? []) put(after, key, undefined, true);
    const previous = new Set(extractProviderResources(ref.projectId, write.path, before).map(providerResourceKey)),
      next = new Set(extractProviderResources(ref.projectId, write.path, after).map(providerResourceKey));
    const cost =
      1 +
      retiring.length +
      2 * [...new Set([...previous, ...next])].filter((key) => previous.has(key) !== next.has(key)).length;
    if (budget + cost > 400) {
      if (!ready.length && !processed) fail();
      break;
    }
    budget += cost;
    retirements.push(...retiring);
    ready.push({ write, patch });
    processed++;
  }
  for (const { write, patch } of ready) {
    for (const key of write.deleteFields ?? []) patch[key] = FieldValue.delete();
    if (write.mode === 'delete') tx.delete(db.doc(write.path));
    else if (write.mode === 'set') tx.set(db.doc(write.path), patch);
    else tx.update(db.doc(write.path), patch);
  }
  retirements.forEach((commit) => commit());
  const nextIndex = offset + processed;
  tx.set(progressRef, {
    schemaVersion: 1,
    projectId: ref.projectId,
    jobId: ref.jobId,
    projectionDigest: operation.projectionDigest,
    acknowledgementFingerprint: proof.acknowledgementFingerprint,
    nextIndex,
    updatedAtMillis: Date.now(),
  });
  if (nextIndex < proof.writes.length)
    return {
      alreadyCommitted: false,
      writesCompleted: ready.length,
      needsContinuation: true,
      ...(proof.partialStop ? { partialStop: true as const } : {}),
    };
  proof.settle.commit();
  return {
    alreadyCommitted: false,
    writesCompleted: ready.length,
    ...(proof.partialStop ? { partialStop: true as const } : { settledUiStepIds: proof.plan.uiStepIds ?? [] }),
  };
}
