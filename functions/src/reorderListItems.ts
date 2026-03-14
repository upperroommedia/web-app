import { randomUUID } from 'node:crypto';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { firestoreAdminListConverter } from './firestoreDataConverter';
import { getFullListRows, patchListRows } from './helpers/addToListHelpers';
import handleError from './handleError';
import { withIdempotency } from './locks/withIdempotency';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import { authenticateSubsplash } from './subsplashUtils';
import { SubsplashListRow } from './types/Subsplash';

const firestoreDB = firebaseAdmin.firestore();

export interface ListItemOrderEntry {
  mediaItemId: string;
  position: number;
}

export interface ReorderListItemsInputType {
  firestoreListId: string;
  itemOrder: ListItemOrderEntry[];
  operationKey?: string;
}

export interface ReorderListItemsOutputType {
  status: 'success' | 'error';
  message: string;
  firestoreListId: string;
  subsplashListId?: string;
}

const getRowMediaItemId = (row: SubsplashListRow): string | undefined => {
  if (row.type !== 'media-item') {
    return undefined;
  }

  return row._embedded?.['media-item']?.id;
};

const reorderListItems = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<ReorderListItemsInputType>): Promise<ReorderListItemsOutputType> => {
    logger.log('reorderListItems');

    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError(
        'unauthenticated',
        'The function must be called while authenticated with publish permissions.'
      );
    }

    const { firestoreListId, itemOrder, operationKey } = request.data;

    if (!firestoreListId || !firestoreListId.trim()) {
      throw new HttpsError('invalid-argument', 'firestoreListId is required.');
    }

    if (!Array.isArray(itemOrder)) {
      throw new HttpsError('invalid-argument', 'itemOrder must be an array.');
    }

    const normalizedFirestoreListId = firestoreListId.trim();
    const normalizedOperationKey =
      operationKey?.trim() || `reorder-list-items:${normalizedFirestoreListId}:${randomUUID()}`;

    try {
      return await withIdempotency(normalizedOperationKey, async () => {
        const listDoc = await firestoreDB
          .collection('lists')
          .doc(normalizedFirestoreListId)
          .withConverter(firestoreAdminListConverter)
          .get();

        if (!listDoc.exists) {
          throw new HttpsError('not-found', `List with firestoreId ${normalizedFirestoreListId} not found.`);
        }

        const listData = listDoc.data()!;
        const subsplashListId = listData.subsplashId;
        if (!subsplashListId) {
          throw new HttpsError(
            'failed-precondition',
            `List ${normalizedFirestoreListId} is not linked to Subsplash and cannot be reordered remotely.`
          );
        }

        return withSubsplashLocks(
          [`list:${subsplashListId}`],
          async () => {
            if (itemOrder.length === 0) {
              return {
                status: 'success',
                message: 'No items to reorder.',
                firestoreListId: normalizedFirestoreListId,
                subsplashListId,
              };
            }

            const seenMediaItemIds = new Set<string>();
            itemOrder.forEach(({ mediaItemId, position }) => {
              if (!mediaItemId || !mediaItemId.trim()) {
                throw new HttpsError('invalid-argument', 'Each itemOrder entry must include a mediaItemId.');
              }

              if (!Number.isInteger(position) || position < 1) {
                throw new HttpsError('invalid-argument', 'Each itemOrder entry must include a positive integer position.');
              }

              if (seenMediaItemIds.has(mediaItemId)) {
                throw new HttpsError('invalid-argument', `Duplicate mediaItemId ${mediaItemId} in itemOrder.`);
              }

              seenMediaItemIds.add(mediaItemId);
            });

            const token = await authenticateSubsplash();
            const remoteRows = await getFullListRows(subsplashListId, token);
            const remoteRowsByMediaItemId = new Map<string, (typeof remoteRows)[number]>();

            remoteRows.forEach((row) => {
              const mediaItemId = getRowMediaItemId(row);
              if (mediaItemId) {
                remoteRowsByMediaItemId.set(mediaItemId, row);
              }
            });

            itemOrder.forEach(({ mediaItemId }) => {
              if (!remoteRowsByMediaItemId.has(mediaItemId)) {
                throw new HttpsError(
                  'failed-precondition',
                  `Cannot reorder media item ${mediaItemId}; it does not exist in Subsplash list ${subsplashListId}.`
                );
              }
            });

            const requestedPositions = new Map(itemOrder.map((entry) => [entry.mediaItemId, entry.position]));
            const sortedRequestedRows = [...itemOrder]
              .sort((left, right) => left.position - right.position)
              .map(({ mediaItemId }) => remoteRowsByMediaItemId.get(mediaItemId)!)
              .map((row) => ({ ...row }));

            let requestedRowIndex = 0;
            const reorderedRows = remoteRows.map((row) => {
              const mediaItemId = getRowMediaItemId(row);
              if (!mediaItemId || !requestedPositions.has(mediaItemId)) {
                return row;
              }

              const nextRow = sortedRequestedRows[requestedRowIndex];
              requestedRowIndex += 1;
              return nextRow;
            });

            await patchListRows(subsplashListId, reorderedRows, token);

            return {
              status: 'success',
              message: `Successfully reordered ${itemOrder.length} items in list.`,
              firestoreListId: normalizedFirestoreListId,
              subsplashListId,
            };
          },
          {
            operationKey: normalizedOperationKey,
          }
        );
      });
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default reorderListItems;
