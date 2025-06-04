import { https, logger } from 'firebase-functions/v2';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { recalculateSermonCounts, validateSermonCounts } from './utils/recalculateSermonCounts';

interface FixSermonCountsRequest {
  sermonId?: string; // If provided, fix only this sermon. Otherwise, fix all sermons.
  validateOnly?: boolean; // If true, only validate counts without fixing them
}

interface FixSermonCountsResponse {
  success: boolean;
  message: string;
  results?: Array<{
    sermonId: string;
    wasInconsistent: boolean;
    before?: { numberOfLists: number; numberOfListsUploadedTo: number };
    after?: { numberOfLists: number; numberOfListsUploadedTo: number };
  }>;
}

const fixSermonCounts = https.onCall<FixSermonCountsRequest, Promise<FixSermonCountsResponse>>(async (request) => {
  const { sermonId, validateOnly = false } = request.data || {};
  const firestoreDb = firebaseAdmin.firestore();

  try {
    logger.info(
      `${validateOnly ? 'Validating' : 'Fixing'} sermon counts${
        sermonId ? ` for sermon ${sermonId}` : ' for all sermons'
      }`
    );

    const results: FixSermonCountsResponse['results'] = [];

    if (sermonId) {
      // Fix/validate single sermon
      const sermonDoc = await firestoreDb.doc(`sermons/${sermonId}`).get();
      if (!sermonDoc.exists) {
        return {
          success: false,
          message: `Sermon ${sermonId} does not exist`,
        };
      }

      const sermon = sermonDoc.data()!;
      const before = {
        numberOfLists: sermon.numberOfLists || 0,
        numberOfListsUploadedTo: sermon.numberOfListsUploadedTo || 0,
      };

      if (validateOnly) {
        const isValid = await validateSermonCounts(sermonId);
        results.push({
          sermonId,
          wasInconsistent: !isValid,
          before,
        });
      } else {
        const after = await recalculateSermonCounts(sermonId);
        const wasInconsistent =
          before.numberOfLists !== after.numberOfLists ||
          before.numberOfListsUploadedTo !== after.numberOfListsUploadedTo;

        results.push({
          sermonId,
          wasInconsistent,
          before,
          after,
        });
      }
    } else {
      // Fix/validate all sermons
      const sermonsSnapshot = await firestoreDb.collection('sermons').get();
      logger.info(`Processing ${sermonsSnapshot.docs.length} sermons`);

      for (const sermonDoc of sermonsSnapshot.docs) {
        const sermon = sermonDoc.data();
        const currentSermonId = sermonDoc.id;
        const before = {
          numberOfLists: sermon.numberOfLists || 0,
          numberOfListsUploadedTo: sermon.numberOfListsUploadedTo || 0,
        };

        try {
          if (validateOnly) {
            const isValid = await validateSermonCounts(currentSermonId);
            results.push({
              sermonId: currentSermonId,
              wasInconsistent: !isValid,
              before,
            });
          } else {
            const after = await recalculateSermonCounts(currentSermonId);
            const wasInconsistent =
              before.numberOfLists !== after.numberOfLists ||
              before.numberOfListsUploadedTo !== after.numberOfListsUploadedTo;

            results.push({
              sermonId: currentSermonId,
              wasInconsistent,
              before,
              after,
            });
          }
        } catch (error) {
          logger.error(`Error processing sermon ${currentSermonId}:`, error);
          results.push({
            sermonId: currentSermonId,
            wasInconsistent: true,
            before,
          });
        }
      }
    }

    const inconsistentCount = results.filter((r) => r.wasInconsistent).length;
    const totalCount = results.length;

    const message = validateOnly
      ? `Validation complete. ${inconsistentCount}/${totalCount} sermons have inconsistent counts.`
      : `Fix complete. ${inconsistentCount}/${totalCount} sermons had inconsistent counts and were fixed.`;

    logger.info(message);

    return {
      success: true,
      message,
      results,
    };
  } catch (error) {
    logger.error('Error in fixSermonCounts:', error);
    return {
      success: false,
      message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
});

export default fixSermonCounts;
