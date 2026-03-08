import firestore, { deleteDoc, doc } from '../firebase/firestore';
import { DeleteFromSubsplashInputType, DeleteFromSubsplashReturnType } from '../functions/src/deleteFromSubsplash';
import { sermonConverter } from '../types/Sermon';
import { createOperationKey, formatLockBusyRetryMessage, parseLockBusyDetails } from './callableConcurrency';
import { createFunctionV2 } from './createFunction';

export interface DeleteSermonWithExternalCleanupInput {
  sermonId: string;
  subsplashId?: string;
  soundCloudTrackId?: string;
}

const getDeleteErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'Failed to delete sermon';
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

export class ExternalCleanupError extends Error {
  code?: string;
  details?: unknown;
  cause?: unknown;

  constructor(message: string, options: { code?: string; details?: unknown; cause?: unknown } = {}) {
    super(message);
    this.name = 'ExternalCleanupError';
    this.code = options.code;
    this.details = options.details;
    this.cause = options.cause;
  }
}

const createExternalCleanupError = (error: unknown): ExternalCleanupError => {
  const fallbackMessage = 'Failed to delete sermon because external cleanup is currently busy.';
  const lockBusyDetails = parseLockBusyDetails(error);
  const message = lockBusyDetails
    ? formatLockBusyRetryMessage(fallbackMessage, lockBusyDetails)
    : getDeleteErrorMessage(error);

  const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
  const details = isRecord(error) && 'details' in error ? error.details : undefined;

  return new ExternalCleanupError(message, {
    code,
    details,
    cause: error,
  });
};

export async function deleteSermonWithExternalCleanup({
  sermonId,
  subsplashId,
  soundCloudTrackId,
}: DeleteSermonWithExternalCleanupInput): Promise<void> {
  try {
    if (!sermonId || sermonId.trim().length === 0) {
      throw new Error('Missing sermon id');
    }

    const externalCleanupPromises: Promise<unknown>[] = [];
    const operationKey = createOperationKey('sermon-admin-delete-cleanup', sermonId);

    if (subsplashId) {
      const deleteFromSubsplash = createFunctionV2<DeleteFromSubsplashInputType, DeleteFromSubsplashReturnType>('deletefromsubsplash');
      externalCleanupPromises.push(deleteFromSubsplash({ subsplashId, operationKey }));
    }

    if (soundCloudTrackId) {
      const deleteFromSoundCloud = createFunctionV2<{ soundCloudTrackId: string }, void>('deletefromsoundcloud');
      externalCleanupPromises.push(deleteFromSoundCloud({ soundCloudTrackId }));
    }

    await Promise.all(externalCleanupPromises);

    await deleteDoc(doc(firestore, 'sermons', sermonId).withConverter(sermonConverter));
  } catch (error) {
    throw createExternalCleanupError(error);
  }
}
