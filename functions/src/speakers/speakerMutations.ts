import axios, { isAxiosError } from 'axios';
import { DocumentReference } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { ImageType } from '../../../types/Image';
import { ISpeaker } from '../../../types/Speaker';
import { List, ListType, OverflowBehavior } from '../../../types/List';
import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { firestoreAdminListConverter, firestoreAdminSpeakerConverter } from '../firestoreDataConverter';
import { createNewSubsplashList } from '../createNewSubsplashList';
import { authenticateSubsplash, createAxiosConfig } from '../subsplashUtils';
import { withIdempotency } from '../locks/withIdempotency';
import { withSubsplashLocks } from '../locks/withSubsplashLocks';
import {
  CreateSpeakerCallableInputType,
  CreateSpeakerCallableOutputType,
  DeleteSpeakerCallableInputType,
  DeleteSpeakerCallableOutputType,
  UpdateSpeakerCallableInputType,
  UpdateSpeakerCallableOutputType,
} from './createSpeakerTypes';

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

  const listRef = listsCollection.doc();
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
      createdAtMillis: now,
      updatedAtMillis: now,
      subsplashId: createResult.listId,
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

const createSubsplashSpeakerTag = async (
  input: CreateSubsplashSpeakerTagInputType
): Promise<CreateSubsplashSpeakerTagOutputType> => {
  const runMutation = async (): Promise<CreateSubsplashSpeakerTagOutputType> => {
    const url = input.tagId
      ? `https://core.subsplash.com/tags/v1/tags/${input.tagId}`
      : 'https://core.subsplash.com/tags/v1/tags';
    const payload = {
      app_key: '9XTSHD',
      type: 'speaker',
      title: input.title,
      short_description: input.shortDescription ?? '',
      description: input.description ?? '',
      _embedded: {
        'square-image': toSubsplashImageReference(input.squareImage, 'squareImage'),
      },
    };

    const config = createAxiosConfig(url, await authenticateSubsplash(), input.tagId ? 'PATCH' : 'POST', payload);
    const response = (await axios(config)).data as { id?: unknown };
    const tagId = typeof response.id === 'string' ? response.id : input.tagId || '';
    if (!tagId) {
      throw new HttpsError('internal', 'Subsplash did not return a tag id.');
    }

    return { tagId };
  };

  return withSubsplashLocks([getCreateSpeakerTagLockKey(input.title)], runMutation, {
    ...(input.operationKey ? { operationKey: input.operationKey } : {}),
  });
};

