import axios from 'axios';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import handleError from './handleError';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import { canUserRolePublish } from '../../types/User';
import { getFullListRows } from './helpers/addToListHelpers';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { withIdempotency } from './locks/withIdempotency';
import {
  DEFAULT_LOCK_RETRY_AFTER_MS,
  DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  SUBSPLASH_LOCK_BUSY_CODE,
} from './locks/lockTypes';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';

export interface RemoveFromListInputType {
  listIds: string[];
  listItemIds: string[];
  itemIds: string[]; // The actual item IDs (sermon/media item IDs) for searching overflow lists
  itemTypes: string[]; // The item types (e.g., 'media-item', 'media-series') corresponding to itemIds
  operationKey?: string;
}

type status = 'success' | 'error';
type OutputTypes =
  | {
      listId: string;
      status: 'success';
      listItemId: string;
      itemNotFound?: boolean; // True if item was not found but treated as success
    }
  | {
      listId: string;
      status: 'error';
      error: string;
      errorCode?: string;
      errorDetails?: unknown;
    };
export type RemoveFromListOutputType = OutputTypes[];

const getOperationKey = (operationKey?: string): string | undefined => {
  const normalizedKey = operationKey?.trim();
  return normalizedKey ? normalizedKey : undefined;
};

const getErrorPayload = (
  error: unknown
): { error: string; errorCode?: string; errorDetails?: unknown } => {
  if (error && typeof error === 'object') {
    const maybeError = error as {
      message?: unknown;
      code?: unknown;
      details?: unknown;
    };

    return {
      error: typeof maybeError.message === 'string' ? maybeError.message : JSON.stringify(error),
      ...(typeof maybeError.code === 'string' ? { errorCode: maybeError.code } : {}),
      ...(maybeError.details !== undefined ? { errorDetails: maybeError.details } : {}),
    };
  }

  if (error instanceof Error) {
    return { error: error.message };
  }

  if (typeof error === 'string') {
    return { error };
  }

  return { error: JSON.stringify(error) };
};

