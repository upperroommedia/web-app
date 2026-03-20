import type {
  GetListOverflowChainIssueSeverity,
  GetListOverflowChainOutputType,
} from '@upperroom/contracts/getListOverflowChain';

type SortableListItem = {
  id: string;
  title: string;
  position?: number;
  createdAtMillis?: number;
  dateMillis?: number;
  physicalPlacement?: {
    firestoreListId?: string;
    subsplashListId?: string;
    overflowDepth?: number;
    position?: number;
  };
};

export type ListOverflowChainViewItem<T extends SortableListItem> = T & {
  logicalPosition: number;
  sourceListId: string;
  sourceListName: string;
  sourceDepth: number;
};

export interface ListOverflowChainBoundaryMarker {
  sourceListId: string;
  sourceListName: string;
  sourceDepth: number;
  beforeItemId: string;
  localCount: number;
  physicalCount: number;
  missingMirroredCount: number;
}

export interface ListOverflowChainNodeView {
  firestoreListId: string;
  subsplashId?: string;
  nextSubsplashListId?: string | null;
  name: string;
  depth: number;
  isRoot: boolean;
  physicalCount: number;
  localCount: number;
  missingMirroredCount: number;
  hasCoverageGap: boolean;
}

export interface ListOverflowChainDiagnostic {
  code: string;
  severity: GetListOverflowChainIssueSeverity;
  message: string;
  firestoreListId?: string;
  subsplashListId?: string;
}

export interface ListOverflowChainView<T extends SortableListItem> {
  rootListId: string;
  items: ListOverflowChainViewItem<T>[];
  boundaryMarkers: ListOverflowChainBoundaryMarker[];
  nodes: ListOverflowChainNodeView[];
  diagnostics: ListOverflowChainDiagnostic[];
  canSaveOrder: boolean;
  canMutate: boolean;
  isReadOnly: boolean;
  hasCoverageGap: boolean;
  localMirroredCount: number;
  expectedPhysicalCount: number;
  warningMessage?: string;
}

export const sortListOverflowChainSourceItems = <T extends SortableListItem>(items: readonly T[]): T[] => {
  const allItemsHavePosition = items.length > 0 && items.every((item) => typeof item.position === 'number');

  return [...items].sort((left, right) => {
    if (allItemsHavePosition) {
      return (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER);
    }

    return (
      (right.createdAtMillis ?? 0) - (left.createdAtMillis ?? 0) ||
      (right.dateMillis ?? 0) - (left.dateMillis ?? 0) ||
      left.title.localeCompare(right.title)
    );
  });
};

