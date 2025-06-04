import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { firestoreAdminSermonConverter } from '../firestoreDataConverter';
import { uploadStatus } from '../../../types/SermonTypes';
import { SermonList } from '../../../types/SermonList';

/**
 * Recalculates and updates the numberOfLists and numberOfListsUploadedTo counts for a sermon
 * based on the actual sermonLists subcollection data.
 * This can be used to fix inconsistent count states.
 */
export async function recalculateSermonCounts(sermonId: string): Promise<{ numberOfLists: number; numberOfListsUploadedTo: number }> {
    const firestoreDb = firebaseAdmin.firestore();

    try {
        // Get all sermon lists for this sermon
        const sermonListsSnapshot = await firestoreDb
            .collection('sermons')
            .doc(sermonId)
            .collection('sermonLists')
            .get();

        let numberOfLists = 0;
        let numberOfListsUploadedTo = 0;

        sermonListsSnapshot.docs.forEach((doc) => {
            const sermonList = doc.data() as SermonList;
            numberOfLists++;

            if (sermonList.uploadStatus?.status === uploadStatus.UPLOADED) {
                numberOfListsUploadedTo++;
            }
        });

        // Update the sermon document with the correct counts
        const sermonRef = firestoreDb.doc(`sermons/${sermonId}`).withConverter(firestoreAdminSermonConverter);
        await sermonRef.update({
            numberOfLists,
            numberOfListsUploadedTo,
        });

        console.log(`Recalculated counts for sermon ${sermonId}: ${numberOfListsUploadedTo}/${numberOfLists}`);

        return { numberOfLists, numberOfListsUploadedTo };
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
        const { numberOfLists, numberOfListsUploadedTo } = await recalculateSermonCounts(sermonId);

        const isValid = currentNumberOfLists === numberOfLists && currentNumberOfListsUploadedTo === numberOfListsUploadedTo;

        if (!isValid) {
            console.warn(`Sermon ${sermonId} has inconsistent counts. Current: ${currentNumberOfListsUploadedTo}/${currentNumberOfLists}, Actual: ${numberOfListsUploadedTo}/${numberOfLists}`);
        }

        return isValid;
    } catch (error) {
        console.error(`Error validating counts for sermon ${sermonId}:`, error);
        return false;
    }
} 