/**
 * Firebase callable function to remove a media item from its series
 */

import { randomUUID } from 'node:crypto';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { authenticateSubsplash } from './subsplashUtils';
import { patchMediaItemSeries } from './helpers/seriesHelpers';
import { canUserRolePublish } from '../../types/User';
import handleError from './handleError';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { withIdempotency } from './locks/withIdempotency';

export interface RemoveFromSeriesInputType {
  mediaItemId: string;
  operationKey?: string;
}

export interface RemoveFromSeriesOutputType {
  status: 'success' | 'error';
  message: string;
  mediaItemId: string;
}

const removeFromSeries = onCall(
  async (request: CallableRequest<RemoveFromSeriesInputType>): Promise<RemoveFromSeriesOutputType> => {
    logger.log('removeFromSeries');

    // Authentication check
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated with publish permissions.');
    }

    const { mediaItemId, operationKey } = request.data;

    // Validation
    if (!mediaItemId || !mediaItemId.trim()) {
      throw new HttpsError('invalid-argument', 'mediaItemId is required.');
    }

    const normalizedMediaItemId = mediaItemId.trim();
    const normalizedOperationKey = operationKey?.trim() || `remove-from-series:${normalizedMediaItemId}:${randomUUID()}`;

    try {
      return await withIdempotency(normalizedOperationKey, async () => {
        return withSubsplashLocks(
          [`media-item:${normalizedMediaItemId}`],
          async () => {
            // Authenticate with Subsplash
            const token = await authenticateSubsplash();

            // Remove media item from series by setting series to null
            await patchMediaItemSeries(normalizedMediaItemId, null, token);

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
