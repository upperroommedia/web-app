import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { isAxiosError } from 'axios';
import { SUBSPLASH_MEDIA_ITEM_NOT_FOUND_CODE } from '@upperroom/contracts/addToList';
import { authenticateSubsplash } from './subsplashUtils';
import { SubsplashListRow, SubsplashMediaItem } from './types/Subsplash';
import {
  createListRow,
  getFullListRows,
  getReconciledListState,
  patchListRows,
  createNewList,
  getListDetails,
  deleteListRow,
} from './helpers/addToListHelpers';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { Timestamp, type DocumentReference, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { OverflowBehavior } from '@upperroom/shared/types/List';
import handleError from './handleError';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { withIdempotency } from './locks/withIdempotency';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import {
  buildOverflowListMetadata,
  buildOverflowListSubtitle,
  buildOverflowListTitle,
  buildRootListMetadata,
  syncRootMembershipPlacements,
  syncOverflowChainMetadata,
} from './helpers/listOverflowChain';
import { ensureCanPerformStrictPublishedMutation } from './helpers/publishedListDrift';
import { listDebugError, listDebugLog, listDebugWarn, summarizeSubsplashRows } from './helpers/listDebugLogger';
import { getConfiguredMaxListSize } from './helpers/listCapacity';
import { canReconstructRemoteRow, getRemoteRowResourceId, getRemoteRowTitle } from './helpers/remoteChainItems';
import { getSubsplashMediaItemDetails, getSubsplashMediaItemDiagnostics } from './helpers/subsplashMediaItems';
import { rebalanceOverflowChainAfterRemoval } from './removeFromList';
import { captureFunctionsExceptionAndFlush } from './sentry';

const firestoreDB = firebaseAdmin.firestore();

export interface AddtoListInputType {
  destinationListIds: string[];
  mediaItem: SubsplashMediaItem;
  maxListSize?: number;
  operationKey?: string;
}

type OutputTypes =
  | {
      listId: string;
      status: 'success';
      listItemId?: string;
      actualPlacement?: {
        firestoreListId: string;
        subsplashListId: string;
        overflowDepth: number;
        position: number;
        listItemId?: string;
      };
    }
  | {
      listId: string;
      status: 'error';
      error: string;
      errorCode?: string;
      errorDetails?: unknown;
    };

export type AddToListOutputType = OutputTypes[];

const getOperationKey = (operationKey?: string): string | undefined => {
  const normalizedKey = operationKey?.trim();
  return normalizedKey ? normalizedKey : undefined;
};

const getErrorPayload = (error: unknown): { error: string; errorCode?: string; errorDetails?: unknown } => {
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

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const assertSubsplashMediaItemExists = async (
  mediaItem: SubsplashMediaItem,
  token: string
): Promise<void> => {
  try {
    await getSubsplashMediaItemDetails(mediaItem.id, token);
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 404) {
      throw new HttpsError(
        'not-found',
        `Media item ${mediaItem.id} no longer exists in Subsplash.`,
        {
          code: SUBSPLASH_MEDIA_ITEM_NOT_FOUND_CODE,
          media_item_id: mediaItem.id,
        }
      );
    }

    throw error;
  }
};

const isMissingSubsplashMediaItemError = (error: unknown): boolean =>
  error instanceof HttpsError &&
  error.code === 'not-found' &&
  typeof error.details === 'object' &&
  error.details !== null &&
  'code' in error.details &&
  error.details.code === SUBSPLASH_MEDIA_ITEM_NOT_FOUND_CODE;

const normalizeMatchWords = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

const buildFlexibleWordPattern = (words: string[]): RegExp | null => {
  if (words.length === 0) {
    return null;
  }

  return new RegExp(words.map((word) => `\\b${word}\\b`).join('[\\s\\S]*'), 'i');
};

const MORE_SERMONS_PATTERN = /\bmore\b[\s\S]*\bsermons?\b/i;

const looksLikeOverflowListName = ({
  rootListName,
  candidateTitle,
}: {
  rootListName: string;
  candidateTitle: string;
}): boolean => {
  const normalizedCandidate = candidateTitle.trim();
  if (!normalizedCandidate) {
    return false;
  }

  if (MORE_SERMONS_PATTERN.test(normalizedCandidate)) {
    return true;
  }

  const rootWords = normalizeMatchWords(rootListName);
  const candidateWords = normalizeMatchWords(normalizedCandidate);
  if (rootWords.length === 0 || candidateWords.length === 0) {
    return false;
  }

  const rootPattern = buildFlexibleWordPattern(rootWords);
  const candidatePattern = buildFlexibleWordPattern(candidateWords);
  if (rootPattern?.test(normalizedCandidate) || candidatePattern?.test(rootListName)) {
    return true;
  }

  const rootWordSet = new Set(rootWords);
  const overlapCount = candidateWords.filter((word) => rootWordSet.has(word)).length;
  const minimumOverlap = Math.max(2, Math.ceil(rootWords.length * 0.6));
  return overlapCount >= minimumOverlap;
};

const findAdoptableOverflowListCandidate = async ({
  rows,
  rootListName,
  token,
}: {
  rows: SubsplashListRow[];
  rootListName: string;
  token: string;
}): Promise<{ listId: string; title: string }> => {
  for (const row of rows) {
    if (row.type !== 'list') {
      continue;
    }

    const linkedListId = getRemoteRowResourceId(row);
    if (!linkedListId) {
      continue;
    }

    let linkedListTitle = getRemoteRowTitle(row);
    if (!linkedListTitle) {
      try {
        const listDetails = await getListDetails(linkedListId, token);
        linkedListTitle = normalizeString(listDetails.title);
      } catch (error) {
        listDebugWarn('addToList.findAdoptableOverflowListCandidate.skipUnresolvableList', {
          linkedListId,
          rootListName,
          error,
        });
        continue;
      }
    }

    if (!linkedListTitle || !looksLikeOverflowListName({ rootListName, candidateTitle: linkedListTitle })) {
      continue;
    }

    return {
      listId: linkedListId,
      title: linkedListTitle,
    };
  }

  throw new Error('NO_MATCHING_OVERFLOW_CANDIDATE');
};

const canReuseExistingOverflowDoc = ({
  existingData,
  rootListId,
}: {
  existingData: Record<string, unknown>;
  rootListId: string;
}): boolean => {
  const existingRootListId = normalizeString(existingData.rootListId);
  const isOverflowList = existingData.isMoreSermonsList === true;

  if (!isOverflowList) {
    return false;
  }

  if (!existingRootListId) {
    return true;
  }

  return existingRootListId === rootListId;
};

const resolveListItemIdWithRetry = async (
  listId: string,
  itemToAdd: SubsplashMediaItem,
  token: string,
  finalRowsSnapshot?: SubsplashListRow[]
): Promise<string | undefined> => {
  const addedRowFromPatch = finalRowsSnapshot?.find(
    (row) => row.type === itemToAdd.type && getRemoteRowResourceId(row) === itemToAdd.id
  );
  if (addedRowFromPatch?.id) {
    return addedRowFromPatch.id;
  }

  const retryDelaysMs = [0, 50, 150, 300, 500];
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    const updatedListRows = await getFullListRows(listId, token);
    const addedRow = updatedListRows.find(
      (row) => row.type === itemToAdd.type && getRemoteRowResourceId(row) === itemToAdd.id
    );
    if (addedRow?.id) {
      return addedRow.id;
    }
  }

  return undefined;
};

