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
  const tagId = normalizeOptionalString(speakerRecord.tagId);
  const sermonCountValue = speakerRecord.sermonCount;
  const sermonCount = typeof sermonCountValue === 'number' ? sermonCountValue : 0;

  return {
    speaker: {
      name,
      images: images ?? [],
      sermonCount,
      ...(tagId ? { tagId } : {}),
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
  const operationKey = normalizeOptionalString(payload.operationKey);
  const name = patch.name === undefined ? undefined : requireTrimmedSpeakerName(patch.name, 'patch.name');
  const images = patch.images === undefined ? undefined : (patch.images as ImageType[]);
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

  if (name === undefined && images === undefined && associatedListId === undefined && !createSpeakerList) {
    throw new HttpsError('invalid-argument', 'At least one patch field is required.');
  }

  return {
    speakerId,
    patch: {
      ...(name !== undefined ? { name } : {}),
      ...(images !== undefined ? { images } : {}),
      ...(associatedListId !== undefined ? { associatedListId } : {}),
    },
    createSpeakerList,
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
  squareImage: ImageType,
  operationKey?: string
): Promise<PreparedSpeakerListType> => {
  const createResult = await createNewSubsplashList({
    title: speakerName,
    images: [squareImage],
    ...(operationKey ? { operationKey } : {}),
  });

  const listRef = listsCollection.doc();
  const now = Date.now();
  return {
    listRef,
    list: {
      id: listRef.id,
      name: speakerName,
      images: [squareImage],
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 0,
      type: ListType.SPEAKER_LIST,
      createdAtMillis: now,
      updatedAtMillis: now,
      subsplashId: createResult.listId,
    },
  };
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

    let preparedList: PreparedSpeakerListType | undefined;
    if (input.createSpeakerList) {
      preparedList = await prepareSpeakerList(
        normalizedName,
        squareImage,
        scopeOperationKey(input.operationKey, 'create-speaker-list')
      );
    }

    const speakerRef = speakersCollection.doc();
    const associatedListId = preparedList?.list.id ?? input.associatedListId;
    const speaker: ISpeaker = {
      id: speakerRef.id,
      name: normalizedName,
      images: input.speaker.images,
      sermonCount: input.speaker.sermonCount ?? 0,
      ...(input.speaker.tagId ? { tagId: input.speaker.tagId } : {}),
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
    const squareImage = requireSquareImage(nextImages);
    const normalizedName = requireTrimmedSpeakerName(nextName);

    if (normalizeSpeakerNameForDuplicateCheck(existingSpeaker.name) !== normalizeSpeakerNameForDuplicateCheck(normalizedName)) {
      await assertSpeakerNameUnique(normalizedName, existingSpeaker.id);
    }

    let preparedList: PreparedSpeakerListType | undefined;
    if (input.createSpeakerList) {
      preparedList = await prepareSpeakerList(
        normalizedName,
        squareImage,
        scopeOperationKey(input.operationKey, 'create-speaker-list')
      );
    }

    let nextListId = existingSpeaker.listId;
    if (preparedList) {
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

    const updatedSpeaker: ISpeaker = {
      id: existingSpeaker.id,
      name: normalizedName,
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
    let deletedListId: string | undefined;
    let deletedSubsplashListId: string | undefined;

    if (input.deleteAssociatedList && existingSpeaker.listId) {
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

        const batch = firestore.batch();
        batch.delete(speakerRef);
        batch.delete(listRef);
        await batch.commit();

        return {
          status: 'success',
          speakerId: existingSpeaker.id,
          listDeleted: true,
          ...(deletedListId ? { deletedListId } : {}),
          ...(deletedSubsplashListId ? { deletedSubsplashListId } : {}),
        };
      }
    }

    await speakerRef.delete();

    return {
      status: 'success',
      speakerId: existingSpeaker.id,
      listDeleted: false,
      ...(deletedListId ? { deletedListId } : {}),
      ...(deletedSubsplashListId ? { deletedSubsplashListId } : {}),
    };
  });
};