export const removeFromList = async (
  listIds: string[],
  listItemIds: string[],
  itemIds: string[],
  itemTypes: string[],
  operationKey?: string
) => {
  const normalizedOperationKey = getOperationKey(operationKey);
  const token = await authenticateSubsplash();
  const firestoreDB = firebaseAdmin.firestore();
  // Validate input arrays have the same length
  if (listIds.length !== listItemIds.length || listIds.length !== itemIds.length || listIds.length !== itemTypes.length) {
    throw new Error('All input arrays must have the same length');
  }

  const lockKeys = listIds.map((listId) => `list:${listId}`);
  itemIds.forEach((itemId, index) => {
    if (itemTypes[index] === 'media-item') {
      lockKeys.push(`media-item:${itemId}`);
    }
  });

  const runRemoval = async (): Promise<RemoveFromListOutputType> => {
    const result = await Promise.allSettled(
      listItemIds.map(async (listItemId, index) => {
      const listId = listIds[index];
      const itemId = itemIds[index];
      const itemType = itemTypes[index];
      
      logger.log(`Deleting item with listItemId: ${listItemId}, itemId: ${itemId}, type: ${itemType} from list: ${listId}`);
      
      try {
        // First, try to delete using the provided listItemId
        const deleteConfig = createAxiosConfig(`https://core.subsplash.com/builder/v1/list-rows/${listItemId}`, token, 'DELETE');
        await axios(deleteConfig);
        logger.log(`Successfully deleted item ${listItemId} from original list ${listId}`);
        return { listId, listItemId, foundInOriginalList: true };
      } catch (error: unknown) {
        // If deletion fails, the item might have been moved to an overflow list
        // Check if it's a 404 or similar error
        // Handle both axios error format and plain object format from mocks
        const axiosError = error as { response?: { status?: number }; status?: number };
        const errorStatus = (axiosError.response?.status ?? axiosError.status) as number | undefined;
        if (errorStatus === 404 || errorStatus === 400) {
          logger.log(`Item ${listItemId} not found in original list ${listId}, searching overflow chain for itemId: ${itemId}...`);
          
          try {
            // Search through overflow chain using the item ID and type
            const listQuery = await firestoreDB
              .collection('lists')
              .where('subsplashId', '==', listId)
              .limit(1)
              .get();
            
            let moreSermonsRef: string | undefined;
            if (!listQuery.empty) {
              const listData = listQuery.docs[0].data();
              moreSermonsRef = listData.moreSermonsRef;
            }
            
            // Search through the overflow chain (if it exists)
            while (moreSermonsRef) {
              try {
                const overflowRows = await getFullListRows(moreSermonsRef, token);
                
                // Search by item ID and type (most reliable method)
                const matchingRow = overflowRows.find(
                  (row) => row._embedded[row.type]?.id === itemId && row.type === itemType
                );
                
                if (matchingRow && matchingRow.id) {
                  // Found it! Delete from the overflow list
                  logger.log(`Found item ${itemId} in overflow list ${moreSermonsRef} with listItemId: ${matchingRow.id}`);
                  const deleteConfig = createAxiosConfig(
                    `https://core.subsplash.com/builder/v1/list-rows/${matchingRow.id}`,
                    token,
                    'DELETE'
                  );
                  await axios(deleteConfig);
                  logger.log(`Successfully deleted item from overflow list ${moreSermonsRef}`);
                  return { listId: moreSermonsRef, listItemId: matchingRow.id, foundInOriginalList: false };
                }
                
                // Check if there's another overflow list
                const linkRow = overflowRows.find((row) => row.type === 'list' && row._embedded.list?.id);
                if (linkRow && linkRow._embedded.list?.id) {
                  // Get next overflow list from Firestore
                  const nextListQuery = await firestoreDB
                    .collection('lists')
                    .where('subsplashId', '==', moreSermonsRef)
                    .limit(1)
                    .get();
                  
                  if (!nextListQuery.empty) {
                    const nextListData = nextListQuery.docs[0].data();
                    moreSermonsRef = nextListData.moreSermonsRef;
                  } else {
                    break;
                  }
                } else {
                  break;
                }
              } catch (overflowError) {
                logger.error(`Error searching overflow list ${moreSermonsRef}:`, overflowError);
                break;
              }
            }
            
            // If we get here, we couldn't find the item anywhere
            // This can happen if someone edited Subsplash directly and removed the item
            // Log a warning but don't throw an error - treat it as a successful removal
            // since the end result is the same (item is not in the list)
            logger.warn(
              `Item ${itemId} (listItemId: ${listItemId}) not found in list ${listId} or any overflow lists. ` +
              `This may indicate the item was already removed from Subsplash directly. Treating as successful removal.`
            );
            // Return success since the item is effectively removed (not found anywhere)
            return { listId, listItemId, foundInOriginalList: false, itemNotFound: true };
          } catch (searchError) {
            // If search failed due to an error (not just not found), still treat as success
            // since the item is effectively not in the list
            logger.warn(
              `Error searching for item ${itemId} in overflow chain, but treating as successful removal: ${searchError}`
            );
            return { listId, listItemId, foundInOriginalList: false, itemNotFound: true };
          }
        } else {
          // Some other error (not 404/400) - this is unexpected, but we should still handle gracefully
          // Log the error but treat as success since we can't delete what doesn't exist
          logger.warn(
            `Unexpected error when deleting item ${listItemId} from list ${listId}: ${error}. Treating as successful removal.`
          );
          return { listId, listItemId, foundInOriginalList: false, itemNotFound: true };
        }
      }
      })
    );
  
    logger.log(result);
    const returnResult = result.map((r, index): OutputTypes => {
      if (r.status === 'fulfilled') {
      const status: status = 'success';
      const result: OutputTypes = { listId: listIds[index], status, listItemId: r.value.listItemId };
      // Include itemNotFound flag if the item wasn't found but was treated as success
      if (r.value.itemNotFound) {
        return { ...result, itemNotFound: true };
      }
      return result;
      }

      logger.log('error', r.reason);
      const status: status = 'error';
      const errorPayload = getErrorPayload(r.reason);
      return { listId: listIds[index], status, ...errorPayload };
    });
    return returnResult;
  };

  try {
    const executeLockedRemoval = async (): Promise<RemoveFromListOutputType> => {
      return withSubsplashLocks(lockKeys, runRemoval, {
        ...(normalizedOperationKey ? { operationKey: normalizedOperationKey } : {}),
      });
    };

    if (normalizedOperationKey) {
      return await withIdempotency(normalizedOperationKey, executeLockedRemoval);
    }

    return await executeLockedRemoval();
  } catch (error) {
    const errorPayload = getErrorPayload(error);
    if (errorPayload.errorCode === 'aborted') {
      const busyDetails = errorPayload.errorDetails ?? {
        code: SUBSPLASH_LOCK_BUSY_CODE,
        locked_keys: lockKeys.length > 0 ? [lockKeys[0]] : [],
        wait_ms: DEFAULT_LOCK_WAIT_TIMEOUT_MS,
        retry_after_ms: DEFAULT_LOCK_RETRY_AFTER_MS,
      };

      return listIds.map((listId): OutputTypes => ({
        listId,
        status: 'error',
        ...errorPayload,
        errorDetails: busyDetails,
      }));
    }
    throw error;
  }
};
const removeFromListCallable = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<RemoveFromListInputType>): Promise<RemoveFromListOutputType> => {
    logger.log('removeFromList');

    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const data = request.data;
    if (!data.listItemIds || !data.listIds || !data.itemIds || !data.itemTypes || 
        data.listIds.length !== data.listItemIds.length || 
        data.listIds.length !== data.itemIds.length || 
        data.listIds.length !== data.itemTypes.length) {
      throw new HttpsError(
        'invalid-argument',
        'The function must be called with non-empty equal sized listIds, listItemIds, itemIds, and itemTypes arrays.'
      );
    }
    try {
      return await removeFromList(data.listIds, data.listItemIds, data.itemIds, data.itemTypes, data.operationKey);
    } catch (err) {
      throw handleError(err);
    }
  }
);

export default removeFromListCallable;
