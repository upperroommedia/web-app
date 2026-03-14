import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { firestoreAdminListConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';

const listItemOnDelete = onDocumentDeleted('lists/{listId}/listItems/{sermonId}', async (event) => {
  const { listId, sermonId } = event.params;
  const firestoreDb = firebaseAdmin.firestore();

  // Remove list from sermon if sermon still exists
  try {
    const sermonListRef = firestoreDb.collection('sermons').doc(sermonId).collection('sermonLists').doc(listId);
    const listRef = firestoreDb.collection('lists').doc(listId).withConverter(firestoreAdminListConverter);

    await firestoreDb.runTransaction(async (transaction) => {
      // Reads must come before writes in a transaction
      const sermonListDoc = await transaction.get(sermonListRef);
      const listDoc = await transaction.get(listRef);

      if (sermonListDoc.exists) {
        logger.info(`Removing list ${listId} from sermon ${sermonId}`);
        transaction.delete(sermonListRef);
        logger.info(`Successfully removed sermon list ${listId} from sermon ${sermonId}`);
      } else {
        logger.info(`Sermon list ${listId} for sermon ${sermonId} does not exist, skipping delete`);
      }

      // Decrement list count
      if (listDoc.exists) {
        logger.info(`Decrementing count for list ${listId}`);
        transaction.update(listRef, {
          count: FieldValue.increment(-1),
        });
        logger.info(`Successfully decremented count for list ${listId}`);
      } else {
        logger.warn(`List ${listId} does not exist, skipping count decrement`);
      }
    });
  } catch (error) {
    logger.error(`listItemOnDelete failed for listId: ${listId} and sermonId: ${sermonId}:`, error);
    // Don't throw here as this is expected when the list is being deleted
  }
});

export default listItemOnDelete;
