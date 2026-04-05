import firebaseAdmin from '../../../packages/shared/firebase/firebaseAdmin.js';
import { FieldValue, type DocumentReference, type SetOptions } from 'firebase-admin/firestore';
import type { List } from '../../../packages/shared/types/List';
import { uploadStatus } from '../../../packages/shared/types/SermonTypes';
import { HttpsError } from 'firebase-functions/v2/https';
import axios from 'axios';
import type {
  GetListOverflowChainIssue,
  GetListOverflowChainNode,
  GetListOverflowChainOutputType,
} from '../../../packages/contracts/getListOverflowChain';
import { createAxiosConfig } from '../subsplashUtils';
import { getFullListRows, patchListRows } from './addToListHelpers';
import {
  listDebugLog,
  summarizeOverflowIssues,
  summarizeOverflowNodes,
  summarizeSubsplashRows,
} from './listDebugLogger';
import {
  countLogicalContentRows,
  getLogicalContentRows,
  getRemoteRowResourceId,
} from './remoteChainItems';

type StoredListData = List & {
  title?: string;
};

type StoredListRecord = {
  id: string;
  data: StoredListData;
};

const firestore = firebaseAdmin.firestore();

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const getListName = (record: StoredListRecord): string =>
  normalizeString(record.data.name) ?? normalizeString(record.data.title) ?? record.id;

const getCanonicalOverflowListName = (rootName: string): string => `More ${rootName} sermons`;
const getOverflowListSubtitle = (overflowDepth: number): string => `Page ${overflowDepth}`;

const getListCount = (record: StoredListRecord): number => {
  return typeof record.data.count === 'number' && Number.isFinite(record.data.count) ? record.data.count : 0;
};

const getStoredListRecordById = async (listId: string): Promise<StoredListRecord | null> => {
  const snapshot = await firestore.collection('lists').doc(listId).get();
  if (!snapshot.exists) {
    return null;
  }

  return {
    id: snapshot.id,
    data: snapshot.data() as StoredListData,
  };
};

const getStoredListRecordBySubsplashId = async (subsplashId: string): Promise<StoredListRecord | null> => {
  const matches = await getStoredListRecordsByField('subsplashId', subsplashId);
  return matches[0] ?? null;
};

const getStoredListRecordsByField = async (field: string, value: string): Promise<StoredListRecord[]> => {
  const snapshot = await firestore.collection('lists').where(field, '==', value).limit(2).get();
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    data: doc.data() as StoredListData,
  }));
};

const pushIssue = (
  issues: GetListOverflowChainIssue[],
  nextIssue: GetListOverflowChainIssue
): void => {
  const alreadyExists = issues.some((issue) => {
    return (
      issue.code === nextIssue.code &&
      issue.firestoreListId === nextIssue.firestoreListId &&
      issue.subsplashListId === nextIssue.subsplashListId
    );
  });

  if (!alreadyExists) {
    issues.push(nextIssue);
  }
};

const cloneIssues = (issues: GetListOverflowChainIssue[]): GetListOverflowChainIssue[] =>
  issues.map((issue) => ({ ...issue }));

type StoredChainNode = {
  record: StoredListRecord;
  depth: number;
};

const getStoredChainNodesFromRoot = async (
  rootRecord: StoredListRecord
): Promise<StoredChainNode[]> => {
  const nodes: StoredChainNode[] = [];
  const visitedListIds = new Set<string>();

  let currentRecord: StoredListRecord | null = rootRecord;
  let depth = 0;

  while (currentRecord) {
    if (visitedListIds.has(currentRecord.id)) {
      break;
    }

    visitedListIds.add(currentRecord.id);
    nodes.push({
      record: currentRecord,
      depth,
    });

    const nextSubsplashListId = normalizeString(currentRecord.data.moreSermonsRef);
    if (!nextSubsplashListId) {
      break;
    }

    currentRecord = await getStoredListRecordBySubsplashId(nextSubsplashListId);
    if (!currentRecord) {
      break;
    }

    depth += 1;
  }

  return nodes;
};

const getContentRowCount = async (subsplashId: string, token: string): Promise<number> => {
  const rows = await getFullListRows(subsplashId, token);
  const currentRecord = await getStoredListRecordBySubsplashId(subsplashId);
  const expectedNextSubsplashListId = normalizeString(currentRecord?.data.moreSermonsRef);
  return countLogicalContentRows({ rows, expectedNextSubsplashListId });
};

