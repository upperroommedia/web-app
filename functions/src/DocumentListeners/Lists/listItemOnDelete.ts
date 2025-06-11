import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { firestoreAdminListConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';

const listItemOnDelete = onDocumentDeleted(
  'lists/{listId}/listItems/{sermonId}',
  async (event) => {
    const { listId, sermonId } = event.params;
    const firestoreDb = firebaseAdmin.firestore();

    // Remove list from sermon if sermon still exists
    try {
      logger.info(`Removing list ${listId} from sermon ${sermonId}`);
      const sermonListRef = firestoreDb.collection('sermons').doc(sermonId).collection('sermonLists').doc(listId);

      // Check if the sermon list document exists before deleting
      const sermonListDoc = await sermonListRef.get();
      if (sermonListDoc.exists) {
        await sermonListRef.delete();
        logger.info(`Successfully removed sermon list ${listId} from sermon ${sermonId}`);
      } else {
        logger.info(`Sermon list ${listId} for sermon ${sermonId} does not exist, skipping delete`);
      }
    } catch (err) {
      logger.error(`Error removing list ${listId} from sermon ${sermonId}:`, err);
      // Don't throw here as we still want to update the list count
    }

    // Decrement list count
    try {
      logger.info(`Decrementing count for list ${listId}`);
      await firestoreDb
        .collection('lists')
        .doc(listId)
        .withConverter(firestoreAdminListConverter)
        .update({ count: FieldValue.increment(-1) });
      logger.info(`Successfully decremented count for list ${listId}`);
    } catch (error) {
      logger.error(
        `Error decrementing list count for ${listId}:`,
        error,
        '- this can be ignored if the list was deleted'
      );
      // Don't throw here as this is expected when the list is being deleted
    }
  }
);

export default listItemOnDelete;
