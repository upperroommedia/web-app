import { https, logger } from 'firebase-functions/v2';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { recalculateSermonCounts, validateSermonCounts } from './utils/recalculateSermonCounts';
import handleError from './handleError';

interface FixSermonCountsRequest {
  sermonId?: string; // If provided, fix only this sermon. Otherwise, fix all sermons.
  validateOnly?: boolean; // If true, only validate counts without fixing them
}

interface FixSermonCountsResponse {
  success: boolean;
  message: string;
  results?: Array<{
    sermonId: string;
    before?: { numberOfLists: number; numberOfListsUploadedTo: number };
    after?: { numberOfLists: number; numberOfListsUploadedTo: number };
  }>;
}

const fixSermonCounts = https.onCall<FixSermonCountsRequest, Promise<FixSermonCountsResponse>>(
  { memory: '1GiB' },
  async (request) => {
    const { sermonId, validateOnly = false } = request.data || {};
    const firestoreDb = firebaseAdmin.firestore();
    let totalCount = 0;
    try {
      logger.info(
        `${validateOnly ? 'Validating' : 'Fixing'} sermon counts${
          sermonId ? ` for sermon ${sermonId}` : ' for all sermons'
        }`
      );

      const results: FixSermonCountsResponse['results'] = [];

      if (sermonId) {
        // Fix/validate single sermon
        totalCount = 1;
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
          if (!isValid) {
            results.push({
              sermonId,
              before,
            });
          }
        } else {
          const { wasInconsistent, after } = await recalculateSermonCounts(
            sermonId,
            before.numberOfLists,
            before.numberOfListsUploadedTo
          );
          if (wasInconsistent) {
            results.push({
              sermonId,
              before,
              after,
            });
          }
        }
      } else {
        // Fix/validate all sermons
        const sermonsSnapshot = await firestoreDb.collection('sermons').get();
        totalCount = sermonsSnapshot.docs.length;
        logger.info(`Processing ${totalCount} sermons`);

        await Promise.all(
          sermonsSnapshot.docs.map(async (sermonDoc) => {
            const sermon = sermonDoc.data();
            const currentSermonId = sermonDoc.id;
            const before = {
              numberOfLists: sermon.numberOfLists || 0,
              numberOfListsUploadedTo: sermon.numberOfListsUploadedTo || 0,
            };

            try {
              if (validateOnly) {
                const isValid = await validateSermonCounts(currentSermonId);
                if (!isValid) {
                  results.push({
                    sermonId: currentSermonId,
                    before,
                  });
                }
              } else {
                const { wasInconsistent, after } = await recalculateSermonCounts(
                  currentSermonId,
                  before.numberOfLists,
                  before.numberOfListsUploadedTo
                );
                if (wasInconsistent) {
                  results.push({
                    sermonId: currentSermonId,
                    before,
                    after,
                  });
                }
              }
            } catch (error) {
              logger.error(`Error processing sermon ${currentSermonId}:`, error);
              results.push({
                sermonId: currentSermonId,
                before,
              });
            }
          })
        );
      }

      const inconsistentCount = results.length;

      const message = validateOnly
        ? `Validation complete. ${inconsistentCount}/${totalCount} sermons have inconsistent counts.`
        : `Fix complete. ${inconsistentCount}/${totalCount} sermons had inconsistent counts and were fixed.`;

      logger.info(message);
      logger.info('Results:', results);

      return {
        success: true,
        message,
        results,
      };
    } catch (error) {
      handleError(error, {
        alertCode: 'FIX_SERMON_COUNTS_RUNTIME_FAILURE',
        summary: 'fixSermonCounts failed while validating or repairing sermon counts.',
        context: { functionName: 'fixSermonCounts', sermonId: sermonId ?? null, validateOnly },
      });
      logger.error('Error in fixSermonCounts:', error);
      return {
        success: false,
        message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }
);

export default fixSermonCounts;
