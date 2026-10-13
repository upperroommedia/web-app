import type { Firestore } from 'firebase-admin/firestore';
import type { SermonList } from '@upperroom/shared/types/SermonList';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { deriveSubsplashStatus } from '../../utils/deriveSubsplashStatus';

export const deriveMembershipCounts = (memberships: ReadonlyArray<Pick<SermonList, 'uploadStatus'>>) => {
  const numberOfLists = memberships.length;
  const numberOfListsUploadedTo = memberships.filter(
    (membership) => membership.uploadStatus?.status === uploadStatus.UPLOADED
  ).length;
  return {
    numberOfLists,
    numberOfListsUploadedTo,
    'status.subsplash': deriveSubsplashStatus(numberOfLists, numberOfListsUploadedTo),
  };
};

// Event payloads may be duplicated or arrive out of order. Read canonical state and
// its projection in one transaction so an old event cannot overwrite a newer status.
export async function syncMembershipInvariants(
  firestore: Firestore,
  sermonId: string,
  membershipId: string,
  fallbackRootListId: string = membershipId
): Promise<void> {
  const sermonRef = firestore.doc(`sermons/${sermonId}`);
  const membershipsRef = sermonRef.collection('sermonLists');
  await firestore.runTransaction(async (transaction) => {
    const sermon = await transaction.get(sermonRef);
    if (!sermon.exists) return;
    const [total, uploaded, canonicalDocument] = await Promise.all([
      transaction.get(membershipsRef.count()),
      transaction.get(membershipsRef.where('uploadStatus.status', '==', uploadStatus.UPLOADED).count()),
      transaction.get(membershipsRef.doc(membershipId)),
    ]);
    const canonical = canonicalDocument.data() as SermonList | undefined;
    const rootListId = canonical?.rootListId ?? fallbackRootListId;
    const projectionRef = rootListId?.trim() ? firestore.doc(`lists/${rootListId}/listItems/${sermonId}`) : undefined;
    const projection = projectionRef ? await transaction.get(projectionRef) : undefined;
    const numberOfLists = total.data().count;
    const numberOfListsUploadedTo = uploaded.data().count;
    transaction.update(sermonRef, {
      numberOfLists,
      numberOfListsUploadedTo,
      'status.subsplash': deriveSubsplashStatus(numberOfLists, numberOfListsUploadedTo),
    });
    if (projectionRef && projection?.exists) {
      const upload = canonical?.uploadStatus ?? { status: uploadStatus.NOT_UPLOADED };
      const nextProjection = { ...projection.data(), uploadStatus: upload } as Record<string, unknown>;
      if (upload.status !== uploadStatus.UPLOADED) delete nextProjection.physicalPlacement;
      transaction.set(projectionRef, nextProjection);
    }
  });
}
