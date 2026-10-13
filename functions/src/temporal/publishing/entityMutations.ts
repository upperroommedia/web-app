import { prepareListDeletionReady, readListDeletionReadyCompletion } from '../../helpers/listDeletionReady';
import axios from 'axios';
import type { ReviewedEntityCreatePlan } from './reviewedCreateContinuation';
import { capturePublishingAllocationSource } from './allocationBarrier';
import {
  loadFactualListDeletionCleanup,
  sealListDeletionCompletion,
  validateListDeletionCompletion,
  deleteListDeletionCanonicalPage,
  removeListDeletionMirrors,
} from '../../helpers/listDeletionMirrors';
import type { DurableJobIntent } from '../../../../packages/orchestration/src/job-store';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import type { DurableEntityRef, DurableJobKind, DurableJobRef } from '@upperroom/contracts/temporal';
import { uploadStatus, sermonStatusType, type Sermon } from '@upperroom/shared/types/SermonTypes';
import type { ImageType } from '@upperroom/shared/types/Image';
import { createNewSubsplashListDomain } from '../../createNewSubsplashList';
import { editSubsplashListDomain } from '../../editSubsplashList';
import { markListOverflowLinkDomain } from '../../markListOverflowLink';
import type { MarkListOverflowLinkInputType } from '@upperroom/contracts/markListOverflowLink';
import { deleteSubsplashListDomain } from '../../deleteSubsplashList';
import { addToListDomain, type AddtoListInputType } from '../../addToList';
import { runWithListProjectionProgram } from '../../helpers/addToListHelpers';
import { acknowledgedProjectionDigest } from './criticalAcknowledgedRepair';
import { removeFromListDomain, type RemoveFromListInputType } from '../../removeFromList';
import { reorderListItemsDomain } from '../../reorderListItems';
import { createSeriesDomain } from '../../createSeries';
import { updateSeriesMetadataDomain } from '../../updateSeriesMetadata';
import { deleteSeriesDomain } from '../../deleteSeries';
import { bulkAddToSeriesDomain, type BulkAddToSeriesInputType } from '../../bulkAddToSeries';
import { removeFromSeriesDomain } from '../../removeFromSeries';
import { reorderSeriesItemsDomain } from '../../reorderSeriesItems';
import { authenticateSubsplash, createAxiosConfig } from '../../subsplashUtils';
import { auditPublishedListDrift, resolvePublishedListDrift } from '../../helpers/publishedListDrift';
import {
  getSeriesItems,
  getAllSeriesItemsAcrossStatuses,
  deriveSeriesMetadata,
  getSeriesSubtitleFromPublishedCount,
  patchSeriesMetadata,
} from '../../helpers/seriesHelpers';
import { withSubsplashLocks } from '../../locks/withSubsplashLocks';
import { createSeriesMediaItemMembershipHash } from '../../helpers/seriesRemoteState';
import {
  createSpeakerMutation,
  updateSpeakerMutation,
  deleteSpeakerMutation,
  parseCreateSpeakerInput,
  parseUpdateSpeakerInput,
  parseDeleteSpeakerInput,
} from '../../speakers/speakerMutations';
import { providerPayloadFingerprint, providerReceiptId, readProviderReceipt } from './providerReceipts';
import {
  abortProviderMutationPlan,
  beginProviderMutationPlan,
  prepareProviderMutationPlanCommit,
  getPublishingMutationOperation,
  type PublishingMutationFinalSettlement,
  type PublishingMutationEffectsClosure,
  type PublishingAcknowledgedProjectionPlan,
  type PublishingMutationPlan,
  type PublishingMutationRequest,
  releaseCanonicalProviderBindingsForCurrentJob,
  runDurablePublishingOperation,
} from './durableOperationContext';
import { createFirebasePublishingDependencies } from './firebaseDependencies';
import type { PrivatePublishingIntent } from './types';
import { normalizeCanonicalPublishingPatch } from './intent';
import { executeMaintenancePage, normalizeMaintenanceInput } from './maintenance';
import type { ReorderListItemsInputType } from '@upperroom/contracts/reorderListItems';
import type { ReorderSeriesItemsInputType } from '@upperroom/contracts/reorderSeriesItems';
import type { UpdateSeriesMetadataInputType } from '@upperroom/contracts/updateSeriesMetadata';
import type { CreateSeriesInputType } from '@upperroom/contracts/createSeries';

