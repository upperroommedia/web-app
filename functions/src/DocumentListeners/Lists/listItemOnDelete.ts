import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { firestoreAdminListConverter } from '../../firestoreDataConverter';
import { shouldMirrorPhysicalListItemToRootMembership } from '../../helpers/listOverflowChain';

const listItemOnDelete = onDocumentDeleted('lists/{listId}/listItems/{sermonId}', async (event) => {
  const { listId, sermonId } = event.params;
  const firestoreDb = firebaseAdmin.firestore();

  try {
    const listRef = firestoreDb.collection('lists').doc(listId).withConverter(firestoreAdminListConverter);
    const listDoc = await listRef.get();
    const list = listDoc.data();

    if (!list || !shouldMirrorPhysicalListItemToRootMembership(list)) {
      return;
    }

    logger.warn('listItemOnDelete.autoCascadeSkipped', {
      listId,
      sermonId,
      reason: 'listItems are treated as projection data; canonical sermon membership must only be removed by explicit admin actions.',
    });
  } catch (error) {
    logger.error(`listItemOnDelete failed for listId: ${listId} and sermonId: ${sermonId}:`, error);
    // Don't throw here as this is expected when the list is being deleted
  }
});

export default listItemOnDelete;
