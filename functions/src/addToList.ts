import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import { SubsplashMediaItem } from './types/Subsplash';
import { createListRow, getFullListRows, getFullListRowsWithTotal, patchListRows, createNewList, getListDetails } from './helpers/addToListHelpers';
import firebaseAdmin from '../../firebase/firebaseAdmin';
import { firestoreAdminListConverter } from './firestoreDataConverter';
import { Timestamp } from 'firebase-admin/firestore';
import { canUserRolePublish } from '../../types/User';
import { OverflowBehavior } from '../../types/List';
import handleError from './handleError';
import axios from 'axios';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { withIdempotency } from './locks/withIdempotency';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';

const firestoreDB = firebaseAdmin.firestore();

export interface AddtoListInputType {
  destinationListIds: string[];
  mediaItem: SubsplashMediaItem;
  maxListSize?: number;
  operationKey?: string;
}

type OutputTypes =
  | { listId: string; status: 'success'; listItemId?: string }
  | {
      listId: string;
      status: 'error';
      error: string;
      errorCode?: string;
      errorDetails?: unknown;
    };

export type AddToListOutputType = OutputTypes[];

const DEFAULT_MAX_LIST_SIZE = 200;

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

// Helper to handle a single list processing step recursively
// Returns listItemId if item was added, undefined if item already existed
async function processListStep(
  listId: string, 
  itemToAdd: SubsplashMediaItem, 
  token: string,
  maxListSize: number = DEFAULT_MAX_LIST_SIZE
): Promise<{ listItemId?: string }> {
  const listQuery = firestoreDB.collection('lists').where('subsplashId', '==', listId).limit(1).withConverter(firestoreAdminListConverter);

  // Collect items to propagate after transaction commits
  // This fixes the transaction isolation bug where recursive calls can't see uncommitted documents
  let itemsToPropagateAfterCommit: Array<{ listId: string; item: SubsplashMediaItem }> = [];
  let itemExisted = false;
  let existingListItemId: string | undefined;

  await firestoreDB.runTransaction(async (transaction) => {
    // Reset the array at the start of each transaction attempt
    // This prevents accumulation of items when Firestore retries the transaction
    itemsToPropagateAfterCommit = [];
    itemExisted = false;
    existingListItemId = undefined;
    
    const querySnapshot = await transaction.get(listQuery);
    if (querySnapshot.empty) throw new HttpsError('not-found', `List ${listId} not found in Firestore`);
    
    const listDoc = querySnapshot.docs[0];
    const listData = listDoc.data();

    // Lock list by updating timestamp
    transaction.update(listDoc.ref, { updatedAtMillis: Timestamp.now().toMillis() });

    // Fetch Subsplash Data (Network call inside transaction - needed for consistency check)
    // Note: In high throughput scenarios, this might cause contention, but for this use case it ensures we see the latest state.
    // Use getFullListRowsWithTotal to get the actual total count from API (includes unlisted items)
    const { rows: currentRows, total: totalRowCount } = await getFullListRowsWithTotal(listId, token);

    // Check if item already exists
    const exists = currentRows.some(row => 
       row._embedded[row.type]?.id === itemToAdd.id
    );

    if (exists) {
      logger.log(`Item ${itemToAdd.id} already in list ${listId}`);
      itemExisted = true;
      
      // Item already exists - find its listItemId
      const existingRow = currentRows.find(row => 
        row._embedded[row.type]?.id === itemToAdd.id
      );
      existingListItemId = existingRow?.id;
      
      // BUG FIX: If item exists in Subsplash but Firestore document for overflow list doesn't exist,
      // this means a previous transaction attempt updated Subsplash but failed before committing Firestore.
      // We need to ensure the Firestore document exists to maintain consistency.
      if (listData.overflowBehavior === OverflowBehavior.CREATENEWLIST) {
        // Check if there's a link row to an overflow list (indicates overflow list exists in Subsplash)
        const linkRow = currentRows.find(r => r.type === 'list');
        if (linkRow && linkRow._embedded.list?.id) {
          const overflowListId = linkRow._embedded.list.id;
          
          // Check if parent's moreSermonsRef is set (indicates Firestore doc should exist)
          if (!listData.moreSermonsRef) {
            // Overflow list exists in Subsplash but not in Firestore - create it
            const overflowListDetails = await getListDetails(overflowListId, token);
            const newListRef = firestoreDB.collection('lists').doc();
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { id, ...dataToCopy } = listData;
            
            const newListData: Record<string, unknown> = {
              ...dataToCopy,
              id: newListRef.id,
              subsplashId: overflowListId,
              name: overflowListDetails.title,
              createdAtMillis: Date.now(),
              updatedAtMillis: Date.now(),
              count: 0,
              images: [],
              isMoreSermonsList: true
            };
            
            transaction.set(newListRef, newListData);
            transaction.update(listDoc.ref, { moreSermonsRef: overflowListId });
          }
        }
      }
      
      return;
    }

    // Insert new item at position 1 (FIFO / Stack Push)
    // "Always first one in the first list"
    const newRow = createListRow(itemToAdd, listId, 1);
    const updatedRows = [newRow, ...currentRows];
    
    // Check overflow using the actual total count from API (includes unlisted items)
    // The API total represents the true count of all rows in the list, including unlisted ones
    // If totalRowCount is already at maxListSize, adding any item will exceed the limit
    const willOverflow = totalRowCount >= maxListSize;

    // Handle Overflow
    // Use totalRowCount (from API) instead of updatedRows.length because:
    // - updatedRows.length only counts visible (non-unlisted) rows
    // - totalRowCount includes unlisted items, which count toward the limit
    // - If totalRowCount is already at maxListSize, adding any item will exceed the limit
    if (willOverflow) {
      if (listData.overflowBehavior === OverflowBehavior.CREATENEWLIST) {
        let nextListId = listData.moreSermonsRef;
        
        // Ensure we have a next list
        if (!nextListId) {
          const currentListDetails = await getListDetails(listId, token);
          // If the current list is already a "more" list, use its name without the "More " prefix
          // Otherwise, use the current list's title
          // This ensures we always get "More Original Name" and never "More More Original Name"
          const baseTitle = currentListDetails.title.startsWith('More ') 
            ? currentListDetails.title.substring(5) // Remove "More " prefix
            : currentListDetails.title;
          
          // Calculate page number by depth in the linked list chain
          // If current list is NOT a "more" list, the new overflow list is Page 1
          // If current list IS a "more" list, traverse back to root and count depth
          let pageNumber = 1;
          if (listData.isMoreSermonsList) {
            // Current list is a "more" list, so we need to find the root and count depth
            // We're already at Page 1 (or deeper), so start counting from 1
            // Traverse backwards by finding which list has moreSermonsRef pointing to current list
            let currentListData = listData;
            let depth = 1; // Start at 1 since we're already at a "more" list (Page 1)
            
            // Traverse backwards to find the root list
            // Keep going while we can find a parent that is also a "more" list
            while (true) {
              // Find the parent list by looking for a list that has moreSermonsRef pointing to current list
              const parentQuery = await firestoreDB
                .collection('lists')
                .where('moreSermonsRef', '==', currentListData.subsplashId || listId)
                .limit(1)
                .get();
              
              if (parentQuery.empty) {
                // Can't find parent, we've reached the root or a non-"more" list
                break;
              }
              
              const parentDoc = parentQuery.docs[0];
              const parentData = parentDoc.data() as typeof listData;
              
              // If parent is also a "more" list, continue traversing
              // Otherwise, we've found the root (which is not a "more" list)
              if (parentData.isMoreSermonsList) {
                currentListData = parentData;
                depth++;
              } else {
                // Parent is the root list (not a "more" list), stop here
                break;
              }
            }
            
            // Page number is depth + 1 (current overflow list will be one more level deep)
            // If we're at Page 1 (depth=1), the next will be Page 2 (depth+1=2)
            // If we're at Page 2 (depth=2), the next will be Page 3 (depth+1=3)
            pageNumber = depth + 1;
          }
          
          const newTitle = `More ${baseTitle}`;
          const subtitle = `Page ${pageNumber}`;
          logger.log(`Creating new overflow list: ${newTitle} with subtitle: ${subtitle} (Page ${pageNumber})`);
          
          const newList = await createNewList(newTitle, token, subtitle);
          nextListId = newList.id;

          // Create Firestore doc for new list
          const newListRef = firestoreDB.collection('lists').doc();
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { id, ...dataToCopy } = listData; 
          
          const newListData: Record<string, unknown> = {
            ...dataToCopy,
            id: newListRef.id,
            subsplashId: nextListId,
            name: newTitle,
            createdAtMillis: Date.now(),
            updatedAtMillis: Date.now(),
            count: 0,
            images: [],
            isMoreSermonsList: true
          };
          // Don't set moreSermonsRef if undefined (Firestore doesn't allow undefined values)
          // It will be set later if needed via transaction.update
          transaction.set(newListRef, newListData);
          
          transaction.update(listDoc.ref, { moreSermonsRef: nextListId });
        }

        // Identify items to move (Prune items to make space: Max (maxListSize - 1) items + 1 Link = maxListSize)
        // We need to keep the top (maxListSize - 1) items
        // The rest are overflow.
        // NOTE: The array includes the new item at index 0.
        // We will have at least (maxListSize + 1) items here if we overflowed.
        
        // We need to find the Link row if it exists to preserve/move it.
        // Actually, the Link row should always be the LAST item if it exists.
        // But we just prepended an item, so Link is pushed down.
        
        // Strategy:
        // 1. Separate "Content" rows from "Link" rows.
        // 2. We only want ONE Link row to the *immediate* next list at the bottom.
        
        const contentRows = updatedRows.filter(r => !(r.type === 'list' && r._embedded.list?.id === nextListId));
        
        // Check if we have *other* links? Assuming we only link to 'nextListId'.
        
        // Items to propagate are those that fall off the (maxListSize - 1) limit.
        // We keep (maxListSize - 1) content items + 1 link row = maxListSize total.
        // Take top (maxListSize - 1) content items.
        const itemsToKeep = contentRows.slice(0, maxListSize - 1);
        const itemsToPropagate = contentRows.slice(maxListSize - 1);
        
        // Step 1: Delete items that will be propagated (matching remove-item.har pattern)
        // This matches the pattern in remove-item.har: DELETE to /builder/v1/list-rows/{id} with no body, returns 204
        if (itemsToPropagate.length > 0) {
            // Delete the rows that will be propagated (they have IDs since they're existing rows)
            const rowsToDelete = itemsToPropagate.filter(r => r.id);
            for (const rowToDelete of rowsToDelete) {
                // Match HAR file: DELETE https://core.subsplash.com/builder/v1/list-rows/{id}
                // No body, returns 204 No Content
                const deleteConfig = createAxiosConfig(
                    `https://core.subsplash.com/builder/v1/list-rows/${rowToDelete.id}`,
                    token,
                    'DELETE'
                );
                await axios(deleteConfig);
            }
            
            // Store items for propagation AFTER transaction commits
            // This fixes the transaction isolation bug
            const reversedPropagate = [...itemsToPropagate].reverse();
            for (const itemRow of reversedPropagate) {
                 const embeddedResource = itemRow._embedded[itemRow.type];
                 if (embeddedResource) {
                     const itemToMove: SubsplashMediaItem = {
                         id: embeddedResource.id,
                         type: itemRow.type
                     };
                     itemsToPropagateAfterCommit.push({
                       listId: nextListId!,
                       item: itemToMove
                     });
                 }
            }
        }

        // Step 2: Patch with remaining rows (reordering only, no new item yet)
        // This matches remove-item.har: after DELETE, patch with remaining rows to update positions
        // After deleting rows, the list has fewer rows, so we patch with itemsToKeep to reorder them
        // We exclude the new item (newRow) from this patch - it will be added in step 3
        // IMPORTANT: We also need to include the existing link row if it exists, otherwise it will still be in the list
        // and cause the count to be wrong in step 3
        const existingLinkRow = currentRows.find(r => r.type === 'list' && r._embedded.list?.id === nextListId);
        const rowsToPatchAfterDelete = itemsToKeep.filter(r => r.id); // Only existing rows, no new item
        if (existingLinkRow) {
            // Include the existing link row in the patch so it gets reordered correctly
            rowsToPatchAfterDelete.push(existingLinkRow);
        }
        if (rowsToPatchAfterDelete.length > 0) {
            await patchListRows(listId, rowsToPatchAfterDelete, token);
        }

        // Step 3: Add the new item with link row in a separate patch
        // Now that the list has the correct count (after delete + patch), we can add the new item
        // Note: itemsToKeep already includes the new item (it's at index 0 from updatedRows)
        // If the link row already exists, we need to update it, not create a new one
        // Create/Update Link Row - use existing link row if it exists, otherwise create new one
        const linkRow = existingLinkRow 
            ? { ...existingLinkRow, position: itemsToKeep.length + 1 } // Update existing link row position
            : createListRow({ id: nextListId!, type: 'list' }, listId, itemsToKeep.length + 1); // Create new link row
        
        // Finalize rows: itemsToKeep (which already includes newRow at position 0) + link
        const finalRows = [...itemsToKeep, linkRow];
        
        // Patch Subsplash
        await patchListRows(listId, finalRows, token);

      } else if (listData.overflowBehavior === OverflowBehavior.REMOVEOLDEST) {
        // Just slice to max size
        const finalRows = updatedRows.slice(0, maxListSize);
        await patchListRows(listId, finalRows, token);
      } else {
         throw new HttpsError('failed-precondition', 'List overflowed and no valid behavior set');
      }
    } else {
      // No overflow, just patch
      await patchListRows(listId, updatedRows, token);
    }
  });
  
  // AFTER transaction commits: get the listItemId
  let listItemId: string | undefined;
  if (itemExisted) {
    // Item already existed - use the captured listItemId
    listItemId = existingListItemId;
  } else {
    // Item was newly added - fetch the updated rows to get the listItemId
    // The item we just added should be at position 1
    const updatedListRows = await getFullListRows(listId, token);
    // Find the row by item ID (not just position 1, since concurrent adds may have shifted positions)
    // The item we just added should be the one with the highest position among rows with this item ID
    // Actually, since we add at position 1, it should be at position 1, but in concurrent scenarios
    // other items might have been added, so we just find by item ID and take the first match
    const addedRow = updatedListRows.find(row => 
      row._embedded[itemToAdd.type]?.id === itemToAdd.id
    );
    listItemId = addedRow?.id;
  }
  
  // AFTER transaction commits: propagate items to overflow lists
  // This fixes the transaction isolation bug - the Firestore document created above
  // is now committed and visible to the recursive calls
  for (const { listId: targetListId, item } of itemsToPropagateAfterCommit) {
    await processListStep(targetListId, item, token, maxListSize);
  }
  return { listItemId };
}