const chunkValues = <T>(values: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

type StoredSermonRecord = {
  id: string;
  data: Record<string, unknown> & {
    subsplashId?: string;
  };
};

const getStoredSermonsBySubsplashIds = async (subsplashIds: string[]): Promise<Map<string, StoredSermonRecord>> => {
  const sermonsBySubsplashId = new Map<string, StoredSermonRecord>();

  for (const subsplashIdChunk of chunkValues([...new Set(subsplashIds)], 10)) {
    if (subsplashIdChunk.length === 0) {
      continue;
    }

    const snapshot = await firestore.collection('sermons').where('subsplashId', 'in', subsplashIdChunk).get();
    snapshot.docs.forEach((doc) => {
      const sermonData = doc.data() as Record<string, unknown> & { subsplashId?: string };
      const subsplashId = normalizeString(sermonData.subsplashId);
      if (!subsplashId) {
        return;
      }

      sermonsBySubsplashId.set(subsplashId, {
        id: doc.id,
        data: sermonData,
      });
    });
  }

  return sermonsBySubsplashId;
};

const getStoredRootProjectionItemsBySubsplashId = (
  rootListItemsSnapshot: FirebaseFirestore.QuerySnapshot
): Map<string, StoredSermonRecord> => {
  const itemsBySubsplashId = new Map<string, StoredSermonRecord>();

  rootListItemsSnapshot.docs.forEach((doc) => {
    const itemData = doc.data() as Record<string, unknown> & { subsplashId?: string };
    const subsplashId = normalizeString(itemData.subsplashId);
    if (!subsplashId || itemsBySubsplashId.has(subsplashId)) {
      return;
    }

    itemsBySubsplashId.set(subsplashId, {
      id: doc.id,
      data: itemData,
    });
  });

  return itemsBySubsplashId;
};

type BatchWriteOperation =
  | {
      type: 'set';
      ref: DocumentReference;
      data: Record<string, unknown>;
      options?: SetOptions;
    }
  | {
      type: 'update';
      ref: DocumentReference;
      data: Record<string, unknown>;
    };

const commitBatchWriteOperations = async (operations: BatchWriteOperation[]): Promise<void> => {
  for (const operationChunk of chunkValues(operations, 400)) {
    const batch = firestore.batch();

    operationChunk.forEach((operation) => {
      if (operation.type === 'set') {
        if (operation.options) {
          batch.set(operation.ref, operation.data, operation.options);
        } else {
          batch.set(operation.ref, operation.data);
        }
        return;
      }

      batch.update(operation.ref, operation.data);
    });

    await batch.commit();
  }
};

export const syncRootMembershipPlacements = async (
  startingSubsplashId: string,
  token: string
): Promise<void> => {
  listDebugLog('listOverflowChain.syncRootMembershipPlacements.start', {
    startingSubsplashId,
  });
  const startingRecord = await getStoredListRecordBySubsplashId(startingSubsplashId);
  if (!startingRecord) {
    listDebugLog('listOverflowChain.syncRootMembershipPlacements.skipMissingStartingRecord', {
      startingSubsplashId,
    });
    return;
  }

  const issues: GetListOverflowChainIssue[] = [];
  const rootRecord = await resolveRootRecord(startingRecord, issues);
  const chain = await getStoredChainNodesFromRoot(rootRecord);
  if (chain.length === 0) {
    listDebugLog('listOverflowChain.syncRootMembershipPlacements.skipEmptyChain', {
      startingSubsplashId,
      rootListId: rootRecord.id,
    });
    return;
  }

  const rootNode = chain[0];
  const rootListId = rootNode.record.id;
  const rootListItemsRef = firestore.collection('lists').doc(rootListId).collection('listItems');
  const rootListItemsSnapshot = await rootListItemsRef.get();
  const rootProjectionItemsBySubsplashId = getStoredRootProjectionItemsBySubsplashId(rootListItemsSnapshot);
  const rootListData = rootNode.record.data;
  const rootListMembershipData = { ...rootListData };
  delete rootListMembershipData.count;
  delete rootListMembershipData.updatedAtMillis;

  const rowsByNode = await Promise.all(
    chain.map(async (node) => {
      const subsplashListId = normalizeString(node.record.data.subsplashId);
      return {
        node,
        subsplashListId,
        rows: subsplashListId ? await getFullListRows(subsplashListId, token) : [],
      };
    })
  );
  listDebugLog('listOverflowChain.syncRootMembershipPlacements.rowsLoaded', {
    startingSubsplashId,
    rootListId,
    chain: chain.map(({ record, depth }) => ({
      firestoreListId: record.id,
      subsplashId: record.data.subsplashId,
      depth,
    })),
    rowsByNode: rowsByNode.map(({ node, subsplashListId, rows }) => ({
      firestoreListId: node.record.id,
      subsplashListId,
      depth: node.depth,
      rows: summarizeSubsplashRows(rows),
    })),
  });

  const contentPlacements = rowsByNode.flatMap(({ node, subsplashListId, rows }, nodeIndex) => {
    const expectedNextSubsplashListId = chain[nodeIndex + 1]?.record.data.subsplashId;
    return getLogicalContentRows({
      rows,
      expectedNextSubsplashListId: normalizeString(expectedNextSubsplashListId),
    }).map((row) => ({
        node,
        subsplashListId: subsplashListId as string,
        row,
        mediaItemId: row.type === 'media-item' ? getRemoteRowResourceId(row) : undefined,
      }));
  });

  const mediaPlacements = contentPlacements.filter(
    (placement): placement is typeof placement & { mediaItemId: string } => Boolean(placement.mediaItemId)
  );

  const sermonsBySubsplashId = await getStoredSermonsBySubsplashIds(
    mediaPlacements.map((placement) => placement.mediaItemId)
  );

  let logicalPosition = 1;
  const seenPublishedSermonIds = new Set<string>();
  const operations: BatchWriteOperation[] = [];

  contentPlacements.forEach((placement) => {
    if (!placement.mediaItemId) {
      logicalPosition += 1;
      return;
    }

    const sermonRecord =
      sermonsBySubsplashId.get(placement.mediaItemId) ?? rootProjectionItemsBySubsplashId.get(placement.mediaItemId);
    if (!sermonRecord) {
      logicalPosition += 1;
      return;
    }

    seenPublishedSermonIds.add(sermonRecord.id);

    operations.push({
      type: 'set',
      ref: rootListItemsRef.doc(sermonRecord.id),
      data: {
        ...sermonRecord.data,
        position: logicalPosition,
        uploadStatus: {
          status: uploadStatus.UPLOADED,
          listItemId: placement.row.id,
        },
        physicalPlacement: {
          firestoreListId: placement.node.record.id,
          subsplashListId: placement.subsplashListId,
          overflowDepth: placement.node.depth,
          position: placement.row.position,
          listItemId: placement.row.id,
        },
      },
      options: { merge: true },
    });

    operations.push({
      type: 'set',
      ref: firestore.collection('sermons').doc(sermonRecord.id).collection('sermonLists').doc(rootListId),
      data: {
        ...rootListMembershipData,
        id: rootListId,
        uploadStatus: {
          status: uploadStatus.UPLOADED,
          listItemId: placement.row.id,
        },
      },
      options: { merge: true },
    });

    logicalPosition += 1;
  });

  rootListItemsSnapshot.docs.forEach((doc) => {
    const existingUploadStatus = doc.data()?.uploadStatus?.status;
    if (existingUploadStatus !== uploadStatus.UPLOADED || seenPublishedSermonIds.has(doc.id)) {
      return;
    }

    operations.push({
      type: 'update',
      ref: doc.ref,
      data: {
        'uploadStatus.status': uploadStatus.NOT_UPLOADED,
        'uploadStatus.listItemId': FieldValue.delete(),
        physicalPlacement: FieldValue.delete(),
        position: FieldValue.delete(),
      },
    });

    operations.push({
      type: 'update',
      ref: firestore.collection('sermons').doc(doc.id).collection('sermonLists').doc(rootListId),
      data: {
        'uploadStatus.status': uploadStatus.NOT_UPLOADED,
        'uploadStatus.listItemId': FieldValue.delete(),
        publishGeneration: FieldValue.increment(1),
      },
    });
  });

  if (operations.length > 0) {
    await commitBatchWriteOperations(operations);
  }
  listDebugLog('listOverflowChain.syncRootMembershipPlacements.complete', {
    startingSubsplashId,
    rootListId,
    publishedPlacementCount: mediaPlacements.length,
    seenPublishedSermonIds: [...seenPublishedSermonIds],
    operationCount: operations.length,
  });
};

const patchSubsplashListTitle = async (
  subsplashId: string,
  title: string,
  token: string
): Promise<void> => {
  const requestData = JSON.stringify({
    app_key: '9XTSHD',
    title,
  });
  const config = createAxiosConfig(
    `https://core.subsplash.com/builder/v1/lists/${subsplashId}`,
    token,
    'PATCH',
    requestData
  );

  await axios(config);
};

const collapseEmptyTailOverflowPages = async (
  rootRecord: StoredListRecord,
  token: string
): Promise<void> => {
  listDebugLog('listOverflowChain.collapseEmptyTailOverflowPages.start', {
    rootListId: rootRecord.id,
    rootSubsplashId: rootRecord.data.subsplashId,
  });
  while (true) {
    const latestRootRecord = (await getStoredListRecordById(rootRecord.id)) ?? rootRecord;
    const chain = await getStoredChainNodesFromRoot(latestRootRecord);
    if (chain.length <= 1) {
      listDebugLog('listOverflowChain.collapseEmptyTailOverflowPages.noTailToCollapse', {
        rootListId: rootRecord.id,
      });
      return;
    }

    const tailNode = chain[chain.length - 1];
    const tailSubsplashId = normalizeString(tailNode.record.data.subsplashId);
    if (!tailSubsplashId) {
      return;
    }

    const tailRows = await getFullListRows(tailSubsplashId, token);
    const tailHasContent = countLogicalContentRows({ rows: tailRows }) > 0;
    const tailHasLinkedOverflow = tailRows.some((row) => row.type === 'list' && row._embedded.list?.id);
    listDebugLog('listOverflowChain.collapseEmptyTailOverflowPages.inspectTail', {
      rootListId: rootRecord.id,
      tailFirestoreListId: tailNode.record.id,
      tailSubsplashId,
      tailRows: summarizeSubsplashRows(tailRows),
      tailHasContent,
      tailHasLinkedOverflow,
    });

    if (tailHasContent || tailHasLinkedOverflow) {
      listDebugLog('listOverflowChain.collapseEmptyTailOverflowPages.tailPreserved', {
        rootListId: rootRecord.id,
        tailFirestoreListId: tailNode.record.id,
      });
      return;
    }

    const parentNode = chain[chain.length - 2];
    const parentSubsplashId = normalizeString(parentNode.record.data.subsplashId);
    if (!parentSubsplashId) {
      return;
    }

    const parentRows = await getFullListRows(parentSubsplashId, token);
    const linkRowsToDelete = parentRows.filter(
      (row) => row.type === 'list' && row._embedded.list?.id === tailSubsplashId && row.id
    );
    listDebugLog('listOverflowChain.collapseEmptyTailOverflowPages.deleteParentLinks', {
      rootListId: rootRecord.id,
      parentFirestoreListId: parentNode.record.id,
      parentSubsplashId,
      tailFirestoreListId: tailNode.record.id,
      tailSubsplashId,
      parentRows: summarizeSubsplashRows(parentRows),
      linkRowsToDelete: summarizeSubsplashRows(linkRowsToDelete),
    });
    for (const linkRow of linkRowsToDelete) {
      const deleteConfig = createAxiosConfig(
        `https://core.subsplash.com/builder/v1/list-rows/${linkRow.id}`,
        token,
        'DELETE'
      );
      await axios(deleteConfig);
    }
    const updatedParentRows = parentRows.filter(
      (row) => !(row.type === 'list' && row._embedded.list?.id === tailSubsplashId)
    );

    await patchListRows(parentSubsplashId, updatedParentRows, token);
    const now = Date.now();
    const batch = firestore.batch();
    batch.update(firestore.collection('lists').doc(parentNode.record.id), {
      moreSermonsRef: FieldValue.delete(),
      updatedAtMillis: now,
    });
    batch.set(
      firestore.collection('lists').doc(tailNode.record.id),
      {
        count: 0,
        updatedAtMillis: now,
      },
      { merge: true }
    );
    await batch.commit();
    listDebugLog('listOverflowChain.collapseEmptyTailOverflowPages.collapsedTail', {
      rootListId: rootRecord.id,
      parentFirestoreListId: parentNode.record.id,
      tailFirestoreListId: tailNode.record.id,
      updatedParentRows: summarizeSubsplashRows(updatedParentRows),
    });
  }
};

const resolveRootRecord = async (
  startingRecord: StoredListRecord,
  issues: GetListOverflowChainIssue[]
): Promise<StoredListRecord> => {
  const explicitRootListId = normalizeString(startingRecord.data.rootListId);
  if (startingRecord.data.isRootList === true) {
    if (explicitRootListId && explicitRootListId !== startingRecord.id) {
      pushIssue(issues, {
        code: 'CHAIN_ROOT_METADATA_CONFLICT',
        severity: 'blocking',
        message: 'Root list metadata points to a different logical root.',
        firestoreListId: startingRecord.id,
      });
    }
    return startingRecord;
  }

  if (explicitRootListId && explicitRootListId !== startingRecord.id) {
    const explicitRootRecord = await getStoredListRecordById(explicitRootListId);
    if (explicitRootRecord) {
      return explicitRootRecord;
    }

    pushIssue(issues, {
      code: 'CHAIN_ROOT_METADATA_CONFLICT',
      severity: 'blocking',
      message: 'Explicit rootListId points to a missing Firestore list.',
      firestoreListId: startingRecord.id,
    });
  }

  const visitedListIds = new Set<string>();
  let currentRecord = startingRecord;

  while (true) {
    if (visitedListIds.has(currentRecord.id)) {
      pushIssue(issues, {
        code: 'CHAIN_CYCLE_DETECTED',
        severity: 'blocking',
        message: 'Cycle detected while resolving the logical root list.',
        firestoreListId: currentRecord.id,
        subsplashListId: currentRecord.data.subsplashId,
      });
      return currentRecord;
    }

    visitedListIds.add(currentRecord.id);

    const currentSubsplashId = normalizeString(currentRecord.data.subsplashId);
    if (!currentSubsplashId) {
      return currentRecord;
    }

    const parentMatches = await getStoredListRecordsByField('moreSermonsRef', currentSubsplashId);
    if (parentMatches.length === 0) {
      return currentRecord;
    }

    if (parentMatches.length > 1) {
      pushIssue(issues, {
        code: 'CHAIN_PARENT_CHILD_MISMATCH',
        severity: 'blocking',
        message: 'Multiple parent lists reference the same overflow page.',
        firestoreListId: currentRecord.id,
        subsplashListId: currentSubsplashId,
      });
    }

    currentRecord = parentMatches[0];
  }
};

const buildChainFromRoot = async (
  rootRecord: StoredListRecord,
  issues: GetListOverflowChainIssue[]
): Promise<GetListOverflowChainNode[]> => {
  const nodes: GetListOverflowChainNode[] = [];
  const visitedListIds = new Set<string>();
  const depthMap = new Map<number, string>();

  let currentRecord: StoredListRecord | null = rootRecord;
  let parentRecord: StoredListRecord | null = null;
  let inferredDepth = 0;

  while (currentRecord) {
    if (visitedListIds.has(currentRecord.id)) {
      pushIssue(issues, {
        code: 'CHAIN_CYCLE_DETECTED',
        severity: 'blocking',
        message: 'Cycle detected while traversing the overflow chain.',
        firestoreListId: currentRecord.id,
        subsplashListId: currentRecord.data.subsplashId,
      });
      break;
    }

    visitedListIds.add(currentRecord.id);

    const explicitDepth = currentRecord.data.overflowDepth;
    const nodeDepth = typeof explicitDepth === 'number' ? explicitDepth : inferredDepth;

    if (typeof explicitDepth === 'number' && explicitDepth !== inferredDepth) {
      pushIssue(issues, {
        code: 'CHAIN_PARENT_CHILD_MISMATCH',
        severity: 'blocking',
        message: 'Explicit overflow depth does not match parent-child chain position.',
        firestoreListId: currentRecord.id,
        subsplashListId: currentRecord.data.subsplashId,
      });
    }

    if (depthMap.has(nodeDepth)) {
      pushIssue(issues, {
        code: 'CHAIN_DEPTH_COLLISION',
        severity: 'blocking',
        message: 'Multiple lists claim the same overflow depth.',
        firestoreListId: currentRecord.id,
        subsplashListId: currentRecord.data.subsplashId,
      });
    } else {
      depthMap.set(nodeDepth, currentRecord.id);
    }

    const rootName = getListName(rootRecord);
    const currentName = getListName(currentRecord);
    if (!parentRecord && currentRecord.data.isMoreSermonsList === true) {
      pushIssue(issues, {
        code: 'CHAIN_ROOT_METADATA_CONFLICT',
        severity: 'blocking',
        message: 'List is marked as an overflow page but no parent/root chain could be resolved.',
        firestoreListId: currentRecord.id,
        subsplashListId: currentRecord.data.subsplashId,
      });
    }

    if (parentRecord && currentName !== getCanonicalOverflowListName(rootName)) {
      pushIssue(issues, {
        code: 'CHAIN_NAME_DRIFT',
        severity: 'warning',
        message: 'Overflow page name differs from the canonical root naming pattern.',
        firestoreListId: currentRecord.id,
        subsplashListId: currentRecord.data.subsplashId,
      });
    }

    const nextSubsplashListId = normalizeString(currentRecord.data.moreSermonsRef) ?? null;
    nodes.push({
      firestoreListId: currentRecord.id,
      subsplashId: normalizeString(currentRecord.data.subsplashId),
      name: currentName,
      depth: nodeDepth,
      count: getListCount(currentRecord),
      isRoot: !parentRecord,
      parentFirestoreListId: parentRecord?.id ?? null,
      nextSubsplashListId,
    });

    if (!nextSubsplashListId) {
      break;
    }

    if (nextSubsplashListId === normalizeString(currentRecord.data.subsplashId)) {
      pushIssue(issues, {
        code: 'CHAIN_SELF_LINK',
        severity: 'blocking',
        message: 'A list links to itself as its own overflow page.',
        firestoreListId: currentRecord.id,
        subsplashListId: nextSubsplashListId,
      });
      break;
    }

    const nextMatches = await getStoredListRecordsByField('subsplashId', nextSubsplashListId);
    if (nextMatches.length === 0) {
      pushIssue(issues, {
        code: 'CHAIN_MISSING_LINK_TARGET',
        severity: 'blocking',
        message: 'A list points to an overflow page that is missing from Firestore.',
        firestoreListId: currentRecord.id,
        subsplashListId: nextSubsplashListId,
      });
      break;
    }

    if (nextMatches.length > 1) {
      pushIssue(issues, {
        code: 'CHAIN_PARENT_CHILD_MISMATCH',
        severity: 'blocking',
        message: 'Multiple Firestore lists share the same Subsplash overflow page id.',
        firestoreListId: currentRecord.id,
        subsplashListId: nextSubsplashListId,
      });
    }

    const nextRecord = nextMatches[0];
    const nextExplicitRootListId = normalizeString(nextRecord.data.rootListId);
    if (nextExplicitRootListId && nextExplicitRootListId !== rootRecord.id) {
      pushIssue(issues, {
        code: 'CHAIN_ROOT_METADATA_CONFLICT',
        severity: 'blocking',
        message: 'Overflow page metadata points to a different logical root.',
        firestoreListId: nextRecord.id,
        subsplashListId: nextRecord.data.subsplashId,
      });
    }

    parentRecord = currentRecord;
    currentRecord = nextRecord;
    inferredDepth += 1;
  }

  return nodes;
};

export const getOverflowChainState = async (
  listId: string
): Promise<GetListOverflowChainOutputType> => {
  const normalizedListId = normalizeString(listId);
  if (!normalizedListId) {
    throw new HttpsError('invalid-argument', 'listId is required.');
  }

  const requestedRecord = await getStoredListRecordById(normalizedListId);
  if (!requestedRecord) {
    throw new HttpsError('not-found', `List ${normalizedListId} not found.`);
  }

  const issues: GetListOverflowChainIssue[] = [];
  const rootRecord = await resolveRootRecord(requestedRecord, issues);
  const nodes = await buildChainFromRoot(rootRecord, issues);

  const computedLogicalCount = nodes.reduce((sum, node) => sum + node.count, 0);
  const rootLogicalCount =
    typeof rootRecord.data.logicalCount === 'number' ? rootRecord.data.logicalCount : undefined;

  const output = {
    requestedListId: normalizedListId,
    rootListId: rootRecord.id,
    redirectListId: rootRecord.id,
    logicalCount: rootLogicalCount ?? computedLogicalCount,
    canMutate: !issues.some((issue) => issue.severity === 'blocking'),
    nodes,
    issues,
    remoteItems: [],
  };
  listDebugLog('listOverflowChain.getOverflowChainState.complete', {
    requestedListId: normalizedListId,
    rootListId: rootRecord.id,
    logicalCount: output.logicalCount,
    canMutate: output.canMutate,
    nodes: summarizeOverflowNodes(nodes),
    issues: summarizeOverflowIssues(issues),
  });
  return output;
};

export const buildOverflowListTitle = (rootName: string): string => getCanonicalOverflowListName(rootName);

export const buildOverflowListSubtitle = (overflowDepth: number): string =>
  getOverflowListSubtitle(overflowDepth);

export const buildRootListMetadata = ({
  rootListId,
  logicalCount,
  hasOverflowPages,
}: {
  rootListId: string;
  logicalCount: number;
  hasOverflowPages: boolean;
}): Pick<List, 'isRootList' | 'isMoreSermonsList' | 'rootListId' | 'overflowDepth' | 'logicalCount' | 'hasOverflowPages'> => ({
  isRootList: true,
  isMoreSermonsList: false,
  rootListId,
  overflowDepth: 0,
  logicalCount,
  hasOverflowPages,
});

export const buildOverflowListMetadata = ({
  rootListId,
  overflowDepth,
}: {
  rootListId: string;
  overflowDepth: number;
}): Pick<List, 'isRootList' | 'isMoreSermonsList' | 'rootListId' | 'overflowDepth'> => ({
  isRootList: false,
  isMoreSermonsList: true,
  rootListId,
  overflowDepth,
});

export const shouldMirrorPhysicalListItemToRootMembership = (
  list: Pick<List, 'isRootList' | 'isMoreSermonsList'>
): boolean => {
  if (list.isMoreSermonsList === true) {
    return false;
  }

  if (list.isRootList === false) {
    return false;
  }

  return true;
};

export type OverflowChainRepairWrite = {
  firestoreListId: string;
  data: Pick<List, 'isRootList' | 'isMoreSermonsList' | 'rootListId' | 'overflowDepth'> &
    Partial<Pick<List, 'logicalCount' | 'hasOverflowPages' | 'name'>> & {
      updatedAtMillis: number;
    };
};

export type OverflowChainRepairPlan = {
  rootListId: string;
  logicalCount: number;
  hasOverflowPages: boolean;
  canApply: boolean;
  issues: GetListOverflowChainIssue[];
  updates: OverflowChainRepairWrite[];
};

export const buildOverflowChainRepairPlan = (
  chainState: GetListOverflowChainOutputType,
  options?: {
    now?: number;
  }
): OverflowChainRepairPlan => {
  const issues = cloneIssues(chainState.issues);
  const rootNode = chainState.nodes[0];
  const logicalCount = chainState.nodes.reduce((sum, node) => sum + node.count, 0);
  const hasOverflowPages = chainState.nodes.length > 1;
  const now = options?.now ?? Date.now();

  if (!rootNode) {
    return {
      rootListId: chainState.rootListId,
      logicalCount,
      hasOverflowPages,
      canApply: false,
      issues,
      updates: [],
    };
  }

  const rootName = rootNode.name.trim() || chainState.rootListId;
  const updates = chainState.nodes.map((node) => {
    const metadata =
      node.depth === 0
        ? buildRootListMetadata({
            rootListId: chainState.rootListId,
            logicalCount,
            hasOverflowPages,
          })
        : buildOverflowListMetadata({
            rootListId: chainState.rootListId,
            overflowDepth: node.depth,
          });

    return {
      firestoreListId: node.firestoreListId,
      data: {
        ...metadata,
        ...(node.depth > 0 ? { name: buildOverflowListTitle(rootName) } : {}),
        updatedAtMillis: now,
      },
    };
  });

  return {
    rootListId: chainState.rootListId,
    logicalCount,
    hasOverflowPages,
    canApply: !issues.some((issue) => issue.severity === 'blocking'),
    issues,
    updates,
  };
};

export const syncOverflowChainMetadata = async (
  startingSubsplashId: string,
  token: string
): Promise<void> => {
  listDebugLog('listOverflowChain.syncOverflowChainMetadata.start', {
    startingSubsplashId,
  });
  const startingRecord = await getStoredListRecordBySubsplashId(startingSubsplashId);
  if (!startingRecord) {
    listDebugLog('listOverflowChain.syncOverflowChainMetadata.skipMissingStartingRecord', {
      startingSubsplashId,
    });
    return;
  }

  const issues: GetListOverflowChainIssue[] = [];
  const rootRecord = await resolveRootRecord(startingRecord, issues);

  await collapseEmptyTailOverflowPages(rootRecord, token);

  const latestRootRecord = (await getStoredListRecordById(rootRecord.id)) ?? rootRecord;
  const chain = await getStoredChainNodesFromRoot(latestRootRecord);
  if (chain.length === 0) {
    listDebugLog('listOverflowChain.syncOverflowChainMetadata.skipEmptyChain', {
      startingSubsplashId,
      rootListId: rootRecord.id,
    });
    return;
  }

  const rootListId = chain[0].record.id;
  const rootName = getListName(chain[0].record);
  const counts = await Promise.all(
    chain.map(async (node) => {
      const subsplashId = normalizeString(node.record.data.subsplashId);
      return subsplashId ? getContentRowCount(subsplashId, token) : 0;
    })
  );
  const logicalCount = counts.reduce((sum, count) => sum + count, 0);
  const hasOverflowPages = chain.length > 1;
  const now = Date.now();
  const batch = firestore.batch();

  chain.forEach((node, index) => {
    const metadata =
      node.depth === 0
        ? buildRootListMetadata({
            rootListId,
            logicalCount,
            hasOverflowPages,
          })
        : buildOverflowListMetadata({
            rootListId,
            overflowDepth: node.depth,
          });

    const nextName =
      node.depth === 0
        ? getListName(node.record)
        : buildOverflowListTitle(rootName);

    batch.set(
      firestore.collection('lists').doc(node.record.id),
      {
        ...metadata,
        count: counts[index],
        name: nextName,
        updatedAtMillis: now,
      },
      { merge: true }
    );
  });

  await batch.commit();
  listDebugLog('listOverflowChain.syncOverflowChainMetadata.complete', {
    startingSubsplashId,
    rootListId,
    rootName,
    logicalCount,
    hasOverflowPages,
    counts,
    chain: chain.map(({ record, depth }) => ({
      firestoreListId: record.id,
      subsplashId: record.data.subsplashId,
      depth,
    })),
  });
};

export const syncOverflowChainNames = async (
  startingSubsplashId: string,
  rootName: string,
  token: string
): Promise<void> => {
  const startingRecord = await getStoredListRecordBySubsplashId(startingSubsplashId);
  if (!startingRecord) {
    return;
  }

  const issues: GetListOverflowChainIssue[] = [];
  const rootRecord = await resolveRootRecord(startingRecord, issues);
  const chain = await getStoredChainNodesFromRoot(rootRecord);
  const batch = firestore.batch();
  const now = Date.now();

  batch.set(
    firestore.collection('lists').doc(rootRecord.id),
    {
      name: rootName,
      updatedAtMillis: now,
    },
    { merge: true }
  );

  for (const node of chain) {
    if (node.depth === 0) {
      continue;
    }

    const canonicalTitle = buildOverflowListTitle(rootName);
    const subsplashId = normalizeString(node.record.data.subsplashId);
    if (subsplashId) {
      await patchSubsplashListTitle(subsplashId, canonicalTitle, token);
    }

    batch.set(
      firestore.collection('lists').doc(node.record.id),
      {
        ...buildOverflowListMetadata({
          rootListId: rootRecord.id,
          overflowDepth: node.depth,
        }),
        name: canonicalTitle,
        updatedAtMillis: now,
      },
      { merge: true }
    );
  }

  await batch.commit();
};

export { getCanonicalOverflowListName };