const collectListResolutionDiagnostics = async ({
  listId,
  itemToAdd,
  token,
  finalRowsSnapshot,
}: {
  listId: string;
  itemToAdd: SubsplashMediaItem;
  token: string;
  finalRowsSnapshot?: SubsplashListRow[];
}): Promise<Record<string, unknown>> => {
  const [latestRowsResult, mediaItemDiagnostics] = await Promise.all([
    getFullListRows(listId, token)
      .then((rows) => ({ ok: true as const, rows }))
      .catch((error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      })),
    getSubsplashMediaItemDiagnostics(itemToAdd.id, token),
  ]);

  const latestRows = latestRowsResult.ok ? latestRowsResult.rows : undefined;
  const currentSeriesId = mediaItemDiagnostics.found
    ? mediaItemDiagnostics.item._embedded?.['media-series']?.id
    : undefined;
  const rowsReferencingMediaItem = latestRows?.filter((row) => getRemoteRowResourceId(row) === itemToAdd.id) ?? [];
  const rowsReferencingCurrentSeries = currentSeriesId
    ? latestRows?.filter((row) => row.type === 'media-series' && getRemoteRowResourceId(row) === currentSeriesId) ?? []
    : [];

  return {
    finalRowsSnapshot: finalRowsSnapshot ? summarizeSubsplashRows(finalRowsSnapshot) : undefined,
    latestRows: latestRowsResult.ok && latestRows
      ? summarizeSubsplashRows(latestRows)
      : { error: latestRowsResult.ok ? 'No latest rows returned' : latestRowsResult.error },
    mediaItemDiagnostics: mediaItemDiagnostics.found
      ? mediaItemDiagnostics.summary
      : mediaItemDiagnostics,
    rowsReferencingMediaItem: summarizeSubsplashRows(rowsReferencingMediaItem),
    rowsReferencingCurrentSeries: summarizeSubsplashRows(rowsReferencingCurrentSeries),
  };
};

const findItemInOverflowChain = async (
  rootSubsplashListId: string,
  itemToAdd: SubsplashMediaItem,
  token: string
): Promise<{ listId: string; listItemId: string } | null> => {
  const visitedListIds = new Set<string>();
  let currentListId: string | undefined = rootSubsplashListId;

  while (currentListId && !visitedListIds.has(currentListId)) {
    visitedListIds.add(currentListId);

    const rows = await getFullListRows(currentListId, token);
    const matchingRow = rows.find((row) => row.type === itemToAdd.type && getRemoteRowResourceId(row) === itemToAdd.id);
    if (matchingRow?.id) {
      return {
        listId: currentListId,
        listItemId: matchingRow.id,
      };
    }

    const listSnapshot = await firestoreDB.collection('lists').where('subsplashId', '==', currentListId).limit(1).get();
    if (listSnapshot.empty) {
      break;
    }

    currentListId = normalizeString(listSnapshot.docs[0].data().moreSermonsRef);
  }

  return null;
};

const findItemInOverflowChainWithRetry = async (
  rootSubsplashListId: string,
  itemToAdd: SubsplashMediaItem,
  token: string
): Promise<{ listId: string; listItemId: string } | null> => {
  const retryDelaysMs = [0, 50, 150, 300, 500];

  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    const resolvedPlacement = await findItemInOverflowChain(rootSubsplashListId, itemToAdd, token);
    if (resolvedPlacement) {
      return resolvedPlacement;
    }
  }

  return null;
};

const findAllItemPlacementsInOverflowChain = async (
  rootListId: string,
  itemToAdd: SubsplashMediaItem,
  token: string
): Promise<Array<{ listId: string; listItemId: string }>> => {
  const visitedListIds = new Set<string>();
  const placements: Array<{ listId: string; listItemId: string }> = [];
  let currentListId: string | undefined = rootListId;

  while (currentListId && !visitedListIds.has(currentListId)) {
    visitedListIds.add(currentListId);

    const rows = await getFullListRows(currentListId, token);
    rows
      .filter((row) => row.type === itemToAdd.type && getRemoteRowResourceId(row) === itemToAdd.id && row.id)
      .forEach((row) => {
        placements.push({
          listId: currentListId!,
          listItemId: row.id!,
        });
      });

    const listQuery = await firestoreDB.collection('lists').where('subsplashId', '==', currentListId).limit(1).get();
    if (listQuery.empty) {
      break;
    }

    currentListId = normalizeString(listQuery.docs[0].data().moreSermonsRef);
  }

  return placements;
};

const deleteExistingRowsMissingFromTarget = async (
  listId: string,
  existingRows: SubsplashListRow[],
  targetRows: SubsplashListRow[],
  token: string
): Promise<void> => {
  const targetIds = new Set(
    targetRows
      .map((row) => row.id)
      .filter((rowId): rowId is string => typeof rowId === 'string' && rowId.trim().length > 0)
  );

  const rowsToDelete = existingRows.filter((row) => row.id && !targetIds.has(row.id));
  for (const rowToDelete of rowsToDelete) {
    await deleteListRow(rowToDelete.id!, listId, token);
  }
};

const ensureListIsPatchableBeforeDestructiveMutation = async (
  listId: string,
  currentRows: SubsplashListRow[],
  token: string
): Promise<void> => {
  if (currentRows.length === 0) {
    return;
  }

  try {
    await patchListRows(listId, currentRows, token);
  } catch (error) {
    if (isSubsplashUnknownListRowError(error)) {
      throw new StaleListSnapshotPreflightError(listId, error);
    }

    throw error;
  }
};

const ensureExistingRowCountDoesNotExceedConfiguredMax = ({
  listId,
  enforcedRowCount,
  maxListSize,
}: {
  listId: string;
  enforcedRowCount: number;
  maxListSize: number;
}): void => {
  if (enforcedRowCount <= maxListSize) {
    return;
  }

  throw new HttpsError(
    'failed-precondition',
    `List ${listId} currently has ${enforcedRowCount} enforced rows in Subsplash, which exceeds the configured maxListSize of ${maxListSize}. No changes were made.`
  );
};

const computeOverflowContentKeepLimit = ({
  listId,
  maxListSize,
  physicalMaxRowCount,
  updatedRowCount,
  phantomRowCount,
}: {
  listId: string;
  maxListSize: number;
  physicalMaxRowCount: number;
  updatedRowCount: number;
  phantomRowCount: number;
}): number => {
  const effectiveVisibleCapacity = Math.max(0, maxListSize - phantomRowCount);
  const logicalKeepLimit = Math.max(0, effectiveVisibleCapacity - 1);
  if (physicalMaxRowCount < 200 || updatedRowCount < physicalMaxRowCount) {
    return logicalKeepLimit;
  }

  const physicalKeepLimit = Math.max(0, physicalMaxRowCount - 2);
  const adjustedKeepLimit = Math.min(logicalKeepLimit, physicalKeepLimit);

  if (adjustedKeepLimit < logicalKeepLimit) {
      listDebugLog('addToList.computeOverflowContentKeepLimit.reserveSafetySlot', {
        listId,
        maxListSize,
        physicalMaxRowCount,
        updatedRowCount,
        phantomRowCount,
        effectiveVisibleCapacity,
        logicalKeepLimit,
        adjustedKeepLimit,
      });
  }

  return adjustedKeepLimit;
};

