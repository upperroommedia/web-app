import { firestore } from 'firebase-functions';
import { db } from '../../../../firebase/firebaseAdmin';
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
      const list = (await db.collection('lists').doc(listId).get()).data();
      if (!list) {
        throw new HttpsError('internal', 'Something went wrong, please try again later');
      }
      const batch = db.batch();
      batch.create(
        db
          .collection('sermons')
          .doc(sermonId)
          .collection('sermonLists')
          .doc(listId)
          .withConverter(firestoreAdminListConverter),
        list
      );
      batch.update(db.doc(`lists/${listId}`).withConverter(firestoreAdminListConverter), {
        count: FieldValue.increment(1),
      });
      return batch.commit();
    } catch (error) {
      throw handleError(error);
    }
  });

export default listItemOnCreate;
