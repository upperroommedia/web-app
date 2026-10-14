import { prepareSpeakerDeletionMirrors, removeSpeakerDeletionMirrors, type SpeakerDeletionMirrorHandle } from '../helpers/speakerDeletionMirrors';
import { assertSynchronousProviderMutationCompleted } from '../temporal/publishing/providerMutationCompletion';
import {markPublishingCritical, getPublishingMutationOperation, runPublishingProviderMutation, prepareProviderMutationPlanCommit, prepareAcknowledgedProjectionPlan, publishingMutationRequestFingerprint} from '../temporal/publishing/durableOperationContext';
import {reserveSubsplashAssociation} from '../temporal/publishing/providerAssociations';
import axios from '../providerSandbox/http';
import { isAxiosError } from 'axios';
import { isDurablePublishingOperation, runDurableTransaction, commitDurableProjection } from '../temporal/publishing/durableOperationContext';
import { executeProviderCreate, providerPayloadFingerprint,providerReceiptId } from '../temporal/publishing/providerReceipts';
import {acknowledgedProjectionDigest} from '../temporal/publishing/criticalAcknowledgedRepair';
import {repairMismatchedSubsplashImageRefs} from '../helpers/subsplashImageRefs';
import {getDurablePublishingJobId} from '../temporal/publishing/durableOperationContext';
import {inferProviderReceiptScope,PROVIDER_RECEIPTS_COLLECTION,type ProviderReceipt} from '../temporal/publishing/providerReceipts';
import type {Firestore,Transaction} from 'firebase-admin/firestore';
import type { FrozenProjectionWrite } from '../temporal/publishing/criticalAcknowledgedRepair';
import type { ProviderMutationResource } from '../temporal/publishing/providerMutationGuard';
import { DocumentReference, DocumentSnapshot } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { ImageType } from '@upperroom/shared/types/Image';
import { ISpeaker } from '@upperroom/shared/types/Speaker';
import { List, ListType, OverflowBehavior } from '@upperroom/shared/types/List';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { firestoreAdminListConverter, firestoreAdminSpeakerConverter } from '../firestoreDataConverter';
import { createNewSubsplashList } from '../createNewSubsplashList';
import { authenticateSubsplash, createAxiosConfig } from '../subsplashUtils';
import { withIdempotency } from '../locks/withIdempotency';
import { withSubsplashLocks } from '../locks/withSubsplashLocks';
import { buildRootListMetadata } from '../helpers/listOverflowChain';
import { deleteLogicalListChain } from '../helpers/deleteLogicalListChain';
import {
  CreateSpeakerCallableInputType,
  CreateSpeakerCallableOutputType,
  DeleteSpeakerCallableInputType,
  DeleteSpeakerCallableOutputType,
  UpdateSpeakerCallableInputType,
  UpdateSpeakerCallableOutputType,
} from './createSpeakerTypes';

const synchronousMutationData = <T>(response: { status?: unknown; data: T }): T => {
  assertSynchronousProviderMutationCompleted(response);
  return response.data;
};

const firestore = firebaseAdmin.firestore();
const speakersCollection = firestore.collection('speakers').withConverter(firestoreAdminSpeakerConverter);
const listsCollection = firestore.collection('lists').withConverter(firestoreAdminListConverter);

interface PreparedSpeakerListType {
  listRef: DocumentReference<List>;
  list: List;
}

interface CreateSubsplashSpeakerTagInputType {
  tagId?: string;
  title: string;
  squareImage: ImageType;
  shortDescription?: string;
  description?: string;
  operationKey?: string;
}

interface CreateSubsplashSpeakerTagOutputType {
  tagId: string;
}

interface SubsplashSpeakerTagSummaryType {
  id: string;
  title: string;
}

interface UpdateSubsplashSpeakerTagImageInputType {
  tagId: string;
  squareImage: ImageType;
  operationKey?: string;
}

interface SpeakerProjectionSource {
  speakerId?: string;
}

// Server source identities are supplied by speaker CRUD, never by a free-form patch.
// Standalone tag/image operations must resolve exactly one current canonical owner.
const freezeSpeakerTagProjection = async (
  target: ProviderMutationResource & {provider:'subsplash';resourceType:'tag'},
  step: string,
  method: 'PATCH' | 'DELETE',
  payload: Record<string, unknown>,
  source: SpeakerProjectionSource,
  patchFor: (current: ISpeaker) => Record<string, unknown>
): Promise<void> => {
  if (!isDurablePublishingOperation()) return;
  const operation = getPublishingMutationOperation();
  if (!operation) throw new Error('PROVIDER_ACK_PROJECTION_OPERATION_REQUIRED');
  let canonicalId = source.speakerId;
  if (!canonicalId) {
    const owners = await speakersCollection.where('tagId', '==', target.resourceId).limit(2).get();
    if (owners.size !== 1) throw new Error('PROVIDER_ACK_PROJECTION_CANONICAL_OWNER_REQUIRED');
    canonicalId = owners.docs[0].id;
  }
  const ref = speakersCollection.doc(canonicalId);
  await runDurableTransaction(firestore, async tx => {
    const current = await tx.get(ref);
    const data = current.data();
    if (!current.exists || !data || data.tagId !== target.resourceId) {
      throw new Error('PROVIDER_ACK_PROJECTION_CANONICAL_IDENTITY_CHANGED');
    }
    const patch = method === 'DELETE' ? {} : patchFor(data);
    const original = data as unknown as Record<string, unknown>;
    const expectedFields = {tagId:target.resourceId,...Object.fromEntries(Object.keys(patch).filter(key=>original[key]!==undefined).map(key=>[key,original[key]]))};
    const absentFields = Object.keys(patch).filter(key=>original[key]===undefined);
    const write: FrozenProjectionWrite = {
      path: ref.path, expectedFields, ...(absentFields.length ? {absentFields} : {}),
      patch,
      ...(method === 'DELETE' ? { deleteFields: ['tagId'] } : {}),
    };
    const freeze = await prepareAcknowledgedProjectionPlan(tx, {
      operation, completesActivity: false,
      requests: [{ step, method, target, payload, fingerprint: publishingMutationRequestFingerprint({method,target,payload}) }],
      writes: [write],
      verifications: [{ ...target,
        ...(method === 'DELETE' ? { expectedState: 'absent' as const, expectedProviderFields: {} } : {
          expectedProviderFields: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'app_key')),
        }),
      }],
    });
    freeze.commit();
  });
};

const freezeSpeakerListProjection = async (
  listId: string, step: string, payload: Record<string, unknown>, speakerName: string, images: ImageType[], canonicalListId?: string,
  speakerProjection?: {speakerId:string;requiredTagStep?:string}
): Promise<void> => {
  if (!isDurablePublishingOperation()) return;
  const operation = getPublishingMutationOperation();
  if (!operation) throw new Error('PROVIDER_ACK_PROJECTION_OPERATION_REQUIRED');
  let ref: DocumentReference<List>;
  if (canonicalListId) ref = listsCollection.doc(canonicalListId);
  else {
    const owners = await listsCollection.where('subsplashId', '==', listId).limit(2).get();
    if (owners.size !== 1) throw new Error('PROVIDER_ACK_PROJECTION_CANONICAL_OWNER_REQUIRED');
    ref = owners.docs[0].ref;
  }
  const target = {provider:'subsplash' as const,account:'app:9XTSHD',resourceType:'list' as const,resourceId:listId};
  await runDurableTransaction(firestore, async tx => {
    const current = await tx.get(ref);
    if (!current.exists || current.data()?.subsplashId !== listId) throw new Error('PROVIDER_ACK_PROJECTION_CANONICAL_IDENTITY_CHANGED');
    const writes: FrozenProjectionWrite[] = [{path:ref.path,expectedFields:{subsplashId:listId,...(current.data()?.name!==undefined?{name:current.data()!.name}:{}),...(current.data()?.images!==undefined?{images:current.data()!.images}:{})},patch:{name:speakerName,images}}];
    if (speakerProjection) {
      const speakerRef = speakersCollection.doc(speakerProjection.speakerId);
      const speaker = await tx.get(speakerRef);
      const data = speaker.data();
      if (!speaker.exists || !data || data.listId !== ref.id) throw new Error('PROVIDER_ACK_PROJECTION_CANONICAL_IDENTITY_CHANGED');
      writes.push({path:speakerRef.path,expectedFields:{listId:ref.id,name:data.name,images:data.images},
        requiredSteps:[...(speakerProjection.requiredTagStep?[speakerProjection.requiredTagStep]:[]),step],
        patch:{name:speakerName,images}});
    }
    const freeze = await prepareAcknowledgedProjectionPlan(tx, {
      operation, completesActivity: false,
      requests: [{ step, method:'PATCH', target, payload, fingerprint:publishingMutationRequestFingerprint({method:'PATCH',target,payload}) }],
      writes,
      verifications: [{...target,expectedProviderFields:Object.fromEntries(Object.entries(payload).filter(([key])=>key!=='app_key'))}],
    });
    freeze.commit();
  });
};