const addToList = onCall({ secrets: subsplashSecretsWithRuntimeAlerts }, async (request: CallableRequest<AddtoListInputType>): Promise<AddToListOutputType> => {
  logger.log('addToList');

  if (!canUserRolePublish(request.auth?.token.role)) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }

  const { destinationListIds, mediaItem } = request.data;
  if (!destinationListIds || !mediaItem) {
    throw new HttpsError('invalid-argument', 'Missing destinationListIds or mediaItem.');
  }

  const operationKey = getOperationKey(request.data.operationKey);

  try {
    const token = await authenticateSubsplash();
    const maxListSize = request.data.maxListSize ?? DEFAULT_MAX_LIST_SIZE;
    const lockKeys = [...destinationListIds.map((listId) => `list:${listId}`), `media-item:${mediaItem.id}`];

    const runMutation = async (): Promise<AddToListOutputType> => {
      const results = await Promise.allSettled(
        destinationListIds.map(async (listId) => {
          const result = await processListStep(listId, mediaItem, token, maxListSize);
          return { listId, listItemId: result.listItemId };
        })
      );

      return results.map((result, index): OutputTypes => {
        if (result.status === 'fulfilled') {
          return {
            listId: destinationListIds[index],
            status: 'success',
            listItemId: result.value.listItemId,
          };
        }

        const errorPayload = getErrorPayload(result.reason);
        logger.error(`Error adding to list ${destinationListIds[index]}:`, errorPayload);
        return {
          listId: destinationListIds[index],
          status: 'error',
          ...errorPayload,
        };
      });
    };

    const executeLockedMutation = async (): Promise<AddToListOutputType> => {
      return withSubsplashLocks(lockKeys, runMutation, {
        ...(operationKey ? { operationKey } : {}),
      });
    };

    if (operationKey) {
      return await withIdempotency(operationKey, executeLockedMutation);
    }

    return await executeLockedMutation();
  } catch (error) {
    const errorPayload = getErrorPayload(error);
    if (errorPayload.errorCode === 'aborted') {
      return destinationListIds.map((listId): OutputTypes => ({
        listId,
        status: 'error',
        ...errorPayload,
      }));
    }

    const err = error as unknown;
    logger.error('addToList failed', errorPayload);
    throw handleError(err);
  }
});

export default addToList;
