import { firestore } from 'firebase-functions';
import { firestore as firestoreAdmin } from 'firebase-admin';
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
      const list = (await firestoreAdmin().collection('lists').doc(listId).get()).data();
      if (!list) {
        throw new HttpsError('internal', 'Something went wrong, please try again later');
      }
      const batch = firestoreAdmin().batch();
      batch.create(
        firestoreAdmin()
          .collection('sermons')
          .doc(sermonId)
          .collection('sermonLists')
          .doc(listId)
          .withConverter(firestoreAdminListConverter),
        list
      );
      batch.update(firestoreAdmin().doc(`lists/${listId}`).withConverter(firestoreAdminListConverter), {
        count: FieldValue.increment(1),
      });
      return batch.commit();
    } catch (error) {
      throw handleError(error);
    }
  });

export default listItemOnCreate;