const syncSubsplashSpeakerListRemote = async (
  subsplashListId: string,
  speakerName: string,
  images: ImageType[],
  operationKey?: string
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
    const config = createAxiosConfig(url, await authenticateSubsplash(), 'PATCH', payload);
    await axios(config);
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

const deleteSubsplashListRemote = async (subsplashListId: string, operationKey?: string): Promise<void> => {
  const runMutation = async (): Promise<void> => {
    const url = `https://core.subsplash.com/builder/v1/lists/${subsplashListId}`;
    const config = createAxiosConfig(url, await authenticateSubsplash(), 'DELETE');
    await axios(config);
  };

  const runLockedMutation = async (): Promise<void> => {
    return withSubsplashLocks([`list:${subsplashListId}`], runMutation, {
      ...(operationKey ? { operationKey } : {}),
    });
  };

  try {
    if (operationKey) {
      await withIdempotency(operationKey, runLockedMutation);
      return;
    }
    await runLockedMutation();
  } catch (error) {
    if (isAxiosError(error)) {
      const responseCode = getSubsplashErrorCode(error.response?.data);
      if (error.response?.status === 404 || responseCode === 'resource_not_found') {
        return;
      }
    }
    throw error;
  }
};

const deleteSubsplashTagRemote = async (subsplashTagId: string, operationKey?: string): Promise<void> => {
  const runMutation = async (): Promise<void> => {
    const url = `https://core.subsplash.com/tags/v1/tags/${subsplashTagId}`;
    const config = createAxiosConfig(url, await authenticateSubsplash(), 'DELETE');
    await axios(config);
  };

  const runLockedMutation = async (): Promise<void> => {
    return withSubsplashLocks([`tag:${subsplashTagId}`], runMutation, {
      ...(operationKey ? { operationKey } : {}),
    });
  };

  try {
    if (operationKey) {
      await withIdempotency(operationKey, runLockedMutation);
      return;
    }
    await runLockedMutation();
  } catch (error) {
    if (isAxiosError(error)) {
      const responseCode = getSubsplashErrorCode(error.response?.data);
      if (error.response?.status === 404 || responseCode === 'resource_not_found') {
        return;
      }
    }
    throw error;
  }
};

const matchesSpeakerReference = (candidate: unknown, targetSpeaker: ISpeaker, normalizedTargetName: string): boolean => {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const candidateRecord = candidate as { id?: unknown; tagId?: unknown; name?: unknown };

  if (typeof candidateRecord.id === 'string' && candidateRecord.id === targetSpeaker.id) {
    return true;
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

  const commitBatchIfNeeded = async (): Promise<void> => {
    if (pendingWrites === 0) {
      return;
    }
    await batch.commit();
    batch = firestore.batch();
    pendingWrites = 0;
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

export const createSpeakerMutation = async (
  input: CreateSpeakerCallableInputType
): Promise<CreateSpeakerCallableOutputType> => {
  return runWithOptionalIdempotency(input.operationKey, async () => {
    const normalizedName = requireTrimmedSpeakerName(input.speaker.name);
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

      const speakerRef = speakersCollection.doc();
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

      await firestore.runTransaction(async (transaction) => {
        transaction.set(speakerRef, speaker);
        if (preparedList) {
          transaction.set(preparedList.listRef, preparedList.list);
        }
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

    if (input.createSpeakerList && existingSpeaker.listId && !input.deleteAssociatedList) {
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

    let existingListSnapshot: FirebaseFirestore.DocumentSnapshot<List> | undefined;
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

    if (existingSpeaker.tagId) {
      await createSubsplashSpeakerTag({
        tagId: existingSpeaker.tagId,
        title: normalizedName,
        squareImage: requireSquareImage(nextImages),
        shortDescription: nextShortDescription,
        description: nextDescription,
        operationKey: scopeOperationKey(input.operationKey, `update-speaker-tag-${existingSpeaker.tagId}`),
      });
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
          scopeOperationKey(input.operationKey, `update-speaker-list-${existingList.subsplashId}`)
        );
      }
    }

    if (input.deleteAssociatedList && existingSpeaker.listId && existingListSnapshot?.exists) {
      const existingList = existingListSnapshot.data();
      if (existingList?.subsplashId) {
        await deleteSubsplashListRemote(
          existingList.subsplashId,
          scopeOperationKey(input.operationKey, `delete-list-${existingList.subsplashId}`)
        );
      }
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

    await firestore.runTransaction(async (transaction) => {
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
      if (input.deleteAssociatedList && existingSpeaker.listId && existingListSnapshot?.exists) {
        transaction.delete(listsCollection.doc(existingSpeaker.listId));
      }
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
      throw new HttpsError('not-found', `Speaker ${input.speakerId} does not exist.`);
    }

    const existingSpeaker = speakerSnapshot.data();
    if (!existingSpeaker) {
      throw new HttpsError('not-found', `Speaker ${input.speakerId} does not exist.`);
    }

    let tagDeleted = false;
    if (existingSpeaker.tagId) {
      await deleteSubsplashTagRemote(
        existingSpeaker.tagId,
        scopeOperationKey(input.operationKey, `delete-tag-${existingSpeaker.tagId}`)
      );
      tagDeleted = true;
    }

    let deletedListId: string | undefined;
    let deletedSubsplashListId: string | undefined;
    let listRefToDelete: DocumentReference<List> | undefined;
    let listDeleted = false;

    if (existingSpeaker.listId) {
      const listRef = listsCollection.doc(existingSpeaker.listId);
      const listSnapshot = await listRef.get();
      if (listSnapshot.exists) {
        const list = listSnapshot.data();
        if (!list) {
          throw new HttpsError('internal', `List ${existingSpeaker.listId} could not be loaded.`);
        }
        deletedListId = list.id;
        if (list.subsplashId) {
          await deleteSubsplashListRemote(
            list.subsplashId,
            scopeOperationKey(input.operationKey, `delete-list-${list.subsplashId}`)
          );
          deletedSubsplashListId = list.subsplashId;
        }
        listRefToDelete = listRef;
        listDeleted = true;
      }
    }

    const removedFromSermonsCount = await removeSpeakerFromSermons(existingSpeaker);

    const deleteBatch = firestore.batch();
    deleteBatch.delete(speakerRef);
    if (listRefToDelete) {
      deleteBatch.delete(listRefToDelete);
    }
    await deleteBatch.commit();

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
