import { FieldValue } from 'firebase-admin/firestore';
import { firestore, logger } from 'firebase-functions/v2';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { SermonList } from '../../../../types/SermonList';
import { uploadStatus } from '../../../../types/SermonTypes';
import { firestoreAdminSermonConverter } from '../../firestoreDataConverter';
import handleError from '../../handleError';

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

      // Sermon was uploaded
      if (previousUploadStatus !== uploadStatus.UPLOADED && updatedUploadStatus === uploadStatus.UPLOADED) {
        logger.log('Sermon was uploaded - incrementing numberOfListsUploadedTo');
        await firestoreDb.runTransaction(async (transaction) => {
          const sermonDoc = await transaction.get(sermonRef);
          if (sermonDoc.exists) {
            transaction.update(sermonRef, {
              numberOfListsUploadedTo: FieldValue.increment(1),
            });
          } else {
            logger.warn(`Sermon ${sermonId} does not exist, skipping increment`);
          }
        });
      } else if (previousUploadStatus === uploadStatus.UPLOADED && updatedUploadStatus !== uploadStatus.UPLOADED) {
        logger.log('Sermon was removed - decrementing numberOfListsUploadedTo');
        await firestoreDb.runTransaction(async (transaction) => {
          const sermonDoc = await transaction.get(sermonRef);
          if (sermonDoc.exists) {
            transaction.update(sermonRef, {
              numberOfListsUploadedTo: FieldValue.increment(-1),
            });
          } else {
            logger.warn(`Sermon ${sermonId} does not exist, skipping decrement`);
          }
        });
      }
    } catch (error) {
      logger.error(`Error updating numberOfListsUploadedTo for sermon ${sermonId}:`, error);
      throw handleError(error);
    }
  }
);

export default sermonListOnUpdate;