export interface PublishingEntityIntent {
  kind: DurableJobKind;
  entity: DurableEntityRef;
  actorUid: string;
  generation?: number;
  payload: Record<string, unknown>;
}
export interface NormalizedPublishingEntityPayload {
  operation: string;
  input: Record<string, unknown>;
}
export interface PublishingEntityExecutionOptions {
  getSourceStepIds?: () => string[];
  prepareProviderMutationEffectsClosed?: (
    tx: Transaction,
    ref: DurableJobRef,
    plan: PublishingMutationEffectsClosure
  ) => Promise<{ alreadyClosed: boolean; commit: () => void }>;
  abortProviderMutationPlan?: (ref: DurableJobRef, plan: { operation: string }) => Promise<void>;
  prepareAcknowledgedProjectionPlan?: (
    tx: Transaction,
    ref: DurableJobRef,
    plan: PublishingAcknowledgedProjectionPlan
  ) => Promise<{ projectionDigest: string; commit: () => void }>;
  beginProviderMutationPlan?: (ref: DurableJobRef, plan: PublishingMutationPlan) => Promise<void>;
  runPublishingProviderMutation?: <T>(ref: DurableJobRef, request: PublishingMutationRequest<T>) => Promise<T>;
  prepareProviderMutationPlanCommit?: (
    tx: Transaction,
    ref: DurableJobRef,
    plan: PublishingMutationFinalSettlement
  ) => Promise<{ alreadyCommitted: boolean; commit: () => void }>;
  /** Root checks the admitted entity generation before each irreversible step and projection. */
  assertCurrent?: (ref: DurableJobRef, intent: PublishingEntityIntent) => Promise<void>;
  commitCurrent?: (ref: DurableJobRef, mutate: (tx: Transaction) => Promise<void>) => Promise<void>;
  markCritical?: (
    ref: DurableJobRef,
    reasonCode: string,
    prepare?: (tx: Transaction) => Promise<() => void>
  ) => Promise<void>;
  leaseAudio?: (ref: DurableJobRef, sermonId?: string, sourcePath?: string) => Promise<void>;
  releaseAudio?: (ref: DurableJobRef) => Promise<{ released: boolean }>;
}
const invalid = (message: string): never => {
  throw new HttpsError('invalid-argument', message);
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Expected an input object.');
  return value as Record<string, unknown>;
};
const id = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.includes('/'))
    return invalid(`${field} requires an ID.`);
  return value.trim();
};
const ids = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length > 200) return invalid(`${field} requires at most 200 IDs.`);
  const result = value.map((item) => id(item, field));
  if (new Set(result).size !== result.length) return invalid(`${field} contains duplicate IDs.`);
  return result;
};
const cloneBounded = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return invalid('Input nesting is too deep.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 12000) return invalid('Input string is too long.');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalid('Expected finite numbers.');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) return invalid('Input array is too large.');
    return Object.freeze(value.map((item) => cloneBounded(item, depth + 1)));
  }
  if (value && typeof value === 'object')
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
          if (['__proto__', 'prototype', 'constructor'].includes(key)) return invalid('Unsupported input property.');
          return [key, cloneBounded(item, depth + 1)];
        })
      )
    );
  return invalid('Input must contain JSON values.');
};
const FIELDS: Record<string, readonly string[]> = {
  'list.create:create': ['title', 'subtitle', 'images', 'localList', 'skipSubsplash'],
  'list.update:update': ['listId', 'title', 'subtitle', 'images', 'localList'],
  'list.delete:delete': ['listId'],
  'list.membership:add': ['destinationListIds', 'mediaItem', 'maxListSize', 'sermonIds', 'publishEligible'],
  'list.membership:remove': ['listIds', 'listItemIds', 'itemIds', 'itemTypes', 'sermonIds'],
  'list.reorder:reorder': ['rootListId', 'logicalItemOrder'],
  'list.reconcile:markOverflow': ['rootListId', 'physicalFirestoreListId', 'rowId', 'clear'],
  'list.reconcile:audit': ['listId'],
  'list.reconcile:resolve': ['listId', 'strategy'],
  'list.publish:publish': ['sermonIds'],
  'series.create:create': ['title', 'summary', 'images', 'skipSubsplash', 'firestoreId'],
  'series.update:update': ['title', 'summary', 'images'],
  'series.delete:delete': [],
  'series.membership:add': [
    'sermonIds',
    'publishEligible',
    'seriesSubsplashId',
    'expectedPublishedMembershipHash',
    'adds',
    'publishedItemOrder',
  ],
  'series.membership:remove': [
    'sermonIds',
    'mediaItemIds',
    'mediaItemId',
    'expectedRemoteMembershipHash',
    'expectedRetainedMembershipHash',
  ],
  'series.membership:unpublish': [
    'sermonIds',
    'mediaItemIds',
    'mediaItemId',
    'expectedRemoteMembershipHash',
    'expectedRetainedMembershipHash',
  ],
  'series.reorder:reorder': ['itemOrder', 'expectedRemoteMembershipHash', 'localItemOrder'],
  'series.publish:publish': ['sermonIds', 'expectedPublishedMembershipHash', 'publishedItemOrder'],
  'speaker.mutate:create': ['speaker', 'createSpeakerList', 'associatedListId'],
  'speaker.mutate:update': ['speakerId', 'patch', 'createSpeakerList', 'deleteAssociatedList'],
  'speaker.mutate:delete': ['speakerId', 'deleteAssociatedList'],
};
/** Admission and execution share this whitelist; raw arbitrary callable names are never dispatched. */
export function normalizePublishingEntityPayload(
  kind: DurableJobKind,
  raw: unknown
): NormalizedPublishingEntityPayload {
  const payload = object(raw);
  if (kind === 'series.sync_metadata') {
    if (
      Object.keys(payload).some((field) => !['operation', 'input'].includes(field)) ||
      (payload.operation !== undefined && payload.operation !== 'sync_metadata') ||
      Object.keys(object(payload.input ?? {})).length
    )
      invalid('Derived series metadata accepts no client patch.');
    return { operation: 'sync_metadata', input: {} };
  }
  if (kind === 'maintenance.run')
    return {
      operation: 'maintenance',
      input: normalizeMaintenanceInput(payload.input ?? payload) as unknown as Record<string, unknown>,
    };
  const defaultOperation = kind.split('.')[1];
  const operation = typeof payload.operation === 'string' ? payload.operation : defaultOperation;
  const allowed = FIELDS[`${kind}:${operation}`];
  if (!allowed) return invalid('Unsupported entity operation.');
  const source = object(payload.input ?? {});
  if (Object.keys(source).some((key) => key !== 'operationKey' && !allowed.includes(key)))
    return invalid('Unsupported operation input property.');
  const input = Object.fromEntries(
    allowed.filter((field) => source[field] !== undefined).map((field) => [field, cloneBounded(source[field])])
  );
  if (JSON.stringify(input).length > 64000) return invalid('Entity intent is too large.');
  for (const field of [
    'sermonIds',
    'mediaItemIds',
    'destinationListIds',
    'listIds',
    'listItemIds',
    'itemIds',
    'publishedItemOrder',
  ])
    if (input[field] !== undefined) input[field] = ids(input[field], field);
  for (const field of ['publishEligible', 'skipSubsplash', 'createSpeakerList', 'deleteAssociatedList'])
    if (input[field] !== undefined && typeof input[field] !== 'boolean') invalid(`${field} must be boolean.`);
  if (input.localList !== undefined) {
    const local = object(input.localList);
    const fields = ['name', 'type', 'overflowBehavior', 'images', 'listTagAndPosition', 'maxListSize'];
    if (Object.keys(local).some((field) => !fields.includes(field))) invalid('Unsupported local list property.');
    if (
      local.type !== undefined &&
      !['series', 'speaker-list', 'topic-list', 'category-list', 'latest'].includes(String(local.type))
    )
      invalid('Invalid list type.');
    if (
      local.overflowBehavior !== undefined &&
      !['ERROR', 'CREATENEWLIST', 'REMOVEOLDEST'].includes(String(local.overflowBehavior))
    )
      invalid('Invalid overflow behavior.');
    if (input.title === undefined && typeof local.name === 'string') input.title = local.name;
    if (input.images === undefined && Array.isArray(local.images)) input.images = local.images;
  }
  if (kind.endsWith('.create') || kind === 'series.update') {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 500)
      invalid('title is required and must be at most 500 characters.');
  }
  if (input.images !== undefined && (!Array.isArray(input.images) || input.images.length > 20))
    invalid('images must contain at most 20 items.');
  for (const field of ['itemOrder', 'localItemOrder', 'logicalItemOrder'])
    if (input[field] !== undefined) {
      if (!Array.isArray(input[field])) invalid(`${field} must be an array.`);
      const entries = input[field] as unknown[];
      for (const rawEntry of entries) {
        const entry = object(rawEntry);
        const fields =
          field === 'itemOrder'
            ? ['mediaItemId', 'sermonId', 'id', 'position']
            : field === 'localItemOrder'
            ? ['sermonId', 'id', 'position']
            : ['rowId', 'mediaItemId', 'sermonId', 'position'];
        if (
          Object.keys(entry).some((key) => !fields.includes(key)) ||
          !Number.isInteger(entry.position) ||
          Number(entry.position) < 1 ||
          Number(entry.position) > 100000
        )
          invalid('Invalid order entry.');
        const identifier = entry.mediaItemId ?? entry.sermonId ?? entry.id ?? entry.rowId;
        id(identifier, 'order ID');
      }
    }
  if (input.sermonIds !== undefined && (input.sermonIds as string[]).length === 0)
    invalid('Select at least one sermon.');
  if (kind === 'speaker.mutate') {
    const parse =
      operation === 'create'
        ? parseCreateSpeakerInput
        : operation === 'update'
        ? parseUpdateSpeakerInput
        : parseDeleteSpeakerInput;
    return Object.freeze({ operation, input: Object.freeze(parse(input) as unknown as Record<string, unknown>) });
  }
  if (
    kind === 'list.reconcile' &&
    operation === 'resolve' &&
    !['IGNORE', 'FIREBASE_FROM_SUBSPLASH'].includes(String(input.strategy))
  )
    invalid('A reconciliation strategy must be explicitly selected.');
  return Object.freeze({ operation, input: Object.freeze(input) });
}
export const normalizePublishingEntityIntent = normalizePublishingEntityPayload;
const db = () => firebaseAdmin.firestore();
const actorRequest = async <T>(
  actorUid: string,
  data: T,
  adminOnly = false,
  allowUploader = false
): Promise<Pick<CallableRequest<T>, 'data' | 'auth'>> => {
  const actor = await firebaseAdmin.auth().getUser(actorUid);
  if (
    actor.disabled ||
    !(adminOnly
      ? actor.customClaims?.role === 'admin'
      : (allowUploader ? ['admin', 'publisher', 'uploader'] : ['admin', 'publisher']).includes(
          actor.customClaims?.role
        ))
  )
    throw new HttpsError('permission-denied', 'Your permission to perform this operation has changed.');
  return {
    data,
    auth: {
      uid: actor.uid,
      rawToken: '',
      token: { ...actor.customClaims, uid: actor.uid } as NonNullable<CallableRequest<T>['auth']>['token'],
    },
  };
};
const confirmed = (value: { status?: string }): void => {
  if (value.status && !['success', 'deleted', 'ignored'].includes(value.status))
    throw new HttpsError('failed-precondition', 'The operation did not fully complete.', {
      reason: 'ENTITY_MUTATION_PARTIAL',
    });
};
const operationKey = (ref: DurableJobRef, step: string) => `durable:${ref.projectId}:${ref.jobId}:${step}`;
/** Safe result IDs/counts only. Full provider responses remain in private activity memory/receipts. */
export const executePublishingEntityOperation = (
  ref: DurableJobRef,
  intent: PublishingEntityIntent,
  options: PublishingEntityExecutionOptions = {}
): Promise<Record<string, unknown>> =>
  runPublishingEntityContext(ref, options, async () => {
    const result = await executeEntityOperation(ref, intent, options);
    if (getPublishingMutationOperation()) await commitFinalEntityProjection(ref, options, async () => {});
    await releaseCanonicalProviderBindingsForCurrentJob();
    return result;
  });