const MAX_SUBSPLASH_SPEAKER_NAME_LENGTH = 30;

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new HttpsError('invalid-argument', 'Expected a string value.');
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeOptionalNullableString = (value: unknown, fieldName: string): string | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new HttpsError('invalid-argument', `${fieldName} must be a string or null.`);
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const resolveExplicitBoolean = (value: unknown, fieldName: string): boolean => {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new HttpsError('invalid-argument', `${fieldName} must be a boolean when provided.`);
  }
  return value;
};

export const normalizeSpeakerNameForDuplicateCheck = (name: string): string => {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
};

export const requireTrimmedSpeakerName = (name: unknown, fieldName = 'speaker.name'): string => {
  if (typeof name !== 'string') {
    throw new HttpsError('invalid-argument', `${fieldName} must be a string.`);
  }

  const trimmed = name.trim();
  if (!trimmed) {
    throw new HttpsError('invalid-argument', `${fieldName} is required.`);
  }
  if (trimmed.length > MAX_SUBSPLASH_SPEAKER_NAME_LENGTH) {
    throw new HttpsError(
      'invalid-argument',
      `${fieldName} must be ${MAX_SUBSPLASH_SPEAKER_NAME_LENGTH} characters or fewer.`
    );
  }

  return trimmed;
};

export const requireSquareImage = (images: unknown, fieldName = 'speaker.images'): ImageType => {
  if (!Array.isArray(images)) {
    throw new HttpsError('invalid-argument', `${fieldName} must be an array.`);
  }

  const squareImage = images.find((image) => image && typeof image === 'object' && image.type === 'square');
  if (!squareImage) {
    throw new HttpsError('invalid-argument', 'A square image is required.');
  }

  return squareImage as ImageType;
};

export const parseCreateSpeakerInput = (input: unknown): CreateSpeakerCallableInputType => {
  if (!input || typeof input !== 'object') {
    throw new HttpsError('invalid-argument', 'Request data is required.');
  }

  const payload = input as Record<string, unknown>;
  const speakerPayload = payload.speaker;

  if (!speakerPayload || typeof speakerPayload !== 'object') {
    throw new HttpsError('invalid-argument', 'speaker payload is required.');
  }

  const speakerRecord = speakerPayload as Record<string, unknown>;
  const name = requireTrimmedSpeakerName(speakerRecord.name);
  const images = Array.isArray(speakerRecord.images) ? (speakerRecord.images as ImageType[]) : undefined;
  requireSquareImage(images);

  const createSpeakerList = resolveExplicitBoolean(payload.createSpeakerList, 'createSpeakerList');
  const associatedListId = normalizeOptionalString(payload.associatedListId);
  if (createSpeakerList && associatedListId) {
    throw new HttpsError(
      'invalid-argument',
      'createSpeakerList and associatedListId cannot be used together.'
    );
  }

  const operationKey = normalizeOptionalString(payload.operationKey);
  const shortDescription = normalizeOptionalString(speakerRecord.shortDescription);
  const description = normalizeOptionalString(speakerRecord.description);

  return {
    speaker: {
      name,
      images: images ?? [],
      ...(shortDescription ? { shortDescription } : {}),
      ...(description ? { description } : {}),
    },
    createSpeakerList,
    ...(associatedListId ? { associatedListId } : {}),
    ...(operationKey ? { operationKey } : {}),
  };
};

export const parseUpdateSpeakerInput = (input: unknown): UpdateSpeakerCallableInputType => {
  if (!input || typeof input !== 'object') {
    throw new HttpsError('invalid-argument', 'Request data is required.');
  }

  const payload = input as Record<string, unknown>;
  const speakerId = normalizeOptionalString(payload.speakerId);
  if (!speakerId) {
    throw new HttpsError('invalid-argument', 'speakerId is required.');
  }

  const patchValue = payload.patch;
  if (!patchValue || typeof patchValue !== 'object') {
    throw new HttpsError('invalid-argument', 'patch payload is required.');
  }

  const patch = patchValue as Record<string, unknown>;
  const createSpeakerList = resolveExplicitBoolean(payload.createSpeakerList, 'createSpeakerList');
  const deleteAssociatedList = resolveExplicitBoolean(payload.deleteAssociatedList, 'deleteAssociatedList');
  const operationKey = normalizeOptionalString(payload.operationKey);
  const name = patch.name === undefined ? undefined : requireTrimmedSpeakerName(patch.name, 'patch.name');
  const images = patch.images === undefined ? undefined : (patch.images as ImageType[]);
  const hasShortDescription = Object.prototype.hasOwnProperty.call(patch, 'shortDescription');
  const shortDescription = hasShortDescription
    ? normalizeOptionalNullableString(patch.shortDescription, 'patch.shortDescription')
    : undefined;
  const hasDescription = Object.prototype.hasOwnProperty.call(patch, 'description');
  const description = hasDescription
    ? normalizeOptionalNullableString(patch.description, 'patch.description')
    : undefined;
  const associatedListIdRaw = patch.associatedListId;
  const associatedListId = associatedListIdRaw === null
    ? null
    : normalizeOptionalString(associatedListIdRaw);

  if (images !== undefined) {
    requireSquareImage(images, 'patch.images');
  }

  if (createSpeakerList && associatedListId !== undefined) {
    throw new HttpsError(
      'invalid-argument',
      'createSpeakerList cannot be used with patch.associatedListId.'
    );
  }

  if (
    name === undefined &&
    images === undefined &&
    shortDescription === undefined &&
    description === undefined &&
    associatedListId === undefined &&
    !createSpeakerList &&
    !deleteAssociatedList
  ) {
    throw new HttpsError('invalid-argument', 'At least one patch field is required.');
  }

  return {
    speakerId,
    patch: {
      ...(name !== undefined ? { name } : {}),
      ...(images !== undefined ? { images } : {}),
      ...(shortDescription !== undefined ? { shortDescription } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(associatedListId !== undefined ? { associatedListId } : {}),
    },
    createSpeakerList,
    deleteAssociatedList,
    ...(operationKey ? { operationKey } : {}),
  };
};

export const parseDeleteSpeakerInput = (input: unknown): DeleteSpeakerCallableInputType => {
  if (!input || typeof input !== 'object') {
    throw new HttpsError('invalid-argument', 'Request data is required.');
  }

  const payload = input as Record<string, unknown>;
  const speakerId = normalizeOptionalString(payload.speakerId);
  if (!speakerId) {
    throw new HttpsError('invalid-argument', 'speakerId is required.');
  }

  const deleteAssociatedList = resolveExplicitBoolean(payload.deleteAssociatedList, 'deleteAssociatedList');
  const operationKey = normalizeOptionalString(payload.operationKey);

  return {
    speakerId,
    deleteAssociatedList,
    ...(operationKey ? { operationKey } : {}),
  };
};

const runWithOptionalIdempotency = async <T>(operationKey: string | undefined, run: () => Promise<T>): Promise<T> => {
  if (operationKey) {
    return withIdempotency(operationKey, run);
  }
  return run();
};

const scopeOperationKey = (operationKey: string | undefined, suffix: string): string | undefined => {
  if (!operationKey) {
    return undefined;
  }
  return `${operationKey}:${suffix}`;
};

const assertListExists = async (listId: string): Promise<void> => {
  const snapshot = await listsCollection.doc(listId).get();
  if (!snapshot.exists) {
    throw new HttpsError('invalid-argument', `associatedListId ${listId} does not exist.`);
  }
};

const assertSpeakerNameUnique = async (speakerName: string, excludeSpeakerId?: string): Promise<void> => {
  const normalizedName = normalizeSpeakerNameForDuplicateCheck(speakerName);
  const snapshot = await speakersCollection.get();

  const duplicate = snapshot.docs.find((docSnapshot) => {
    const speaker = docSnapshot.data();
    if (excludeSpeakerId && speaker.id === excludeSpeakerId) {
      return false;
    }
    return normalizeSpeakerNameForDuplicateCheck(speaker.name) === normalizedName;
  });

  if (duplicate) {
    throw new HttpsError('already-exists', `Speaker "${speakerName}" already exists.`);
  }
};

const prepareSpeakerList = async (
  speakerName: string,
  images: ImageType[],
  operationKey?: string
): Promise<PreparedSpeakerListType> => {
  const createResult = await createNewSubsplashList({
    title: speakerName,
    images,
    ...(operationKey ? { operationKey } : {}),
  });

  const listRef = isDurablePublishingOperation() && operationKey
    ? listsCollection.doc(providerPayloadFingerprint([operationKey,'local-speaker-list']).slice(0,32))
    : listsCollection.doc();
  const existingList=isDurablePublishingOperation()?await listRef.get():undefined;
  const now = Date.now();
  return {
    listRef,
    list: {
      id: listRef.id,
      name: speakerName,
      images,
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 0,
      type: ListType.SPEAKER_LIST,
      createdAtMillis: existingList?.data()?.createdAtMillis ?? now,
      updatedAtMillis: now,
      subsplashId: createResult.listId,
      ...buildRootListMetadata({
        rootListId: listRef.id,
        logicalCount: 0,
        hasOverflowPages: false,
      }),
    },
  };
};

const toSubsplashImageReference = (image: ImageType, fieldName: string): { id: string; type: ImageType['type'] } => {
  const remoteImageId = image.subsplashId || image.id;
  if (!remoteImageId) {
    throw new HttpsError('invalid-argument', `${fieldName} is missing a remote image id.`);
  }

  return {
    id: remoteImageId,
    type: image.type,
  };
};

const normalizeSlug = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

const getCreateSpeakerTagLockKey = (title: string): string => {
  return `tag:create-speaker-${normalizeSlug(title) || 'untitled'}`;
};

const getUpdateSpeakerTagLockKey = (tagId: string): string => {
  return `tag:update-speaker-${tagId}`;
};

const SPEAKER_TAG_RETRY_ATTEMPTS = 3;
const SPEAKER_TAG_RETRY_BASE_DELAY_MS = 400;
const SPEAKER_TAG_RETRY_MAX_DELAY_MS = 5000;
const SUBSPLASH_SPEAKER_PAGE_SIZE = 100;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const getAxiosStatusCode = (error: unknown): number | undefined => (
  error && typeof error === 'object' && 'response' in error
    ? (error as { response?: { status?: number } }).response?.status
    : undefined
);

const getRetryAfterDelayMs = (error: unknown): number | undefined => {
  if (!(error && typeof error === 'object' && 'response' in error)) {
    return undefined;
  }

  const headers = (error as { response?: { headers?: Record<string, unknown> } }).response?.headers;
  if (!headers) {
    return undefined;
  }

  const retryAfter = headers['retry-after'];
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
    return retryAfter * 1000;
  }
  if (typeof retryAfter === 'string') {
    const numeric = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(numeric)) {
      return numeric * 1000;
    }
  }

  return undefined;
};