const shouldOverflowAfterInsert = ({
  enforcedRowCount,
  maxListSize,
  physicalMaxRowCount,
  currentRows,
}: {
  enforcedRowCount: number;
  maxListSize: number;
  physicalMaxRowCount: number;
  currentRows: SubsplashListRow[];
}): boolean => {
  if (enforcedRowCount >= maxListSize) {
    return true;
  }

  const hasContinuationLink = currentRows.some((row) => row.type === 'list');
  if (!hasContinuationLink || physicalMaxRowCount < 200) {
    return false;
  }

  return enforcedRowCount + 1 >= physicalMaxRowCount;
};

const isSubsplashMaxRowExceededError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const maybeError = error as {
    message?: unknown;
    details?: {
      upstream?: {
        errors?: Array<{ detail?: unknown }>;
      };
    };
  };

  const upstreamDetails = maybeError.details?.upstream?.errors;
  if (Array.isArray(upstreamDetails)) {
    return upstreamDetails.some((entry) => typeof entry?.detail === 'string' && entry.detail.includes('max number of list rows exceeded'));
  }

  return typeof maybeError.message === 'string' && maybeError.message.includes('max number of list rows exceeded');
};

const getSubsplashUpstreamErrorDetails = (error: unknown): string[] => {
  if (!error || typeof error !== 'object') {
    return [];
  }

  const details = (error as {
    details?: {
      upstream?: {
        errors?: Array<{ detail?: unknown }>;
      };
    };
  }).details?.upstream?.errors;

  if (!Array.isArray(details)) {
    return [];
  }

  return details
    .map((entry) => entry?.detail)
    .filter((detail): detail is string => typeof detail === 'string');
};

const isSubsplashUnknownListRowError = (error: unknown): boolean =>
  getSubsplashUpstreamErrorDetails(error).some((detail) => /unknown list row:/i.test(detail));

class StaleListSnapshotPreflightError extends Error {
  constructor(
    readonly listId: string,
    readonly originalError: unknown
  ) {
    super(`Subsplash returned a stale row snapshot for list ${listId}.`);
    this.name = 'StaleListSnapshotPreflightError';
  }
}

const applyRemoveOldestMutation = async ({
  listId,
  itemId,
  currentRows,
  finalRows,
  token,
}: {
  listId: string;
  itemId: string;
  currentRows: SubsplashListRow[];
  finalRows: SubsplashListRow[];
  token: string;
}): Promise<SubsplashListRow[]> => {
  const finalRowIds = new Set(
    finalRows
      .map((row) => row.id)
      .filter((rowId): rowId is string => typeof rowId === 'string' && rowId.trim().length > 0)
  );
  const rowsToDelete = currentRows.filter((row) => row.id && !finalRowIds.has(row.id));
  const visibleRowsAfterDelete = finalRows.filter((row) => row.id);

  listDebugLog('addToList.processListStep.removeOldest.start', {
    listId,
    itemId,
    currentRows: summarizeSubsplashRows(currentRows),
    finalRows: summarizeSubsplashRows(finalRows),
    visibleRowsAfterDelete: summarizeSubsplashRows(visibleRowsAfterDelete),
    rowsToDelete: summarizeSubsplashRows(rowsToDelete),
  });

  await ensureListIsPatchableBeforeDestructiveMutation(listId, currentRows, token);

  try {
    await deleteExistingRowsMissingFromTarget(listId, currentRows, finalRows, token);
    let finalRowsSnapshot: SubsplashListRow[];
    try {
      finalRowsSnapshot = await patchListRows(listId, finalRows, token);
    } catch (error) {
      if (!isSubsplashMaxRowExceededError(error) || visibleRowsAfterDelete.length >= finalRows.length) {
        throw error;
      }

      listDebugWarn('addToList.processListStep.removeOldest.hiddenCapacityRetry.start', {
        listId,
        itemId,
        error,
        visibleRowsAfterDelete: summarizeSubsplashRows(visibleRowsAfterDelete),
        finalRows: summarizeSubsplashRows(finalRows),
      });

      const compactedFinalRows = finalRows.slice(0, visibleRowsAfterDelete.length);
      const compactedVisibleRowsBeforeInsert = compactedFinalRows.filter((row) => row.id);

      const healedRowsSnapshot = await patchListRows(listId, compactedVisibleRowsBeforeInsert, token);
      listDebugLog('addToList.processListStep.removeOldest.hiddenCapacityRetry.healedVisibleRows', {
        listId,
        itemId,
        compactedFinalRows: summarizeSubsplashRows(compactedFinalRows),
        healedRowsSnapshot: summarizeSubsplashRows(healedRowsSnapshot),
      });

      finalRowsSnapshot = await patchListRows(listId, compactedFinalRows, token);
      listDebugLog('addToList.processListStep.removeOldest.hiddenCapacityRetry.complete', {
        listId,
        itemId,
        finalRowsSnapshot: summarizeSubsplashRows(finalRowsSnapshot),
      });
    }

    listDebugLog('addToList.processListStep.removeOldest.complete', {
      listId,
      itemId,
      finalRowsSnapshot: summarizeSubsplashRows(finalRowsSnapshot),
    });
    return finalRowsSnapshot;
  } catch (error) {
    listDebugWarn('addToList.processListStep.removeOldest.patchFailed', {
      listId,
      itemId,
      error,
      rowsToDelete: summarizeSubsplashRows(rowsToDelete),
      finalRows: summarizeSubsplashRows(finalRows),
    });

    let rollbackSucceeded = false;
    try {
      const rollbackRowsSnapshot = await patchListRows(listId, currentRows, token, {
        forceFullRows: true,
      });
      listDebugWarn('addToList.processListStep.removeOldest.rollbackSucceeded', {
        listId,
        itemId,
        rollbackRowsSnapshot: summarizeSubsplashRows(rollbackRowsSnapshot),
      });
      rollbackSucceeded = true;
    } catch (rollbackError) {
      listDebugError('addToList.processListStep.removeOldest.rollbackFailed', {
        listId,
        itemId,
        error,
        rollbackError,
        originalRows: summarizeSubsplashRows(currentRows),
        finalRows: summarizeSubsplashRows(finalRows),
        rowsToDelete: summarizeSubsplashRows(rowsToDelete),
      });
      throw new HttpsError(
        'internal',
        'Failed to update latest list in Subsplash and automatic rollback failed. Subsplash may need manual review.'
      );
    }

    if (rollbackSucceeded) {
      throw new HttpsError(
        'internal',
        'Failed to update latest list in Subsplash. The original list order was restored.'
      );
    }

    throw new HttpsError(
      'internal',
      'Failed to update latest list in Subsplash and automatic rollback status could not be determined.'
    );
  }

};

