/**
 * Firebase callable function to delete a media series
 */

import { randomUUID } from 'node:crypto';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { authenticateSubsplash } from './subsplashUtils';
import {
  deleteSubsplashSeries,
  getAllSeriesItemsAcrossStatuses,
  unlinkMediaItemFromSeries,
} from './helpers/seriesHelpers';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { firestoreAdminSeriesConverter } from './firestoreDataConverter';
import { canUserRolePublish } from '../../types/User';
import handleError from './handleError';
import { runWithConcurrency } from './utils/runWithConcurrency';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { withIdempotency } from './locks/withIdempotency';

const firestoreDB = firebaseAdmin.firestore();

const FIRESTORE_BATCH_OP_LIMIT = 400;
const REMOTE_UNLINK_DEFAULT_CONCURRENCY = 4;
const REMOTE_UNLINK_MAX_CONCURRENCY = 5;

export interface DeleteSeriesInputType {
  firestoreId: string;
  operationKey?: string;
}

export interface DeleteSeriesOutputType {
  status: 'success' | 'error';
  remoteUnlinkAttempted: number;
  remoteUnlinkSucceeded: number;
  remoteUnlinkSkippedNotFound: number;
  remoteRemainingLinkedCount: number;
  localSeriesItemsDeleted: number;
  localSermonsUnlinked: number;
  error?: string;
}

const cleanupLocalSeriesData = async (
  firestoreId: string
): Promise<{ localSeriesItemsDeleted: number; localSermonsUnlinked: number }> => {
  const seriesRef = firestoreDB.collection('series').doc(firestoreId);
  const seriesItemsSnapshot = await seriesRef.collection('seriesItems').get();
  const sermonsSnapshot = await firestoreDB.collection('sermons').where('seriesId', '==', firestoreId).get();

  const commitPromises: Array<Promise<FirebaseFirestore.WriteResult[]>> = [];
  let batch = firestoreDB.batch();
  let operationCount = 0;

  const commitBatchIfNeeded = () => {
    if (operationCount === 0) {
      return;
    }
    commitPromises.push(batch.commit());
    batch = firestoreDB.batch();
    operationCount = 0;
  };

  const enqueueOperation = (operation: (currentBatch: FirebaseFirestore.WriteBatch) => void) => {
    if (operationCount >= FIRESTORE_BATCH_OP_LIMIT) {
      commitBatchIfNeeded();
    }
    operation(batch);
    operationCount += 1;
  };

  seriesItemsSnapshot.docs.forEach((seriesItemDoc) => {
    enqueueOperation((currentBatch) => {
      currentBatch.delete(seriesItemDoc.ref);
    });
  });

  sermonsSnapshot.docs.forEach((sermonDoc) => {
    enqueueOperation((currentBatch) => {
      currentBatch.update(sermonDoc.ref, { seriesId: null });
    });
  });

  enqueueOperation((currentBatch) => {
    currentBatch.delete(seriesRef);
  });

  commitBatchIfNeeded();
  await Promise.all(commitPromises);

  return {
    localSeriesItemsDeleted: seriesItemsSnapshot.size,
    localSermonsUnlinked: sermonsSnapshot.size,
  };
};

const deleteSeries = onCall(
  async (request: CallableRequest<DeleteSeriesInputType>): Promise<DeleteSeriesOutputType> => {
    logger.log('deleteSeries');

    // Authentication check
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated with publish permissions.');
    }

    const { firestoreId, operationKey } = request.data;

    // Validation
    if (!firestoreId || !firestoreId.trim()) {
      throw new HttpsError('invalid-argument', 'Firestore ID is required.');
    }

    const normalizedFirestoreId = firestoreId.trim();
    const normalizedOperationKey = operationKey?.trim() || `delete-series:${normalizedFirestoreId}:${randomUUID()}`;

    try {
      return await withIdempotency(normalizedOperationKey, async () => {
        return withSubsplashLocks(
          [`series:${normalizedFirestoreId}`],
          async () => {
            // Get the series document from Firestore.
            const seriesRef = firestoreDB
              .collection('series')
              .doc(normalizedFirestoreId)
              .withConverter(firestoreAdminSeriesConverter);
            const seriesDoc = await seriesRef.get();

            if (!seriesDoc.exists) {
              throw new HttpsError('not-found', `Series with Firestore ID ${normalizedFirestoreId} not found.`);
            }

            const seriesData = seriesDoc.data()!;
            const subsplashId = seriesData.subsplashId;

            let remoteUnlinkAttempted = 0;
            let remoteUnlinkSucceeded = 0;
            let remoteUnlinkSkippedNotFound = 0;
            let remoteRemainingLinkedCount = 0;

            // If published to Subsplash, unlink all series members first, verify, then delete the series.
            if (subsplashId) {
              const token = await authenticateSubsplash();
              logger.log(`deleteSeries remote phase started: Firestore ID=${normalizedFirestoreId}, Subsplash ID=${subsplashId}`);

              const linkedRemoteItems = await getAllSeriesItemsAcrossStatuses(subsplashId, token);
              remoteUnlinkAttempted = linkedRemoteItems.length;
              logger.log(`deleteSeries found ${remoteUnlinkAttempted} linked remote items to unlink`);

              const unlinkConcurrency = Math.min(REMOTE_UNLINK_MAX_CONCURRENCY, REMOTE_UNLINK_DEFAULT_CONCURRENCY);
              await runWithConcurrency(linkedRemoteItems, unlinkConcurrency, async (item) => {
                  const unlinkResult = await unlinkMediaItemFromSeries(item.id, token, {
                    audio: item._embedded?.audio,
                    images: item._embedded?.images,
                  });

                  if (unlinkResult.status === 'not-found') {
                    remoteUnlinkSkippedNotFound += 1;
                    return;
                  }

                  remoteUnlinkSucceeded += 1;
              });

              const remainingRemoteItems = await getAllSeriesItemsAcrossStatuses(subsplashId, token);
              remoteRemainingLinkedCount = remainingRemoteItems.length;
              if (remoteRemainingLinkedCount > 0) {
                logger.error(
                  `deleteSeries aborting due to remaining linked items. Firestore ID=${normalizedFirestoreId}, Subsplash ID=${subsplashId}, remaining=${remoteRemainingLinkedCount}`
                );
                throw new HttpsError(
                  'failed-precondition',
                  `Cannot delete series ${subsplashId}: ${remoteRemainingLinkedCount} media item(s) are still linked.`
                );
              }

              await deleteSubsplashSeries(subsplashId, token);
              logger.log(
                `deleteSeries remote phase complete: attempted=${remoteUnlinkAttempted}, unlinked=${remoteUnlinkSucceeded}, skippedNotFound=${remoteUnlinkSkippedNotFound}`
              );
            }

            const cleanupResult = await cleanupLocalSeriesData(normalizedFirestoreId);
            logger.log(
              `deleteSeries local cleanup complete: Firestore ID=${normalizedFirestoreId}, localSeriesItemsDeleted=${cleanupResult.localSeriesItemsDeleted}, localSermonsUnlinked=${cleanupResult.localSermonsUnlinked}`
            );

            return {
              status: 'success',
              remoteUnlinkAttempted,
              remoteUnlinkSucceeded,
              remoteUnlinkSkippedNotFound,
              remoteRemainingLinkedCount,
              localSeriesItemsDeleted: cleanupResult.localSeriesItemsDeleted,
              localSermonsUnlinked: cleanupResult.localSermonsUnlinked,
            };
          },
          {
            operationKey: normalizedOperationKey,
          }
        );
      });
    } catch (err) {
      throw handleError(err);
    }
  }
);

export default deleteSeries;
