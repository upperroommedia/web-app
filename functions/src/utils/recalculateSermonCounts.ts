import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { firestoreAdminSermonConverter } from '../firestoreDataConverter';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { SermonList } from '@upperroom/shared/types/SermonList';

/**
 * Recalculates and updates the numberOfLists and numberOfListsUploadedTo counts for a sermon
 * based on the actual sermonLists subcollection data.
 * This can be used to fix inconsistent count states.
 */
export async function recalculateSermonCounts(
  sermonId: string,
  beforeNumberOfLists: number,
  beforeNumberOfListsUploadedTo: number
): Promise<{ wasInconsistent: boolean; after: { numberOfLists: number; numberOfListsUploadedTo: number } }> {
  const firestoreDb = firebaseAdmin.firestore();

  try {
    // Get all sermon lists for this sermon
    const sermonListsSnapshot = await firestoreDb.collection('sermons').doc(sermonId).collection('sermonLists').get();

    let numberOfLists = 0;
    let numberOfListsUploadedTo = 0;

    sermonListsSnapshot.docs.forEach((doc) => {
      const sermonList = doc.data() as SermonList;
      numberOfLists++;

      if (sermonList.uploadStatus?.status === uploadStatus.UPLOADED) {
        numberOfListsUploadedTo++;
      }
    });

    const wasInconsistent =
      beforeNumberOfLists !== numberOfLists || beforeNumberOfListsUploadedTo !== numberOfListsUploadedTo;

    // Update the sermon document with the correct counts
    if (wasInconsistent) {
      const sermonRef = firestoreDb.doc(`sermons/${sermonId}`).withConverter(firestoreAdminSermonConverter);
      await sermonRef.update({
        numberOfLists,
        numberOfListsUploadedTo,
      });

      console.log(`Recalculated counts for sermon ${sermonId}: ${numberOfListsUploadedTo}/${numberOfLists}`);
    }
    return { wasInconsistent, after: { numberOfLists, numberOfListsUploadedTo } };
  } catch (error) {
    console.error(`Error recalculating counts for sermon ${sermonId}:`, error);
    throw error;
  }
}

/**
 * Validates that the sermon counts match the actual data.
 * Returns true if counts are correct, false if they need to be recalculated.
 */
export async function validateSermonCounts(sermonId: string): Promise<boolean> {
  const firestoreDb = firebaseAdmin.firestore();

  try {
    // Get the sermon document
    const sermonDoc = await firestoreDb.doc(`sermons/${sermonId}`).withConverter(firestoreAdminSermonConverter).get();
    if (!sermonDoc.exists) {
      console.warn(`Sermon ${sermonId} does not exist`);
      return false;
    }

    const sermon = sermonDoc.data()!;
    const currentNumberOfLists = sermon.numberOfLists || 0;
    const currentNumberOfListsUploadedTo = sermon.numberOfListsUploadedTo || 0;

    // Calculate actual counts
    const { wasInconsistent, after } = await recalculateSermonCounts(
      sermonId,
      currentNumberOfLists,
      currentNumberOfListsUploadedTo
    );

    if (wasInconsistent) {
      console.warn(
        `Sermon ${sermonId} has inconsistent counts. Current: ${currentNumberOfListsUploadedTo}/${currentNumberOfLists}, Actual: ${after.numberOfListsUploadedTo}/${after.numberOfLists}`
      );
    }

    return !wasInconsistent;
  } catch (error) {
    console.error(`Error validating counts for sermon ${sermonId}:`, error);
    return false;
  }
}
