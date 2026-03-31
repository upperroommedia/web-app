import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import type { SermonList } from '@upperroom/shared/types/SermonList';

const firestore = firebaseAdmin.firestore();

type CanonicalMembershipStatus = Pick<SermonList, 'uploadStatus'> | undefined;

export const syncRootProjectionStatusFromCanonical = async ({
  sermonId,
  rootListId,
  canonicalMembership,
}: {
  sermonId: string;
  rootListId: string;
  canonicalMembership?: CanonicalMembershipStatus;
}): Promise<void> => {
  const normalizedSermonId = sermonId?.trim();
  const normalizedRootListId = rootListId?.trim();

  if (!normalizedSermonId || !normalizedRootListId) {
    console.warn('Skipping root projection status sync because sermonId or rootListId is missing', {
      sermonId,
      rootListId,
    });
    return;
  }

  const projectionRef = firestore
    .collection('lists')
    .doc(normalizedRootListId)
    .collection('listItems')
    .doc(normalizedSermonId);
  const projectionSnapshot = await projectionRef.get();

  if (!projectionSnapshot.exists) {
    return;
  }

  const nextUploadStatus = canonicalMembership?.uploadStatus ?? { status: uploadStatus.NOT_UPLOADED };
  const shouldClearPlacement = nextUploadStatus.status !== uploadStatus.UPLOADED;

  await firestore.runTransaction(async (transaction) => {
    const latestSnapshot = await transaction.get(projectionRef);
    if (!latestSnapshot.exists) {
      return;
    }

    const latestData = latestSnapshot.data() ?? {};
    const nextProjection = {
      ...latestData,
      uploadStatus: nextUploadStatus,
    } as Record<string, unknown>;

    if (shouldClearPlacement) {
      delete nextProjection.physicalPlacement;
    }

    transaction.set(projectionRef, nextProjection);
  });
};