const ensureImmediateOverflowListLinkInFirestore = async ({
  listDoc,
  listData,
  currentRows,
  token,
  totalRowCount,
  maxListSize,
}: {
  listDoc: QueryDocumentSnapshot;
  listData: Record<string, unknown>;
  currentRows: SubsplashListRow[];
  token: string;
  totalRowCount: number;
  maxListSize: number;
}): Promise<boolean> => {
  if (listData.overflowBehavior !== OverflowBehavior.CREATENEWLIST) {
    return false;
  }

  const linkRow = currentRows.find((row) => row.type === 'list' && row._embedded.list?.id);
  const overflowListId = linkRow?._embedded.list?.id;
  if (!overflowListId) {
    return false;
  }

  const hasStoredLink =
    typeof listData.moreSermonsRef === 'string' && listData.moreSermonsRef.trim() === overflowListId;
  const existingOverflowSnapshot = await firestoreDB
    .collection('lists')
    .where('subsplashId', '==', overflowListId)
    .limit(1)
    .get();

  if (hasStoredLink && !existingOverflowSnapshot.empty) {
    return false;
  }

  const explicitRootListId =
    typeof listData.rootListId === 'string' && listData.rootListId.trim() ? listData.rootListId.trim() : undefined;
  const isOverflowList = listData.isMoreSermonsList === true;
  const parentDepth = typeof listData.overflowDepth === 'number' ? listData.overflowDepth : isOverflowList ? 1 : 0;
  const rootListId = explicitRootListId ?? listDoc.id;
  const overflowListDetails = await getListDetails(overflowListId, token);
  const now = Date.now();

  const batch = firestoreDB.batch();
  batch.set(
    listDoc.ref,
    {
      moreSermonsRef: overflowListId,
      maxListSize,
      updatedAtMillis: now,
      ...(isOverflowList
        ? buildOverflowListMetadata({
            rootListId,
            overflowDepth: parentDepth,
          })
        : buildRootListMetadata({
            rootListId: listDoc.id,
            logicalCount: typeof listData.logicalCount === 'number' ? listData.logicalCount : totalRowCount,
            hasOverflowPages: true,
          })),
    },
    { merge: true }
  );

  if (existingOverflowSnapshot.empty) {
    const newListRef = firestoreDB.collection('lists').doc();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, ...dataToCopy } = listData;
    batch.set(newListRef, {
      ...dataToCopy,
      id: newListRef.id,
      subsplashId: overflowListId,
      name: overflowListDetails.title,
      createdAtMillis: now,
      updatedAtMillis: now,
      count: 0,
      maxListSize,
      images: [],
      ...buildOverflowListMetadata({
        rootListId,
        overflowDepth: parentDepth + 1,
      }),
    });
  }

  await batch.commit();
  return true;
};

