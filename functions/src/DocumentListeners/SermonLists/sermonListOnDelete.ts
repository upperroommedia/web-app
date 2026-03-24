import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import handleError from '../../handleError';
import { firestoreAdminSermonConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';
import { SermonList } from '@upperroom/shared/types/SermonList';
import { removeFromList } from '../../removeFromList';
import { ensureSermonCountInvariant } from '../../utils/sermonCountInvariantGuard';
import { syncRootProjectionStatusFromCanonical } from '../../helpers/syncRootProjectionStatusFromCanonical';

const sermonListOnDelete = onDocumentDeleted('sermons/{sermonId}/sermonLists/{sermonListId}', async (event) => {
  const snapshot = event.data;
  const { sermonId } = event.params;

  if (!snapshot) {
    console.error('Snapshot is undefined in sermonListOnDelete');
    return;
  }

  const data = snapshot.data() as SermonList;
  const firestoreDb = firebaseAdmin.firestore();

  try {
    const sermonRef = firestoreDb.doc(`sermons/${sermonId}`).withConverter(firestoreAdminSermonConverter);
    let didMutate = false;

    // First, try to remove from Subsplash if it was uploaded
    // CRITICAL FIX: Set decrementListUploadedToValue based on uploadStatus, not Subsplash removal success
    // The counter decrement should happen regardless of Subsplash removal outcome
    let decrementListUploadedToValue = 0;
    if (data.uploadStatus && data.uploadStatus.status === 'UPLOADED') {
      // Set decrement value immediately - counter should be decremented regardless of Subsplash removal
      decrementListUploadedToValue = -1;
      try {
        // Get the sermon document to find the subsplashId (item ID)
        const sermonDoc = await firestoreDb.doc(`sermons/${sermonId}`).withConverter(firestoreAdminSermonConverter).get();
        const sermonData = sermonDoc.data();
        const itemId = sermonData?.subsplashId || sermonId; // Fallback to sermonId if no subsplashId
        
        // Use subsplashId instead of data.id - removeFromList queries Firestore with subsplashId
        // to enable proper overflow list traversal
        if (!data.subsplashId) {
          logger.warn(`Cannot remove sermon ${sermonId} from Subsplash list: missing subsplashId for list ${data.id}`);
        } else {
          await removeFromList(
            [data.subsplashId], 
            [data.uploadStatus.listItemId],
            [itemId],
            ['media-item']
          );
          logger.info(`Successfully removed sermon ${sermonId} from Subsplash list ${data.subsplashId}`);
        }
      } catch (error) {
        logger.error(`Failed to remove sermon ${sermonId} from Subsplash list ${data.subsplashId || data.id}:`, error);
        // Continue with counter updates even if Subsplash removal fails
        // decrementListUploadedToValue is already set to -1 above
      }
    }

    // Update counters using transaction for atomicity
    await firestoreDb.runTransaction(async (transaction) => {
      const sermonDoc = await transaction.get(sermonRef);
      if (sermonDoc.exists) {
        transaction.update(sermonRef, {
          numberOfLists: FieldValue.increment(-1),
          numberOfListsUploadedTo: FieldValue.increment(decrementListUploadedToValue),
        });
        didMutate = true;
        logger.info(`Successfully decremented numberOfLists for sermon ${sermonId}`, {
          oldValues: {
            numberOfLists: sermonDoc.data()?.numberOfLists,
            numberOfListsUploadedTo: sermonDoc.data()?.numberOfListsUploadedTo,
          },
          changedBy: { numberOfLists: -1, numberOfListsUploadedTo: decrementListUploadedToValue },
        });
      } else {
        console.warn(`Sermon ${sermonId} does not exist, skipping counter updates`);
      }
    });

    if (didMutate) {
      await ensureSermonCountInvariant(sermonId);
    }
    await syncRootProjectionStatusFromCanonical({
      sermonId,
      rootListId: data.rootListId ?? data.id,
      canonicalMembership: undefined,
    });
  } catch (error) {
    console.error(`Error in sermonListOnDelete for sermon ${sermonId}:`, error);
    throw handleError(error);
  }
});

export default sermonListOnDelete;
