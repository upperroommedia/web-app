import axios from 'axios';
import { FieldValue } from 'firebase-admin/firestore';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import handleError from './handleError';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { createListRow, getFullListRows, patchListRows } from './helpers/addToListHelpers';
import { syncOverflowChainMetadata } from './helpers/listOverflowChain';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { withIdempotency } from './locks/withIdempotency';
import {
  DEFAULT_LOCK_RETRY_AFTER_MS,
  DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  SUBSPLASH_LOCK_BUSY_CODE,
} from './locks/lockTypes';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import {
  listDebugError,
  listDebugLog,
  listDebugWarn,
  summarizeSubsplashRows,
} from './helpers/listDebugLogger';
import { getConfiguredMaxListSize, getPageContentCapacity } from './helpers/listCapacity';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { SubsplashListRow } from './types/Subsplash';

export interface RemoveFromListInputType {
  listIds: string[];
  listItemIds: string[];
  itemIds: string[]; // The actual item IDs (sermon/media item IDs) for searching overflow lists
  itemTypes: string[]; // The item types (e.g., 'media-item', 'media-series') corresponding to itemIds
  sermonIds?: string[];
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

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const findItemPlacementInOverflowChain = async (
  rootListId: string,
  itemId: string,
  itemType: string,
  token: string
): Promise<{ listId: string; listItemId: string } | null> => {
  const firestoreDB = firebaseAdmin.firestore();
  const visitedListIds = new Set<string>();
  let currentListId: string | undefined = rootListId;

  while (currentListId && !visitedListIds.has(currentListId)) {
    visitedListIds.add(currentListId);

    const rows = await getFullListRows(currentListId, token);
    const matchingRow = rows.find(
      (row) => row.type === itemType && row._embedded[row.type]?.id === itemId && row.id
    );
    if (matchingRow?.id) {
      return {
        listId: currentListId,
        listItemId: matchingRow.id,
      };
    }

    const listQuery = await firestoreDB.collection('lists').where('subsplashId', '==', currentListId).limit(1).get();
    if (listQuery.empty) {
      break;
    }

    currentListId = normalizeString(listQuery.docs[0].data().moreSermonsRef);
  }

  return null;
};

type OverflowChainNode = {
  firestoreListId: string;
  subsplashListId: string;
  remoteRows: SubsplashListRow[];
};

type PublishedPlacement = {
  firestoreListId: string;
  subsplashListId: string;
  overflowDepth: number;
  position: number;
  listItemId?: string;
};

const loadOverflowChainNodes = async (rootSubsplashListId: string, token: string): Promise<OverflowChainNode[]> => {
  const firestoreDB = firebaseAdmin.firestore();
  const visitedListIds = new Set<string>();
  const nodes: OverflowChainNode[] = [];
  let currentListId: string | undefined = rootSubsplashListId;

  while (currentListId && !visitedListIds.has(currentListId)) {
    visitedListIds.add(currentListId);

    const listQuery = await firestoreDB.collection('lists').where('subsplashId', '==', currentListId).limit(1).get();
    if (listQuery.empty) {
      break;
    }

    const listDoc = listQuery.docs[0];
    const remoteRows = await getFullListRows(currentListId, token);
    nodes.push({
      firestoreListId: listDoc.id,
      subsplashListId: currentListId,
      remoteRows,
    });

    currentListId = normalizeString(listDoc.data().moreSermonsRef);
  }

  return nodes;
};

const deleteRowsMissingFromTarget = async (
  node: OverflowChainNode,
  targetRows: SubsplashListRow[],
  token: string
): Promise<void> => {
  const targetIds = new Set(
    targetRows
      .map((row) => row.id?.trim())
      .filter((rowId): rowId is string => Boolean(rowId))
  );

  const rowsToDelete = node.remoteRows.filter((row) => row.id && !targetIds.has(row.id));
  for (const rowToDelete of rowsToDelete) {
    const deleteConfig = createAxiosConfig(
      `https://core.subsplash.com/builder/v1/list-rows/${rowToDelete.id}`,
      token,
      'DELETE'
    );
    await axios(deleteConfig);
  }
};

const buildTargetPages = (nodes: OverflowChainNode[], maxListSize: number): SubsplashListRow[][] => {
  const mediaRows = nodes.flatMap((node) => node.remoteRows.filter((row) => row.type !== 'list'));
  const pages: SubsplashListRow[][] = [];
  let cursor = 0;

  while (cursor < mediaRows.length) {
    const remaining = mediaRows.length - cursor;
    const takeCount = getPageContentCapacity(remaining, maxListSize);
    pages.push(mediaRows.slice(cursor, cursor + takeCount));
    cursor += takeCount;
  }

  while (pages.length < nodes.length) {
    pages.push([]);
  }

  return pages;
};

const buildTargetRowsForNode = (
  node: OverflowChainNode,
  pageRows: SubsplashListRow[],
  nextNode: OverflowChainNode | undefined
): SubsplashListRow[] => {
  const nextRows = pageRows.map((row) => {
    const sourceListId = row._embedded?.['source-list']?.id;
    if (sourceListId === node.subsplashListId) {
      return { ...row };
    }

    return createListRow(
      {
        id: row._embedded?.[row.type]?.id as string,
        type: row.type,
      },
      node.subsplashListId,
      0
    );
  });

  if (!nextNode || pageRows.length === 0 && nextNode === undefined) {
    return nextRows;
  }

  if (!nextNode) {
    return nextRows;
  }

  const existingLinkRow = node.remoteRows.find(
    (row) => row.type === 'list' && row._embedded.list?.id === nextNode.subsplashListId
  );
  nextRows.push(
    existingLinkRow
      ? { ...existingLinkRow }
      : createListRow({ id: nextNode.subsplashListId, type: 'list' }, node.subsplashListId, nextRows.length + 1)
  );

  return nextRows;
};

const updateRootProjectionAfterRemoval = async ({
  rootFirestoreListId,
  removedMediaItemId,
  removedSermonId,
  placementsByMediaItemId,
}: {
  rootFirestoreListId: string;
  removedMediaItemId: string;
  removedSermonId?: string;
  placementsByMediaItemId: Map<string, PublishedPlacement>;
}): Promise<void> => {
  const firestoreDB = firebaseAdmin.firestore();
  const rootProjectionRef = firestoreDB.collection('lists').doc(rootFirestoreListId).collection('listItems');
  const rootListSnapshot = await firestoreDB.collection('lists').doc(rootFirestoreListId).get();
  const rootListData = rootListSnapshot.data() ?? {};
  const projectionSnapshot = await rootProjectionRef.get();
  const sermonIdByMediaItemId = new Map<string, string>();

  projectionSnapshot.docs.forEach((doc) => {
    const subsplashId = normalizeString(doc.data().subsplashId);
    if (!subsplashId) {
      return;
    }
    sermonIdByMediaItemId.set(subsplashId, doc.id);
  });

  const batch = firestoreDB.batch();
  const resolvedRemovedSermonId = removedSermonId ?? sermonIdByMediaItemId.get(removedMediaItemId);
  if (resolvedRemovedSermonId) {
    listDebugLog('removeFromList.updateRootProjectionAfterRemoval.removedSermonResolved', {
      rootFirestoreListId,
      removedMediaItemId,
      removedSermonId: resolvedRemovedSermonId,
      resolutionMode: removedSermonId ? 'explicit-sermon-id' : 'projection-media-match',
    });
    const removedCanonicalRef = firestoreDB
      .collection('sermons')
      .doc(resolvedRemovedSermonId)
      .collection('sermonLists')
      .doc(rootFirestoreListId);
    const removedCanonicalSnapshot = await removedCanonicalRef.get();

    batch.update(
      rootProjectionRef.doc(resolvedRemovedSermonId),
      {
        uploadStatus: {
          status: uploadStatus.NOT_UPLOADED,
        },
        physicalPlacement: FieldValue.delete(),
      }
    );
    if (removedCanonicalSnapshot.exists) {
      batch.update(removedCanonicalRef, {
        ...rootListData,
        id: rootFirestoreListId,
        uploadStatus: {
          status: uploadStatus.NOT_UPLOADED,
        },
        publishGeneration: FieldValue.increment(1),
      });
    } else {
      batch.set(
        removedCanonicalRef,
        {
          ...rootListData,
          id: rootFirestoreListId,
          uploadStatus: {
            status: uploadStatus.NOT_UPLOADED,
          },
          publishGeneration: 1,
        },
        { merge: true }
      );
    }
  } else {
    listDebugWarn('removeFromList.updateRootProjectionAfterRemoval.missingRemovedSermonId', {
      rootFirestoreListId,
      removedMediaItemId,
      knownProjectionMediaItemIds: [...sermonIdByMediaItemId.keys()],
    });
  }

  placementsByMediaItemId.forEach((placement, mediaItemId) => {
    const sermonId = sermonIdByMediaItemId.get(mediaItemId);
    if (!sermonId) {
      return;
    }

    batch.set(
      rootProjectionRef.doc(sermonId),
      {
        uploadStatus: {
          status: uploadStatus.UPLOADED,
          listItemId: placement.listItemId,
        },
        physicalPlacement: placement,
      },
      { merge: true }
    );
    batch.set(
      firestoreDB
        .collection('sermons')
        .doc(sermonId)
        .collection('sermonLists')
        .doc(rootFirestoreListId),
      {
        ...rootListData,
        id: rootFirestoreListId,
        uploadStatus: {
          status: uploadStatus.UPLOADED,
          ...(placement.listItemId ? { listItemId: placement.listItemId } : {}),
        },
      },
      { merge: true }
    );
  });

  await batch.commit();
};

const rebalanceOverflowChainAfterRemoval = async ({
  rootSubsplashListId,
  removedMediaItemId,
  removedSermonId,
  token,
  maxListSize,
}: {
  rootSubsplashListId: string;
  removedMediaItemId: string;
  removedSermonId?: string;
  token: string;
  maxListSize?: number;
}): Promise<void> => {
  const nodes = await loadOverflowChainNodes(rootSubsplashListId, token);
  if (nodes.length === 0) {
    return;
  }

  const rootListSnapshot = await firebaseAdmin.firestore().collection('lists').doc(nodes[0].firestoreListId).get();
  const rootListData = rootListSnapshot.data();
  const configuredMaxListSize =
    typeof rootListData?.maxListSize === 'number' &&
    Number.isFinite(rootListData.maxListSize) &&
    rootListData.maxListSize > 0
      ? rootListData.maxListSize
      : undefined;
  const effectiveMaxListSize =
    (typeof maxListSize === 'number' && Number.isFinite(maxListSize) && maxListSize > 0
      ? maxListSize
      : undefined) ??
    configuredMaxListSize ??
    getConfiguredMaxListSize();

  listDebugLog('removeFromList.rebalance.start', {
    rootSubsplashListId,
    removedMediaItemId,
    maxListSize: effectiveMaxListSize,
    nodes: nodes.map((node) => ({
      firestoreListId: node.firestoreListId,
      subsplashListId: node.subsplashListId,
      remoteRows: summarizeSubsplashRows(node.remoteRows),
    })),
  });

  const targetPages = buildTargetPages(nodes, effectiveMaxListSize);
  const placementsByMediaItemId = new Map<string, PublishedPlacement>();

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const shouldHaveLink = index + 1 < targetPages.length && targetPages[index + 1].length > 0;
    const nextNode = shouldHaveLink ? nodes[index + 1] : undefined;
    const targetRows = buildTargetRowsForNode(node, targetPages[index], nextNode);

    listDebugLog('removeFromList.rebalance.partition', {
      rootSubsplashListId,
      firestoreListId: node.firestoreListId,
      subsplashListId: node.subsplashListId,
      targetRows: summarizeSubsplashRows(targetRows),
    });

    await deleteRowsMissingFromTarget(node, targetRows, token);
    const appliedRows =
      targetRows.length > 0 ? await patchListRows(node.subsplashListId, targetRows, token) : [];

    appliedRows
      .filter((row) => row.type !== 'list')
      .forEach((row) => {
        const mediaItemId = normalizeString(row._embedded?.[row.type]?.id);
        if (!mediaItemId) {
          return;
        }

        const contentPosition =
          appliedRows
            .filter((candidate) => candidate.type !== 'list')
            .findIndex((candidate) => candidate.id === row.id) + 1;

        placementsByMediaItemId.set(mediaItemId, {
          firestoreListId: node.firestoreListId,
          subsplashListId: node.subsplashListId,
          overflowDepth: index,
          position: contentPosition,
          listItemId: row.id,
        });
      });
  }