// Helper to handle a single list processing step recursively
// Returns listItemId if item was added, undefined if item already existed
async function processListStepOnce(
  listId: string,
  itemToAdd: SubsplashMediaItem,
  token: string,
  maxListSize: number = getConfiguredMaxListSize(),
  shouldSyncChainMetadata: boolean = true,
  shouldSearchLogicalChain: boolean = true,
  shouldEnforceStrictPreflight: boolean = true
): Promise<{
  listItemId?: string;
  actualPlacement?: {
    firestoreListId: string;
    subsplashListId: string;
    overflowDepth: number;
    position: number;
    listItemId?: string;
  };
}> {
  listDebugLog('addToList.processListStep.start', {
    listId,
    itemToAdd,
    maxListSize,
    shouldSyncChainMetadata,
    shouldSearchLogicalChain,
    shouldEnforceStrictPreflight,
  });
  const listQuery = firestoreDB.collection('lists').where('subsplashId', '==', listId).limit(1);
  let itemsToPropagateAfterCommit: Array<{ listId: string; item: SubsplashMediaItem }> = [];
  let itemExisted = false;
  let existingListItemId: string | undefined;
  let finalRowsSnapshot: SubsplashListRow[] | undefined;
  const querySnapshot = await listQuery.get();
  if (querySnapshot.empty) {
    throw new HttpsError('not-found', `List ${listId} not found in Firestore`);
  }

  const listDoc = querySnapshot.docs[0];
  const listData = listDoc.data() as Record<string, unknown>;
  const listName =
    (typeof listData.name === 'string' && listData.name.trim()) ||
    (typeof listData.title === 'string' && listData.title.trim()) ||
    listDoc.id;
  const explicitRootListId =
    typeof listData.rootListId === 'string' && listData.rootListId.trim() ? listData.rootListId.trim() : undefined;
  const isOverflowList = listData.isMoreSermonsList === true;

  let existingPlacementInChain: { listId: string; listItemId: string } | null = null;
  let existingPlacementsInChain: Array<{ listId: string; listItemId: string }> = [];
  if (shouldSearchLogicalChain) {
    existingPlacementInChain = await findItemInOverflowChain(listId, itemToAdd, token);
    existingPlacementsInChain = await findAllItemPlacementsInOverflowChain(listId, itemToAdd, token);
  }

  listDebugLog('addToList.processListStep.loadedList', {
    listId,
    firestoreListId: listDoc.id,
    explicitRootListId,
    isOverflowList,
    overflowBehavior: listData.overflowBehavior,
    moreSermonsRef: listData.moreSermonsRef,
    existingPlacementInChain,
  });

  if (shouldEnforceStrictPreflight) {
    listDebugLog('addToList.processListStep.strictPreflight.start', {
      listId,
      rootListId: explicitRootListId ?? listDoc.id,
      action: 'publish',
    });
    await ensureCanPerformStrictPublishedMutation(explicitRootListId ?? listDoc.id, token, 'publish');
    listDebugLog('addToList.processListStep.strictPreflight.success', {
      listId,
      rootListId: explicitRootListId ?? listDoc.id,
      action: 'publish',
    });
  }

  let {
    rows: currentRows,
    enforcedRowCount,
    phantomRowCount,
    maxItemCount: physicalMaxRowCount,
  } = await getReconciledListState(listId, token);
  let exists = currentRows.some((row) => getRemoteRowResourceId(row) === itemToAdd.id);
  listDebugLog('addToList.processListStep.remoteState', {
    listId,
    enforcedRowCount,
    phantomRowCount,
    physicalMaxRowCount,
    exists,
    currentRows: summarizeSubsplashRows(currentRows),
  });

  ensureExistingRowCountDoesNotExceedConfiguredMax({
    listId,
    enforcedRowCount,
    maxListSize,
  });

  await listDoc.ref.update({ updatedAtMillis: Timestamp.now().toMillis() });

  if (existingPlacementsInChain.length > 0) {
    const currentPlacements = currentRows
      .filter((row) => row.type === itemToAdd.type && getRemoteRowResourceId(row) === itemToAdd.id && row.id)
      .map((row) => ({ listId, listItemId: row.id! }));
    const currentPlacementToKeep = currentPlacements[0]?.listItemId;
    const placementsToDelete = existingPlacementsInChain.filter(
      (placement) =>
        placement.listId !== listId ||
        (currentPlacementToKeep ? placement.listItemId !== currentPlacementToKeep : true)
    );

    if (placementsToDelete.length > 0) {
      listDebugLog('addToList.processListStep.removeExistingPlacements.start', {
        listId,
        itemId: itemToAdd.id,
        placementsToDelete,
      });
      for (const placement of placementsToDelete) {
        await deleteListRow(placement.listItemId, placement.listId, token);
      }
      await rebalanceOverflowChainAfterRemoval({
        rootSubsplashListId: listId,
        removedMediaItemId: itemToAdd.id,
        token,
        maxListSize,
      });
      ({
        rows: currentRows,
        enforcedRowCount,
        phantomRowCount,
        maxItemCount: physicalMaxRowCount,
      } = await getReconciledListState(listId, token));
      exists = currentRows.some((row) => getRemoteRowResourceId(row) === itemToAdd.id);
      existingPlacementInChain = exists
        ? {
            listId,
            listItemId: currentRows.find((row) => getRemoteRowResourceId(row) === itemToAdd.id)?.id ?? '',
          }
        : null;
      listDebugLog('addToList.processListStep.removeExistingPlacements.complete', {
        listId,
        itemId: itemToAdd.id,
        currentRows: summarizeSubsplashRows(currentRows),
      });
    }
  }

  if (exists) {
    listDebugLog('addToList.processListStep.alreadyInPhysicalList', {
      listId,
      itemId: itemToAdd.id,
    });
    itemExisted = true;
    const existingRow = currentRows.find((row) => getRemoteRowResourceId(row) === itemToAdd.id);
    existingListItemId = existingRow?.id;
    if (existingRow && existingRow.position !== 1) {
      const reorderedRows = [
        existingRow,
        ...currentRows.filter((row) => row.id !== existingRow.id),
      ];
      finalRowsSnapshot = await patchListRows(listId, reorderedRows, token);
      currentRows = finalRowsSnapshot;
      listDebugLog('addToList.processListStep.promoteExistingRow.complete', {
        listId,
        itemId: itemToAdd.id,
        listItemId: existingListItemId,
        finalRowsSnapshot: summarizeSubsplashRows(finalRowsSnapshot),
      });
    }

    const repairedOverflowMetadata = await ensureImmediateOverflowListLinkInFirestore({
      listDoc,
      listData,
      currentRows,
      token,
      totalRowCount: enforcedRowCount,
      maxListSize,
    });

    if (!finalRowsSnapshot) {
      finalRowsSnapshot = currentRows;
    }

    if (repairedOverflowMetadata && existingListItemId && existingRow?.position === 1) {
      return {
        listItemId: existingListItemId,
      };
    }
  } else {
    const newRow = createListRow(itemToAdd, listId, 1);
    const updatedRows = [newRow, ...currentRows];
    const willOverflow = shouldOverflowAfterInsert({
      enforcedRowCount,
      maxListSize,
      physicalMaxRowCount,
      currentRows,
    });
    listDebugLog('addToList.processListStep.prePatchDecision', {
      listId,
      itemId: itemToAdd.id,
      willOverflow,
      maxListSize,
      physicalMaxRowCount,
      updatedRows: summarizeSubsplashRows(updatedRows),
    });

    if (willOverflow) {
      listDebugLog('addToList.processListStep.branchDecision', {
        listId,
        itemId: itemToAdd.id,
        branch: 'overflow',
        overflowBehavior: listData.overflowBehavior,
        enforcedRowCount,
        phantomRowCount,
        physicalMaxRowCount,
        maxListSize,
      });
      if (listData.overflowBehavior === OverflowBehavior.CREATENEWLIST) {
        let nextListId =
          typeof listData.moreSermonsRef === 'string' && listData.moreSermonsRef.trim()
            ? listData.moreSermonsRef.trim()
            : undefined;
        let rootListId = explicitRootListId ?? listDoc.id;
        let rootListName = listName;
        const explicitOverflowDepth = typeof listData.overflowDepth === 'number' ? listData.overflowDepth : undefined;
        const hasExplicitOverflowDepth = explicitOverflowDepth !== undefined;
        let currentDepth: number = explicitOverflowDepth ?? (isOverflowList ? 1 : 0);
        let pendingOverflowDoc:
          | {
              ref: DocumentReference;
              data: Record<string, unknown>;
              parentUpdate: Record<string, unknown>;
              merge?: boolean;
            }
          | undefined;

        if (!nextListId) {
          if (isOverflowList) {
            let currentSubsplashId = listId;

            while (true) {
              const parentQuery = await firestoreDB
                .collection('lists')
                .where('moreSermonsRef', '==', currentSubsplashId)
                .limit(1)
                .get();

              if (parentQuery.empty) {
                break;
              }

              const parentDoc = parentQuery.docs[0];
              const parentData = parentDoc.data() as Record<string, unknown>;

              if (parentData.isMoreSermonsList === true) {
                currentSubsplashId =
                  typeof parentData.subsplashId === 'string' && parentData.subsplashId.trim()
                    ? parentData.subsplashId
                    : parentDoc.id;
                if (!hasExplicitOverflowDepth) {
                  currentDepth += 1;
                }
                if (!explicitRootListId && typeof parentData.rootListId === 'string' && parentData.rootListId.trim()) {
                  rootListId = parentData.rootListId.trim();
                }
                continue;
              }

              rootListId = parentDoc.id;
              rootListName =
                (typeof parentData.name === 'string' && parentData.name.trim()) ||
                (typeof parentData.title === 'string' && parentData.title.trim()) ||
                parentDoc.id;
              break;
            }
          }

          const newOverflowDepth = currentDepth + 1;
          let adoptedOverflowCandidate = await findAdoptableOverflowListCandidate({
            rows: currentRows,
            rootListName,
            token,
          }).catch((error) => {
            if (error instanceof Error && error.message === 'NO_MATCHING_OVERFLOW_CANDIDATE') {
              return null;
            }
            throw error;
          });
          const newTitle = buildOverflowListTitle(rootListName);
          const subtitle = buildOverflowListSubtitle(newOverflowDepth);
          const now = Date.now();

          let existingOverflowSnapshot = await firestoreDB
            .collection('lists')
            .where('subsplashId', '==', adoptedOverflowCandidate?.listId ?? '__missing__')
            .limit(2)
            .get();

          if (existingOverflowSnapshot.docs.length > 1 && adoptedOverflowCandidate) {
            throw new HttpsError(
              'failed-precondition',
              `Multiple Firestore lists already exist for Subsplash list ${adoptedOverflowCandidate.listId}.`
            );
          }

          if (adoptedOverflowCandidate && existingOverflowSnapshot.docs[0]) {
            const existingOverflowData = existingOverflowSnapshot.docs[0].data() as Record<string, unknown>;
            if (!canReuseExistingOverflowDoc({ existingData: existingOverflowData, rootListId })) {
              listDebugWarn('addToList.processListStep.adoptOverflowList.skipExistingStandaloneFirestoreDoc', {
                listId,
                candidateListId: adoptedOverflowCandidate.listId,
                rootListId,
                existingFirestoreListId: existingOverflowSnapshot.docs[0].id,
                existingRootListId: normalizeString(existingOverflowData.rootListId),
                isMoreSermonsList: existingOverflowData.isMoreSermonsList === true,
                type: normalizeString(existingOverflowData.type),
              });
              adoptedOverflowCandidate = null;
              existingOverflowSnapshot = await firestoreDB
                .collection('lists')
                .where('subsplashId', '==', '__missing__')
                .limit(1)
                .get();
            }
          }

          if (adoptedOverflowCandidate) {
            nextListId = adoptedOverflowCandidate.listId;
            listDebugLog('addToList.processListStep.adoptOverflowList.success', {
              listId,
              nextListId,
              rootListId,
              newOverflowDepth,
              adoptedOverflowTitle: adoptedOverflowCandidate.title,
            });
          } else {
            listDebugLog('addToList.processListStep.createOverflowList.start', {
              listId,
              rootListId,
              rootListName,
              currentDepth,
              newOverflowDepth,
              newTitle,
              subtitle,
            });

            const newList = await createNewList(newTitle, token, subtitle);
            nextListId = newList.id;
            listDebugLog('addToList.processListStep.createOverflowList.success', {
              listId,
              nextListId,
              rootListId,
              newOverflowDepth,
            });

            existingOverflowSnapshot = await firestoreDB
              .collection('lists')
              .where('subsplashId', '==', nextListId)
              .limit(2)
              .get();
            if (existingOverflowSnapshot.docs.length > 1) {
              throw new HttpsError(
                'failed-precondition',
                `Multiple Firestore lists already exist for Subsplash list ${nextListId}.`
              );
            }
          }
          const existingOverflowDoc = existingOverflowSnapshot.docs[0];
          const overflowListName = adoptedOverflowCandidate?.title ?? newTitle;

          if (existingOverflowDoc) {
            pendingOverflowDoc = {
              ref: existingOverflowDoc.ref,
              data: {
                updatedAtMillis: now,
                maxListSize,
                name: overflowListName,
                ...buildOverflowListMetadata({
                  rootListId,
                  overflowDepth: newOverflowDepth,
                }),
              },
              parentUpdate: {
                moreSermonsRef: nextListId,
                maxListSize,
                ...(isOverflowList
                  ? buildOverflowListMetadata({
                      rootListId,
                      overflowDepth: currentDepth,
                    })
                  : buildRootListMetadata({
                      rootListId: listDoc.id,
                      logicalCount: typeof listData.logicalCount === 'number' ? listData.logicalCount : enforcedRowCount,
                      hasOverflowPages: true,
                  })),
              },
              merge: true,
            };
          } else {
            const newListRef = firestoreDB.collection('lists').doc();
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { id, ...dataToCopy } = listData;
            pendingOverflowDoc = {
              ref: newListRef,
              data: {
                ...dataToCopy,
                id: newListRef.id,
                subsplashId: nextListId,
                name: overflowListName,
                createdAtMillis: now,
                updatedAtMillis: now,
                count: 0,
                maxListSize,
                images: [],
                ...buildOverflowListMetadata({
                  rootListId,
                  overflowDepth: newOverflowDepth,
                }),
              },
              parentUpdate: {
                moreSermonsRef: nextListId,
                maxListSize,
                ...(isOverflowList
                  ? buildOverflowListMetadata({
                      rootListId,
                      overflowDepth: currentDepth,
                    })
                  : buildRootListMetadata({
                      rootListId: listDoc.id,
                      logicalCount: typeof listData.logicalCount === 'number' ? listData.logicalCount : enforcedRowCount,
                      hasOverflowPages: true,
                    })),
              },
            };
          }
        }

        const contentRows = updatedRows.filter((r) => !(r.type === 'list' && r._embedded.list?.id === nextListId));
        const contentKeepLimit = computeOverflowContentKeepLimit({
          listId,
          maxListSize,
          physicalMaxRowCount,
          updatedRowCount: updatedRows.length,
          phantomRowCount,
        });
        const itemsToKeep = contentRows.slice(0, contentKeepLimit);
        const itemsToPropagate = contentRows.slice(contentKeepLimit);
        listDebugLog('addToList.processListStep.overflowPartition', {
          listId,
          nextListId,
          physicalMaxRowCount,
          contentKeepLimit,
          itemsToKeep: summarizeSubsplashRows(itemsToKeep),
          itemsToPropagate: summarizeSubsplashRows(itemsToPropagate),
        });

        if (itemsToPropagate.length > 0) {
          listDebugLog('addToList.processListStep.overflowDeleteAndPropagate.start', {
            listId,
            nextListId,
            propagateCount: itemsToPropagate.length,
            rowsToDelete: summarizeSubsplashRows(itemsToPropagate.filter((r) => Boolean(r.id))),
          });
          await ensureListIsPatchableBeforeDestructiveMutation(listId, currentRows, token);

          const rowsToDelete = itemsToPropagate.filter((r) => r.id);
          for (const rowToDelete of rowsToDelete) {
            await deleteListRow(rowToDelete.id!, listId, token);
          }

          const reversedPropagate = [...itemsToPropagate].reverse();
          for (const itemRow of reversedPropagate) {
            const resourceId = getRemoteRowResourceId(itemRow);
            if (!resourceId || !canReconstructRemoteRow(itemRow)) {
              throw new HttpsError(
                'failed-precondition',
                `Row ${itemRow.id ?? 'unknown'} cannot be shifted into overflow because Subsplash did not provide a reconstructible resource identity.`
              );
            }

            itemsToPropagateAfterCommit.push({
              listId: nextListId!,
              item: {
                id: resourceId,
                type: itemRow.type,
              },
            });
          }
          listDebugLog('addToList.processListStep.overflowDeleteAndPropagate.queued', {
            listId,
            nextListId,
            itemsToPropagateAfterCommit,
          });
        }

        const existingLinkRow = currentRows.find((r) => r.type === 'list' && r._embedded.list?.id === nextListId);
        const rowsToPatchAfterDelete = itemsToKeep.filter((r) => r.id);
        if (existingLinkRow) {
          rowsToPatchAfterDelete.push(existingLinkRow);
        }
        if (rowsToPatchAfterDelete.length > 0) {
          await patchListRows(listId, rowsToPatchAfterDelete, token);
        }

        const linkRow = existingLinkRow
          ? { ...existingLinkRow, position: itemsToKeep.length + 1 }
          : createListRow({ id: nextListId!, type: 'list' }, listId, itemsToKeep.length + 1);
        const finalRows = [...itemsToKeep, linkRow];
        finalRowsSnapshot = await patchListRows(listId, finalRows, token);
        listDebugLog('addToList.processListStep.overflowPatch.complete', {
          listId,
          nextListId,
          finalRowsSnapshot: summarizeSubsplashRows(finalRowsSnapshot),
        });

        if (pendingOverflowDoc) {
          const batch = firestoreDB.batch();
          if (pendingOverflowDoc.merge) {
            batch.set(pendingOverflowDoc.ref, pendingOverflowDoc.data, { merge: true });
          } else {
            batch.set(pendingOverflowDoc.ref, pendingOverflowDoc.data);
          }
          batch.update(listDoc.ref, pendingOverflowDoc.parentUpdate);
          await batch.commit();
          listDebugLog('addToList.processListStep.overflowFirestoreMetadata.created', {
            listId,
            nextListId,
            pendingOverflowFirestoreListId: pendingOverflowDoc.ref.id,
            parentUpdate: pendingOverflowDoc.parentUpdate,
          });
        }
      } else if (listData.overflowBehavior === OverflowBehavior.REMOVEOLDEST) {
        const effectiveVisibleCapacity = Math.max(0, maxListSize - phantomRowCount);
        const finalRows = updatedRows.slice(0, effectiveVisibleCapacity);
        listDebugLog('addToList.processListStep.removeOldest.plan', {
          listId,
          itemId: itemToAdd.id,
          enforcedRowCount,
          phantomRowCount,
          effectiveVisibleCapacity,
          updatedRows: summarizeSubsplashRows(updatedRows),
          finalRows: summarizeSubsplashRows(finalRows),
        });
        finalRowsSnapshot = await applyRemoveOldestMutation({
          listId,
          itemId: itemToAdd.id,
          currentRows,
          finalRows,
          token,
        });
      } else {
        throw new HttpsError('failed-precondition', 'List overflowed and no valid behavior set');
      }
    } else {
      listDebugLog('addToList.processListStep.branchDecision', {
        listId,
        itemId: itemToAdd.id,
        branch: 'simplePatch',
        overflowBehavior: listData.overflowBehavior,
        enforcedRowCount,
        phantomRowCount,
        physicalMaxRowCount,
        maxListSize,
      });
      try {
        finalRowsSnapshot = await patchListRows(listId, updatedRows, token);
      } catch (error) {
        if (!isSubsplashMaxRowExceededError(error) || listData.overflowBehavior !== OverflowBehavior.REMOVEOLDEST) {
          throw error;
        }

        const fallbackVisibleCapacity = Math.max(0, maxListSize - 1);
        const fallbackFinalRows = updatedRows.slice(0, fallbackVisibleCapacity);
        listDebugWarn('addToList.processListStep.simplePatch.hiddenCapacityFallback', {
          listId,
          itemId: itemToAdd.id,
          maxListSize,
          fallbackVisibleCapacity,
          updatedRows: summarizeSubsplashRows(updatedRows),
          fallbackFinalRows: summarizeSubsplashRows(fallbackFinalRows),
          error,
        });
        finalRowsSnapshot = await applyRemoveOldestMutation({
          listId,
          itemId: itemToAdd.id,
          currentRows,
          finalRows: fallbackFinalRows,
          token,
        });
      }
      listDebugLog('addToList.processListStep.simplePatch.complete', {
        listId,
        finalRowsSnapshot: summarizeSubsplashRows(finalRowsSnapshot),
      });
    }
  }

  let listItemId: string | undefined;
  if (itemExisted) {
    listItemId = existingListItemId;
  } else {
    listItemId = await resolveListItemIdWithRetry(listId, itemToAdd, token, finalRowsSnapshot);
    if (!listItemId) {
      const recoveredPlacement = await findItemInOverflowChainWithRetry(listId, itemToAdd, token);
      if (recoveredPlacement?.listItemId) {
        listItemId = recoveredPlacement.listItemId;
        listDebugWarn('addToList.processListStep.resolveListItemId.recoveredFromChain', {
          listId,
          itemId: itemToAdd.id,
          recoveredPlacement,
        });
      }
    }
  }

  if (!listItemId) {
    const resolutionDiagnostics = await collectListResolutionDiagnostics({
      listId,
      itemToAdd,
      token,
      finalRowsSnapshot,
    });
    listDebugError('addToList.processListStep.resolveListItemId.failed', {
      listId,
      itemId: itemToAdd.id,
      ...resolutionDiagnostics,
    });
    throw new HttpsError('internal', `Added item ${itemToAdd.id} could not be resolved in list ${listId} after patch.`);
  }

  for (const { listId: targetListId, item } of itemsToPropagateAfterCommit) {
    listDebugLog('addToList.processListStep.propagate.start', {
      sourceListId: listId,
      targetListId,
      item,
    });
    await processListStep(targetListId, item, token, maxListSize, false, false, false);
  }

  let actualPlacement:
    | {
        firestoreListId: string;
        subsplashListId: string;
        overflowDepth: number;
        position: number;
        listItemId?: string;
      }
    | undefined;

  const resolvedPlacement = await findItemInOverflowChain(listId, itemToAdd, token);
  if (resolvedPlacement) {
    const physicalListQuery = await firestoreDB
      .collection('lists')
      .where('subsplashId', '==', resolvedPlacement.listId)
      .limit(1)
      .get();
    const physicalListDoc = physicalListQuery.docs[0];
    const physicalRows = await getFullListRows(resolvedPlacement.listId, token);
    const position = physicalRows.findIndex((row) => row.id === resolvedPlacement.listItemId) + 1;

    if (physicalListDoc && position > 0) {
      const physicalListData = physicalListDoc.data() as Record<string, unknown>;
      actualPlacement = {
        firestoreListId: physicalListDoc.id,
        subsplashListId: resolvedPlacement.listId,
        overflowDepth: typeof physicalListData.overflowDepth === 'number' ? physicalListData.overflowDepth : 0,
        position,
        listItemId: resolvedPlacement.listItemId,
      };
    }
  }
  listDebugLog('addToList.processListStep.finalPlacement', {
    listId,
    itemId: itemToAdd.id,
    listItemId,
    actualPlacement,
  });

  if (shouldSyncChainMetadata) {
    listDebugLog('addToList.processListStep.syncMetadata.start', {
      listId,
      itemId: itemToAdd.id,
    });
    await syncOverflowChainMetadata(listId, token);
    await syncRootMembershipPlacements(listId, token);
    listDebugLog('addToList.processListStep.syncMetadata.complete', {
      listId,
      itemId: itemToAdd.id,
    });
  }
  return { listItemId, actualPlacement };
}

