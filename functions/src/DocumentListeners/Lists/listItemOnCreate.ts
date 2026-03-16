import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import handleError from '../../handleError';
import { firestoreAdminListConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { shouldMirrorPhysicalListItemToRootMembership } from '../../helpers/listOverflowChain';
// TODO: add on update listener
const listItemOnCreate = onDocumentCreated(
  'lists/{listId}/listItems/{sermonId}',
  async (event) => {
    const { listId, sermonId } = event.params;
    const firestore = firebaseAdmin.firestore();
    try {
      const list = (
        await firestore.collection('lists').doc(listId).withConverter(firestoreAdminListConverter).get()
      ).data();
      if (!list) {
        throw new HttpsError('internal', 'Something went wrong, please try again later');
      }

      if (!shouldMirrorPhysicalListItemToRootMembership(list)) {
        return;
      }

      const sermonListRef = firestore.collection('sermons').doc(sermonId).collection('sermonLists').doc(listId);
      const existingSermonList = await sermonListRef.get();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { count: _count, updatedAtMillis: _updatedAtMillis, ...listNoCountOrUpdatedAtMillis } = list;
      const batch = firestore.batch();
      if (!existingSermonList.exists) {
        batch.create(
          sermonListRef.withConverter(firestoreAdminListConverter),
          listNoCountOrUpdatedAtMillis
        );
      }
      batch.update(firestore.doc(`lists/${listId}`).withConverter(firestoreAdminListConverter), {
        count: FieldValue.increment(1),
      });
      return batch.commit();
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default listItemOnCreate;
