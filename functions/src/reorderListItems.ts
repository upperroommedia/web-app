import { randomUUID } from 'node:crypto';
import axios from 'axios';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import type {
  ListItemOrderEntry,
  ReorderListItemsAssignment,
  ReorderListItemsInputType,
  ReorderListItemsOutputType,
} from '../../packages/contracts/reorderListItems';
import { firestoreAdminListConverter } from './firestoreDataConverter';
import { createListRow, getFullListRows, patchListRows } from './helpers/addToListHelpers';
import { getOverflowChainState } from './helpers/listOverflowChain';
import { ensureCanPerformStrictPublishedMutation } from './helpers/publishedListDrift';
import {
  canReconstructRemoteRow,
  countLogicalContentRows,
  getRemoteRowResourceId,
  getLogicalContentRows,
} from './helpers/remoteChainItems';
import {
  listDebugError,
  listDebugLog,
  summarizeAssignments,
  summarizeOverflowIssues,
  summarizeOverflowNodes,
  summarizeSubsplashRows,
} from './helpers/listDebugLogger';
import handleError from './handleError';
import { withIdempotency } from './locks/withIdempotency';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import { SubsplashListRow, type SubsplashMediaType } from './types/Subsplash';

const firestoreDB = firebaseAdmin.firestore();

type ChainRemoteNode = {
  firestoreListId: string;
  subsplashListId: string;
  overflowDepth: number;
  currentItemCount: number;
  remoteRows: SubsplashListRow[];
};

type RemoteContentRow = {
  row: SubsplashListRow;
  rowId: string;
  resourceId?: string;
};

type NormalizedListItemOrderEntry = ListItemOrderEntry & {
  rowId: string;
  usedLegacyMediaItemId: boolean;
};

const getBlockingIssuesMessage = (
  rootListId: string,
  issues: Awaited<ReturnType<typeof getOverflowChainState>>['issues']
): string => {
  const blockingIssues = issues.filter((issue) => issue.severity === 'blocking');
  if (blockingIssues.length === 0) {
    return `List ${rootListId} cannot be safely reordered.`;
  }

  return `List ${rootListId} cannot be safely reordered: ${blockingIssues
    .map((issue) => issue.code)
    .join(', ')}.`;
};

const normalizeLogicalOrder = (logicalItemOrder: ListItemOrderEntry[]): NormalizedListItemOrderEntry[] => {
  const seenRowIds = new Set<string>();

  const normalized = logicalItemOrder.map((entry) => {
    const rowId = entry.rowId?.trim() || entry.mediaItemId?.trim();
    if (!rowId) {
      throw new HttpsError('invalid-argument', 'Each logicalItemOrder entry must include a rowId.');
    }

    if (!Number.isInteger(entry.position) || entry.position < 1) {
      throw new HttpsError(
        'invalid-argument',
        'Each logicalItemOrder entry must include a positive integer position.'
      );
    }

    if (seenRowIds.has(rowId)) {
      throw new HttpsError('invalid-argument', `Duplicate rowId ${rowId} in logicalItemOrder.`);
    }

    seenRowIds.add(rowId);
    return {
      ...entry,
      rowId,
      usedLegacyMediaItemId: !entry.rowId && Boolean(entry.mediaItemId),
    };
  });

  return normalized.sort((left, right) => left.position - right.position);
};

const getRemoteContentRows = (nodes: ChainRemoteNode[]): RemoteContentRow[] =>
  nodes.flatMap((node, nodeIndex) =>
    getLogicalContentRows({
      rows: node.remoteRows,
      expectedNextSubsplashListId: nodes[nodeIndex + 1]?.subsplashListId,
    }).map((row) => ({
      row,
      rowId: row.id as string,
      resourceId: getRemoteRowResourceId(row),
    }))
  );