async function processListStep(
  listId: string,
  itemToAdd: SubsplashMediaItem,
  token: string,
  maxListSize: number = getConfiguredMaxListSize(),
  shouldSyncChainMetadata: boolean = true,
  shouldSearchLogicalChain: boolean = true,
  shouldEnforceStrictPreflight: boolean = true
): ReturnType<typeof processListStepOnce> {
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await processListStepOnce(
        listId,
        itemToAdd,
        token,
        maxListSize,
        shouldSyncChainMetadata,
        shouldSearchLogicalChain,
        shouldEnforceStrictPreflight
      );
    } catch (error) {
      if (!(error instanceof StaleListSnapshotPreflightError)) {
        throw error;
      }

      if (attempt >= maxAttempts) {
        throw error.originalError;
      }

      listDebugWarn('addToList.processListStep.staleSnapshotRetry', {
        listId,
        itemId: itemToAdd.id,
        attempt,
        maxAttempts,
        error: getErrorPayload(error.originalError),
      });
    }
  }

  throw new HttpsError('internal', `Failed to process list ${listId} after refreshing stale state.`);
}

const recoverPlacementAfterFailedMutation = async ({
  rootListId,
  mediaItem,
  token,
}: {
  rootListId: string;
  mediaItem: SubsplashMediaItem;
  token: string;
}): Promise<
  | {
      listItemId?: string;
      actualPlacement?: {
        firestoreListId: string;
        subsplashListId: string;
        overflowDepth: number;
        position: number;
        listItemId?: string;
      };
    }
  | null
