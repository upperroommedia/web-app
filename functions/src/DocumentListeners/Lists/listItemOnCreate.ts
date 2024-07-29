import { firestore } from 'firebase-functions';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import handleError from '../../handleError';
import { firestoreAdminListConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
// TODO: add on update listener
const listItemOnCreate = firestore
  .document('lists/{listId}/listItems/{sermonId}')
  .onCreate(async (snapshot, context) => {
    const { listId, sermonId } = context.params;
    const firestore = firebaseAdmin.firestore();
    try {
      const list = (
        await firestore.collection('lists').doc(listId).withConverter(firestoreAdminListConverter).get()
      ).data();
      if (!list) {
        throw new HttpsError('internal', 'Something went wrong, please try again later');
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { count: _count, updatedAtMillis: _updatedAtMillis, ...listNoCountOrUpdatedAtMillis } = list;
      const batch = firestore.batch();
      batch.create(
        firestore
          .collection('sermons')
          .doc(sermonId)
          .collection('sermonLists')
          .doc(listId)
          .withConverter(firestoreAdminListConverter),
        listNoCountOrUpdatedAtMillis
      );
      batch.update(firestore.doc(`lists/${listId}`).withConverter(firestoreAdminListConverter), {
        count: FieldValue.increment(1),
      });
      return batch.commit();
    } catch (error) {
      throw handleError(error);
    }
  });

export default listItemOnCreate;
