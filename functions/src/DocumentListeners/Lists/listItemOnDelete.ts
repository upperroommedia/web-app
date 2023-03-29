import { firestore, logger } from 'firebase-functions';
import { firestore as firestoreAdmin } from 'firebase-admin';
import { firestoreAdminListConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';

const listItemOnDelete = firestore
  .document('lists/{listId}/listItems/{sermonId}')
  .onDelete(async (snapshot, context) => {
    const { listId, sermonId } = context.params;
    // removing list from sermon if sermon still exists
    try {
      logger.info(`Removing list ${listId} from sermon ${sermonId}`);
      await firestoreAdmin().collection('sermons').doc(sermonId).collection('sermonLists').doc(listId).delete();
    } catch (err) {
      logger.info(`Sermon ${sermonId} does not exist - skipping delete`);
    }
    try {
      logger.log('Decrementing list count');
      await firestoreAdmin()
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