> => {
  const resolvedPlacement = await findItemInOverflowChainWithRetry(rootListId, mediaItem, token);
  if (!resolvedPlacement) {
    return null;
  }

  const physicalListQuery = await firestoreDB
    .collection('lists')
    .where('subsplashId', '==', resolvedPlacement.listId)
    .limit(1)
    .get();
  const physicalListDoc = physicalListQuery.docs[0];
  const physicalRows = await getFullListRows(resolvedPlacement.listId, token);
  const position = physicalRows.findIndex((row) => row.id === resolvedPlacement.listItemId) + 1;

  let actualPlacement:
    | {
        firestoreListId: string;
        subsplashListId: string;
        overflowDepth: number;
        position: number;
        listItemId?: string;
      }
    | undefined;

  if (physicalListDoc && position > 0) {
    const physicalListData = physicalListDoc.data() as Record<string, unknown>;
    actualPlacement = {
      firestoreListId: physicalListDoc.id,
      subsplashListId: resolvedPlacement.listId,
      overflowDepth: typeof physicalListData.overflowDepth === 'number' ? physicalListData.overflowDepth : 0,
      position,
      listItemId: resolvedPlacement.listItemId,
    };
  }

  try {
    await syncOverflowChainMetadata(rootListId, token);
    await syncRootMembershipPlacements(rootListId, token);
  } catch (syncError) {
    listDebugWarn('addToList.callable.runMutation.recoveredPlacement.syncFailed', {
      rootListId,
      mediaItemId: mediaItem.id,
      syncError: getErrorPayload(syncError),
    });
  }

  return {
    listItemId: resolvedPlacement.listItemId,
    actualPlacement,
  };
};

