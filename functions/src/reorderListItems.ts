import { randomUUID } from 'node:crypto';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import type {
  ListItemOrderEntry,
  ReorderListItemsAssignment,
  ReorderListItemsInputType,
  ReorderListItemsOutputType,
} from '../../packages/contracts/reorderListItems';
import { firestoreAdminListConverter } from './firestoreDataConverter';
import { createListRow, getFullListRows, getListDetails, patchListRows } from './helpers/addToListHelpers';
import { getOverflowChainState } from './helpers/listOverflowChain';
import handleError from './handleError';
import { withIdempotency } from './locks/withIdempotency';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import { authenticateSubsplash } from './subsplashUtils';
import { SubsplashListRow } from './types/Subsplash';

const firestoreDB = firebaseAdmin.firestore();

const getRowMediaItemId = (row: SubsplashListRow): string | undefined => {
  if (row.type !== 'media-item') {
    return undefined;
  }

  return row._embedded?.['media-item']?.id;
};

type ChainRemoteNode = {
  firestoreListId: string;
  subsplashListId: string;
  overflowDepth: number;
  maxItemCount: number;
  remoteRows: SubsplashListRow[];
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

const normalizeLogicalOrder = (logicalItemOrder: ListItemOrderEntry[]): ListItemOrderEntry[] => {
  const seenMediaItemIds = new Set<string>();

  logicalItemOrder.forEach(({ mediaItemId, position }) => {
    if (!mediaItemId || !mediaItemId.trim()) {
      throw new HttpsError('invalid-argument', 'Each logicalItemOrder entry must include a mediaItemId.');
    }

    if (!Number.isInteger(position) || position < 1) {
      throw new HttpsError(
        'invalid-argument',
        'Each logicalItemOrder entry must include a positive integer position.'
      );
    }

    if (seenMediaItemIds.has(mediaItemId)) {
      throw new HttpsError('invalid-argument', `Duplicate mediaItemId ${mediaItemId} in logicalItemOrder.`);
    }

    seenMediaItemIds.add(mediaItemId);
  });

  return [...logicalItemOrder].sort((left, right) => left.position - right.position);
};

const getRemoteMediaRows = (nodes: ChainRemoteNode[]): SubsplashListRow[] =>
  nodes.flatMap((node) =>
    node.remoteRows.filter((row) => {
      if (row.type === 'list') {
        return false;
      }

      if (!getRowMediaItemId(row)) {
        throw new HttpsError(
          'failed-precondition',
          `List ${node.firestoreListId} contains non-media rows that cannot be reordered safely.`
        );
      }

      return true;
    })
  );

const validateLogicalOrderAgainstRemoteRows = (
  sortedLogicalItemOrder: ListItemOrderEntry[],
  remoteMediaRowsById: Map<string, SubsplashListRow>
): void => {
  if (sortedLogicalItemOrder.length !== remoteMediaRowsById.size) {
    throw new HttpsError(
      'failed-precondition',
      'Logical reorder payload must include every synced media item in the overflow chain.'
    );
  }

  sortedLogicalItemOrder.forEach(({ mediaItemId }) => {
    if (!remoteMediaRowsById.has(mediaItemId)) {
      throw new HttpsError(
        'failed-precondition',
        `Cannot reorder media item ${mediaItemId}; it does not exist in the logical overflow chain.`
      );
    }
  });
};

const partitionLogicalRowsAcrossChain = (
  sortedRemoteRows: SubsplashListRow[],
  nodes: ChainRemoteNode[]
): Array<{
  node: ChainRemoteNode;
  rows: SubsplashListRow[];
}> => {
  let cursor = 0;

  return nodes.map((node, index) => {
    const remainingRows = sortedRemoteRows.length - cursor;
    const remainingNodes = nodes.length - index;
    const isTerminalNode = index === nodes.length - 1;
    const maxContentRows = isTerminalNode ? node.maxItemCount : node.maxItemCount - 1;
    const minimumRowsNeededForLaterPages = isTerminalNode ? 0 : remainingNodes - 1;
    const rowCount = isTerminalNode
      ? remainingRows
      : Math.min(maxContentRows, Math.max(1, remainingRows - minimumRowsNeededForLaterPages));
    const rows = sortedRemoteRows.slice(cursor, cursor + rowCount);

    if (rows.length > maxContentRows) {
      throw new HttpsError(
        'failed-precondition',
        `List ${node.firestoreListId} does not have enough capacity to preserve the existing overflow chain.`
      );
    }

    if (rows.length === 0 && remainingRows > 0) {
      throw new HttpsError(
        'failed-precondition',
        `List ${node.firestoreListId} does not have enough capacity to preserve the existing overflow chain.`
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
  partitions: ReturnType<typeof partitionLogicalRowsAcrossChain>
): ReorderListItemsAssignment[] =>
  partitions.flatMap(({ node, rows }) =>
    rows.map((row, index) => ({
      mediaItemId: getRowMediaItemId(row)!,
      firestoreListId: node.firestoreListId,
      subsplashListId: node.subsplashListId,
      overflowDepth: node.overflowDepth,
      position: index + 1,
    }))
  );

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

  const nextRows = partition.rows.map((row) => {
    const sourceListId = row._embedded?.['source-list']?.id;
    if (sourceListId === partition.node.subsplashListId) {
      return { ...row };
    }

    return createListRow(
      {
        id: getRowMediaItemId(row)!,
        type: 'media-item',
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
            const remoteNodes = await Promise.all(
              chainState.nodes.map(async (node) => {
                const subsplashListId = node.subsplashId?.trim();
                if (!subsplashListId) {
                  throw new HttpsError(
                    'failed-precondition',
                    `List ${node.firestoreListId} is not linked to Subsplash and cannot be reordered remotely.`
                  );
                }

                const [listDetails, remoteRows] = await Promise.all([
                  getListDetails(subsplashListId, token),
                  getFullListRows(subsplashListId, token),
                ]);

                return {
                  firestoreListId: node.firestoreListId,
                  subsplashListId,
                  overflowDepth: node.depth,
                  maxItemCount: listDetails.max_item_count,
                  remoteRows,
                } satisfies ChainRemoteNode;
              })
            );

            const remoteMediaRows = getRemoteMediaRows(remoteNodes);
            const remoteRowsByMediaItemId = new Map(
              remoteMediaRows.map((row) => [getRowMediaItemId(row)!, row])
            );

            validateLogicalOrderAgainstRemoteRows(sortedLogicalItemOrder, remoteRowsByMediaItemId);

            const sortedRemoteRows = sortedLogicalItemOrder.map(({ mediaItemId }) => ({
              ...remoteRowsByMediaItemId.get(mediaItemId)!,
            }));

            const partitions = partitionLogicalRowsAcrossChain(sortedRemoteRows, remoteNodes);
            const assignments = createAssignments(partitions);

            for (let index = 0; index < partitions.length; index += 1) {
              const partition = partitions[index];
              const nextNode = remoteNodes[index + 1];
              await patchListRows(
                partition.node.subsplashListId,
                buildPatchedRowsForNode(partition, nextNode),
                token
              );
            }

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
      throw handleError(error);
    }
  }
);

export default reorderListItems;
