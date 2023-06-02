import { firestore, logger } from 'firebase-functions';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { firestoreAdminListConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';

const listItemOnDelete = firestore
  .document('lists/{listId}/listItems/{sermonId}')
  .onDelete(async (snapshot, context) => {
    const { listId, sermonId } = context.params;
    const firestore = firebaseAdmin.firestore();
    // removing list from sermon if sermon still exists
    try {
      logger.info(`Removing list ${listId} from sermon ${sermonId}`);
      await firestore.collection('sermons').doc(sermonId).collection('sermonLists').doc(listId).delete();
    } catch (err) {
      logger.info(`Sermon ${sermonId} does not exist - skipping delete`);
    }
    try {
      logger.log('Decrementing list count');
      await firestore
        .collection('lists')
        .doc(listId)
        .withConverter(firestoreAdminListConverter)
        .update({ count: FieldValue.increment(-1) });
      return;
    } catch (error) {
      logger.error(`Error decrementing list count: ${error} - this can be ignored if the list was deleted`);
    }
  });

export default listItemOnDelete;