const addToList = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts, memory: '512MiB' },
  async (request: CallableRequest<AddtoListInputType>): Promise<AddToListOutputType> => {
    listDebugLog('addToList.callable.start', {
      uid: request.auth?.uid,
      destinationListIds: request.data?.destinationListIds,
      mediaItem: request.data?.mediaItem,
      maxListSize: request.data?.maxListSize,
      operationKey: request.data?.operationKey,
    });

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
      const maxListSize = request.data.maxListSize ?? getConfiguredMaxListSize();
      const lockKeys = [...destinationListIds.map((listId) => `list:${listId}`), `media-item:${mediaItem.id}`];
      listDebugLog('addToList.callable.authenticated', {
        destinationListIds,
        mediaItemId: mediaItem.id,
        maxListSize,
        lockKeys,
        operationKey,
      });

      const runMutation = async (): Promise<AddToListOutputType> => {
        listDebugLog('addToList.callable.runMutation.start', {
          destinationListIds,
          mediaItemId: mediaItem.id,
        });
        await assertSubsplashMediaItemExists(mediaItem, token);
        const results = await Promise.allSettled(
          destinationListIds.map(async (listId) => {
            const result = await processListStep(listId, mediaItem, token, maxListSize);
            return { listId, listItemId: result.listItemId, actualPlacement: result.actualPlacement };
          })
        );

        const outputs = await Promise.all(results.map(async (result, index): Promise<OutputTypes> => {
          if (result.status === 'fulfilled') {
            return {
              listId: destinationListIds[index],
              status: 'success',
              ...(result.value.listItemId ? { listItemId: result.value.listItemId } : {}),
              ...(result.value.actualPlacement ? { actualPlacement: result.value.actualPlacement } : {}),
            };
          }

          const errorPayload = getErrorPayload(result.reason);
          try {
            const recoveredPlacement = await recoverPlacementAfterFailedMutation({
              rootListId: destinationListIds[index],
              mediaItem,
              token,
            });
            if (recoveredPlacement) {
              listDebugWarn('addToList.callable.runMutation.itemRecoveredAfterError', {
                listId: destinationListIds[index],
                mediaItemId: mediaItem.id,
                errorPayload,
                recoveredPlacement,
              });
              return {
                listId: destinationListIds[index],
                status: 'success',
                ...(recoveredPlacement.listItemId ? { listItemId: recoveredPlacement.listItemId } : {}),
                ...(recoveredPlacement.actualPlacement ? { actualPlacement: recoveredPlacement.actualPlacement } : {}),
              };
            }
          } catch (recoveryError) {
            listDebugWarn('addToList.callable.runMutation.itemRecoveryFailed', {
              listId: destinationListIds[index],
              mediaItemId: mediaItem.id,
              errorPayload,
              recoveryError: getErrorPayload(recoveryError),
            });
          }

          listDebugError('addToList.callable.runMutation.itemFailed', {
            listId: destinationListIds[index],
            mediaItemId: mediaItem.id,
            errorPayload,
          });
          await captureFunctionsExceptionAndFlush(result.reason, {
            tags: {
              functionName: 'addtolist',
              failureMode: 'handled-item-error',
              listId: destinationListIds[index],
            },
            extra: {
              destinationListIds,
              mediaItemId: mediaItem.id,
              errorPayload,
            },
          });
          return {
            listId: destinationListIds[index],
            status: 'error',
            ...errorPayload,
          };
        }));

        return outputs;
      };

      const executeLockedMutation = async (): Promise<AddToListOutputType> => {
        return withSubsplashLocks(lockKeys, runMutation, {
          ...(operationKey ? { operationKey } : {}),
        });
      };

      const output = operationKey
        ? await withIdempotency(operationKey, executeLockedMutation)
        : await executeLockedMutation();
      listDebugLog('addToList.callable.success', {
        destinationListIds,
        mediaItemId: mediaItem.id,
        output,
      });
      return output;
    } catch (error) {
      const errorPayload = getErrorPayload(error);
      if (errorPayload.errorCode === 'aborted') {
        listDebugWarn('addToList.callable.lockAborted', {
          destinationListIds,
          mediaItemId: mediaItem.id,
          errorPayload,
        });
        return destinationListIds.map(
          (listId): OutputTypes => ({
            listId,
            status: 'error',
            ...errorPayload,
          })
        );
      }

      const err = error as unknown;
      listDebugError('addToList.callable.failed', {
        destinationListIds,
        mediaItemId: mediaItem.id,
        errorPayload,
      });
      throw handleError(err, {
        suppressReporting: isMissingSubsplashMediaItemError(err),
        context: {
          functionName: 'addtolist',
          destinationListIds,
          mediaItemId: mediaItem.id,
        },
      });
    }
  }
);

export default addToList;
