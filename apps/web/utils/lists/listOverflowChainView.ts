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
  let logicalPosition = 1;

  const nodes: ListOverflowChainNodeView[] = chain.nodes.map((node) => {
    const localItems = itemsByListId[node.firestoreListId] ?? [];
    const localCount = localItems.length;
    const missingMirroredCount = Math.max(0, node.count - localCount);

    return {
      firestoreListId: node.firestoreListId,
      subsplashId: node.subsplashId,
      name: node.name,
      depth: node.depth,
      isRoot: node.isRoot,
      physicalCount: node.count,
      localCount,
      missingMirroredCount,
      hasCoverageGap: localCount !== node.count,
    };
  });

  const items = nodes.flatMap<ListOverflowChainViewItem<T>>((node) => {
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

  const boundaryMarkers: ListOverflowChainBoundaryMarker[] = nodes
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

  const hasCoverageGap = nodes.some((node) => node.hasCoverageGap);
  const hasAnyIssues = diagnostics.length > 0;
  const canSaveOrder = chain.canMutate && !hasAnyIssues;
  const isReadOnly = !canSaveOrder;
  const localMirroredCount = items.length;
  const expectedPhysicalCount = chain.logicalCount;

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