const shouldRetrySubsplashRequest = (status?: number): boolean => (
  status === 429 || status === 408 || status === 500 || status === 502 || status === 503 || status === 504
);

const withSubsplashSpeakerRetry = async <T>(
  operationName: string,
  requestFn: () => Promise<T>
): Promise<T> => {
  let attempt = 0;

  while (true) {
    try {
      return await requestFn();
    } catch (error) {
      const status = getAxiosStatusCode(error);
      if (!shouldRetrySubsplashRequest(status) || attempt >= SPEAKER_TAG_RETRY_ATTEMPTS) {
        throw error;
      }

      const retryAfterMs = getRetryAfterDelayMs(error);
      const computedBackoffMs = Math.min(
        SPEAKER_TAG_RETRY_BASE_DELAY_MS * (2 ** attempt),
        SPEAKER_TAG_RETRY_MAX_DELAY_MS
      );
      const delayMs = retryAfterMs ?? computedBackoffMs;

      logger.warn(`Subsplash ${operationName} received retryable status ${status}; retrying`, {
        operationName,
        status,
        attempt: attempt + 1,
        maxAttempts: SPEAKER_TAG_RETRY_ATTEMPTS + 1,
        delayMs,
      });

      await sleep(delayMs);
      attempt += 1;
    }
  }
};