export const buildListOverflowChainView = <T extends SortableListItem>(
  chain: GetListOverflowChainOutputType,
  itemsByListId: Record<string, readonly T[]>
): ListOverflowChainView<T> => {
  const rootLogicalItems = sortListOverflowChainSourceItems(itemsByListId[chain.rootListId] ?? []);
  const effectiveLogicalCount =
    Array.isArray(chain.remoteItems) && chain.remoteItems.length > 0 ? chain.remoteItems.length : chain.logicalCount;
  const nodeByFirestoreListId = new Map(chain.nodes.map((node) => [node.firestoreListId, node]));
  const hasExplicitPerNodeMirrors = chain.nodes.some((node) => {
    if (node.firestoreListId === chain.rootListId) {
      return false;
    }

    return (itemsByListId[node.firestoreListId] ?? []).length > 0;
  });

  const useRootLogicalProjection = !hasExplicitPerNodeMirrors && rootLogicalItems.length > 0;
  const rootProjectionUsesPhysicalPlacement =
    useRootLogicalProjection &&
    rootLogicalItems.length > 0 &&
    rootLogicalItems.every((item) => item.physicalPlacement?.firestoreListId);
  let logicalPosition = 1;

  const totalRootLogicalCount = rootLogicalItems.length;
  const rootProjectionFullyCoversChain = useRootLogicalProjection && totalRootLogicalCount === effectiveLogicalCount;
  const remoteItemsFullyCoverChain =
    Array.isArray(chain.remoteItems) &&
    chain.remoteItems.length === effectiveLogicalCount &&
    chain.remoteItems.every((item) => item.placement.firestoreListId);
  const placementCountsByNode = rootProjectionUsesPhysicalPlacement
    ? rootLogicalItems.reduce<Map<string, number>>((counts, item) => {
        const firestoreListId = item.physicalPlacement?.firestoreListId;
        if (!firestoreListId) {
          return counts;
        }

        counts.set(firestoreListId, (counts.get(firestoreListId) ?? 0) + 1);
        return counts;
      }, new Map<string, number>())
    : new Map<string, number>();
  const remotePlacementCountsByNode = remoteItemsFullyCoverChain
    ? chain.remoteItems!.reduce<Map<string, number>>((counts, item) => {
        counts.set(
          item.placement.firestoreListId,
          (counts.get(item.placement.firestoreListId) ?? 0) + 1
        );
        return counts;
      }, new Map<string, number>())
    : new Map<string, number>();

  const nodes: ListOverflowChainNodeView[] = chain.nodes.map((node, index) => {
    const localItems = itemsByListId[node.firestoreListId] ?? [];
    let localCount = localItems.length;
    let missingMirroredCount = Math.max(0, node.count - localCount);

    if (remoteItemsFullyCoverChain) {
      localCount = remotePlacementCountsByNode.get(node.firestoreListId) ?? 0;
      missingMirroredCount = 0;
    } else if (rootProjectionUsesPhysicalPlacement) {
      localCount = placementCountsByNode.get(node.firestoreListId) ?? 0;
      missingMirroredCount = 0;
    } else if (useRootLogicalProjection) {
      if (rootProjectionFullyCoversChain) {
        localCount = node.count;
        missingMirroredCount = 0;
      } else if (index === 0) {
        localCount = totalRootLogicalCount;
        missingMirroredCount = Math.max(0, node.count - localCount);
      } else {
        localCount = 0;
        missingMirroredCount = node.count;
      }
    }

    return {
      firestoreListId: node.firestoreListId,
      subsplashId: node.subsplashId,
      nextSubsplashListId: node.nextSubsplashListId,
      name: node.name,
      depth: node.depth,
      isRoot: node.isRoot,
      physicalCount: node.count,
      localCount,
      missingMirroredCount,
      hasCoverageGap: localCount !== node.count,
    };
  });

  const items = useRootLogicalProjection
    ? rootLogicalItems.map<ListOverflowChainViewItem<T>>((item, index) => {
        let matchingNode = nodes[nodes.length - 1];
        if (rootProjectionUsesPhysicalPlacement) {
          const placementListId = item.physicalPlacement?.firestoreListId;
          matchingNode =
            (placementListId ? nodes.find((node) => node.firestoreListId === placementListId) : undefined) ??
            matchingNode;
        } else {
          let runningPhysicalCount = 0;
          for (const node of nodes) {
            runningPhysicalCount += node.physicalCount;
            if (index < runningPhysicalCount) {
              matchingNode = node;
              break;
            }
          }
        }

        const nextItem: ListOverflowChainViewItem<T> = {
          ...item,
          logicalPosition,
          sourceListId: matchingNode.firestoreListId,
          sourceListName: matchingNode.name,
          sourceDepth: matchingNode.depth,
        };

        logicalPosition += 1;
        return nextItem;
      })
    : nodes.flatMap<ListOverflowChainViewItem<T>>((node) => {
        const localItems = sortListOverflowChainSourceItems(itemsByListId[node.firestoreListId] ?? []);

        return localItems.map((item) => {
          const nextItem: ListOverflowChainViewItem<T> = {
            ...item,
            logicalPosition,
            sourceListId: node.firestoreListId,
            sourceListName: node.name,
            sourceDepth: node.depth,
          };

          logicalPosition += 1;
          return nextItem;
        });
      });

  const boundaryMarkers: ListOverflowChainBoundaryMarker[] = rootProjectionUsesPhysicalPlacement
    ? items
        .map((item, index) => {
          if (index === 0) {
            return null;
          }

          const previousItem = items[index - 1];
          if (previousItem.sourceListId === item.sourceListId) {
            return null;
          }

          const node = nodeByFirestoreListId.get(item.sourceListId);
          if (!node || node.isRoot) {
            return null;
          }

          const localCount = placementCountsByNode.get(node.firestoreListId) ?? 0;

          return {
            sourceListId: node.firestoreListId,
            sourceListName: node.name,
            sourceDepth: node.depth,
            beforeItemId: item.id,
            localCount,
            physicalCount: node.count,
            missingMirroredCount: 0,
          };
        })
        .filter((value): value is ListOverflowChainBoundaryMarker => value !== null)
    : useRootLogicalProjection
    ? nodes
        .filter((node) => !node.isRoot)
        .map((node) => {
          const splitIndex = nodes
            .filter((candidate) => candidate.depth < node.depth)
            .reduce((sum, candidate) => sum + candidate.physicalCount, 0);
          const firstItem = items[splitIndex];
          if (!firstItem) {
            return null;
          }

          return {
            sourceListId: node.firestoreListId,
            sourceListName: node.name,
            sourceDepth: node.depth,
            beforeItemId: firstItem.id,
            localCount: node.localCount,
            physicalCount: node.physicalCount,
            missingMirroredCount: node.missingMirroredCount,
          };
        })
        .filter((value): value is ListOverflowChainBoundaryMarker => value !== null)
    : nodes
        .filter((node) => !node.isRoot && node.localCount > 0)
        .map((node) => {
          const firstItem = items.find((item) => item.sourceListId === node.firestoreListId);
          if (!firstItem) {
            return null;
          }

          return {
            sourceListId: node.firestoreListId,
            sourceListName: node.name,
            sourceDepth: node.depth,
            beforeItemId: firstItem.id,
            localCount: node.localCount,
            physicalCount: node.physicalCount,
            missingMirroredCount: node.missingMirroredCount,
          };
        })
        .filter((value): value is ListOverflowChainBoundaryMarker => value !== null);

  const diagnostics: ListOverflowChainDiagnostic[] = [...chain.issues];

  nodes.forEach((node) => {
    if (!node.hasCoverageGap) {
      return;
    }

    diagnostics.push({
      code: 'LOCAL_MIRROR_GAP',
      severity: 'warning',
      message: `${node.name} has ${node.localCount} mirrored list rows locally but ${node.physicalCount} physical items in the chain audit.`,
      firestoreListId: node.firestoreListId,
      subsplashListId: node.subsplashId,
    });
  });

  const hasCoverageGap = !remoteItemsFullyCoverChain && nodes.some((node) => node.hasCoverageGap);
  const hasBlockingIssues = diagnostics.some((diagnostic) => diagnostic.severity === 'blocking');
  const canSaveOrder = chain.canMutate && !hasBlockingIssues && !hasCoverageGap;
  const isReadOnly = !canSaveOrder;
  const localMirroredCount = items.length;
  const expectedPhysicalCount = effectiveLogicalCount;

  let warningMessage: string | undefined;
  if (isReadOnly) {
    const reasons: string[] = [];
    if (chain.issues.length > 0) {
      reasons.push('the overflow chain audit reported diagnostics');
    }
    if (hasCoverageGap) {
      reasons.push('local mirrored list rows do not fully cover the physical overflow chain');
    }

    warningMessage = reasons.length
      ? `This logical list is currently read-only because ${reasons.join(' and ')}.`
      : 'This logical list is currently read-only.';
  }

  return {
    rootListId: chain.rootListId,
    items,
    boundaryMarkers,
    nodes,
    diagnostics,
    canSaveOrder,
    canMutate: chain.canMutate,
    isReadOnly,
    hasCoverageGap,
    localMirroredCount,
    expectedPhysicalCount,
    warningMessage,
  };
};
