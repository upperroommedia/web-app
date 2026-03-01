/**
 * Firebase callable function to reorder items within a series
 */

import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { authenticateSubsplash } from './subsplashUtils';
import { getSeriesItems, patchSeriesItemPositions } from './helpers/seriesHelpers';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { firestoreAdminSeriesConverter } from './firestoreDataConverter';
import { canUserRolePublish } from '../../types/User';
import handleError from './handleError';

const firestoreDB = firebaseAdmin.firestore();

export interface ItemOrderEntry {
  mediaItemId: string;
  position: number;
}

export interface ReorderSeriesItemsInputType {
  firestoreSeriesId: string;
  itemOrder: ItemOrderEntry[];
}

export interface ReorderSeriesItemsOutputType {
  status: 'success' | 'error';
  message: string;
  firestoreSeriesId: string;
  subsplashSeriesId?: string;
}

const reorderSeriesItems = onCall(
  async (request: CallableRequest<ReorderSeriesItemsInputType>): Promise<ReorderSeriesItemsOutputType> => {
    logger.log('reorderSeriesItems');

    // Authentication check
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError(
        'unauthenticated',
        'The function must be called while authenticated with publish permissions.'
      );
    }

    const { firestoreSeriesId, itemOrder } = request.data;

    // Validation
    if (!firestoreSeriesId || !firestoreSeriesId.trim()) {
      throw new HttpsError('invalid-argument', 'firestoreSeriesId is required.');
    }

    try {
      // Get series from Firestore to get Subsplash ID
      const seriesDoc = await firestoreDB
        .collection('series')
        .doc(firestoreSeriesId)
        .withConverter(firestoreAdminSeriesConverter)
        .get();

      if (!seriesDoc.exists) {
        throw new HttpsError('not-found', `Series with firestoreId ${firestoreSeriesId} not found.`);
      }

      const seriesData = seriesDoc.data()!;
      const subsplashSeriesId = seriesData.subsplashId;
      if (!subsplashSeriesId) {
        throw new HttpsError(
          'failed-precondition',
          `Series ${firestoreSeriesId} is not linked to Subsplash and cannot be reordered remotely.`
        );
      }

      // If no items to reorder, return success
      if (!itemOrder || itemOrder.length === 0) {
        return {
          status: 'success',
          message: 'No items to reorder.',
          firestoreSeriesId,
          subsplashSeriesId,
        };
      }

      // Authenticate with Subsplash
      const token = await authenticateSubsplash();

      // Subsplash is source-of-truth: fetch current membership before patching.
      const [publishedItems, draftItems, scheduledItems] = await Promise.all([
        getSeriesItems(subsplashSeriesId, token, { status: 'published' }),
        getSeriesItems(subsplashSeriesId, token, { status: 'draft' }),
        getSeriesItems(subsplashSeriesId, token, { status: 'scheduled' }),
      ]);
      const remoteItemsById = new Map<string, { id: string; position: number | null }>();
      [...publishedItems, ...draftItems, ...scheduledItems].forEach((item) => {
        remoteItemsById.set(item.id, { id: item.id, position: item.position ?? null });
      });

      // Validate every requested item exists remotely.
      itemOrder.forEach(({ mediaItemId }) => {
        if (!remoteItemsById.has(mediaItemId)) {
          throw new HttpsError(
            'failed-precondition',
            `Cannot reorder media item ${mediaItemId}; it does not exist in Subsplash series ${subsplashSeriesId}.`
          );
        }
      });

      const requestedPositions = new Map(itemOrder.map((entry) => [entry.mediaItemId, entry.position]));

      // Patch using remote membership as baseline, replacing only explicitly requested items.
      const itemsToUpdate = Array.from(remoteItemsById.values()).map((item) => ({
        id: item.id,
        position: requestedPositions.get(item.id) ?? item.position,
      }));

      await patchSeriesItemPositions(subsplashSeriesId, itemsToUpdate, token);

      logger.log(`Successfully reordered ${itemOrder.length} items in series ${subsplashSeriesId}`);

      return {
        status: 'success',
        message: `Successfully reordered ${itemOrder.length} items in series.`,
        firestoreSeriesId,
        subsplashSeriesId,
      };
    } catch (err) {
      throw handleError(err);
    }
  }
);

export default reorderSeriesItems;
