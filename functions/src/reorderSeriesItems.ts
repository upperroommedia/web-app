/**
 * Firebase callable function to reorder items within a series
 */

import { randomUUID } from 'node:crypto';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { authenticateSubsplash } from './subsplashUtils';
import {
  getAllSeriesItemsAcrossStatuses,
  getSeriesDetails,
  patchSeriesItemPositions,
} from './helpers/seriesHelpers';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { firestoreAdminSeriesConverter } from './firestoreDataConverter';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import handleError from './handleError';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { withIdempotency } from './locks/withIdempotency';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import { createSeriesRemoteMembershipHash } from './helpers/seriesRemoteState';
import { syncSeriesItemSubtitles } from './helpers/seriesItemSubtitles';

const firestoreDB = firebaseAdmin.firestore();

export interface ItemOrderEntry {
  mediaItemId: string;
  position: number;
}

export interface ReorderSeriesItemsInputType {
  firestoreSeriesId: string;
  expectedRemoteMembershipHash?: string;
  itemOrder: ItemOrderEntry[];
  operationKey?: string;
}

export interface ReorderSeriesItemsOutputType {
  status: 'success' | 'error';
  message: string;
  firestoreSeriesId: string;
  subsplashSeriesId?: string;
}

const reorderSeriesItems = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<ReorderSeriesItemsInputType>): Promise<ReorderSeriesItemsOutputType> => {
    logger.log('reorderSeriesItems');

    // Authentication check
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError(
        'unauthenticated',
        'The function must be called while authenticated with publish permissions.'
      );
    }

    const { firestoreSeriesId, expectedRemoteMembershipHash, itemOrder, operationKey } = request.data;

    // Validation
    if (!firestoreSeriesId || !firestoreSeriesId.trim()) {
      throw new HttpsError('invalid-argument', 'firestoreSeriesId is required.');
    }

    const normalizedFirestoreSeriesId = firestoreSeriesId.trim();
    const normalizedOperationKey =
      operationKey?.trim() || `reorder-series-items:${normalizedFirestoreSeriesId}:${randomUUID()}`;

    try {
      return await withIdempotency(normalizedOperationKey, async () => {
        // Resolve Subsplash series id up front so lock keys are always based on remote ids.
        const seriesDoc = await firestoreDB
          .collection('series')
          .doc(normalizedFirestoreSeriesId)
          .withConverter(firestoreAdminSeriesConverter)
          .get();

        if (!seriesDoc.exists) {
          throw new HttpsError('not-found', `Series with firestoreId ${normalizedFirestoreSeriesId} not found.`);
        }

        const seriesData = seriesDoc.data()!;
        const subsplashSeriesId = seriesData.subsplashId;
        if (!subsplashSeriesId) {
          throw new HttpsError(
            'failed-precondition',
            `Series ${normalizedFirestoreSeriesId} is not linked to Subsplash and cannot be reordered remotely.`
          );
        }

        return withSubsplashLocks(
          [`series:${subsplashSeriesId}`],
          async () => {
            // If no items to reorder, return success.
            if (!itemOrder || itemOrder.length === 0) {
              return {
                status: 'success',
                message: 'No items to reorder.',
                firestoreSeriesId: normalizedFirestoreSeriesId,
                subsplashSeriesId,
              };
            }

            const normalizedExpectedRemoteMembershipHash = expectedRemoteMembershipHash?.trim();

            // Authenticate with Subsplash.
            const token = await authenticateSubsplash();

            // Subsplash is source-of-truth: fetch current membership before patching.
            const [remoteItems, remoteSeries] = await Promise.all([
              getAllSeriesItemsAcrossStatuses(subsplashSeriesId, token),
              getSeriesDetails(subsplashSeriesId, token),
            ]);
            const remoteMembershipHash = createSeriesRemoteMembershipHash(
              [...remoteItems]
                .sort((left, right) => (right.position ?? Number.NEGATIVE_INFINITY) - (left.position ?? Number.NEGATIVE_INFINITY))
                .map((item) => ({ id: item.id, status: item.status }))
            );

            if (
              normalizedExpectedRemoteMembershipHash &&
              normalizedExpectedRemoteMembershipHash !== remoteMembershipHash
            ) {
              throw new HttpsError(
                'failed-precondition',
                'Series membership changed in Subsplash. Refresh and retry.'
              );
            }

            const remoteItemsById = new Map<string, { id: string; position: number | null }>();
            remoteItems.forEach((item) => {
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

            if (normalizedExpectedRemoteMembershipHash && itemOrder.length !== remoteItemsById.size) {
              throw new HttpsError(
                'failed-precondition',
                'Reorder request must include every media item currently in the Subsplash series.'
              );
            }

            const requestedPositions = new Map(itemOrder.map((entry) => [entry.mediaItemId, entry.position]));
            if (normalizedExpectedRemoteMembershipHash && requestedPositions.size !== remoteItemsById.size) {
              throw new HttpsError(
                'failed-precondition',
                'Reorder request must be a full permutation of current Subsplash series membership.'
              );
            }

            const itemsToUpdate = Array.from(remoteItemsById.values()).map((item) => {
              const requestedPosition = requestedPositions.get(item.id);
              return {
                id: item.id,
                position: normalizedExpectedRemoteMembershipHash
                  ? (requestedPosition ?? null)
                  : (requestedPosition ?? item.position),
              };
            });

            await patchSeriesItemPositions(subsplashSeriesId, itemsToUpdate, token);
            await withSubsplashLocks(
              remoteItems.map((item) => `media-item:${item.id}`),
              () => syncSeriesItemSubtitles(
                subsplashSeriesId,
                remoteSeries.title,
                remoteItems.map((item) => ({
                  id: item.id,
                  position: requestedPositions.get(item.id) ?? item.position ?? null,
                  subtitle: item.subtitle,
                })),
                token
              ),
              { operationKey: normalizedOperationKey }
            );

            logger.log(`Successfully reordered ${itemOrder.length} items in series ${subsplashSeriesId}`);

            return {
              status: 'success',
              message: `Successfully reordered ${itemOrder.length} items in series.`,
              firestoreSeriesId: normalizedFirestoreSeriesId,
              subsplashSeriesId,
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

export default reorderSeriesItems;