  await syncOverflowChainMetadata(rootSubsplashListId, token);
  await updateRootProjectionAfterRemoval({
    rootFirestoreListId: nodes[0].firestoreListId,
    removedMediaItemId,
    removedSermonId,
    placementsByMediaItemId,
  });
  listDebugLog('removeFromList.rebalance.complete', {
    rootSubsplashListId,
    removedMediaItemId,
    placements: [...placementsByMediaItemId.entries()].map(([mediaItemId, placement]) => ({
      mediaItemId,
      placement,
    })),
  });
};

export const removeFromList = async (
  listIds: string[],
  listItemIds: string[],
  itemIds: string[],
  itemTypes: string[],
  sermonIds?: string[],
  operationKey?: string
) => {
  const normalizedOperationKey = getOperationKey(operationKey);
  listDebugLog('removeFromList.start', {
    listIds,
    listItemIds,
    itemIds,
    itemTypes,
    sermonIds,
    operationKey: normalizedOperationKey,
  });
  const token = await authenticateSubsplash();
  // Validate input arrays have the same length
  if (
    listIds.length !== listItemIds.length ||
    listIds.length !== itemIds.length ||
    listIds.length !== itemTypes.length ||
    (sermonIds !== undefined && listIds.length !== sermonIds.length)
  ) {
    throw new Error('All input arrays must have the same length');
  }

  const lockKeys = listIds.map((listId) => `list:${listId}`);
  itemIds.forEach((itemId, index) => {
    if (itemTypes[index] === 'media-item') {
      lockKeys.push(`media-item:${itemId}`);
    }
  });

  const runRemoval = async (): Promise<RemoveFromListOutputType> => {
    listDebugLog('removeFromList.runRemoval.start', {
      listIds,
      listItemIds,
      itemIds,
      itemTypes,
    });
    const result = await Promise.allSettled(
      listItemIds.map(async (listItemId, index) => {
      const listId = listIds[index];
      const itemId = itemIds[index];
      const itemType = itemTypes[index];
      const sermonId = sermonIds?.[index];
      listDebugLog('removeFromList.item.start', {
        listId,
        listItemId,
        itemId,
        itemType,
        sermonId,
      });
      
      try {
        const resolvedPlacement = await findItemPlacementInOverflowChain(listId, itemId, itemType, token);
        if (!resolvedPlacement) {
          listDebugWarn('removeFromList.item.notFoundInChain', {
            listId,
            listItemId,
            itemId,
            itemType,
          });
          await rebalanceOverflowChainAfterRemoval({
            rootSubsplashListId: listId,
            removedMediaItemId: itemId,
            removedSermonId: sermonId,
            token,
          });
          return { listId, listItemId, foundInOriginalList: false, itemNotFound: true };
        }

        if (resolvedPlacement.listItemId !== listItemId || resolvedPlacement.listId !== listId) {
          listDebugWarn('removeFromList.item.stalePlacementResolved', {
            listId,
            listItemId,
            itemId,
            itemType,
            resolvedPlacement,
          });
        }

        const deleteConfig = createAxiosConfig(
          `https://core.subsplash.com/builder/v1/list-rows/${resolvedPlacement.listItemId}`,
          token,
          'DELETE'
        );
        await axios(deleteConfig);
        listDebugLog('removeFromList.item.deleteRemote.success', {
          listId,
          listItemId,
          itemId,
          itemType,
          resolvedPlacement,
        });
        await rebalanceOverflowChainAfterRemoval({
          rootSubsplashListId: listId,
          removedMediaItemId: itemId,
          removedSermonId: sermonId,
          token,
        });
        return {
          listId: resolvedPlacement.listId,
          listItemId: resolvedPlacement.listItemId,
          foundInOriginalList: resolvedPlacement.listId === listId,
        };
      } catch (error: unknown) {
        const axiosError = error as { response?: { status?: number }; status?: number };
        const errorStatus = (axiosError.response?.status ?? axiosError.status) as number | undefined;
        if (errorStatus === 404 || errorStatus === 400) {
          listDebugWarn('removeFromList.item.disappearedBeforeDeleteCompleted', {
            listId,
            listItemId,
            itemId,
            itemType,
            errorStatus,
          });
          await rebalanceOverflowChainAfterRemoval({
            rootSubsplashListId: listId,
            removedMediaItemId: itemId,
            removedSermonId: sermonId,
            token,
          });
          return { listId, listItemId, foundInOriginalList: false, itemNotFound: true };
        }

        listDebugError('removeFromList.item.failed', {
          listId,
          listItemId,
          itemId,
          itemType,
          error,
        });
        throw error;
      }
      })
    );
  
    listDebugLog('removeFromList.runRemoval.results', {
      result,
    });
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

      listDebugError('removeFromList.runRemoval.itemRejected', {
        listId: listIds[index],
        reason: r.reason,
      });
      const status: status = 'error';
      const errorPayload = getErrorPayload(r.reason);
      return { listId: listIds[index], status, ...errorPayload };
    });
    listDebugLog('removeFromList.runRemoval.complete', {
      returnResult,
    });
    return returnResult;
  };

  try {
    const executeLockedRemoval = async (): Promise<RemoveFromListOutputType> => {
      return withSubsplashLocks(lockKeys, runRemoval, {
        ...(normalizedOperationKey ? { operationKey: normalizedOperationKey } : {}),
      });
    };

    const output = normalizedOperationKey
      ? await withIdempotency(normalizedOperationKey, executeLockedRemoval)
      : await executeLockedRemoval();
    listDebugLog('removeFromList.success', {
      listIds,
      itemIds,
      output,
    });
    return output;
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
    listDebugError('removeFromList.failed', {
      listIds,
      itemIds,
      errorPayload,
    });
    throw error;
  }
};
const removeFromListCallable = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<RemoveFromListInputType>): Promise<RemoveFromListOutputType> => {
    listDebugLog('removeFromList.callable.start', {
      uid: request.auth?.uid,
      listIds: request.data?.listIds,
      listItemIds: request.data?.listItemIds,
      itemIds: request.data?.itemIds,
      itemTypes: request.data?.itemTypes,
      sermonIds: request.data?.sermonIds,
      operationKey: request.data?.operationKey,
    });

    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const data = request.data;
    if (
      !data.listItemIds ||
      !data.listIds ||
      !data.itemIds ||
      !data.itemTypes ||
      data.listIds.length !== data.listItemIds.length ||
      data.listIds.length !== data.itemIds.length ||
      data.listIds.length !== data.itemTypes.length ||
      (data.sermonIds !== undefined && data.listIds.length !== data.sermonIds.length)
    ) {
      throw new HttpsError(
        'invalid-argument',
        'The function must be called with non-empty equal sized listIds, listItemIds, itemIds, itemTypes, and optional sermonIds arrays.'
      );
    }
    try {
      const output = await removeFromList(
        data.listIds,
        data.listItemIds,
        data.itemIds,
        data.itemTypes,
        data.sermonIds,
        data.operationKey
      );
      listDebugLog('removeFromList.callable.success', {
        listIds: data.listIds,
        itemIds: data.itemIds,
        sermonIds: data.sermonIds,
        output,
      });
      return output;
    } catch (err) {
      listDebugError('removeFromList.callable.failed', {
        listIds: data.listIds,
        itemIds: data.itemIds,
        error: err,
      });
      throw handleError(err);
    }
  }
);

export default removeFromListCallable;
