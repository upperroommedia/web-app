import { firestore } from 'firebase-functions';
import { adminFirestore } from '../../../../firebase/initFirebaseAdmin';
import handleError from '../../handleError';
import { firestoreAdminListConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
// TODO: add on update listener
const listItemOnCreate = firestore
  .document('lists/{listId}/listItems/{sermonId}')
  .onCreate(async (snapshot, context) => {
    const { listId, sermonId } = context.params;
    try {
      const list = (await adminFirestore.collection('lists').doc(listId).get()).data();
      if (!list) {
        throw new HttpsError('internal', 'Something went wrong, please try again later');
      }
      const batch = adminFirestore.batch();
      batch.create(
        adminFirestore
          .collection('sermons')
          .doc(sermonId)
          .collection('sermonLists')
          .doc(listId)
          .withConverter(firestoreAdminListConverter),
        list
      );
      batch.update(adminFirestore.doc(`lists/${listId}`).withConverter(firestoreAdminListConverter), {
        count: FieldValue.increment(1),
      });
      return batch.commit();
    } catch (error) {
      throw handleError(error);
    }
  });

export default listItemOnCreate;