const validateLogicalOrderAgainstRemoteRows = (
  sortedLogicalItemOrder: NormalizedListItemOrderEntry[],
  remoteRowsById: Map<string, RemoteContentRow>,
  remoteRowsByMediaItemId: Map<string, RemoteContentRow>
): void => {
  if (sortedLogicalItemOrder.length !== remoteRowsById.size) {
    throw new HttpsError(
      'failed-precondition',
      'Logical reorder payload must include every remote content row in the overflow chain.'
    );
  }

  sortedLogicalItemOrder.forEach(({ rowId, mediaItemId }) => {
    const matchingRow = remoteRowsById.get(rowId) ?? (mediaItemId ? remoteRowsByMediaItemId.get(mediaItemId) : undefined);
    if (!matchingRow) {
      throw new HttpsError(
        'failed-precondition',
        `Cannot reorder row ${rowId}; it does not exist in the logical overflow chain.`
      );
    }
  });
};

const partitionLogicalRowsAcrossChain = (
  sortedRemoteRows: RemoteContentRow[],
  nodes: ChainRemoteNode[]
): Array<{
  node: ChainRemoteNode;
  rows: RemoteContentRow[];
}> => {
  let cursor = 0;

  return nodes.map((node) => {
    const rowCount = node.currentItemCount;
    const rows = sortedRemoteRows.slice(cursor, cursor + rowCount);

    if (rows.length !== rowCount) {
      throw new HttpsError(
        'failed-precondition',
        `List ${node.firestoreListId} could not preserve its existing logical page size during reorder.`
      );
    }

    cursor += rows.length;

    return {
      node,
      rows,
    };
  });
};

const createAssignments = (
  partitions: ReturnType<typeof partitionLogicalRowsAcrossChain>,
  options?: {
    includeRowId?: boolean;
  }
): ReorderListItemsAssignment[] =>
  partitions.flatMap(({ node, rows }) =>
    rows.map((row, index) => ({
      ...(options?.includeRowId ? { rowId: row.rowId } : {}),
      ...(row.row.type === 'media-item' && row.resourceId ? { mediaItemId: row.resourceId } : {}),
      firestoreListId: node.firestoreListId,
      subsplashListId: node.subsplashListId,
      overflowDepth: node.overflowDepth,
      position: index + 1,
    }))
  );

const ensureMovedRowsAreReconstructible = (
  partitions: ReturnType<typeof partitionLogicalRowsAcrossChain>
): void => {
  partitions.forEach(({ node, rows }) => {
    rows.forEach((row) => {
      const sourceListId = row.row._embedded?.['source-list']?.id;
      if (sourceListId === node.subsplashListId) {
        return;
      }

      if (!canReconstructRemoteRow(row.row) || !row.resourceId) {
        throw new HttpsError(
          'failed-precondition',
          `Row ${row.rowId} cannot be moved across overflow pages because Subsplash did not provide a reconstructible resource identity.`
        );
      }
    });
  });
};

const buildPatchedRowsForNode = (
  partition: ReturnType<typeof partitionLogicalRowsAcrossChain>[number],
  nextNode: ChainRemoteNode | undefined
): SubsplashListRow[] => {
  const nextListId = nextNode?.subsplashListId;
  const existingLinkRow = nextListId
    ? partition.node.remoteRows.find(
        (row) => row.type === 'list' && row._embedded.list?.id === nextListId
      )
    : undefined;

  const nextRows = partition.rows.map(({ row, resourceId }) => {
    const sourceListId = row._embedded?.['source-list']?.id;
    if (sourceListId === partition.node.subsplashListId) {
      return { ...row };
    }

    return createListRow(
      {
        id: resourceId!,
        type: row.type as SubsplashMediaType,
      },
      partition.node.subsplashListId,
      0
    );
  });
  if (!nextListId) {
    return nextRows;
  }

  nextRows.push(
    existingLinkRow
      ? { ...existingLinkRow }
      : createListRow({ id: nextListId, type: 'list' }, partition.node.subsplashListId, nextRows.length + 1)
  );

  return nextRows;
};

const deleteRowsMissingFromTarget = async (
  node: ChainRemoteNode,
  targetRows: SubsplashListRow[],
  token: string
): Promise<void> => {
  const targetRowIds = new Set(
    targetRows
      .map((row) => row.id?.trim())
      .filter((rowId): rowId is string => Boolean(rowId))
  );

  const rowsToDelete = node.remoteRows.filter((row) => row.id && !targetRowIds.has(row.id));

  for (const row of rowsToDelete) {
    const deleteConfig = createAxiosConfig(
      `https://core.subsplash.com/builder/v1/list-rows/${row.id}`,
      token,
      'DELETE'
    );
    await axios(deleteConfig);
  }
};

