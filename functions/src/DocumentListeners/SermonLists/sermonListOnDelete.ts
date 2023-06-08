import { firestore } from 'firebase-functions';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import handleError from '../../handleError';
import { firestoreAdminSermonConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';
import { SermonList } from '../../../../types/SermonList';
import { removeFromList } from '../../removeFromList';

const sermonListOnDelete = firestore
  .document('sermons/{sermonId}/sermonLists/{sermonListId}')
  .onDelete(async (snapshot, context) => {
    const { sermonId } = context.params;
    const data = snapshot.data() as SermonList;
    const firestore = firebaseAdmin.firestore();
    try {
      if (data.uploadStatus && data.uploadStatus.status === 'UPLOADED') {
        await removeFromList([data.id], [data.uploadStatus.listItemId]);
      }
      firestore
        .doc(`sermons/${sermonId}`)
        .withConverter(firestoreAdminSermonConverter)
        .update({
          numberOfLists: FieldValue.increment(-1),
          numberOfListsUploadedTo: FieldValue.increment(
            data.uploadStatus && data.uploadStatus.status === 'UPLOADED' ? -1 : 0
          ),
        });
    } catch (error) {
      throw handleError(error);
    }
  });

export default sermonListOnDelete;