/** Shared trusted activity fence; reviewed tails supply only their remaining-stage operation. */
export function runPublishingEntityContext<T>(
  ref: DurableJobRef,
  options: PublishingEntityExecutionOptions,
  operation: () => Promise<T>
): Promise<T> {
  return runDurablePublishingOperation(ref.jobId, operation, (mutate) => commitEntityProjection(ref, options, mutate), {
    getSourceStepIds: options.getSourceStepIds,
    prepareProviderMutationEffectsClosed: options.prepareProviderMutationEffectsClosed
      ? (tx, plan) => options.prepareProviderMutationEffectsClosed!(tx, ref, plan)
      : undefined,
    abortProviderMutationPlan: options.abortProviderMutationPlan
      ? (plan) => options.abortProviderMutationPlan!(ref, plan)
      : undefined,
    prepareAcknowledgedProjectionPlan: options.prepareAcknowledgedProjectionPlan
      ? (tx, plan) => options.prepareAcknowledgedProjectionPlan!(tx, ref, plan)
      : undefined,
    beginProviderMutationPlan: options.beginProviderMutationPlan
      ? (plan) => options.beginProviderMutationPlan!(ref, plan)
      : undefined,
    runPublishingProviderMutation: options.runPublishingProviderMutation
      ? (request) => options.runPublishingProviderMutation!(ref, request)
      : undefined,
    prepareProviderMutationPlanCommit: options.prepareProviderMutationPlanCommit
      ? (tx, plan) => options.prepareProviderMutationPlanCommit!(tx, ref, plan)
      : undefined,
    markCritical: options.markCritical
      ? (reasonCode, prepare) => options.markCritical!(ref, reasonCode, prepare)
      : undefined,
  });
}

