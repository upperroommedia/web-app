/**
 * Firebase callable function to add a media item to a series
 * Note: A media item can only belong to one series at a time,
 * so adding to a new series will remove it from any existing series.
 */

import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { authenticateSubsplash } from './subsplashUtils';
import { patchMediaItemSeries } from './helpers/seriesHelpers';
import { canUserRolePublish } from '../../types/User';
import handleError from './handleError';

export interface AddToSeriesInputType {
  seriesSubsplashId: string;
  mediaItemId: string;
  position?: number;
}

export interface AddToSeriesOutputType {
  status: 'success' | 'error';
  mediaItemId?: string;
  confirmedSeriesId?: string | null;
  position?: number | null;
  error?: string;
}

const addToSeries = onCall(
  async (request: CallableRequest<AddToSeriesInputType>): Promise<AddToSeriesOutputType> => {
    logger.log('addToSeries');

    // Authentication check
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated with publish permissions.');
    }

    const { seriesSubsplashId, mediaItemId, position } = request.data;

    // Validation
    if (!seriesSubsplashId || !seriesSubsplashId.trim()) {
      throw new HttpsError('invalid-argument', 'Series Subsplash ID is required.');
    }

    if (!mediaItemId || !mediaItemId.trim()) {
      throw new HttpsError('invalid-argument', 'Media Item ID is required.');
    }

    try {
      // Authenticate with Subsplash
      const token = await authenticateSubsplash();

      // Patch the media item to assign it to the series
      // This will automatically remove it from any existing series
      const patchedItem = await patchMediaItemSeries(mediaItemId.trim(), seriesSubsplashId.trim(), token, {
        position,
      });
      const confirmedSeriesId = patchedItem._embedded?.['media-series']?.id ?? null;
      if (confirmedSeriesId !== seriesSubsplashId.trim()) {
        throw new HttpsError(
          'failed-precondition',
          `Subsplash did not confirm series assignment. Expected ${seriesSubsplashId}, got ${confirmedSeriesId ?? 'null'}.`
        );
      }

      logger.log(`Added media item ${mediaItemId} to series ${seriesSubsplashId}`);

      return {
        status: 'success',
        mediaItemId: patchedItem.id,
        confirmedSeriesId,
        position: patchedItem.position ?? null,
      };
    } catch (err) {
      throw handleError(err);
    }
  }
);

export default addToSeries;
