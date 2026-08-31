/**
 * Firebase callable function to remove a media item from its series
 */

import { randomUUID } from 'node:crypto';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { authenticateSubsplash } from './subsplashUtils';
import {
  getAllSeriesItemsAcrossStatuses,
  getSeriesDetails,
  patchSeriesItemPositions,
  unlinkMediaItemFromSeries,
} from './helpers/seriesHelpers';
import { syncSeriesItemSubtitles } from './helpers/seriesItemSubtitles';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import handleError from './handleError';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { withIdempotency } from './locks/withIdempotency';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { getSubsplashMediaItemDetails } from './helpers/subsplashMediaItems';
import { SUBSPLASH_SERIES_OWNERSHIP_MISMATCH_CODE } from './expectedOperationalError';
import type {
  RemoveFromSeriesInputType,
  RemoveFromSeriesOutputType,
} from '../../packages/contracts/removeFromSeries';

export type {
  RemoveFromSeriesInputType,
  RemoveFromSeriesOutputType,
} from '../../packages/contracts/removeFromSeries';

const firestoreDB = firebaseAdmin.firestore();

const removeFromSeries = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<RemoveFromSeriesInputType>): Promise<RemoveFromSeriesOutputType> => {
    logger.log('removeFromSeries');

    // Authentication check
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated with publish permissions.');
    }

    const { mediaItemId, firestoreSeriesId, seriesSubsplashId, operationKey } = request.data;

    // Validation
    if (!mediaItemId || !mediaItemId.trim()) {
      throw new HttpsError('invalid-argument', 'mediaItemId is required.');
    }

    const normalizedMediaItemId = mediaItemId.trim();
    const normalizedFirestoreSeriesId = firestoreSeriesId?.trim() || undefined;
    const requestedSeriesSubsplashId = seriesSubsplashId?.trim() || undefined;
    if (!normalizedFirestoreSeriesId && !requestedSeriesSubsplashId) {
      throw new HttpsError(
        'invalid-argument',
        'Either firestoreSeriesId or seriesSubsplashId is required.'
      );
    }
    const normalizedOperationKey = operationKey?.trim() || `remove-from-series:${normalizedMediaItemId}:${randomUUID()}`;

    try {
      return await withIdempotency(normalizedOperationKey, async () => {
        let normalizedSeriesSubsplashId = requestedSeriesSubsplashId;
        if (normalizedFirestoreSeriesId) {
          const seriesDoc = await firestoreDB.collection('series').doc(normalizedFirestoreSeriesId).get();
          if (!seriesDoc.exists) {
            throw new HttpsError('not-found', `Series ${normalizedFirestoreSeriesId} was not found.`);
          }
          const linkedSubsplashId = (seriesDoc.data()?.subsplashId as string | undefined)?.trim();
          if (!linkedSubsplashId) {
            throw new HttpsError(
              'failed-precondition',
              `Series ${normalizedFirestoreSeriesId} is not linked to Subsplash.`
            );
          }
          if (requestedSeriesSubsplashId && requestedSeriesSubsplashId !== linkedSubsplashId) {
            throw new HttpsError(
              'failed-precondition',
              'The requested Firestore and Subsplash series IDs do not refer to the same series.'
            );
          }
          normalizedSeriesSubsplashId = linkedSubsplashId;
        }

        return withSubsplashLocks(
          [
            ...(normalizedSeriesSubsplashId ? [`series:${normalizedSeriesSubsplashId}`] : []),
            `media-item:${normalizedMediaItemId}`,
          ],
          async () => {
            // Authenticate with Subsplash
            const token = await authenticateSubsplash();

            let currentSeriesId: string | undefined;
            let mediaItemExists = true;
            try {
              const currentItem = await getSubsplashMediaItemDetails(normalizedMediaItemId, token);
              currentSeriesId = currentItem._embedded?.['media-series']?.id?.trim();
            } catch (error: unknown) {
              const status = error && typeof error === 'object' && 'response' in error
                ? (error as { response?: { status?: number } }).response?.status
                : undefined;
              if (status !== 404) {
                throw error;
              }
              mediaItemExists = false;
            }
            if (
              normalizedSeriesSubsplashId
              && currentSeriesId
              && currentSeriesId !== normalizedSeriesSubsplashId
            ) {
              throw new HttpsError(
                'failed-precondition',
                `Media item ${normalizedMediaItemId} belongs to a different Subsplash series.`,
                { code: SUBSPLASH_SERIES_OWNERSHIP_MISMATCH_CODE }
              );
            }

            // Remove media item from series by setting series to null
            const unlinkResult = await unlinkMediaItemFromSeries(normalizedMediaItemId, token);
            if (unlinkResult.status === 'not-found') {
              logger.warn(
                `Media item ${normalizedMediaItemId} was already absent from Subsplash; treating removeFromSeries as a no-op.`
              );
            }

            if (normalizedSeriesSubsplashId && mediaItemExists && currentSeriesId) {
              const remainingItems = await getAllSeriesItemsAcrossStatuses(
                normalizedSeriesSubsplashId,
                token
              );
              const compactedItems = [...remainingItems]
                .sort((left, right) => {
                  const leftPosition = left.position ?? Number.POSITIVE_INFINITY;
                  const rightPosition = right.position ?? Number.POSITIVE_INFINITY;
                  return leftPosition - rightPosition || left.id.localeCompare(right.id);
                })
                .map((item, index) => ({
                  ...item,
                  position: index + 1,
                }));

              if (compactedItems.length > 0) {
                await patchSeriesItemPositions(
                  normalizedSeriesSubsplashId,
                  compactedItems.map(({ id, position }) => ({ id, position })),
                  token
                );
              }
              const series = await getSeriesDetails(normalizedSeriesSubsplashId, token);
              await withSubsplashLocks(
                compactedItems.map((item) => `media-item:${item.id}`),
                () => syncSeriesItemSubtitles(
                  normalizedSeriesSubsplashId,
                  series.title,
                  compactedItems,
                  token
                ),
                { operationKey: normalizedOperationKey }
              );
            }

            logger.log(`Successfully removed media item ${normalizedMediaItemId} from series`);

            return {
              status: 'success',
              message: `Media item ${normalizedMediaItemId} removed from series successfully.`,
              mediaItemId: normalizedMediaItemId,
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

export default removeFromSeries;