const reorderListItems = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<ReorderListItemsInputType>): Promise<ReorderListItemsOutputType> => {
    listDebugLog('reorderListItems.callable.start', {
      uid: request.auth?.uid,
      rootListId: request.data?.rootListId,
      logicalItemOrder: request.data?.logicalItemOrder,
      operationKey: request.data?.operationKey,
    });

    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError(
        'unauthenticated',
        'The function must be called while authenticated with publish permissions.'
      );
    }

    const { rootListId, logicalItemOrder, operationKey } = request.data;

    if (!rootListId || !rootListId.trim()) {
      throw new HttpsError('invalid-argument', 'rootListId is required.');
    }

    if (!Array.isArray(logicalItemOrder)) {
      throw new HttpsError('invalid-argument', 'logicalItemOrder must be an array.');
    }

    const normalizedRootListId = rootListId.trim();
    const normalizedOperationKey =
      operationKey?.trim() || `reorder-list-items:${normalizedRootListId}:${randomUUID()}`;

    try {
      return await withIdempotency(normalizedOperationKey, async () => {
        const listDoc = await firestoreDB
          .collection('lists')
          .doc(normalizedRootListId)
          .withConverter(firestoreAdminListConverter)
          .get();

        if (!listDoc.exists) {
          throw new HttpsError('not-found', `List with firestoreId ${normalizedRootListId} not found.`);
        }

        const listData = listDoc.data()!;
        const rootSubsplashListId = listData.subsplashId;
        if (!rootSubsplashListId) {
          throw new HttpsError(
            'failed-precondition',
            `List ${normalizedRootListId} is not linked to Subsplash and cannot be reordered remotely.`
          );
        }

        const chainState = await getOverflowChainState(normalizedRootListId);
        listDebugLog('reorderListItems.chainState', {
          rootListId: normalizedRootListId,
          canMutate: chainState.canMutate,
          nodes: summarizeOverflowNodes(chainState.nodes),
          issues: summarizeOverflowIssues(chainState.issues),
        });
        if (chainState.rootListId !== normalizedRootListId) {
          throw new HttpsError(
            'failed-precondition',
            `List ${normalizedRootListId} is not the logical root for this overflow chain.`
          );
        }

        if (!chainState.canMutate) {
          throw new HttpsError(
            'failed-precondition',
            getBlockingIssuesMessage(normalizedRootListId, chainState.issues)
          );
        }

        const sortedLogicalItemOrder = normalizeLogicalOrder(logicalItemOrder);
        listDebugLog('reorderListItems.logicalOrder.normalized', {
          rootListId: normalizedRootListId,
          logicalItemOrder: sortedLogicalItemOrder,
        });

        return withSubsplashLocks(
          chainState.nodes
            .map((node) => node.subsplashId?.trim())
            .filter((value): value is string => Boolean(value))
            .map((subsplashListId) => `list:${subsplashListId}`),
          async () => {
            if (sortedLogicalItemOrder.length === 0) {
              return {
                status: 'success',
                message: 'No items to reorder.',
                rootListId: normalizedRootListId,
                subsplashListId: rootSubsplashListId,
                assignments: [],
              };
            }

            const token = await authenticateSubsplash();
            listDebugLog('reorderListItems.strictPreflight.start', {
              rootListId: normalizedRootListId,
              action: 'reorder',
            });
            await ensureCanPerformStrictPublishedMutation(normalizedRootListId, token, 'reorder');
            listDebugLog('reorderListItems.strictPreflight.success', {
              rootListId: normalizedRootListId,
            });
            const remoteNodes = await Promise.all(
              chainState.nodes.map(async (node, nodeIndex) => {
                const subsplashListId = node.subsplashId?.trim();
                if (!subsplashListId) {
                  throw new HttpsError(
                    'failed-precondition',
                    `List ${node.firestoreListId} is not linked to Subsplash and cannot be reordered remotely.`
                  );
                }

                const remoteRows = await getFullListRows(subsplashListId, token);
                const currentItemCount = countLogicalContentRows({
                  rows: remoteRows,
                  expectedNextSubsplashListId: chainState.nodes[nodeIndex + 1]?.subsplashId?.trim(),
                });

                return {
                  firestoreListId: node.firestoreListId,
                  subsplashListId,
                  overflowDepth: node.depth,
                  currentItemCount,
                  remoteRows,
                } satisfies ChainRemoteNode;
              })
            );
            listDebugLog('reorderListItems.remoteNodes.loaded', {
              rootListId: normalizedRootListId,
              remoteNodes: remoteNodes.map((node) => ({
                ...node,
                remoteRows: summarizeSubsplashRows(node.remoteRows),
              })),
            });

            const remoteContentRows = getRemoteContentRows(remoteNodes);
            const remoteRowsById = new Map(remoteContentRows.map((row) => [row.rowId, row]));
            const remoteRowsByMediaItemId = new Map(
              remoteContentRows
                .filter((row): row is RemoteContentRow & { resourceId: string } => Boolean(row.resourceId))
                .map((row) => [row.resourceId, row])
            );

            validateLogicalOrderAgainstRemoteRows(sortedLogicalItemOrder, remoteRowsById, remoteRowsByMediaItemId);

            const sortedRemoteRows = sortedLogicalItemOrder.map(({ rowId, mediaItemId }) => {
              const remoteRow = remoteRowsById.get(rowId) ?? (mediaItemId ? remoteRowsByMediaItemId.get(mediaItemId) : undefined);
              if (!remoteRow) {
                throw new HttpsError(
                  'failed-precondition',
                  `Cannot reorder row ${rowId}; it does not exist in the logical overflow chain.`
                );
              }

              return { ...remoteRow };
            });

            const partitions = partitionLogicalRowsAcrossChain(sortedRemoteRows, remoteNodes);
            ensureMovedRowsAreReconstructible(partitions);
            const assignments = createAssignments(partitions, {
              includeRowId: sortedLogicalItemOrder.some((entry) => !entry.usedLegacyMediaItemId),
            });
            listDebugLog('reorderListItems.partitions.created', {
              rootListId: normalizedRootListId,
              partitions: partitions.map((partition) => ({
                node: partition.node.firestoreListId,
                subsplashListId: partition.node.subsplashListId,
                rows: summarizeSubsplashRows(partition.rows.map((row) => row.row)),
              })),
              assignments: summarizeAssignments(assignments),
            });

            for (let index = 0; index < partitions.length; index += 1) {
              const partition = partitions[index];
              const nextNode = remoteNodes[index + 1];
              const nextRows = buildPatchedRowsForNode(partition, nextNode);
              listDebugLog('reorderListItems.partition.apply.start', {
                rootListId: normalizedRootListId,
                firestoreListId: partition.node.firestoreListId,
                subsplashListId: partition.node.subsplashListId,
                nextNode: nextNode
                  ? {
                      firestoreListId: nextNode.firestoreListId,
                      subsplashListId: nextNode.subsplashListId,
                    }
                  : undefined,
                nextRows: summarizeSubsplashRows(nextRows),
              });
              await deleteRowsMissingFromTarget(partition.node, nextRows, token);
              await patchListRows(partition.node.subsplashListId, nextRows, token);
              listDebugLog('reorderListItems.partition.apply.complete', {
                rootListId: normalizedRootListId,
                firestoreListId: partition.node.firestoreListId,
                subsplashListId: partition.node.subsplashListId,
              });
            }

            listDebugLog('reorderListItems.success', {
              rootListId: normalizedRootListId,
              assignments: summarizeAssignments(assignments),
            });
            return {
              status: 'success',
              message: `Successfully reordered ${sortedLogicalItemOrder.length} items in list.`,
              rootListId: normalizedRootListId,
              subsplashListId: rootSubsplashListId,
              assignments,
            };
          },
          {
            operationKey: normalizedOperationKey,
          }
        );
      });
    } catch (error) {
      listDebugError('reorderListItems.callable.failed', {
        rootListId: request.data?.rootListId,
        operationKey: request.data?.operationKey,
        error,
      });
      throw handleError(error);
    }
  }
);

export default reorderListItems;
