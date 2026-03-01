import firestore, { deleteDoc, doc } from '../firebase/firestore';
import { DeleteFromSubsplashInputType, DeleteFromSubsplashReturnType } from '../functions/src/deleteFromSubsplash';
import { sermonConverter } from '../types/Sermon';
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

    if (subsplashId) {
      const deleteFromSubsplash = createFunctionV2<DeleteFromSubsplashInputType, DeleteFromSubsplashReturnType>('deletefromsubsplash');
      externalCleanupPromises.push(deleteFromSubsplash({ subsplashId }));
    }

    if (soundCloudTrackId) {
      const deleteFromSoundCloud = createFunctionV2<{ soundCloudTrackId: string }, void>('deletefromsoundcloud');
      externalCleanupPromises.push(deleteFromSoundCloud({ soundCloudTrackId }));
    }

    const cleanupResults = await Promise.allSettled(externalCleanupPromises);
    cleanupResults.forEach((result) => {
      if (result.status === 'rejected') {
        console.error('External sermon cleanup failed:', result.reason);
      }
    });

    await deleteDoc(doc(firestore, 'sermons', sermonId).withConverter(sermonConverter));
  } catch (error) {
    throw new Error(getDeleteErrorMessage(error));
  }
}
