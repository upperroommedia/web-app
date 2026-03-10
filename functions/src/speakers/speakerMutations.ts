import { HttpsError } from 'firebase-functions/v2/https';
import { ImageType } from '../../../types/Image';
import {
  CreateSpeakerCallableInputType,
  DeleteSpeakerCallableInputType,
  UpdateSpeakerCallableInputType,
} from './createSpeakerTypes';

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
