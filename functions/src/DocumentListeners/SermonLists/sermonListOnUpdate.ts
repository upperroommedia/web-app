import { FieldValue } from 'firebase-admin/firestore';
import { firestore, logger } from 'firebase-functions/v2';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { SermonList } from '@upperroom/shared/types/SermonList';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { firestoreAdminSermonConverter } from '../../firestoreDataConverter';
import handleError from '../../handleError';
import { ensureSermonCountInvariant } from '../../utils/sermonCountInvariantGuard';
import { syncRootProjectionStatusFromCanonical } from '../../helpers/syncRootProjectionStatusFromCanonical';
import { deriveSubsplashStatus } from '../../utils/deriveSubsplashStatus';

const sermonListOnUpdate = firestore.onDocumentUpdated(
  'sermons/{sermonId}/sermonLists/{sermonListId}',
  async (event) => {
    const { sermonId, sermonListId } = event.params;
    const previousList = event.data?.before.data() as SermonList;
    const updatedList = event.data?.after.data() as SermonList;
    const firestoreDb = firebaseAdmin.firestore();
    const previousUploadStatus = previousList?.uploadStatus?.status;
    const updatedUploadStatus = updatedList?.uploadStatus?.status;

    logger.log(
      `sermonListOnUpdate called on sermon ${sermonId} sermonList ${sermonListId}. PreviousUploadStatus: ${previousUploadStatus}, updatedUploadStatus: ${updatedUploadStatus}`
    );

    try {
      const sermonRef = firestoreDb.doc(`sermons/${sermonId}`).withConverter(firestoreAdminSermonConverter);
      let didMutate = false;

      // Sermon was uploaded
      await firestoreDb.runTransaction(async (transaction) => {
        const sermonDoc = await transaction.get(sermonRef);
        if (sermonDoc.exists) {
          const sermon = sermonDoc.data();
          let incrementValue = 0;
          if (previousUploadStatus !== uploadStatus.UPLOADED && updatedUploadStatus === uploadStatus.UPLOADED) {
            logger.log('Sermon was uploaded - incrementing numberOfListsUploadedTo');
            incrementValue = 1;
          } else if (previousUploadStatus === uploadStatus.UPLOADED && updatedUploadStatus !== uploadStatus.UPLOADED) {
            logger.log('Sermon was removed - decrementing numberOfListsUploadedTo');
            incrementValue = -1;
          }

          if (incrementValue !== 0) {
            const nextNumberOfLists = sermon?.numberOfLists ?? 0;
            const nextNumberOfListsUploadedTo = (sermon?.numberOfListsUploadedTo ?? 0) + incrementValue;
            logger.log(`Updating numberOfListsUploadedTo for sermon ${sermonId} by ${incrementValue}`);
            transaction.update(sermonRef, {
              numberOfListsUploadedTo: FieldValue.increment(incrementValue),
              'status.subsplash': deriveSubsplashStatus(nextNumberOfLists, nextNumberOfListsUploadedTo),
            });
            didMutate = true;
          } else {
            logger.log(`Upload status unchanged for sermon ${sermonId}, skipping counter increment`);
          }
        } else {
          logger.warn(`Sermon ${sermonId} does not exist, skipping increment`);
        }
      });
      if (didMutate) {
        await ensureSermonCountInvariant(sermonId);
      }
      await syncRootProjectionStatusFromCanonical({
        sermonId,
        rootListId: updatedList?.rootListId ?? sermonListId,
        canonicalMembership: updatedList,
      });
    } catch (error) {
      logger.error(`Error updating numberOfListsUploadedTo for sermon ${sermonId}:`, error);
      throw handleError(error);
    }
  }
);

export default sermonListOnUpdate;