const getSubsplashErrorCode = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const errors = (payload as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return undefined;
  }

  const firstError = errors[0];
  if (!firstError || typeof firstError !== 'object') {
    return undefined;
  }

  const code = (firstError as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

const findSubsplashSpeakerTagByTitle = async (
  title: string,
  accessToken: string
): Promise<SubsplashSpeakerTagSummaryType | undefined> => {
  const normalizedTitle = normalizeSpeakerNameForDuplicateCheck(title);
  let pageNumber = 1;
  let retrievedCount = 0;

  while (true) {
    const url =
      'https://core.subsplash.com/tags/v1/tags' +
      '?filter%5Bapp_key%5D=9XTSHD' +
      '&filter%5Btype%5D=speaker' +
      `&page%5Bnumber%5D=${pageNumber}` +
      `&page%5Bsize%5D=${SUBSPLASH_SPEAKER_PAGE_SIZE}` +
      '&sort=title';
    const config = createAxiosConfig(url, accessToken, 'GET', undefined, {
      'collection-total': 'include',
    });
    const response = (await withSubsplashSpeakerRetry(
      'findSpeakerTagByTitle',
      () => axios(config)
    )).data as {
      count?: unknown;
      total?: unknown;
      _embedded?: { tags?: unknown };
    };
    const tags = Array.isArray(response._embedded?.tags)
      ? response._embedded.tags
      : [];

    const match = tags.find((candidate): candidate is SubsplashSpeakerTagSummaryType => {
      if (!candidate || typeof candidate !== 'object') {
        return false;
      }
      const record = candidate as { id?: unknown; title?: unknown };
      return (
        typeof record.id === 'string' &&
        typeof record.title === 'string' &&
        normalizeSpeakerNameForDuplicateCheck(record.title) === normalizedTitle
      );
    });
    if (match) {
      return match;
    }

    const responseCount = typeof response.count === 'number'
      ? response.count
      : tags.length;
    const total = typeof response.total === 'number'
      ? response.total
      : undefined;
    retrievedCount += responseCount;

    if (
      tags.length === 0 ||
      (total !== undefined && retrievedCount >= total) ||
      (total === undefined && tags.length < SUBSPLASH_SPEAKER_PAGE_SIZE)
    ) {
      return undefined;
    }

    pageNumber += 1;
  }
};

export const createSubsplashSpeakerTag = async (
  input: CreateSubsplashSpeakerTagInputType,
  projectionSource: SpeakerProjectionSource = {}
): Promise<CreateSubsplashSpeakerTagOutputType> => {
  const buildPayload = () => ({
      app_key: '9XTSHD',
      type: 'speaker',
      title: input.title,
      short_description: input.shortDescription ?? '',
      description: input.description ?? '',
      _embedded: {
        'square-image': toSubsplashImageReference(input.squareImage, 'squareImage'),
      },
  });
  const runMutation = async (): Promise<CreateSubsplashSpeakerTagOutputType> => {
    const url = input.tagId
      ? `https://core.subsplash.com/tags/v1/tags/${input.tagId}`
      : 'https://core.subsplash.com/tags/v1/tags';
    const payload = buildPayload();

    const accessToken = await authenticateSubsplash();
    if (input.tagId) await freezeSpeakerTagProjection(
      {provider:'subsplash',account:'app:9XTSHD',resourceType:'tag',resourceId:input.tagId},
      `speaker-tag-patch:${input.tagId}:${providerPayloadFingerprint(payload)}`, 'PATCH', payload, projectionSource,
      current => ({name:input.title,shortDescription:payload.short_description,description:payload.description,
        images:[...current.images.filter(image=>image.type!=='square'),input.squareImage]}),
    );
    if(input.tagId)await markPublishingCritical('PUBLISHING_ASSOCIATION_CRITICAL',{provider:'subsplash',resourceType:'tag',resourceId:input.tagId!,accountId:'app:9XTSHD',method:'PATCH',requestFingerprint:providerPayloadFingerprint(payload)});
    await reserveSubsplashAssociation(`tagimage:${input.tagId??input.operationKey??input.title}`,[input.tagId,payload._embedded['square-image'].id],payload,input.tagId?{target:{provider:'subsplash',kind:'tag',remoteId:input.tagId}}:input.operationKey?{targetReceiptId:providerReceiptId(input.operationKey,'speaker-tag-create')}:{});
    const config = createAxiosConfig(url, accessToken, input.tagId ? 'PATCH' : 'POST', payload);
    if (!input.tagId) Object.assign(config, { skipSubsplashEdgeRetry: true });
    let response: { id?: unknown };
    try {
      response = (input.tagId ? await runPublishingProviderMutation({operation:getPublishingMutationOperation() ?? 'createSpeakerTag',target:{provider:'subsplash',account:'app:9XTSHD',resourceType:'tag',resourceId:input.tagId!},step:`speaker-tag-patch:${input.tagId}:${providerPayloadFingerprint(payload)}`,method:'PATCH',payload,send:async()=>{const response=synchronousMutationData<{id?:unknown}>(await axios(Object.assign(config,{skipSubsplashEdgeRetry:true})));return {completion:'acknowledged',result:{id:typeof response?.id==='string'?response.id:input.tagId}};}}) : (await axios(config)).data) as { id?: unknown };
    } catch (error) {
      if (input.tagId || isDurablePublishingOperation() || getAxiosStatusCode(error) !== 400) {
        throw error;
      }

      const existingTag = await findSubsplashSpeakerTagByTitle(input.title, accessToken);
      if (!existingTag) {
        throw error;
      }

      logger.warn('Reusing an existing Subsplash speaker tag that is missing from Firestore', {
        speakerTitle: input.title,
        tagId: existingTag.id,
      });

      const reconcileConfig = createAxiosConfig(
        `https://core.subsplash.com/tags/v1/tags/${existingTag.id}`,
        accessToken,
        'PATCH',
        payload
      );
      await freezeSpeakerTagProjection({provider:'subsplash',account:'app:9XTSHD',resourceType:'tag',resourceId:existingTag.id},
        `speaker-tag-reconcile:${existingTag.id}:${providerPayloadFingerprint(payload)}`, 'PATCH', payload, projectionSource,
        current => ({name:input.title,shortDescription:payload.short_description,description:payload.description,images:[...current.images.filter(image=>image.type!=='square'),input.squareImage]}));
      await markPublishingCritical('PUBLISHING_ASSOCIATION_CRITICAL',{provider:'subsplash',resourceType:'tag',resourceId:existingTag.id,accountId:'app:9XTSHD',method:'PATCH',requestFingerprint:providerPayloadFingerprint(payload)});
      await runPublishingProviderMutation({operation:getPublishingMutationOperation() ?? 'reconcileExistingSpeakerTag',target:{provider:'subsplash',account:'app:9XTSHD',resourceType:'tag',resourceId:existingTag.id},step:`speaker-tag-reconcile:${existingTag.id}:${providerPayloadFingerprint(payload)}`,method:'PATCH',payload,send:async()=>{synchronousMutationData(await axios(Object.assign(reconcileConfig,{skipSubsplashEdgeRetry:true})));return {completion:'acknowledged',result:null};}});
      response = { id: existingTag.id };
    }
    const tagId = typeof response.id === 'string' ? response.id : input.tagId || '';
    if (!tagId) {
      throw new HttpsError('internal', 'Subsplash did not return a tag id.');
    }

    return { tagId };
  };

  const guardedMutation = input.operationKey && !input.tagId
    ? () => executeProviderCreate({ operationKey: input.operationKey!, step: 'speaker-tag-create', payload: {title:input.title,squareImage:input.squareImage,shortDescription:input.shortDescription,description:input.description},prepare:async()=>{const payload=buildPayload();await reserveSubsplashAssociation(`tagimage:${input.operationKey}`,[payload._embedded['square-image'].id],payload,{targetReceiptId:providerReceiptId(input.operationKey!,'speaker-tag-create')});}, execute: runMutation })
    : runMutation;
  return withSubsplashLocks([getCreateSpeakerTagLockKey(input.title)], guardedMutation, {
    ...(input.operationKey ? { operationKey: input.operationKey } : {}),
  });
};

export const updateSubsplashSpeakerTagSquareImage = async (
  input: UpdateSubsplashSpeakerTagImageInputType,
  projectionSource: SpeakerProjectionSource = {}
): Promise<void> => {
  const runMutation = async (): Promise<void> => {
    const url = `https://core.subsplash.com/tags/v1/tags/${input.tagId}`;
    const payload = {
      app_key: '9XTSHD',
      _embedded: {
        'square-image': toSubsplashImageReference(input.squareImage, 'squareImage'),
      },
    };

    await freezeSpeakerTagProjection({provider:'subsplash',account:'app:9XTSHD',resourceType:'tag',resourceId:input.tagId},
      `speaker-tag-image-patch:${input.tagId}:${providerPayloadFingerprint(payload)}`, 'PATCH', payload, projectionSource,
      current => ({images:[...current.images.filter(image=>image.type!=='square'),input.squareImage]}));
    await markPublishingCritical('PUBLISHING_ASSOCIATION_CRITICAL',{provider:'subsplash',resourceType:'tag',resourceId:input.tagId,accountId:'app:9XTSHD',method:'PATCH',requestFingerprint:providerPayloadFingerprint(payload)});
    await reserveSubsplashAssociation(`tagimage:${input.tagId}`,[input.tagId,payload._embedded['square-image'].id],payload,{target:{provider:'subsplash',kind:'tag',remoteId:input.tagId}});
    const config = createAxiosConfig(url, await authenticateSubsplash(), 'PATCH', payload);
    await runPublishingProviderMutation({operation:getPublishingMutationOperation() ?? 'updateSpeakerTagSquareImage',target:{provider:'subsplash',account:'app:9XTSHD',resourceType:'tag',resourceId:input.tagId},step:`speaker-tag-image-patch:${input.tagId}:${providerPayloadFingerprint(payload)}`,method:'PATCH',payload,send:async()=>{synchronousMutationData(await axios(Object.assign(config,{skipSubsplashEdgeRetry:true})));return {completion:'acknowledged',result:null};}});
  };

  await withSubsplashLocks([getUpdateSpeakerTagLockKey(input.tagId)], runMutation, {
    ...(input.operationKey ? { operationKey: input.operationKey } : {}),
  });
};

const syncSubsplashSpeakerListRemote = async (
  subsplashListId: string,
  speakerName: string,
  images: ImageType[],
  operationKey?: string,
  canonicalListId?: string,
  speakerProjection?: {speakerId:string;requiredTagStep?:string}
): Promise<void> => {
  const runMutation = async (): Promise<void> => {
    const url = `https://core.subsplash.com/builder/v1/lists/${subsplashListId}`;
    const payload = {
      app_key: '9XTSHD',
      title: speakerName,
      _embedded: {
        images: images.map((image) => toSubsplashImageReference(image, `images.${image.type}`)),
      },
    };
    await freezeSpeakerListProjection(subsplashListId,`syncSubsplashSpeakerListRemote:${subsplashListId}:${providerPayloadFingerprint(payload)}`,payload,speakerName,images,canonicalListId,speakerProjection);
    await markPublishingCritical('PUBLISHING_ASSOCIATION_CRITICAL',{provider:'subsplash',resourceType:'list',resourceId:subsplashListId,accountId:'app:9XTSHD',method:'PATCH',requestFingerprint:providerPayloadFingerprint(payload)});
    await reserveSubsplashAssociation(`speakerlistimages:${subsplashListId}`,[subsplashListId,...payload._embedded.images.map(image=>image.id)],payload,{target:{provider:'subsplash',kind:'list',remoteId:subsplashListId}});
    const config = createAxiosConfig(url, await authenticateSubsplash(), 'PATCH', payload);
    await runPublishingProviderMutation({operation:getPublishingMutationOperation() ?? 'syncSubsplashSpeakerListRemote',target:{provider:'subsplash',account:'app:9XTSHD',resourceType:'list',resourceId:subsplashListId},step:`syncSubsplashSpeakerListRemote:${subsplashListId}:${providerPayloadFingerprint(payload)}`,method:'PATCH',payload:payload,send:async()=>{synchronousMutationData(await axios(Object.assign(config,{skipSubsplashEdgeRetry:true})));return {completion:'acknowledged',result:null};}});
  };

  const runLockedMutation = async (): Promise<void> => {
    return withSubsplashLocks([`list:${subsplashListId}`], runMutation, {
      ...(operationKey ? { operationKey } : {}),
    });
  };

  if (operationKey) {
    await withIdempotency(operationKey, runLockedMutation);
    return;
  }
  await runLockedMutation();
};

const deleteSubsplashTagRemote = async (subsplashTagId: string, operationKey?: string, projectionSource: SpeakerProjectionSource = {}): Promise<{sermonsUpdated:number;listMirrorsUpdated:number;seriesMirrorsUpdated:number}|undefined> => {
  let mirrors: SpeakerDeletionMirrorHandle | undefined;
  if (isDurablePublishingOperation()) {
    if (!projectionSource.speakerId) throw new Error('PROVIDER_ACK_PROJECTION_CANONICAL_OWNER_REQUIRED');
    mirrors = await prepareSpeakerDeletionMirrors(firestore, {speakerId:projectionSource.speakerId,tagId:subsplashTagId});
  }
  const runMutation = async (): Promise<void> => {
    const url = `https://core.subsplash.com/tags/v1/tags/${subsplashTagId}`;
    await markPublishingCritical('PUBLISHING_DELETE_CRITICAL',{provider:'subsplash',resourceType:'tag',resourceId:subsplashTagId,accountId:'app:9XTSHD',method:'DELETE'});
    const config = createAxiosConfig(url, await authenticateSubsplash(), 'DELETE');
    await runPublishingProviderMutation({operation:getPublishingMutationOperation() ?? 'deleteSubsplashTagRemote',target:{provider:'subsplash',account:'app:9XTSHD',resourceType:'tag',resourceId:subsplashTagId},step:`deleteSubsplashTagRemote:${subsplashTagId}:${providerPayloadFingerprint({id:subsplashTagId})}`,method:'DELETE',payload:{id:subsplashTagId},send:async()=>{
      try {
        synchronousMutationData(await axios(Object.assign(config,{skipSubsplashEdgeRetry:true})));
        return {completion:'acknowledged',result:null};
      } catch (error) {
        // The authenticated fixed-ID DELETE already has its desired state on an original 404.
        if (isAxiosError(error) && (error.response?.status === 404 || error.response?.status === 410))
          return {completion:'rejected_no_effect',evidence:{transport:'original_http_response',status:error.response.status,providerCode:'resource_not_found'}};
        throw error;
      }
    }});
  };

  const runLockedMutation = async (): Promise<void> => {
    return withSubsplashLocks([`tag:${subsplashTagId}`], runMutation, {
      ...(operationKey ? { operationKey } : {}),
    });
  };

  try {
    if (operationKey) {
      await withIdempotency(operationKey, runLockedMutation);
    } else {
      await runLockedMutation();
    }
    if (mirrors) return removeSpeakerDeletionMirrors(firestore,mirrors);
  } catch (error) {
    if ((error instanceof Error && error.message === 'PROVIDER_MUTATION_REJECTED_NO_EFFECT') ||
      error && typeof error==='object' && 'code' in error && error.code==='PROVIDER_MUTATION_REJECTED_NO_EFFECT') {
      if (!mirrors) throw error;
      return removeSpeakerDeletionMirrors(firestore,mirrors);
    }
    if (isAxiosError(error)) {
      const responseCode = getSubsplashErrorCode(error.response?.data);
      if (!isDurablePublishingOperation() && (error.response?.status === 404 || responseCode === 'resource_not_found')) {
        return;
      }
    }
    throw error;
  }
  return undefined;
};

const matchesSpeakerReference = (candidate: unknown, targetSpeaker: ISpeaker, normalizedTargetName: string): boolean => {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const candidateRecord = candidate as { id?: unknown; tagId?: unknown; name?: unknown };

  // An explicit canonical ID takes precedence over legacy name/tag aliases.
  if (typeof candidateRecord.id === 'string' && candidateRecord.id.trim()) {
    return candidateRecord.id === targetSpeaker.id;
  }

  if (
    targetSpeaker.tagId &&
    typeof candidateRecord.tagId === 'string' &&
    candidateRecord.tagId === targetSpeaker.tagId
  ) {
    return true;
  }

  if (
    typeof candidateRecord.name === 'string' &&
    normalizeSpeakerNameForDuplicateCheck(candidateRecord.name) === normalizedTargetName
  ) {
    return true;
  }

  return false;
};

const removeSpeakerFromSermons = async (targetSpeaker: ISpeaker): Promise<number> => {
  const sermonsSnapshot = await firestore.collection('sermons').get();
  const normalizedTargetName = normalizeSpeakerNameForDuplicateCheck(targetSpeaker.name);
  const maxBatchWrites = 400;

  let updatedSermons = 0;
  let pendingWrites = 0;
  let batch = firestore.batch();
  let stagedRefs: DocumentReference[] = [];

  const commitBatchIfNeeded = async (): Promise<void> => {
    if (pendingWrites === 0) {
      return;
    }
    const refs=stagedRefs;
    const pendingBatch=batch;
    await commitDurableProjection(async tx=> {
      const current=await Promise.all(refs.map(ref=>tx.get(ref)));
      for(const doc of current) {
        const speakers=doc.data()?.speakers;
        if(!Array.isArray(speakers)) continue;
        const remaining=speakers.filter(candidate=>!matchesSpeakerReference(candidate,targetSpeaker,normalizedTargetName));
        if(remaining.length!==speakers.length) tx.update(doc.ref,{speakers:remaining,editedAtMillis:Date.now()});
      }
    },async()=>{await pendingBatch.commit();});
    batch = firestore.batch();
    pendingWrites = 0;
    stagedRefs=[];
  };

  for (const sermonDoc of sermonsSnapshot.docs) {
    const sermonData = sermonDoc.data() as { speakers?: unknown[] };
    if (!Array.isArray(sermonData.speakers) || sermonData.speakers.length === 0) {
      continue;
    }

    const filteredSpeakers = sermonData.speakers.filter(
      (candidate) => !matchesSpeakerReference(candidate, targetSpeaker, normalizedTargetName)
    );

    if (filteredSpeakers.length === sermonData.speakers.length) {
      continue;
    }

    updatedSermons += 1;
    stagedRefs.push(sermonDoc.ref);
    batch.update(sermonDoc.ref, {
      speakers: filteredSpeakers,
      editedAtMillis: Date.now(),
    });
    pendingWrites += 1;

    if (pendingWrites >= maxBatchWrites) {
      await commitBatchIfNeeded();
    }
  }

  await commitBatchIfNeeded();
  return updatedSermons;
};

export interface SpeakerCreateTailCheckpoint {
  schemaVersion:1;projectId:string;jobId:string;generation:number;workflowId:string;speakerId:string;operationKey:string;inputFingerprint:string;
  images:ImageType[];desiredSpeaker:Omit<ISpeaker,'tagId'>;tagPayload:{title:string;squareImage:ImageType;shortDescription?:string;description?:string};
  originalExists:boolean;originalDocumentDigest:string;listPayload?:Record<string,unknown>;desiredList?:Omit<List,'subsplashId'>;originalListDocumentDigest?:string;checkpointDigest:string;
}
const speakerTailIdentity=(value:SpeakerCreateTailCheckpoint)=>Object.fromEntries(['schemaVersion','projectId','jobId','generation','workflowId','speakerId','operationKey','inputFingerprint','images','desiredSpeaker','tagPayload','originalExists','originalDocumentDigest','listPayload','desiredList','originalListDocumentDigest'].filter(key=>(value as unknown as Record<string,unknown>)[key]!==undefined).map(key=>[key,(value as unknown as Record<string,unknown>)[key]]));
const speakerTailFailure=():never=>{throw new HttpsError('failed-precondition','The original speaker create program is unavailable or changed.');};
const validTailId=(value:unknown):value is string=>typeof value==='string'&&!!value&&value.length<=256&&!/[\s/?#]/.test(value);
export function validateSpeakerCreateTailCheckpoint(checkpoint:SpeakerCreateTailCheckpoint,input:CreateSpeakerCallableInputType,speakerId:string):void {
  if(checkpoint?.schemaVersion!==1||checkpoint.speakerId!==speakerId||checkpoint.operationKey!==input.operationKey||checkpoint.inputFingerprint!==providerPayloadFingerprint(input)||checkpoint.checkpointDigest!==acknowledgedProjectionDigest(speakerTailIdentity(checkpoint))||!Number.isSafeInteger(checkpoint.generation)||checkpoint.generation<1||!validTailId(checkpoint.workflowId)||!Array.isArray(checkpoint.images)||checkpoint.desiredSpeaker.id!==speakerId||checkpoint.desiredSpeaker.name!==requireTrimmedSpeakerName(input.speaker.name)||Boolean(checkpoint.listPayload)!==Boolean(input.createSpeakerList)||Boolean(checkpoint.desiredList)!==Boolean(input.createSpeakerList)||providerPayloadFingerprint(checkpoint.desiredSpeaker.images)!==providerPayloadFingerprint(checkpoint.images))speakerTailFailure();
  requireSquareImage(checkpoint.images);
}
const speakerCheckpointRef=(database:Firestore,checkpoint:Pick<SpeakerCreateTailCheckpoint,'jobId'|'speakerId'>)=>database.doc(`temporalPublishingSpeakerCreationState/${providerReceiptId(checkpoint.jobId,checkpoint.speakerId)}`);
const frozenListPayload=(name:string,images:ImageType[]):Record<string,unknown>=>({app_key:'9XTSHD',display_type:'image',generated:false,header_type:'none',layout_type:'list',title:name,type:'standard',_embedded:{images:images.map(image=>toSubsplashImageReference(image,'speaker image'))}});
const readSpeakerCreateReceipt=async(database:Firestore,checkpoint:SpeakerCreateTailCheckpoint,stage:'speaker-tag-create'|'list-create'):Promise<ProviderReceipt|undefined>=>{
  const key=scopeOperationKey(checkpoint.operationKey,stage==='speaker-tag-create'?'create-speaker-tag':'create-speaker-list')!;
  const receipt=(await database.doc(`${PROVIDER_RECEIPTS_COLLECTION}/${providerReceiptId(key,stage)}`).get()).data() as ProviderReceipt|undefined;
  if(receipt&&(receipt.operationKey!==key||receipt.step!==stage||receipt.projectId!==checkpoint.projectId||receipt.jobId!==checkpoint.jobId||receipt.providerAccount?.provider!=='subsplash'||receipt.providerAccount.account!=='app:9XTSHD'||receipt.fingerprint!==providerPayloadFingerprint(stage==='speaker-tag-create'?checkpoint.tagPayload:checkpoint.listPayload)))speakerTailFailure();
  return receipt;
};
/** Fixed post-tag stages only. Images and the original tag allocation are never replayed. */
export async function completeConfirmedSpeakerCreate(input:CreateSpeakerCallableInputType,confirmed:{tagId:string},options:{checkpoint:SpeakerCreateTailCheckpoint;speakerId:string;firestore?:Firestore;commitCurrent?:(mutate:(tx:Transaction)=>Promise<void>)=>Promise<void>}):Promise<CreateSpeakerCallableOutputType> {
  const checkpoint=options.checkpoint,database=options.firestore??firestore,commit=options.commitCurrent??(mutate=>runDurableTransaction(database,mutate));
  validateSpeakerCreateTailCheckpoint(checkpoint,input,options.speakerId);
  if(getDurablePublishingJobId()!==checkpoint.jobId||!validTailId(confirmed.tagId))speakerTailFailure();
  const stateRef=speakerCheckpointRef(database,checkpoint),speakerRef=database.collection('speakers').doc(checkpoint.speakerId);
  const tagReceipt=await readSpeakerCreateReceipt(database,checkpoint,'speaker-tag-create');
  if(tagReceipt?.state!=='confirmed'||(tagReceipt.result as {tagId?:unknown}|undefined)?.tagId!==confirmed.tagId)speakerTailFailure();
  let completed:ISpeaker|undefined,completedListSubsplashId:string|undefined;
  await commit(async tx=>{
    const [state,canonical,job]=await Promise.all([tx.get(stateRef),tx.get(speakerRef),tx.get(database.doc(`durableJobs/${checkpoint.jobId}`))]);
    if(!state.exists||state.get('checkpointDigest')!==checkpoint.checkpointDigest||job.get('generation')!==checkpoint.generation||job.get('workflowId')!==checkpoint.workflowId||state.get('tagId')&&state.get('tagId')!==confirmed.tagId)speakerTailFailure();
    if(state.get('state')==='completed') {
      const current=canonical.data() as ISpeaker|undefined;
      if(!current||current.tagId!==confirmed.tagId||current.listId!==checkpoint.desiredSpeaker.listId||providerPayloadFingerprint(Object.fromEntries(Object.keys(checkpoint.desiredSpeaker).filter(key=>key!=='sermonCount').map(key=>[key,(current as unknown as Record<string,unknown>)[key]])))!==providerPayloadFingerprint(Object.fromEntries(Object.entries(checkpoint.desiredSpeaker).filter(([key])=>key!=='sermonCount'))))speakerTailFailure();
      const remoteList=state.get('listSubsplashId');
      if(checkpoint.desiredList&&!validTailId(remoteList))speakerTailFailure();
      completed=current;completedListSubsplashId=validTailId(remoteList)?remoteList:undefined;return;
    }
    if(acknowledgedProjectionDigest(canonical.data()??null)!==checkpoint.originalDocumentDigest)speakerTailFailure();
    if(checkpoint.desiredSpeaker.listId&&!checkpoint.desiredList&&!(await tx.get(database.doc(`lists/${checkpoint.desiredSpeaker.listId}`))).exists)speakerTailFailure();
  });
  if(completed)return {status:'success',speakerId:checkpoint.speakerId,speaker:completed,speakerListCreated:Boolean(checkpoint.desiredList),...(completed.listId?{listId:completed.listId}:{}),...(completedListSubsplashId?{listSubsplashId:completedListSubsplashId}:{})};
  const token=await authenticateSubsplash(),tagResponse=synchronousMutationData<Record<string,unknown>>(await axios(createAxiosConfig(`https://core.subsplash.com/tags/v1/tags/${confirmed.tagId}`,token,'GET')));
  const tagSquare=((tagResponse._embedded as {'square-image'?:{id?:unknown}}|undefined)?.['square-image'])?.id;
  if(tagResponse.id!==confirmed.tagId||tagResponse.app_key!=='9XTSHD'||tagResponse.type!=='speaker'||tagResponse.title!==checkpoint.tagPayload.title||tagSquare!==toSubsplashImageReference(checkpoint.tagPayload.squareImage,'squareImage').id||String(tagResponse.short_description??'')!==(checkpoint.tagPayload.shortDescription??'')||String(tagResponse.description??'')!==(checkpoint.tagPayload.description??''))speakerTailFailure();
  await commit(async tx=>{const state=await tx.get(stateRef);if(state.get('checkpointDigest')!==checkpoint.checkpointDigest||state.get('tagId')&&state.get('tagId')!==confirmed.tagId)speakerTailFailure();if(!state.get('listSubsplashId'))tx.update(stateRef,{state:'tag_confirmed',tagId:confirmed.tagId});});
  let remoteListId:string|undefined;
  if(checkpoint.desiredList&&checkpoint.listPayload) {
    const prior=await readSpeakerCreateReceipt(database,checkpoint,'list-create');
    let result:unknown=prior?.state==='confirmed'?prior.result:undefined;
    if(!result) {
      const key=scopeOperationKey(checkpoint.operationKey,'create-speaker-list')!;
      result=await executeProviderCreate({operationKey:key,step:'list-create',payload:checkpoint.listPayload,prepare:async()=>reserveSubsplashAssociation(`listcreate:${key}`,checkpoint.images.map(image=>toSubsplashImageReference(image,'speaker image').id),checkpoint.listPayload,{targetReceiptId:providerReceiptId(key,'list-create')}),execute:async()=>{
        const config=createAxiosConfig('https://core.subsplash.com/builder/v1/lists',token,'POST',checkpoint.listPayload);Object.assign(config,{skipSubsplashEdgeRetry:true});const response=(await axios(config)).data as {id?:unknown};if(!validTailId(response.id))speakerTailFailure();return {listId:response.id};
      }});
    }
    const created=(result as {listId?:unknown}|undefined)?.listId;if(!validTailId(created))return speakerTailFailure();remoteListId=created;
    const list=synchronousMutationData<Record<string,unknown>>(await axios(createAxiosConfig(`https://core.subsplash.com/builder/v1/lists/${remoteListId}`,token,'GET')));
    const remoteImages=((list._embedded as {images?:Array<{id?:unknown;type?:unknown}>}|undefined)?.images??[]).map(image=>({id:image.id,type:image.type}));
    const expectedImages=checkpoint.images.map(image=>toSubsplashImageReference(image,'speaker image'));
    if(list.id!==remoteListId||list.app_key!=='9XTSHD'||list.title!==checkpoint.desiredList.name||providerPayloadFingerprint([...remoteImages].sort((a,b)=>String(a.type).localeCompare(String(b.type))||String(a.id).localeCompare(String(b.id))))!==providerPayloadFingerprint([...expectedImages].sort((a,b)=>a.type.localeCompare(b.type)||a.id.localeCompare(b.id))))speakerTailFailure();
    await commit(async tx=>{const state=await tx.get(stateRef);if(state.get('checkpointDigest')!==checkpoint.checkpointDigest||state.get('listSubsplashId')&&state.get('listSubsplashId')!==remoteListId)speakerTailFailure();tx.update(stateRef,{state:'list_confirmed',listSubsplashId:remoteListId});});
  }
  const speaker:ISpeaker={...checkpoint.desiredSpeaker,tagId:confirmed.tagId};
  await commit(async tx=>{
    const operation=getPublishingMutationOperation(),guard=operation?await prepareProviderMutationPlanCommit(tx,{operation}):undefined;
    const [state,current]=await Promise.all([tx.get(stateRef),tx.get(speakerRef)]);
    if(state.get('checkpointDigest')!==checkpoint.checkpointDigest||state.get('tagId')!==confirmed.tagId||acknowledgedProjectionDigest(current.data()??null)!==checkpoint.originalDocumentDigest)speakerTailFailure();
    const linked=checkpoint.desiredSpeaker.listId?await tx.get(database.doc(`lists/${checkpoint.desiredSpeaker.listId}`)):undefined;
    if(checkpoint.desiredList&&acknowledgedProjectionDigest(linked?.data()??null)!==checkpoint.originalListDocumentDigest||!checkpoint.desiredList&&checkpoint.desiredSpeaker.listId&&!linked?.exists)speakerTailFailure();
    if(guard?.alreadyCommitted)speakerTailFailure();
    tx.set(speakerRef,speaker);
    if(checkpoint.desiredList&&remoteListId)tx.set(database.doc(`lists/${checkpoint.desiredList.id}`),{...checkpoint.desiredList,subsplashId:remoteListId});
    tx.update(stateRef,{state:'completed',tagId:confirmed.tagId,...(remoteListId?{listSubsplashId:remoteListId}:{})});guard?.commit();
  });
  return {status:'success',speakerId:speaker.id,speaker,speakerListCreated:Boolean(checkpoint.desiredList),...(speaker.listId?{listId:speaker.listId}:{}),...(remoteListId?{listSubsplashId:remoteListId}:{})};
}

async function createDurableSpeakerWithCheckpoint(input:CreateSpeakerCallableInputType,options:{speakerId?:string}):Promise<CreateSpeakerCallableOutputType> {
  const operationKey=input.operationKey!,scope=inferProviderReceiptScope(operationKey),jobId=getDurablePublishingJobId();
  if(!scope||scope.jobId!==jobId)speakerTailFailure();
  const speakerId=options.speakerId??providerReceiptId(operationKey,'local-speaker'),speakerRef=firestore.collection('speakers').doc(speakerId),stateRef=speakerCheckpointRef(firestore,{jobId:jobId!,speakerId});
  let checkpoint=(await stateRef.get()).data() as SpeakerCreateTailCheckpoint|undefined;
  if(checkpoint)validateSpeakerCreateTailCheckpoint(checkpoint,input,speakerId);
  else {
    const name=requireTrimmedSpeakerName(input.speaker.name);await assertSpeakerNameUnique(name);if(input.associatedListId)await assertListExists(input.associatedListId);
    const original=await speakerRef.get();
    if(original.exists)throw new HttpsError('already-exists','The selected speaker already exists.');
    const resolved=input.createSpeakerList?await repairMismatchedSubsplashImageRefs(input.speaker.images,await authenticateSubsplash(),scopeOperationKey(operationKey,'speaker-images')):input.speaker.images;
    if(resolved.length!==input.speaker.images.length)speakerTailFailure();
    const images=input.speaker.images.map((image,index)=>{if(resolved[index].id!==image.id||resolved[index].type!==image.type)speakerTailFailure();return {...image,...(resolved[index].subsplashId?{subsplashId:resolved[index].subsplashId}:{})};});
    const tagPayload={title:name,squareImage:requireSquareImage(images),...(input.speaker.shortDescription!==undefined?{shortDescription:input.speaker.shortDescription}:{}),...(input.speaker.description!==undefined?{description:input.speaker.description}:{})};
    await runDurableTransaction(firestore,async tx=>{
      const [previous,current,job,intent]=await Promise.all([tx.get(stateRef),tx.get(speakerRef),tx.get(firestore.doc(`durableJobs/${jobId}`)),tx.get(firestore.doc(`durableJobIntents/${jobId}`))]);
      if(previous.exists){checkpoint=previous.data() as SpeakerCreateTailCheckpoint;validateSpeakerCreateTailCheckpoint(checkpoint,input,speakerId);return;}
      if(!job.exists||job.get('projectId')!==scope!.projectId||job.get('jobId')!==jobId||job.get('generation')!==intent.get('generation')||!Number.isSafeInteger(job.get('generation'))||!validTailId(job.get('workflowId'))||intent.get('kind')==='speaker.mutate'&&intent.get('entity.id')!==speakerId||acknowledgedProjectionDigest(current.data()??null)!==acknowledgedProjectionDigest(original.data()??null))speakerTailFailure();
      const listId=input.createSpeakerList?providerPayloadFingerprint([scopeOperationKey(operationKey,'create-speaker-list'),'local-speaker-list']).slice(0,32):input.associatedListId;
      const listBase=input.createSpeakerList&&listId?await tx.get(firestore.doc(`lists/${listId}`)):undefined;
      const now=Date.now(),desiredSpeaker:Omit<ISpeaker,'tagId'>={id:speakerId,name,shortDescription:input.speaker.shortDescription??'',description:input.speaker.description??'',images,sermonCount:0,...(listId?{listId}:{})};
      const desiredList=input.createSpeakerList&&listId?{id:listId,name,images,overflowBehavior:OverflowBehavior.CREATENEWLIST,count:0,type:ListType.SPEAKER_LIST,createdAtMillis:now,updatedAtMillis:now,...buildRootListMetadata({rootListId:listId,logicalCount:0,hasOverflowPages:false})}:undefined;
      const raw={schemaVersion:1 as const,...scope!,generation:job.get('generation') as number,workflowId:job.get('workflowId') as string,speakerId,operationKey,inputFingerprint:providerPayloadFingerprint(input),images,desiredSpeaker,tagPayload,originalExists:current.exists,originalDocumentDigest:acknowledgedProjectionDigest(current.data()??null),...(desiredList?{desiredList,listPayload:frozenListPayload(name,images),originalListDocumentDigest:acknowledgedProjectionDigest(listBase?.data()??null)}:{})};
      checkpoint={...raw,checkpointDigest:acknowledgedProjectionDigest(raw)};tx.create(stateRef,{...checkpoint,state:'captured'});
    });
  }
  if(!checkpoint)speakerTailFailure();
  const tag=await createSubsplashSpeakerTag({...checkpoint!.tagPayload,operationKey:scopeOperationKey(operationKey,'create-speaker-tag')});
  return completeConfirmedSpeakerCreate(input,tag,{checkpoint:checkpoint!,speakerId});
}

export const createSpeakerMutation = async (
  input: CreateSpeakerCallableInputType,
  options: {speakerId?:string} = {}
): Promise<CreateSpeakerCallableOutputType> => {
  return runWithOptionalIdempotency(input.operationKey, async () => {
    if(isDurablePublishingOperation()&&input.operationKey)return createDurableSpeakerWithCheckpoint(input,options);
    const normalizedName = requireTrimmedSpeakerName(input.speaker.name);
    const existingSpeakerRef=options.speakerId?speakersCollection.doc(options.speakerId):undefined;
    if(existingSpeakerRef) {
      const existing=await existingSpeakerRef.get();
      if(existing.exists) {
        const speaker=existing.data()!;
        if(normalizeSpeakerNameForDuplicateCheck(speaker.name)!==normalizeSpeakerNameForDuplicateCheck(normalizedName)) throw new HttpsError('failed-precondition','The admitted speaker identity changed.');
        return {status:'success' as const,speakerId:speaker.id,speaker,speakerListCreated:Boolean(speaker.listId),...(speaker.listId?{listId:speaker.listId}:{})};
      }
    }
    const squareImage = requireSquareImage(input.speaker.images);
    await assertSpeakerNameUnique(normalizedName);

    if (input.associatedListId) {
      await assertListExists(input.associatedListId);
    }

    const createdTag = await createSubsplashSpeakerTag({
      title: normalizedName,
      squareImage,
      shortDescription: input.speaker.shortDescription,
      description: input.speaker.description,
      operationKey: scopeOperationKey(input.operationKey, 'create-speaker-tag'),
    });

    let preparedList: PreparedSpeakerListType | undefined;
    try {
      if (input.createSpeakerList) {
        preparedList = await prepareSpeakerList(
          normalizedName,
          input.speaker.images,
          scopeOperationKey(input.operationKey, 'create-speaker-list')
        );
      }

      const speakerRef = existingSpeakerRef ?? speakersCollection.doc();
      const associatedListId = preparedList?.list.id ?? input.associatedListId;
      const speaker: ISpeaker = {
        id: speakerRef.id,
        name: normalizedName,
        shortDescription: input.speaker.shortDescription ?? '',
        description: input.speaker.description ?? '',
        images: input.speaker.images,
        sermonCount: 0,
        tagId: createdTag.tagId,
        ...(associatedListId ? { listId: associatedListId } : {}),
      };

      await runDurableTransaction(firestore, async (transaction) => {
        const operation = getPublishingMutationOperation();
        const guard = operation ? await prepareProviderMutationPlanCommit(transaction, { operation }) : undefined;
        if (guard?.alreadyCommitted) return;
        transaction.set(speakerRef, speaker);
        if (preparedList) {
          transaction.set(preparedList.listRef, preparedList.list);
        }
        guard?.commit();
      });

      return {
        status: 'success',
        speakerId: speaker.id,
        speaker,
        speakerListCreated: Boolean(preparedList),
        ...(associatedListId ? { listId: associatedListId } : {}),
        ...(preparedList?.list.subsplashId ? { listSubsplashId: preparedList.list.subsplashId } : {}),
      };
    } catch (error) {
      // Durable primitive receipts retain remote objects for a resumed saga.
      if(isDurablePublishingOperation()) throw error;
      try {
        await deleteSubsplashTagRemote(
          createdTag.tagId,
          scopeOperationKey(input.operationKey, `rollback-delete-tag-${createdTag.tagId}`)
        );
      } catch {
        // preserve the original failure from speaker creation path
      }
      throw error;
    }
  });
};

export const updateSpeakerMutation = async (
  input: UpdateSpeakerCallableInputType
): Promise<UpdateSpeakerCallableOutputType> => {
  return runWithOptionalIdempotency(input.operationKey, async () => {
    const speakerRef = speakersCollection.doc(input.speakerId);
    const speakerSnapshot = await speakerRef.get();
    if (!speakerSnapshot.exists) {
      throw new HttpsError('not-found', `Speaker ${input.speakerId} does not exist.`);
    }

    const existingSpeaker = speakerSnapshot.data();
    if (!existingSpeaker) {
      throw new HttpsError('not-found', `Speaker ${input.speakerId} does not exist.`);
    }
    const nextName = input.patch.name ?? existingSpeaker.name;
    const nextImages = input.patch.images ?? existingSpeaker.images;
    requireSquareImage(nextImages);
    const normalizedName = requireTrimmedSpeakerName(nextName);
    const nextShortDescription = Object.prototype.hasOwnProperty.call(input.patch, 'shortDescription')
      ? input.patch.shortDescription || undefined
      : existingSpeaker.shortDescription;
    const nextDescription = Object.prototype.hasOwnProperty.call(input.patch, 'description')
      ? input.patch.description || undefined
      : existingSpeaker.description;

    if (normalizeSpeakerNameForDuplicateCheck(existingSpeaker.name) !== normalizeSpeakerNameForDuplicateCheck(normalizedName)) {
      await assertSpeakerNameUnique(normalizedName, existingSpeaker.id);
    }

    const durableListId=isDurablePublishingOperation() && input.operationKey ? providerPayloadFingerprint([scopeOperationKey(input.operationKey,'create-speaker-list'),'local-speaker-list']).slice(0,32) : undefined;
    if (input.createSpeakerList && existingSpeaker.listId && !input.deleteAssociatedList && existingSpeaker.listId!==durableListId) {
      throw new HttpsError(
        'invalid-argument',
        'Speaker already has an associated list. Remove it before creating a new one.'
      );
    }

    let preparedList: PreparedSpeakerListType | undefined;
    if (input.createSpeakerList) {
      preparedList = await prepareSpeakerList(
        normalizedName,
        nextImages,
        scopeOperationKey(input.operationKey, 'create-speaker-list')
      );
    }

    let existingListSnapshot: DocumentSnapshot<List> | undefined;
    if (existingSpeaker.listId) {
      existingListSnapshot = await listsCollection.doc(existingSpeaker.listId).get();
    }

    let nextListId = existingSpeaker.listId;
    if (input.deleteAssociatedList) {
      nextListId = undefined;
    } else if (preparedList) {
      nextListId = preparedList.list.id;
    } else if (Object.prototype.hasOwnProperty.call(input.patch, 'associatedListId')) {
      if (input.patch.associatedListId === null) {
        nextListId = undefined;
      } else if (input.patch.associatedListId) {
        await assertListExists(input.patch.associatedListId);
        nextListId = input.patch.associatedListId;
      } else {
        nextListId = undefined;
      }
    }

    let requiredTagStep: string | undefined;
    if (existingSpeaker.tagId) {
      const tagPayload = {app_key:'9XTSHD',type:'speaker',title:normalizedName,short_description:nextShortDescription ?? '',description:nextDescription ?? '',
        _embedded:{'square-image':toSubsplashImageReference(requireSquareImage(nextImages),'squareImage')}};
      requiredTagStep = `speaker-tag-patch:${existingSpeaker.tagId}:${providerPayloadFingerprint(tagPayload)}`;
      await createSubsplashSpeakerTag({
        tagId: existingSpeaker.tagId,
        title: normalizedName,
        squareImage: requireSquareImage(nextImages),
        shortDescription: nextShortDescription,
        description: nextDescription,
        operationKey: scopeOperationKey(input.operationKey, `update-speaker-tag-${existingSpeaker.tagId}`),
      }, {speakerId:existingSpeaker.id});
    }

    if (
      existingSpeaker.listId &&
      existingListSnapshot?.exists &&
      nextListId === existingSpeaker.listId &&
      !input.deleteAssociatedList &&
      !preparedList
    ) {
      const existingList = existingListSnapshot.data();
      if (existingList?.subsplashId) {
        await syncSubsplashSpeakerListRemote(
          existingList.subsplashId,
          normalizedName,
          nextImages,
          scopeOperationKey(input.operationKey, `update-speaker-list-${existingList.subsplashId}`),
          existingSpeaker.listId,
          {speakerId:existingSpeaker.id,requiredTagStep}
        );
      }
    }

    if (input.deleteAssociatedList && existingSpeaker.listId && existingListSnapshot?.exists) {
      await deleteLogicalListChain({
        listId: existingSpeaker.listId,
        operationKey: scopeOperationKey(input.operationKey, `delete-list-chain-${existingSpeaker.listId}`),
      });
    }

    const updatedSpeaker: ISpeaker = {
      id: existingSpeaker.id,
      name: normalizedName,
      shortDescription: nextShortDescription ?? '',
      description: nextDescription ?? '',
      images: nextImages,
      sermonCount: existingSpeaker.sermonCount,
      ...(existingSpeaker.tagId ? { tagId: existingSpeaker.tagId } : {}),
      ...(nextListId ? { listId: nextListId } : {}),
    };

    await runDurableTransaction(firestore, async (transaction) => {
      const operation = getPublishingMutationOperation();
      const guard = operation ? await prepareProviderMutationPlanCommit(transaction, { operation }) : undefined;
      if (guard?.alreadyCommitted) return;
      transaction.set(speakerRef, updatedSpeaker);
      if (preparedList) {
        transaction.set(preparedList.listRef, preparedList.list);
      }
      if (
        existingSpeaker.listId &&
        existingListSnapshot?.exists &&
        nextListId === existingSpeaker.listId &&
        !input.deleteAssociatedList &&
        !preparedList
      ) {
        transaction.set(
          listsCollection.doc(existingSpeaker.listId),
          {
            ...(existingListSnapshot.data() || {}),
            id: existingSpeaker.listId,
            name: normalizedName,
            images: nextImages,
            updatedAtMillis: Date.now(),
          },
          { merge: true }
        );
      }
      guard?.commit();
    });

    return {
      status: 'success',
      speakerId: updatedSpeaker.id,
      speaker: updatedSpeaker,
      speakerListCreated: Boolean(preparedList),
      ...(nextListId ? { listId: nextListId } : {}),
      ...(preparedList?.list.subsplashId ? { listSubsplashId: preparedList.list.subsplashId } : {}),
    };
  });
};

export const deleteSpeakerMutation = async (
  input: DeleteSpeakerCallableInputType
): Promise<DeleteSpeakerCallableOutputType> => {
  return runWithOptionalIdempotency(input.operationKey, async () => {
    const speakerRef = speakersCollection.doc(input.speakerId);
    const speakerSnapshot = await speakerRef.get();
    if (!speakerSnapshot.exists) {
      if(isDurablePublishingOperation()) return {status:'success' as const,speakerId:input.speakerId,tagDeleted:false,removedFromSermonsCount:0,listDeleted:false};
      throw new HttpsError('not-found', `Speaker ${input.speakerId} does not exist.`);
    }

    const existingSpeaker = speakerSnapshot.data();
    if (!existingSpeaker) {
      throw new HttpsError('not-found', `Speaker ${input.speakerId} does not exist.`);
    }

    let tagDeleted = false;
    let mirrorCounts: {sermonsUpdated:number;listMirrorsUpdated:number;seriesMirrorsUpdated:number} | undefined;
    if (existingSpeaker.tagId) {
      mirrorCounts = await deleteSubsplashTagRemote(
        existingSpeaker.tagId,
        scopeOperationKey(input.operationKey, `delete-tag-${existingSpeaker.tagId}`),
        {speakerId:existingSpeaker.id}
      );
      tagDeleted = true;
    }

    let deletedListId: string | undefined;
    let deletedSubsplashListId: string | undefined;
    let listDeleted = false;

    if (input.deleteAssociatedList === true && existingSpeaker.listId) {
      const listRef = listsCollection.doc(existingSpeaker.listId);
      const listSnapshot = await listRef.get();
      if (listSnapshot.exists) {
        const list = listSnapshot.data();
        if (!list) {
          throw new HttpsError('internal', `List ${existingSpeaker.listId} could not be loaded.`);
        }
        const deleteResult = await deleteLogicalListChain({
          listId: list.id,
          operationKey: scopeOperationKey(input.operationKey, `delete-list-chain-${list.id}`),
        });
        deletedListId = deleteResult.rootListId;
        deletedSubsplashListId = deleteResult.rootSubsplashListId;
        listDeleted = true;
      }
    }

    const removedFromSermonsCount = mirrorCounts?.sermonsUpdated ?? await removeSpeakerFromSermons(existingSpeaker);

    const deleteBatch = firestore.batch();
    deleteBatch.delete(speakerRef);
    await commitDurableProjection(async tx=>{
      const operation = getPublishingMutationOperation();
      const guard = operation ? await prepareProviderMutationPlanCommit(tx, { operation }) : undefined;
      if (guard?.alreadyCommitted) return;
      tx.delete(speakerRef);
      guard?.commit();
    },async()=>{await deleteBatch.commit();});

    return {
      status: 'success',
      speakerId: existingSpeaker.id,
      tagDeleted,
      removedFromSermonsCount,
      listDeleted,
      ...(deletedListId ? { deletedListId } : {}),
      ...(deletedSubsplashListId ? { deletedSubsplashListId } : {}),
    };
  });
};
