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
    const firestore = firebaseAdmin.firestore();
    const previousUploadStatus = previousList?.uploadStatus?.status;
    const updatedUploadStatus = updatedList?.uploadStatus?.status;

    logger.log(
      `sermonListOnUpdate called on sermon ${sermonId} sermonList ${sermonListId}. PreviousUploadStatus: ${previousUploadStatus}, updatedUploadStatus: ${updatedUploadStatus}`
    );
    try {
      // Sermon was uploaded
      if (previousUploadStatus !== uploadStatus.UPLOADED && updatedUploadStatus === uploadStatus.UPLOADED) {
        logger.log('Sermon was uploaded');
        firestore
          .doc(`sermons/${sermonId}`)
          .withConverter(firestoreAdminSermonConverter)
          .update({
            numberOfListsUploadedTo: FieldValue.increment(1),
          });
      } else if (previousUploadStatus === uploadStatus.UPLOADED && updatedUploadStatus !== uploadStatus.UPLOADED) {
        logger.log('Sermon was removed');
        firestore
          .doc(`sermons/${sermonId}`)
          .withConverter(firestoreAdminSermonConverter)
          .update({
            numberOfListsUploadedTo: FieldValue.increment(-1),
          });
      }
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default sermonListOnUpdate;
