import { FieldValue } from 'firebase-admin/firestore';
import { firestore, logger } from 'firebase-functions';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { SermonList } from '../../../../types/SermonList';
import { uploadStatus } from '../../../../types/SermonTypes';
import { firestoreAdminSermonConverter } from '../../firestoreDataConverter';
import handleError from '../../handleError';

const sermonListOnUpdate = firestore
  .document('sermons/{sermonId}/sermonLists/{sermonListId}')
  .onUpdate(async (change, context) => {
    const { sermonId } = context.params;
    const previousList = change.before.data() as SermonList;
    const updatedList = change.after.data() as SermonList;
    const firestore = firebaseAdmin.firestore();
    const previousUploadStatus = previousList?.uploadStatus?.status;
    const updatedUploadStatus = updatedList?.uploadStatus?.status;
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
  });

export default sermonListOnUpdate;