/** Freeze the local projection before the original provider allocation can start. */
async function prepareListCreateProjection(
  ref: DurableJobRef,
  intent: PublishingEntityIntent,
  input: Record<string, unknown>,
  options: PublishingEntityExecutionOptions
): Promise<void> {
  const checkpoint = db().doc(`temporalPublishingListCreationState/${ref.jobId}`),
    entity = db().doc(`lists/${intent.entity.id}`);
  await commitEntityProjection(ref, options, async (tx) => {
    const [prior, current] = await Promise.all([tx.get(checkpoint), tx.get(entity)]);
    const intentDigest = providerPayloadFingerprint(intent);
    if (prior.exists) {
      if (
        prior.get('intentDigest') !== intentDigest ||
        prior.get('projectId') !== ref.projectId ||
        prior.get('entityId') !== intent.entity.id
      )
        throw new HttpsError('failed-precondition', 'The original list creation projection changed.');
      return;
    }
    const local = input.localList ? object(input.localList) : {},
      now = Date.now();
    const projection = {
      ...local,
      id: intent.entity.id,
      name: input.title,
      images: input.images ?? [],
      type: local.type ?? 'series',
      overflowBehavior: local.overflowBehavior ?? 'CREATENEWLIST',
      isRootList: true,
      rootListId: intent.entity.id,
      overflowDepth: 0,
      createdAtMillis: current.data()?.createdAtMillis ?? now,
      updatedAtMillis: now,
    };
    tx.create(checkpoint, {
      schemaVersion: 1,
      projectId: ref.projectId,
      jobId: ref.jobId,
      entityId: intent.entity.id,
      intentDigest,
      expectedExists: current.exists,
      ...(current.exists ? { expectedDigest: providerPayloadFingerprint(current.data()) } : {}),
      projection,
    });
  });
}
/** Reviewed list allocation tail: fixed GET and the frozen local projection only. */
export async function completeReviewedListCreate(
  ref: DurableJobRef,
  intent: PublishingEntityIntent,
  plan: ReviewedEntityCreatePlan,
  options: PublishingEntityExecutionOptions
): Promise<Record<string, unknown>> {
  if (
    intent.kind !== 'list.create' ||
    plan.kind !== intent.kind ||
    plan.entity.id !== intent.entity.id ||
    plan.receiptStep !== 'list-create' ||
    plan.generation !== intent.generation
  )
    throw new HttpsError('failed-precondition', 'The reviewed list allocation does not match its original intent.');
  const key = operationKey(ref, 'list.create:create');
  if (plan.receiptId !== providerReceiptId(key, 'list-create'))
    throw new HttpsError('failed-precondition', 'The reviewed allocation route changed.');
  const receipt = await readProviderReceipt(plan.receiptId),
    remote =
      receipt?.result && typeof receipt.result === 'object' && 'listId' in receipt.result
        ? receipt.result.listId
        : undefined;
  if (
    receipt?.state !== 'confirmed' ||
    receipt.projectId !== ref.projectId ||
    receipt.jobId !== ref.jobId ||
    receipt.operationKey !== key ||
    receipt.providerAccount?.provider !== 'subsplash' ||
    receipt.providerAccount.account !== 'app:9XTSHD' ||
    typeof remote !== 'string' ||
    !remote.trim()
  )
    throw new HttpsError('failed-precondition', 'The reviewed allocation is not confirmed.');
  await options.assertCurrent?.(ref, intent);
  const token = await authenticateSubsplash(),
    response = await axios({
      ...createAxiosConfig(`https://core.subsplash.com/builder/v1/lists/${encodeURIComponent(remote)}`, token, 'GET'),
      timeout: 30000,
    });
  if (response.status !== 200 || response.data?.id !== remote || response.data?.app_key !== '9XTSHD')
    throw new HttpsError('failed-precondition', 'The reviewed list could not be verified in its original account.');
  await commitListCreateProjection(ref, intent, options, remote);
  return { listId: intent.entity.id, subsplashId: remote };
}
async function commitListCreateProjection(
  ref: DurableJobRef,
  intent: PublishingEntityIntent,
  options: PublishingEntityExecutionOptions,
  remoteId?: string
): Promise<void> {
  await commitEntityProjection(ref, options, async (tx) => {
    const checkpoint = db().doc(`temporalPublishingListCreationState/${ref.jobId}`),
      entity = db().doc(`lists/${intent.entity.id}`),
      [saved, current] = await Promise.all([tx.get(checkpoint), tx.get(entity)]);
    if (
      !saved.exists ||
      saved.get('projectId') !== ref.projectId ||
      saved.get('intentDigest') !== providerPayloadFingerprint(intent) ||
      saved.get('entityId') !== intent.entity.id
    )
      throw new HttpsError('failed-precondition', 'The original list creation projection is missing.');
    const projection = { ...saved.get('projection'), ...(remoteId ? { subsplashId: remoteId } : {}) };
    if (saved.get('state') === 'completed') {
      if (providerPayloadFingerprint(current.data()) !== saved.get('completedDigest'))
        throw new HttpsError('failed-precondition', 'The created list changed after projection.');
      return;
    }
    if (
      current.exists !== saved.get('expectedExists') ||
      (current.exists && providerPayloadFingerprint(current.data()) !== saved.get('expectedDigest'))
    )
      throw new HttpsError('failed-precondition', 'The list changed before its allocation was projected.');
    const completed = { ...(current.data() ?? {}), ...projection };
    tx.set(entity, projection, { merge: true });
    tx.update(checkpoint, { state: 'completed', completedDigest: providerPayloadFingerprint(completed) });
  });
}
async function beginEntityMutationPlan(
  ref: DurableJobRef,
  intent: PublishingEntityIntent,
  options: PublishingEntityExecutionOptions
): Promise<void> {
  if (!options.beginProviderMutationPlan) return;
  const { buildEntityMutationResourcePlan, assertMutationResourcePlanCurrent } = await import('./mutationResourcePlan');
  const source = { db: db(), ref, intent };
  const plan = await buildEntityMutationResourcePlan(source);
  if (!plan.resources.length) return;
  await beginProviderMutationPlan(plan);
  try {
    await assertMutationResourcePlanCurrent(plan, () => buildEntityMutationResourcePlan(source));
  } catch (error) {
    if (error instanceof Error && error.message === 'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT') {
      await abortProviderMutationPlan({ operation: plan.operation });
      throw Object.assign(error, { code: 'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT' });
    }
    throw error;
  }
}
async function commitFinalEntityProjection(
  ref: DurableJobRef,
  options: PublishingEntityExecutionOptions,
  mutate: (tx: Transaction) => Promise<void>
): Promise<void> {
  await commitEntityProjection(ref, options, async (tx) => {
    const operation = getPublishingMutationOperation();
    const guard = operation ? await prepareProviderMutationPlanCommit(tx, { operation }) : undefined;
    if (guard?.alreadyCommitted) return;
    await mutate(tx);
    guard?.commit();
  });
}
async function finishFactualListDeletion(
  ref: DurableJobRef,
  intent: PublishingEntityIntent,
  options: PublishingEntityExecutionOptions
): Promise<Record<string, unknown>> {
  const immutable = (await db().doc(`durableJobIntents/${ref.jobId}`).get()).data() as
    | DurableJobIntent<unknown>
    | undefined;
  if (
    !immutable ||
    immutable.actorUid !== intent.actorUid ||
    immutable.entity.id !== intent.entity.id ||
    immutable.kind !== intent.kind
  )
    throw new HttpsError('failed-precondition', 'The original list deletion proof is missing.');
  const { plan, remainingCanonicalRefs } = await loadFactualListDeletionCleanup(db(), ref, immutable);
  for (let offset = 0; offset < remainingCanonicalRefs.length; offset += 64)
    await deleteListDeletionCanonicalPage(db(), plan, remainingCanonicalRefs.slice(offset, offset + 64));
  await removeListDeletionMirrors(db(), plan);
  await sealListDeletionCompletion(db(), plan);
  const header = await db().doc(`temporalListDeletionMirrorPlans/${plan.planId}`).get(),
    operation = header.get('operation');
  if (plan.remoteListIds.length)
    await prepareListDeletionReady(db(), ref, plan, {
      commitCurrent: async <T>(current: DurableJobRef, mutate: (tx: Transaction) => Promise<T>) => {
        let result: T;
        await commitEntityProjection(current, options, async (tx) => {
          result = await mutate(tx);
        });
        return result!;
      },
    });
  await commitEntityProjection(ref, options, async (tx) => {
    await validateListDeletionCompletion(tx, db(), plan);
    if (operation !== undefined) {
      if (typeof operation !== 'string' || !operation || !options.prepareProviderMutationPlanCommit)
        throw new HttpsError('failed-precondition', 'Original list deletion settlement is required.');
      const settlement = await options.prepareProviderMutationPlanCommit(tx, ref, {
        operation,
        validateSourceCompletion: async (transaction, session, seal) => {
          await validateListDeletionCompletion(transaction, db(), plan);
          if (!seal) throw new HttpsError('failed-precondition', 'The original deletion closure is missing.');
          return readListDeletionReadyCompletion(transaction, db(), plan, session, seal);
        },
      });
      settlement.commit();
    }
  });
  return { listId: intent.entity.id, deletedCount: plan.firestoreListIds.length };
}
async function executeEntityOperation(
  ref: DurableJobRef,
  intent: PublishingEntityIntent,
  options: PublishingEntityExecutionOptions
): Promise<Record<string, unknown>> {
  const { operation, input } = normalizePublishingEntityPayload(intent.kind, intent.payload);
  const expectedType = intent.kind.split('.')[0];
  if (['list', 'series', 'speaker', 'maintenance'].includes(expectedType) && intent.entity.type !== expectedType)
    invalid('Entity type does not match the operation.');
  const fence = () => options.assertCurrent?.(ref, intent) ?? Promise.resolve();
  const commit = (mutate: (tx: Transaction) => Promise<void>) => commitEntityProjection(ref, options, mutate);
  await fence();
  if (intent.kind === 'series.sync_metadata') {
    if (intent.actorUid !== 'system:firebase-event')
      throw new HttpsError('permission-denied', 'Derived metadata is admitted only from trusted Firestore events.');
    return executeDerivedSeriesSync(ref, intent, options);
  }
  if (intent.kind === 'maintenance.run')
    return {
      ...(await executeMaintenancePage(
        ref,
        intent.actorUid,
        input as unknown as Parameters<typeof executeMaintenancePage>[2]
      )),
    };
  const localSeriesAdd =
    (intent.kind === 'series.membership' && operation === 'add' && input.publishEligible !== true) ||
    (intent.kind === 'series.create' && input.skipSubsplash === true);
  await actorRequest(intent.actorUid, {}, intent.kind === 'speaker.mutate' && operation === 'create', localSeriesAdd);
  if (intent.kind.startsWith('series.') && intent.kind !== 'series.create') {
    const [series, actor] = await Promise.all([
      db().collection('series').doc(id(intent.entity.id, 'entity.id')).get(),
      firebaseAdmin.auth().getUser(intent.actorUid),
    ]);
    if (!series.exists) throw new HttpsError('not-found', 'Series no longer exists.');
    if (actor.customClaims?.role !== 'admin' && series.data()?.ownerId !== actor.uid)
      throw new HttpsError('permission-denied', 'You do not own this series.');
  }
  const key = operationKey(ref, `${intent.kind}:${operation}`);
  const request = <T>(data: T) =>
    actorRequest(intent.actorUid, data, intent.kind === 'speaker.mutate' && operation === 'create', localSeriesAdd);
  const entityId = id(intent.entity.id, 'entity.id');
  const entityRef = db()
    .collection(intent.entity.type === 'series' ? 'series' : intent.entity.type === 'speaker' ? 'speakers' : 'lists')
    .doc(entityId);
  const guarded = async <T>(_step: string, _payload: unknown, execute: () => Promise<T>): Promise<T> => execute();
  if (intent.kind === 'list.delete' && !(await entityRef.get()).exists)
    return finishFactualListDeletion(ref, intent, options);
  if (
    !['list.publish', 'list.membership', 'series.publish', 'series.membership', 'series.reorder'].includes(intent.kind)
  )
    await beginEntityMutationPlan(ref, intent, options);
  if (intent.kind === 'list.create') {
    await prepareListCreateProjection(ref, intent, input, options);
    const result =
      input.skipSubsplash === true
        ? undefined
        : await createNewSubsplashListDomain(
            await request({
              title: String(input.title),
              subtitle: input.subtitle as string | undefined,
              images: input.images as ImageType[] | undefined,
              operationKey: key,
            })
          );
    await fence();
    await commitListCreateProjection(ref, intent, options, result?.listId);
    return { listId: entityId, ...(result ? { subsplashId: result.listId } : {}) };
  }
  if (intent.kind === 'list.update') {
    const list = await entityRef.get();
    if (!list.exists) throw new HttpsError('not-found', 'List no longer exists.');
    const listId = list.data()?.subsplashId as string | undefined;
    if (listId)
      await editSubsplashListDomain(
        await request({
          listId,
          title: input.title as string | undefined,
          subtitle: input.subtitle as string | undefined,
          images: input.images as ImageType[] | undefined,
          operationKey: key,
        })
      );
    await fence();
    await commitFinalEntityProjection(ref, options, async (tx) => {
      tx.update(entityRef, {
        ...((input.localList && object(input.localList)) || {}),
        ...(input.title ? { name: input.title } : {}),
        ...(input.images ? { images: input.images } : {}),
        updatedAtMillis: Date.now(),
      });
    });
    return { listId: entityId };
  }
  if (intent.kind === 'list.delete') {
    const result = await guarded('delete', { listId: entityId }, async () =>
      deleteSubsplashListDomain(await request({ listId: entityId, operationKey: key }))
    );
    await finishFactualListDeletion(ref, intent, options);
    return { listId: entityId, deletedCount: result.deletedFirestoreListIds.length };
  }
  if (intent.kind === 'list.reorder') {
    const list = await entityRef.get();
    if (!list.exists) throw new HttpsError('not-found', 'List no longer exists.');
    if (!list.data()?.subsplashId) {
      const order = input.logicalItemOrder as Array<{ sermonId?: string; position: number }>;
      await commit(async (tx) => {
        const rows = await tx.get(entityRef.collection('listItems'));
        for (const entry of order) {
          const row = rows.docs.find((doc) => doc.id === entry.sermonId);
          if (!row) throw new HttpsError('failed-precondition', 'Local list membership changed.');
          tx.update(row.ref, { position: entry.position });
        }
      });
      return { listId: entityId };
    }
    const result = await guarded('reorder', input, async () =>
      reorderListItemsDomain(
        await request({ ...input, rootListId: entityId, operationKey: key } as unknown as ReorderListItemsInputType)
      )
    );
    confirmed(result);
    return { listId: entityId };
  }
  if (intent.kind === 'list.reconcile') {
    const token = await authenticateSubsplash();
    if (operation === 'markOverflow') {
      await guarded('mark-overflow', input, async () =>
        markListOverflowLinkDomain(
          await request({ ...input, rootListId: entityId } as unknown as MarkListOverflowLinkInputType)
        )
      );
      return { listId: entityId, marked: true };
    }
    if (operation === 'audit') {
      const result = await auditPublishedListDrift(entityId, token);
      return { listId: entityId, hasDrift: !result.inSync };
    }
    const result = await guarded('resolve', input, () =>
      resolvePublishedListDrift({
        listId: entityId,
        token,
        strategy: input.strategy as 'IGNORE' | 'FIREBASE_FROM_SUBSPLASH',
      })
    );
    return {
      listId: result.rootListId,
      updatedCount: result.updatedSermonIds.length,
      importedCount: result.importedSermonIds.length,
    };
  }
  if (intent.kind === 'list.membership' && !input.sermonIds) {
    const result =
      operation === 'add'
        ? await guarded('add', input, async () =>
            addToListDomain(
              await request({
                ...input,
                destinationListIds: [(await entityRef.get()).data()?.subsplashId || entityId],
                operationKey: key,
              } as unknown as AddtoListInputType)
            )
          )
        : await guarded('remove', input, async () =>
            removeFromListDomain(await request({ ...input, operationKey: key } as unknown as RemoveFromListInputType))
          );
    if (result.some((item) => item.status !== 'success'))
      throw new HttpsError('failed-precondition', 'List membership requires review.', {
        reason: 'ENTITY_MUTATION_PARTIAL',
      });
    return { listId: entityId, processed: result.length };
  }
  if (intent.kind === 'series.create') {
    const result = await createSeriesDomain(
      {
        ...input,
        ownerId: intent.actorUid,
        firestoreId: entityId,
        operationKey: key,
      } as unknown as CreateSeriesInputType,
      (
        await request({})
      ).auth!.token.role,
      { commitCurrent: (write) => commit(write) }
    );
    confirmed(result);
    return { seriesId: result.firestoreId, ...(result.subsplashId ? { subsplashId: result.subsplashId } : {}) };
  }
  if (intent.kind === 'series.update') {
    const series = await entityRef.get();
    if (!series.data()?.subsplashId) {
      await commit(async (tx) => {
        tx.update(entityRef, {
          name: String(input.title).trim(),
          ...(input.images ? { images: input.images } : {}),
          summary: typeof input.summary === 'string' ? input.summary.trim() : FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      return { seriesId: entityId };
    }
    const result = await updateSeriesMetadataDomain(
      await request({ ...input, firestoreId: entityId, operationKey: key } as unknown as UpdateSeriesMetadataInputType)
    );
    confirmed(result);
    return { seriesId: entityId, subsplashId: result.subsplashId };
  }
  if (intent.kind === 'series.delete') {
    const result = await guarded('delete', input, async () =>
      deleteSeriesDomain(await request({ firestoreId: entityId, operationKey: key }))
    );
    confirmed(result);
    return { seriesId: entityId, deletedCount: result.localSeriesItemsDeleted };
  }
  if (intent.kind === 'speaker.mutate') {
    const result = await guarded('speaker', input, async () => {
      if (operation === 'create') {
        const out = await createSpeakerMutation(parseCreateSpeakerInput({ ...input, operationKey: key }), {
          speakerId: entityId,
        });
        return { speakerId: out.speakerId, ...(out.listId ? { listId: out.listId } : {}) };
      }
      if (operation === 'update') {
        const out = await updateSpeakerMutation(
          parseUpdateSpeakerInput({ ...input, speakerId: entityId, operationKey: key })
        );
        return { speakerId: out.speakerId, ...(out.listId ? { listId: out.listId } : {}) };
      }
      const out = await deleteSpeakerMutation(
        parseDeleteSpeakerInput({ ...input, speakerId: entityId, operationKey: key })
      );
      return { speakerId: out.speakerId, removedFromSermonsCount: out.removedFromSermonsCount };
    });
    return result;
  }
  return executeMembershipAndPublication(ref, intent, { operation, input }, options);
}

async function executeMembershipAndPublication(
  ref: DurableJobRef,
  intent: PublishingEntityIntent,
  normalized: NormalizedPublishingEntityPayload,
  options: PublishingEntityExecutionOptions
): Promise<Record<string, unknown>> {
  const { operation, input } = normalized;
  const entityId = id(intent.entity.id, 'entity.id');
  const fence = () => options.assertCurrent?.(ref, intent) ?? Promise.resolve();
  const commit = (mutate: (tx: Transaction) => Promise<void>) => commitEntityProjection(ref, options, mutate);
  const request = <T>(data: T) =>
    actorRequest(
      intent.actorUid,
      data,
      false,
      intent.kind === 'series.membership' && operation === 'add' && input.publishEligible !== true
    );
  const key = operationKey(ref, `${intent.kind}:${operation}`);
  const collection = intent.entity.type === 'series' ? 'series' : 'lists';
  const entityRef = db().collection(collection).doc(entityId);
  const actor = await firebaseAdmin.auth().getUser(intent.actorUid);
  const entity = await entityRef.get();
  if (!entity.exists) throw new HttpsError('not-found', 'The destination no longer exists.');
  if (collection === 'series' && actor.customClaims?.role !== 'admin' && entity.data()?.ownerId !== actor.uid)
    throw new HttpsError('permission-denied', 'You do not own this series.');
  const sermonIds = input.sermonIds === undefined ? [] : ids(input.sermonIds, 'sermonIds');
  const guarded = <T>(_step: string, _payload: unknown, execute: () => Promise<T>) => execute();
  if (intent.kind === 'series.reorder') {
    await beginEntityMutationPlan(ref, intent, options);
    if (input.itemOrder && entity.data()?.subsplashId) {
      const result = await guarded('remote-reorder', input, async () =>
        reorderSeriesItemsDomain(
          await request({
            ...input,
            firestoreSeriesId: entityId,
            operationKey: key,
          } as unknown as ReorderSeriesItemsInputType)
        )
      );
      confirmed(result);
    }
    const local = Array.isArray(input.localItemOrder)
      ? input.localItemOrder
      : Array.isArray(input.itemOrder)
      ? input.itemOrder
      : [];
    if (local.length) {
      await fence();
      await commitFinalEntityProjection(ref, options, async (tx) => {
        const rows = await tx.get(entityRef.collection('seriesItems'));
        const order = local.map((item) => object(item));
        for (const entry of order) {
          const sermonId = entry.sermonId ?? entry.id;
          if (typeof sermonId !== 'string') continue;
          const row = rows.docs.find((doc) => doc.id === sermonId);
          if (!row || !Number.isInteger(entry.position) || Number(entry.position) < 1)
            throw new HttpsError('failed-precondition', 'Series order changed; refresh before reordering.');
          tx.update(row.ref, { position: entry.position });
        }
      });
    }
    return { seriesId: entityId };
  }
  if (intent.kind === 'series.membership' && ['remove', 'unpublish'].includes(operation)) {
    await beginEntityMutationPlan(ref, intent, options);
    const mediaIds = ids(input.mediaItemIds ?? (input.mediaItemId ? [input.mediaItemId] : []), 'mediaItemIds');
    const rows = await entityRef.collection('seriesItems').get();
    for (const sermonId of sermonIds) {
      const row = rows.docs.find((doc) => doc.id === sermonId);
      if (row?.data().sermonSubsplashId) mediaIds.push(row.data().sermonSubsplashId);
    }
    if (typeof input.expectedRetainedMembershipHash === 'string' && entity.data()?.subsplashId) {
      const current = await getAllSeriesItemsAcrossStatuses(entity.data()!.subsplashId, await authenticateSubsplash());
      const removing = new Set(mediaIds);
      const retained = providerPayloadFingerprint(
        current
          .filter((item) => !removing.has(item.id))
          .map((item) => item.id)
          .sort()
      );
      if (retained !== input.expectedRetainedMembershipHash)
        throw new HttpsError('failed-precondition', 'Series membership changed. Refresh before removing rows.', {
          reason: 'REMOTE_MEMBERSHIP_CHANGED',
        });
    }
    for (const mediaItemId of [...new Set(mediaIds)]) {
      await fence();
      const result = await guarded(`remove:${mediaItemId}`, { mediaItemId }, async () =>
        removeFromSeriesDomain(
          await request({ firestoreSeriesId: entityId, mediaItemId, operationKey: `${key}:${mediaItemId}` })
        )
      );
      confirmed(result);
    }
    for (const sermonId of sermonIds) {
      await fence();
      await commit(async (tx) => {
        const sermonRef = db().collection('sermons').doc(sermonId);
        const sermon = await tx.get(sermonRef);
        const rowRef = entityRef.collection('seriesItems').doc(sermonId);
        const row = await tx.get(rowRef);
        if (operation === 'unpublish') {
          if (row.exists) tx.update(rowRef, { publishedToSubsplash: false, sermonSubsplashId: FieldValue.delete() });
          if (sermon.exists && sermon.data()?.seriesId === entityId)
            tx.update(sermonRef, { seriesPublishedToSubsplash: false });
        } else {
          tx.delete(rowRef);
          if (sermon.exists && sermon.data()?.seriesId === entityId)
            tx.update(sermonRef, { seriesId: null, seriesPublishedToSubsplash: false });
        }
      });
    }
    return { seriesId: entityId, removedCount: sermonIds.length };
  }
  // Canonical list membership and series membership are applied to current Firestore state,
  // preserving single-series membership and the inverse Subsplash position convention.
  if (intent.kind === 'series.membership' && operation === 'add' && sermonIds.length) {
    await fence();
    await commit(async (tx) => {
      const rows = await tx.get(entityRef.collection('seriesItems'));
      const sermons = await Promise.all(sermonIds.map((sermonId) => tx.get(db().collection('sermons').doc(sermonId))));
      const maxPosition = rows.docs.reduce((max, doc) => Math.max(max, Number(doc.data().position) || 0), 0);
      for (let index = 0; index < sermons.length; index++) {
        const sermon = sermons[index];
        if (!sermon.exists) throw new HttpsError('not-found', 'A selected sermon no longer exists.');
        const data = sermon.data()!;
        if (data.seriesId && data.seriesId !== entityId)
          throw new HttpsError('failed-precondition', 'A selected sermon already belongs to another series.');
        if (actor.customClaims?.role !== 'admin' && data.uploaderId !== actor.uid)
          throw new HttpsError('permission-denied', 'You do not own a selected sermon.');
        if ([sermonStatusType.PENDING, sermonStatusType.PROCESSING].includes(data.status?.audioStatus))
          throw new HttpsError('failed-precondition', 'A selected sermon is still processing.');
        if (rows.docs.some((doc) => doc.id === sermon.id)) continue;
        tx.set(entityRef.collection('seriesItems').doc(sermon.id), {
          id: sermon.id,
          position: maxPosition + sermons.length - index,
          publishedToSubsplash: false,
          ...(data.subsplashId ? { sermonSubsplashId: data.subsplashId } : {}),
          addedAt: FieldValue.serverTimestamp(),
        });
        tx.update(sermon.ref, { seriesId: entityId });
      }
    });
    if (input.publishEligible !== true) return { seriesId: entityId, addedCount: sermonIds.length };
  }
  if (intent.kind === 'series.membership' && input.adds && !sermonIds.length) {
    const result = await guarded('bulk-add', input, async () =>
      bulkAddToSeriesDomain(
        await request({
          ...input,
          firestoreSeriesId: entityId,
          operationKey: key,
          rollbackOnFailure: false,
        } as unknown as BulkAddToSeriesInputType)
      )
    );
    confirmed(result);
    return { seriesId: entityId, processed: result.processed };
  }
  if (!['list.publish', 'list.membership', 'series.publish', 'series.membership'].includes(intent.kind))
    return invalid('Unsupported entity operation.');
  const ensureMedia = async (sermonId: string): Promise<Sermon> => {
    const snap = await db().collection('sermons').doc(sermonId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'A selected sermon no longer exists.');
    const sermon = { ...snap.data(), id: sermonId } as Sermon;
    if (
      intent.kind === 'series.membership' &&
      input.publishEligible === true &&
      sermon.status?.subsplash !== uploadStatus.UPLOADED &&
      !sermon.subsplashId
    )
      return sermon;
    const privateIntent: PrivatePublishingIntent = {
      sermonId,
      action: 'publish',
      generation: intent.generation ?? 0,
      actorUid: intent.actorUid,
      payload: {
        sermon,
        allocationSource: capturePublishingAllocationSource(snap.data() ?? {}),
        ...(typeof (sermon as unknown as { audioArtifacts?: { finalPath?: string } }).audioArtifacts?.finalPath ===
        'string'
          ? {
              audioStoragePath: (sermon as unknown as { audioArtifacts: { finalPath: string } }).audioArtifacts
                .finalPath,
            }
          : {}),
      },
      destinations: {
        listIds: collection === 'lists' ? [entityId] : [],
        ...(collection === 'series' ? { seriesId: entityId } : {}),
        soundcloud: false,
      },
    };
    const deps = createFirebasePublishingDependencies({
      getSourceStepIds: options.getSourceStepIds,
      prepareProviderMutationEffectsClosed: options.prepareProviderMutationEffectsClosed
        ? (current, tx, plan) => options.prepareProviderMutationEffectsClosed!(tx, current, plan)
        : undefined,
      abortProviderMutationPlan: options.abortProviderMutationPlan,
      prepareAcknowledgedProjectionPlan: options.prepareAcknowledgedProjectionPlan
        ? (current, tx, plan) => options.prepareAcknowledgedProjectionPlan!(tx, current, plan)
        : undefined,
      beginProviderMutationPlan: options.beginProviderMutationPlan,
      runPublishingProviderMutation: options.runPublishingProviderMutation,
      prepareProviderMutationPlanCommit: options.prepareProviderMutationPlanCommit
        ? (current, tx, plan) => options.prepareProviderMutationPlanCommit!(tx, current, plan)
        : undefined,
      loadIntent: async () => privateIntent,
      assertCurrent: async () => fence(),
      recordStep: async () => undefined,
      markCritical: async (_ref, reasonCode, prepare) => {
        if (!options.markCritical)
          throw new HttpsError('failed-precondition', 'Critical provider admission is required.');
        await options.markCritical(ref, reasonCode, prepare);
      },
      commitCurrent: (_ref, mutate) => commit(mutate),
      leaseAudio: async (current, selected, sourcePath) => {
        if (!options.leaseAudio) throw new HttpsError('failed-precondition', 'Audio admission lease is required.');
        await options.leaseAudio(current, selected, sourcePath);
      },
      releaseAudio: async (current) => {
        if (!options.releaseAudio) throw new HttpsError('failed-precondition', 'Audio admission lease is required.');
        return options.releaseAudio(current);
      },
    });
    await fence();
    await deps.ensureSubsplashMedia(ref, privateIntent);
    await deps.awaitSubsplashReady(ref, privateIntent);
    if (options.releaseAudio) await options.releaseAudio(ref);
    const latest = await db().collection('sermons').doc(sermonId).get();
    return { ...latest.data(), id: sermonId } as Sermon;
  };
  if (collection === 'lists') {
    const remoteId = entity.data()?.subsplashId;
    if (typeof remoteId !== 'string' || !remoteId)
      throw new HttpsError('failed-precondition', 'Publish the destination list first.');
    const prepared = new Map<string, Sermon>();
    if (operation !== 'remove') for (const selected of sermonIds) prepared.set(selected, await ensureMedia(selected));
    await beginEntityMutationPlan(ref, intent, options);
    for (const sermonId of sermonIds) {
      await fence();
      const sermon =
        operation === 'remove'
          ? ({ ...(await db().collection('sermons').doc(sermonId).get()).data(), id: sermonId } as Sermon)
          : prepared.get(sermonId)!;
      const membershipRef = db().collection('sermons').doc(sermonId).collection('sermonLists').doc(entityId);
      if (operation === 'remove') {
        const membership = await membershipRef.get();
        if (sermon.subsplashId && membership.data()?.uploadStatus?.listItemId) {
          const out = await guarded(`remove:${sermonId}`, { sermonId, entityId }, async () =>
            runWithListProjectionProgram(
              async (tx, prepared) => {
                // Only the original deletion of this exact admitted membership row
                // authorizes its local mirrors to disappear during factual repair.
                if (
                  prepared.method !== 'DELETE' ||
                  prepared.target.resourceId !== membership.data()!.uploadStatus.listItemId
                )
                  return [];
                const snapshots = await Promise.all([
                  tx.get(membershipRef),
                  tx.get(entityRef.collection('listItems').doc(sermonId)),
                ]);
                return snapshots
                  .filter((snapshot) => snapshot.exists)
                  .map((snapshot) => ({
                    path: snapshot.ref.path,
                    mode: 'delete' as const,
                    expectedExists: true,
                    expectedDocumentDigest: acknowledgedProjectionDigest(snapshot.data()),
                    expectedFields: {},
                    patch: {},
                    requiredSteps: [prepared.step],
                  }));
              },
              async () =>
                removeFromListDomain(
                  await request({
                    listIds: [remoteId],
                    listItemIds: [membership.data()!.uploadStatus.listItemId],
                    itemIds: [sermon.subsplashId!],
                    itemTypes: ['media-item'],
                    sermonIds: [sermonId],
                    operationKey: `${key}:${sermonId}`,
                  })
                )
            )
          );
          if (out.some((item) => item.status !== 'success'))
            throw new HttpsError('failed-precondition', 'Removal needs review.');
        }
        await commit(async (tx) => {
          tx.delete(membershipRef);
          tx.delete(entityRef.collection('listItems').doc(sermonId));
        });
      } else {
        const out = await guarded(`add:${sermonId}`, { sermonId, entityId }, async () =>
          addToListDomain(
            await request({
              destinationListIds: [remoteId],
              mediaItem: {
                id: sermon.subsplashId!,
                title: sermon.title,
                subtitle: sermon.subtitle,
                type: 'media-item',
              } as AddtoListInputType['mediaItem'],
              operationKey: `${key}:${sermonId}`,
            })
          )
        );
        const result = out[0];
        if (!result || result.status !== 'success')
          throw new HttpsError('failed-precondition', 'Publication needs review.');
        await commit(async (tx) => {
          tx.set(
            membershipRef,
            {
              _durableMembershipJobId: ref.jobId,
              id: entityId,
              subsplashId: remoteId,
              name: entity.data()?.name ?? '',
              uploadStatus: {
                status: uploadStatus.UPLOADED,
                ...(result.listItemId ? { listItemId: result.listItemId } : {}),
              },
            },
            { merge: true }
          );
        });
      }
    }
    // Every per-sermon projection is complete before the one parent operation
    // is sealed. Unknown original requests keep the entire resource graph held.
    await commitFinalEntityProjection(ref, options, async () => {});
    return { listId: entityId, processed: sermonIds.length };
  }
  let remoteId = entity.data()?.subsplashId as string | undefined;
  if (!remoteId) {
    const result = await createSeriesDomain(
      {
        firestoreId: entityId,
        title: entity.data()!.name,
        ownerId: entity.data()!.ownerId,
        summary: entity.data()!.summary,
        images: entity.data()!.images,
        operationKey: `${key}:create`,
      },
      actor.customClaims?.role,
      { commitCurrent: (write) => commit(write) }
    );
    confirmed(result);
    remoteId = result.subsplashId;
  }
  if (!remoteId) throw new HttpsError('failed-precondition', 'Series creation requires review.');
  const adds: Array<{ mediaItemId: string; sermonId: string }> = [];
  for (const sermonId of sermonIds) {
    const sermon = await ensureMedia(sermonId);
    if (sermon.subsplashId) adds.push({ mediaItemId: sermon.subsplashId, sermonId });
  }
  if (!adds.length) return { seriesId: entityId, processed: 0 };
  await beginEntityMutationPlan(ref, intent, options);
  const token = await authenticateSubsplash();
  const remote = await getSeriesItems(remoteId, token);
  const expected =
    typeof input.expectedPublishedMembershipHash === 'string'
      ? input.expectedPublishedMembershipHash
      : createSeriesMediaItemMembershipHash(remote.map((item) => ({ id: item.id })));
  const order = Array.isArray(input.publishedItemOrder)
    ? (input.publishedItemOrder as string[])
    : [
        ...remote.map((item) => item.id),
        ...adds.filter((add) => !remote.some((item) => item.id === add.mediaItemId)).map((add) => add.mediaItemId),
      ];
  await fence();
  const result = await guarded('bulk-publish', { adds, expected, order }, async () =>
    bulkAddToSeriesDomain(
      await request({
        firestoreSeriesId: entityId,
        seriesSubsplashId: remoteId!,
        operationKey: key,
        expectedPublishedMembershipHash: expected,
        adds,
        publishedItemOrder: order,
        rollbackOnFailure: false,
      })
    )
  );
  confirmed(result);
  await fence();
  await commitFinalEntityProjection(ref, options, async (tx) => {
    for (const add of adds) {
      tx.set(
        entityRef.collection('seriesItems').doc(add.sermonId),
        { publishedToSubsplash: true, sermonSubsplashId: add.mediaItemId },
        { merge: true }
      );
      tx.update(db().collection('sermons').doc(add.sermonId), { seriesPublishedToSubsplash: true });
    }
  });
  return { seriesId: entityId, processed: result.processed };
}

async function commitEntityProjection(
  ref: DurableJobRef,
  options: PublishingEntityExecutionOptions,
  mutate: (tx: Transaction) => Promise<void>
): Promise<void> {
  if (options.commitCurrent) return options.commitCurrent(ref, mutate);
  await db().runTransaction(mutate);
}

export interface PublishingEntityAdmission {
  kind: DurableJobKind;
  entity: DurableEntityRef;
  payload: Record<string, unknown>;
  actorUid: string;
  role: string;
}
/** Freeze canonical intent at admission. Provider identity always comes from verified server records. */
export async function normalizePublishingEntityAdmission(
  admission: PublishingEntityAdmission
): Promise<NormalizedPublishingEntityPayload> {
  const { kind, entity, actorUid, role } = admission;
  if (kind === 'series.sync_metadata')
    throw new HttpsError('permission-denied', 'Derived metadata is admitted only from trusted Firestore events.');
  id(entity.id, 'entity.id');
  const expectedType = kind.split('.')[0];
  if (['list', 'series', 'speaker', 'maintenance'].includes(expectedType) && entity.type !== expectedType)
    invalid('Entity type does not match the operation.');
  const payload = object(admission.payload);
  const source = { ...object(payload.input ?? {}) };
  const operation = typeof payload.operation === 'string' ? payload.operation : kind.split('.')[1];
  const requestedRemoteIDs =
    kind === 'series.membership' && ['remove', 'unpublish'].includes(operation)
      ? ids(source.mediaItemIds ?? (source.mediaItemId ? [source.mediaItemId] : []), 'mediaItemIds')
      : [];
  if (requestedRemoteIDs.length && Array.isArray(source.sermonIds) && !source.sermonIds.length) delete source.sermonIds;
  for (const field of [
    'operationKey',
    'listId',
    'rootListId',
    'firestoreSeriesId',
    'firestoreId',
    'seriesSubsplashId',
    'speakerId',
    'mediaItem',
    'adds',
    'mediaItemIds',
    'mediaItemId',
    'listIds',
    'itemIds',
    'listItemIds',
    'destinationListIds',
    'publishedItemOrder',
    'expectedRetainedMembershipHash',
  ])
    delete source[field];
  if (kind === 'series.membership' && ['remove', 'unpublish'].includes(operation))
    delete source.expectedRemoteMembershipHash;
  if (kind === 'speaker.mutate' && operation !== 'create') source.speakerId = entity.id;
  const hydrateImages = async (value: unknown) =>
    (await normalizeCanonicalPublishingPatch({ patch: { images: value }, firestore: db() })).images;
  if (source.images !== undefined) source.images = await hydrateImages(source.images);
  if (source.localList !== undefined) {
    const local = { ...object(source.localList) };
    if (local.images !== undefined) local.images = await hydrateImages(local.images);
    source.localList = local;
  }
  if (kind === 'speaker.mutate') {
    for (const field of ['speaker', 'patch'])
      if (source[field] !== undefined) {
        const details = { ...object(source[field]) };
        if (details.images !== undefined) details.images = await hydrateImages(details.images);
        source[field] = details;
      }
  }
  const normalized = normalizePublishingEntityPayload(kind, { operation, input: source });
  if (kind === 'maintenance.run') return normalized;
  if (kind === 'speaker.mutate' && operation === 'create' && role !== 'admin')
    throw new HttpsError('permission-denied', 'Speaker changes require administrator permission.');
  if (!['admin', 'publisher', 'uploader'].includes(role))
    throw new HttpsError('permission-denied', 'You do not have permission to change this entity.');
  const localSeriesAdd =
    kind === 'series.membership' && operation === 'add' && normalized.input.publishEligible !== true;
  if (role === 'uploader' && !localSeriesAdd && !(kind === 'series.create' && normalized.input.skipSubsplash === true))
    throw new HttpsError('permission-denied', 'Provider mutations require publish permission.');
  const collection = entity.type === 'series' ? 'series' : entity.type === 'speaker' ? 'speakers' : 'lists';
  const record = await db().collection(collection).doc(entity.id).get();
  if (!kind.endsWith('.create') && !(kind === 'speaker.mutate' && operation === 'create') && !record.exists)
    throw new HttpsError('not-found', 'The selected entity no longer exists.');
  if (entity.type === 'series' && record.exists && role !== 'admin' && record.data()?.ownerId !== actorUid)
    throw new HttpsError('permission-denied', 'You do not own this series.');
  const canonicalIds = normalized.input.sermonIds === undefined ? [] : ids(normalized.input.sermonIds, 'sermonIds');
  if (
    ['list.membership', 'list.publish', 'series.membership', 'series.publish'].includes(kind) &&
    !canonicalIds.length &&
    !requestedRemoteIDs.length
  )
    return invalid('Select canonical sermon IDs; provider IDs cannot authorize a mutation.');
  const input = { ...normalized.input };
  const sermons = await Promise.all(canonicalIds.map((sermonId) => db().collection('sermons').doc(sermonId).get()));
  for (const sermon of sermons) {
    if (!sermon.exists) throw new HttpsError('not-found', 'A selected sermon no longer exists.');
    if (localSeriesAdd && role !== 'admin' && sermon.data()?.uploaderId !== actorUid)
      throw new HttpsError('permission-denied', 'You do not own a selected sermon.');
  }
  if (kind === 'series.membership' && ['remove', 'unpublish'].includes(operation) && record.data()?.subsplashId) {
    const remote = await getAllSeriesItemsAcrossStatuses(record.data()!.subsplashId, await authenticateSubsplash());
    const selected = remote.filter((item) => requestedRemoteIDs.includes(item.id));
    if (selected.length !== requestedRemoteIDs.length)
      throw new HttpsError(
        'failed-precondition',
        'Selected remote rows no longer belong to this series. Refresh before removing them.'
      );
    const canonicalRows = await Promise.all(
      canonicalIds.map((sermonId) =>
        db().collection('series').doc(entity.id).collection('seriesItems').doc(sermonId).get()
      )
    );
    const canonicalRemoteIds = canonicalRows.flatMap((row) =>
      row.exists && row.data()?.publishedToSubsplash === true && typeof row.data()?.sermonSubsplashId === 'string'
        ? [row.data()!.sermonSubsplashId as string]
        : []
    );
    const removing = new Set([...selected.map((item) => item.id), ...canonicalRemoteIds]);
    if (removing.size) input.mediaItemIds = ids([...removing], 'selected remote rows');
    input.expectedRetainedMembershipHash = providerPayloadFingerprint(
      remote
        .filter((item) => !removing.has(item.id))
        .map((item) => item.id)
        .sort()
    );
  } else if (requestedRemoteIDs.length)
    throw new HttpsError('failed-precondition', 'The selected series is not linked to provider rows.');
  if (kind === 'series.reorder') {
    const localOrder = Array.isArray(input.localItemOrder)
      ? (input.localItemOrder as Array<{ sermonId?: string; id?: string; position: number }>)
      : [];
    if (!localOrder.length) return invalid('Canonical sermon order is required.');
    const rows = await db().collection('series').doc(entity.id).collection('seriesItems').get();
    const verifiedOrder = [];
    for (const entry of localOrder) {
      const row = rows.docs.find((doc) => doc.id === (entry.sermonId ?? entry.id));
      if (!row) throw new HttpsError('failed-precondition', 'Series membership changed.');
      if (row.data().publishedToSubsplash && typeof row.data().sermonSubsplashId === 'string')
        verifiedOrder.push({ mediaItemId: row.data().sermonSubsplashId, position: entry.position });
    }
    input.itemOrder = verifiedOrder;
  }
  if (kind === 'list.reorder' && Array.isArray(input.logicalItemOrder)) {
    const rows = await db().collection('lists').doc(entity.id).collection('listItems').get();
    input.logicalItemOrder = await Promise.all(
      (input.logicalItemOrder as Array<{ sermonId?: string; position: number }>).map(async (entry) => {
        const sermonId = id(entry.sermonId, 'logicalItemOrder.sermonId');
        const row = rows.docs.find((doc) => doc.id === sermonId);
        if (!row) throw new HttpsError('failed-precondition', 'List membership changed.');
        const sermon = await db().collection('sermons').doc(sermonId).get();
        return {
          sermonId,
          position: entry.position,
          ...(typeof sermon.data()?.subsplashId === 'string' ? { mediaItemId: sermon.data()!.subsplashId } : {}),
        };
      })
    );
  }
  return Object.freeze({ operation, input: Object.freeze(input) });
}

async function executeDerivedSeriesSync(
  ref: DurableJobRef,
  intent: PublishingEntityIntent,
  options: PublishingEntityExecutionOptions
): Promise<Record<string, unknown>> {
  const seriesRef = db().collection('series').doc(id(intent.entity.id, 'entity.id'));
  let state: { subsplashId: string; metadata: ReturnType<typeof deriveSeriesMetadata> } | undefined;
  const derive = async () =>
    commitEntityProjection(ref, options, async (tx) => {
      const series = await tx.get(seriesRef);
      if (!series.exists) {
        state = undefined;
        return;
      }
      const rows = seriesRef.collection('seriesItems');
      const [total, published] = await Promise.all([
        tx.get(rows.count()),
        tx.get(rows.where('publishedToSubsplash', '==', true).count()),
      ]);
      const metadata = {
        itemCount: total.data().count,
        publishedItemCount: published.data().count,
        subtitle: getSeriesSubtitleFromPublishedCount(published.data().count),
      };
      state = {
        subsplashId: typeof series.data()?.subsplashId === 'string' ? series.data()!.subsplashId : '',
        metadata,
      };
      if (
        series.data()?.subtitle !== metadata.subtitle ||
        series.data()?.publishedItemCount !== metadata.publishedItemCount ||
        series.data()?.itemCount !== metadata.itemCount
      )
        tx.update(seriesRef, { ...metadata, updatedAt: FieldValue.serverTimestamp() });
    });
  await derive();
  if (!state?.subsplashId) return { seriesId: intent.entity.id };
  const remoteId = state.subsplashId;
  await withSubsplashLocks(
    [`series:${remoteId}`],
    async () => {
      await options.assertCurrent?.(ref, intent);
      await derive();
      if (!state?.subsplashId || state.subsplashId !== remoteId)
        throw new HttpsError('aborted', 'Series identity changed during metadata synchronization.');
      await beginEntityMutationPlan(ref, intent, options);
      await patchSeriesMetadata(remoteId, { subtitle: state.metadata.subtitle }, await authenticateSubsplash());
      const acknowledgedMetadata = state.metadata;
      await commitFinalEntityProjection(ref, options, async (tx) => {
        const latest = await tx.get(seriesRef);
        if (!latest.exists || latest.data()?.subsplashId !== remoteId)
          throw new HttpsError('aborted', 'Series identity changed during metadata synchronization.');
        tx.update(seriesRef, { ...acknowledgedMetadata, updatedAt: FieldValue.serverTimestamp() });
      });
    },
    { operationKey: operationKey(ref, 'derived-metadata') }
  );
  return { seriesId: intent.entity.id };
}
