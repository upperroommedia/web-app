import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import CollectionsIcon from '@mui/icons-material/Collections';
import Divider from '@mui/material/Divider';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PendingIcon from '@mui/icons-material/Pending';
import SaveIcon from '@mui/icons-material/Save';
import Typography from '@mui/material/Typography';
import UndoIcon from '@mui/icons-material/Undo';
import { alpha, useTheme } from '@mui/material/styles';
import {
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { Modifier } from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import {
  GetListOverflowChainInputType,
  GetListOverflowChainOutputType,
  GetListOverflowChainRemoteItem,
} from '@upperroom/contracts/getListOverflowChain';
import type {
  MarkListOverflowLinkInputType,
  MarkListOverflowLinkOutputType,
} from '@upperroom/contracts/markListOverflowLink';
import type {
  GetListPublishedDriftInputType,
  GetListPublishedDriftOutputType,
  PublishedListDriftIssue,
} from '@upperroom/contracts/getListPublishedDrift';
import {
  ReorderListItemsAssignment,
  ReorderListItemsInputType,
  ReorderListItemsOutputType,
} from '@upperroom/contracts/reorderListItems';
import AvatarWithDefaultImage from '../../../components/AvatarWithDefaultImage';
import OverflowChainPanel from '../../../components/admin/lists/OverflowChainPanel';
import useAuth from '../../../context/user/UserContext';
import firestore, {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  writeBatch,
  updateDoc,
  where,
  type Unsubscribe,
} from '../../../firebase/firestore';
import AppLayout from '../../../layout/AppLayout';
import { listConverter, List } from '../../../types/List';
import { listUploadStatus, sermonListConverter } from '../../../types/SermonList';
import { sermonConverter } from '../../../types/Sermon';
import { Sermon, uploadStatus } from '../../../types/SermonTypes';
import type { ImageType } from '../../../types/Image';
import { createOperationKey } from '../../../utils/callableConcurrency';
import { createFunctionV2 } from '../../../utils/createFunction';
import {
  buildListOverflowChainView,
  ListOverflowChainView,
  ListOverflowChainViewItem,
  sortListOverflowChainSourceItems,
} from '../../../utils/lists/listOverflowChainView';

type ListDetailItem = Sermon & {
  rowId?: string;
  rowType?: string;
  rowMethod?: string;
  isTrackedInFirebase?: boolean;
  isSubsplashOnlyPlaceholder?: boolean;
  reconstructible?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canRemove?: boolean;
  isListRow?: boolean;
  isOverflowLink?: boolean;
  isOverflowCandidate?: boolean;
  linkedListId?: string;
  linkedListTitle?: string;
  position?: number;
  uploadStatus?: listUploadStatus;
};

export type LoadListDetailsPageItem = ListDetailItem;
type ListPageItem = ListOverflowChainViewItem<LoadListDetailsPageItem>;

interface LoadListDetailsPageDependencies {
  listId: string;
  getListOverflowChain: (input: GetListOverflowChainInputType) => Promise<GetListOverflowChainOutputType>;
  getListPublishedDrift?: (input: GetListPublishedDriftInputType) => Promise<GetListPublishedDriftOutputType>;
  getListDoc: (rootListId: string) => Promise<List>;
  getRootItems: (rootListId: string) => Promise<LoadListDetailsPageItem[]>;
  replaceRoute: (href: string) => Promise<unknown> | unknown;
}

interface LoadListDetailsPageResult {
  redirected?: boolean;
  list?: List;
  chainView?: ListOverflowChainView<LoadListDetailsPageItem>;
  items?: ListPageItem[];
  publishedDrift?: GetListPublishedDriftOutputType | null;
}

const inFlightListDetailsLoads = new Map<string, Promise<LoadListDetailsPageResult>>();

interface SortableItemProps {
  item: ListPageItem;
  index: number;
  onOpenSermon: (id: string) => void;
  onMarkOverflow?: (item: ListPageItem) => void;
  dragDisabled?: boolean;
  overflowMarkDisabled?: boolean;
  overflowMarkLoading?: boolean;
  placementDirty?: boolean;
  showPhysicalPlacement?: boolean;
}

interface PersistListDetailsPageOrderDependencies {
  rootListId: string;
  rootSubsplashId?: string;
  items: ListPageItem[];
  chainView: ListOverflowChainView<ListDetailItem> | null;
  publishedDrift?: GetListPublishedDriftOutputType | null;
  reorderListItems: (input: ReorderListItemsInputType) => Promise<ReorderListItemsOutputType>;
}

interface SubscribeToListDetailsLiveUpdatesDependencies {
  rootListId: string;
  scheduleReload: () => void;
  reportError?: (error: unknown) => void;
  onSnapshotImpl?: typeof onSnapshot;
  docImpl?: typeof doc;
  collectionImpl?: typeof collection;
  collectionGroupImpl?: typeof collectionGroup;
  queryImpl?: typeof query;
  whereImpl?: typeof where;
}

const createGetListOverflowChain = createFunctionV2<
  GetListOverflowChainInputType,
  GetListOverflowChainOutputType
>('getlistoverflowchain');
const createGetListPublishedDrift = createFunctionV2<
  GetListPublishedDriftInputType,
  GetListPublishedDriftOutputType
>('getlistpublisheddrift');
const createMarkListOverflowLink = createFunctionV2<
  MarkListOverflowLinkInputType,
  MarkListOverflowLinkOutputType
>('marklistoverflowlink');
const createReorderListItems = createFunctionV2<ReorderListItemsInputType, ReorderListItemsOutputType>(
  'reorderlistitems'
);

const getErrorMessage = (error: unknown, fallbackMessage: string): string =>
  error instanceof Error && error.message ? error.message : fallbackMessage;

const cloneListItems = (items: ListPageItem[]): ListPageItem[] => items.map((item) => ({ ...item }));

const AUTO_RESOLUTION_BLOCKING_CODES = new Set<PublishedListDriftIssue['code']>([
  'REMOTE_ONLY_AMBIGUOUS_MATCH',
  'REMOTE_ONLY_UNSUPPORTED_TYPE',
  'REMOTE_ONLY_UNKNOWN_TYPE',
  'CONTINUATION_ROW_INVALID',
  'CHAIN_STRUCTURE_INVALID',
]);

const buildRemoteListPageItems = ({
  remoteItems,
  rootItems,
}: {
  remoteItems: GetListOverflowChainRemoteItem[];
  rootItems: LoadListDetailsPageItem[];
}): LoadListDetailsPageItem[] => {
  const rootItemById = new Map(rootItems.map((item) => [item.id, item]));
  const rootItemBySubsplashId = new Map(
    rootItems
      .filter((item): item is LoadListDetailsPageItem & { subsplashId: string } => Boolean(item.subsplashId))
      .map((item) => [item.subsplashId, item])
  );

  return remoteItems.map((remoteItem) => {
    const localItem =
      (remoteItem.matchedSermonId ? rootItemById.get(remoteItem.matchedSermonId) : undefined) ??
      (remoteItem.resourceId ? rootItemBySubsplashId.get(remoteItem.resourceId) : undefined);

    const remoteImage: ImageType | undefined = remoteItem.imageUrl
      ? {
        id: `remote-image-${remoteItem.rowId}`,
        size: 'original',
        type: (remoteItem.imageType === 'wide' || remoteItem.imageType === 'banner' ? remoteItem.imageType : 'square') as ImageType['type'],
        height: 0,
        width: 0,
        downloadLink: remoteItem.imageUrl,
        name: `Subsplash ${remoteItem.rowType}`,
        dateAddedMillis: 0,
        ...(remoteItem.imageAverageColorHex ? { averageColorHex: remoteItem.imageAverageColorHex } : {}),
      }
      : undefined;

    return {
      ...(localItem ?? {
        id: `remote-${remoteItem.rowId}`,
        title: remoteItem.title ?? `Subsplash ${remoteItem.rowType}`,
        subtitle: remoteItem.subtitle ?? '',
        description: '',
        speakers: [],
        dateMillis: 0,
        sourceStartTime: 0,
        durationSeconds: 0,
        topics: [],
        status: {
          subsplash: uploadStatus.UPLOADED,
          soundCloud: uploadStatus.NOT_UPLOADED,
          audioStatus: 'processed' as Sermon['status']['audioStatus'],
        },
        images: [],
        createdAtMillis: 0,
        editedAtMillis: 0,
      }),
      rowId: remoteItem.rowId,
      rowType: remoteItem.rowType,
      rowMethod: remoteItem.rowMethod,
      position: remoteItem.logicalPosition,
      subsplashId: remoteItem.resourceId,
      isTrackedInFirebase: remoteItem.isTrackedInFirebase,
      isSubsplashOnlyPlaceholder: remoteItem.isSubsplashOnlyPlaceholder,
      reconstructible: remoteItem.reconstructible,
      canEdit: remoteItem.canEdit,
      canDelete: remoteItem.canDelete,
      canRemove: remoteItem.canRemove,
      isListRow: remoteItem.isListRow,
      isOverflowLink: remoteItem.isOverflowLink,
      isOverflowCandidate: remoteItem.isOverflowCandidate,
      linkedListId: remoteItem.linkedListId,
      linkedListTitle: remoteItem.linkedListTitle,
      uploadStatus: localItem?.uploadStatus,
      physicalPlacement: remoteItem.placement,
      title: localItem?.title ?? remoteItem.title ?? `Subsplash ${remoteItem.rowType}`,
      subtitle: localItem?.subtitle ?? remoteItem.subtitle ?? '',
      images: localItem?.images?.length ? localItem.images : remoteImage ? [remoteImage] : [],
    } as LoadListDetailsPageItem;
  });
};

const getPreferredListItemImage = (images: ImageType[] | undefined): ImageType | undefined => {
  if (!images || images.length === 0) {
    return undefined;
  }

  return (
    images.find((image) => image.type === 'square') ??
    images.find((image) => image.type === 'wide') ??
    images.find((image) => image.type === 'banner') ??
    images[0]
  );
};

export const canAutoResolvePublishedDrift = (
  publishedDrift?: GetListPublishedDriftOutputType | null
): boolean => {
  if (!publishedDrift || publishedDrift.inSync) {
    return false;
  }

  return !publishedDrift.issues.some(
    (issue) => issue.code !== 'IN_SYNC' && AUTO_RESOLUTION_BLOCKING_CODES.has(issue.code)
  );
};

export const getPublishedDriftIssueMessages = (
  publishedDrift?: GetListPublishedDriftOutputType | null
): string[] => {
  if (!publishedDrift || publishedDrift.inSync) {
    return [];
  }

  return [...new Set(publishedDrift.issues.filter((issue) => issue.code !== 'IN_SYNC').map((issue) => issue.message))];
};

export const getPublishedDriftWarningMessage = ({
  publishedDrift,
  ignored,
}: {
  publishedDrift?: GetListPublishedDriftOutputType | null;
  ignored: boolean;
}): string | undefined => {
  if (!publishedDrift || publishedDrift.inSync) {
    return undefined;
  }

  if (ignored) {
    return 'You chose to ignore the current Firebase/Subsplash mismatch for now. This list remains locked for reorder and overflow-causing publish until the mismatch is resolved.';
  }

  return 'Published sermons in Firebase do not match what Subsplash currently shows for this list. Review the mismatches below and either update Firebase to match Subsplash or ignore for now. Strict actions remain locked until the mismatch is resolved.';
};

export const isStrictListActionLocked = ({
  chainView,
  publishedDrift,
}: {
  chainView: ListOverflowChainView<ListDetailItem> | null;
  publishedDrift?: GetListPublishedDriftOutputType | null;
}): boolean => {
  if (chainView?.isReadOnly) {
    return true;
  }

  if (publishedDrift && !publishedDrift.canReorder) {
    return true;
  }

  return false;
};

const normalizeListItemPositions = (items: ListPageItem[]): ListPageItem[] =>
  items.map((item, index) => ({
    ...item,
    position: index + 1,
    logicalPosition: index + 1,
  }));

type CanonicalListMembershipStatus = {
  uploadStatus?: listUploadStatus;
};

export const mergeRootItemsWithCanonicalMemberships = ({
  items,
  canonicalMembershipBySermonId,
}: {
  items: LoadListDetailsPageItem[];
  canonicalMembershipBySermonId: Map<string, CanonicalListMembershipStatus>;
}): LoadListDetailsPageItem[] =>
  items.map((item) => {
    const canonicalMembership = canonicalMembershipBySermonId.get(item.id);
    if (!canonicalMembership?.uploadStatus) {
      return item;
    }

    return {
      ...item,
      uploadStatus: canonicalMembership.uploadStatus,
    };
  });

export const getPhysicalListTagLabel = (item: Pick<ListPageItem, 'sourceDepth'>): string =>
  item.sourceDepth <= 0 ? 'Root page' : `Overflow ${item.sourceDepth}`;

const resolveAssignmentForItem = (
  item: Pick<ListPageItem, 'rowId' | 'subsplashId'>,
  assignments: ReorderListItemsAssignment[]
): ReorderListItemsAssignment | undefined => {
  if (item.rowId) {
    const assignmentByRowId = assignments.find((assignment) => assignment.rowId === item.rowId);
    if (assignmentByRowId) {
      return assignmentByRowId;
    }
  }

  if (item.subsplashId) {
    return assignments.find((assignment) => assignment.mediaItemId === item.subsplashId);
  }

  return undefined;
};

const buildFirestoreOrderUpdatePlan = ({
  rootListId,
  items,
  assignments,
}: {
  rootListId: string;
  items: ListPageItem[];
  assignments: ReorderListItemsAssignment[];
}) => {
  return items
    .filter((item) => item.isTrackedInFirebase !== false)
    .map((item, index) => {
      const rowAssignment = resolveAssignmentForItem(item, assignments);
      const targetListId = rowAssignment?.firestoreListId ?? item.sourceListId ?? rootListId;

      return {
        item,
        sourceListId: item.sourceListId ?? rootListId,
        targetListId,
        logicalPosition: index + 1,
      };
    });
};

const syncFirestoreListItemsOrder = async ({
  rootListId,
  items,
  assignments,
}: {
  rootListId: string;
  items: ListPageItem[];
  assignments: ReorderListItemsAssignment[];
}): Promise<void> => {
  const batch = writeBatch(firestore);
  const updatePlan = buildFirestoreOrderUpdatePlan({ rootListId, items, assignments });

  updatePlan.forEach(({ item, targetListId, logicalPosition }) => {
    const assignment = resolveAssignmentForItem(item, assignments);
    const physicalPlacement =
      assignment
        ? {
          firestoreListId: targetListId,
          subsplashListId: assignment.subsplashListId,
          overflowDepth: assignment.overflowDepth,
          position: assignment.position,
        }
        : undefined;

    batch.set(
      doc(firestore, 'lists', rootListId, 'listItems', item.id),
      {
        position: logicalPosition,
        ...(physicalPlacement ? { physicalPlacement } : {}),
      },
      { merge: true }
    );
  });

  await batch.commit();
};

export const applyReorderAssignmentsToItems = ({
  items,
  assignments,
  chainView,
}: {
  items: ListPageItem[];
  assignments: ReorderListItemsAssignment[];
  chainView: ListOverflowChainView<ListDetailItem>;
}): ListPageItem[] => {
  const nodeByFirestoreListId = new Map(chainView.nodes.map((node) => [node.firestoreListId, node]));

  return normalizeListItemPositions(
    items.map((item) => {
      const assignment = resolveAssignmentForItem(item, assignments);
      if (!assignment) {
        return item;
      }

      const assignedNode =
        nodeByFirestoreListId.get(assignment.firestoreListId) ??
        chainView.nodes.find((node) => node.isRoot) ??
        chainView.nodes[0];

      return {
        ...item,
        physicalPlacement: {
          firestoreListId: assignment.firestoreListId,
          subsplashListId: assignment.subsplashListId,
          overflowDepth: assignment.overflowDepth,
          position: assignment.position,
        },
        sourceListId: assignment.firestoreListId,
        sourceListName: assignedNode?.name ?? item.sourceListName,
        sourceDepth: assignment.overflowDepth,
      };
    })
  );
};

export const persistListDetailsPageOrder = async ({
  rootListId,
  rootSubsplashId,
  items,
  chainView,
  publishedDrift,
  reorderListItems,
}: PersistListDetailsPageOrderDependencies): Promise<ListPageItem[]> => {
  if (!chainView || chainView.canSaveOrder === false || (publishedDrift && !publishedDrift.canReorder)) {
    return items;
  }

  if (!rootSubsplashId) {
    await Promise.all(
      items.map((item, index) =>
        updateDoc(doc(firestore, 'lists', rootListId, 'listItems', item.id), {
          position: index + 1,
        })
      )
    );
    return normalizeListItemPositions(items);
  }

  const itemsMissingRemoteRowId = items.filter(
    (item) => !item.rowId && !item.subsplashId
  );

  if (itemsMissingRemoteRowId.length > 0) {
    throw new Error('One or more remote rows are missing row IDs. Refresh and try again.');
  }

  const reorderResult =
    items.length > 0
      ? await reorderListItems({
        rootListId,
        logicalItemOrder: items.map((item, index) => ({
          ...(item.rowId ? { rowId: item.rowId } : {}),
          ...(item.subsplashId ? { mediaItemId: item.subsplashId } : {}),
          position: index + 1,
        })),
        operationKey: createOperationKey('list-admin-reorder', rootListId),
      })
      : {
        status: 'success' as const,
        message: 'No remote items to reorder.',
        rootListId,
        subsplashListId: rootSubsplashId,
        assignments: [],
      };

  if (reorderResult.status !== 'success') {
    throw new Error(reorderResult.message || 'Subsplash reorder failed.');
  }

  await syncFirestoreListItemsOrder({
    rootListId,
    items,
    assignments: reorderResult.assignments,
  });

  return applyReorderAssignmentsToItems({
    items,
    assignments: reorderResult.assignments,
    chainView,
  });
};

export const subscribeToListDetailsLiveUpdates = ({
  rootListId,
  scheduleReload,
  reportError,
  onSnapshotImpl = onSnapshot,
  docImpl = doc,
  collectionImpl = collection,
  collectionGroupImpl = collectionGroup,
  queryImpl = query,
  whereImpl = where,
}: SubscribeToListDetailsLiveUpdatesDependencies): Unsubscribe => {
  let sawInitialListSnapshot = false;
  let sawInitialItemsSnapshot = false;
  let sawInitialCanonicalSnapshot = false;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;

  const allInitialSnapshotsSeen = () =>
    sawInitialListSnapshot && sawInitialItemsSnapshot && sawInitialCanonicalSnapshot;

  const queueReload = () => {
    if (reloadTimer) {
      return;
    }

    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      scheduleReload();
    }, 0);
  };

  const handleError = (error: unknown) => {
    console.error('List details live update subscription failed', error);
    reportError?.(error);
  };

  const unsubscribeList = onSnapshotImpl(
    docImpl(firestore, 'lists', rootListId),
    () => {
      if (!sawInitialListSnapshot) {
        sawInitialListSnapshot = true;
        return;
      }
      if (!allInitialSnapshotsSeen()) {
        return;
      }
      queueReload();
    },
    handleError
  );

  const unsubscribeItems = onSnapshotImpl(
    collectionImpl(firestore, 'lists', rootListId, 'listItems'),
    () => {
      if (!sawInitialItemsSnapshot) {
        sawInitialItemsSnapshot = true;
        return;
      }
      if (!allInitialSnapshotsSeen()) {
        return;
      }
      queueReload();
    },
    handleError
  );

  const unsubscribeCanonicalMemberships = onSnapshotImpl(
    queryImpl(collectionGroupImpl(firestore, 'sermonLists'), whereImpl('id', '==', rootListId)),
    () => {
      if (!sawInitialCanonicalSnapshot) {
        sawInitialCanonicalSnapshot = true;
        return;
      }
      if (!allInitialSnapshotsSeen()) {
        return;
      }
      queueReload();
    },
    handleError
  );

  return () => {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }
    unsubscribeList();
    unsubscribeItems();
    unsubscribeCanonicalMemberships();
  };
};

const formatListType = (value?: string): string => {
  if (!value) {
    return 'List';
  }

  return value
    .split('-')
    .map((segment) => `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`)
    .join(' ');
};

const SortableListSermonItem = ({
  item,
  index,
  onOpenSermon,
  onMarkOverflow,
  dragDisabled = false,
  overflowMarkDisabled = false,
  overflowMarkLoading = false,
  placementDirty = false,
  showPhysicalPlacement = false,
}: SortableItemProps) => {
  const theme = useTheme();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: dragDisabled });
  const isSyncedToList = item.uploadStatus?.status === uploadStatus.UPLOADED;
  const isPlaceholder = item.isTrackedInFirebase === false;
  const speakerNames = item.speakers?.map((speaker) => speaker.name).filter(Boolean).join(', ');
  const physicalListTagLabel = getPhysicalListTagLabel(item);
  const isDarkMode = theme.palette.mode === 'dark';
  const placeholderBackground = isDarkMode
    ? alpha(theme.palette.common.black, 0.18)
    : alpha(theme.palette.common.black, 0.03);
  const firebaseRowBackground = isDarkMode ? alpha(theme.palette.common.white, 0.03) : 'background.paper';
  const firebaseRowHoverBackground = isDarkMode ? alpha(theme.palette.common.white, 0.06) : 'action.hover';
  const placeholderBorder = isDarkMode
    ? alpha(theme.palette.common.white, 0.09)
    : alpha(theme.palette.common.black, 0.08);
  const placeholderPrimaryText = alpha(theme.palette.text.primary, 0.4);
  const placeholderSecondaryText = isDarkMode
    ? alpha(theme.palette.text.secondary, 0.82)
    : alpha(theme.palette.text.secondary, 0.6);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : 0,
    position: 'relative' as const,
  };

  const handleRowClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button,a,[role="button"],[data-no-row-nav="true"]')) {
      return;
    }
    if (item.isTrackedInFirebase === false) {
      return;
    }

    onOpenSermon(item.id);
  };

  return (
    <Box
      ref={setNodeRef}
      style={style}
      onClick={handleRowClick}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: { xs: 1.25, sm: 1.5 },
        p: { xs: 1.25, sm: 1.5 },
        cursor: isPlaceholder ? 'default' : 'pointer',
        bgcolor: isPlaceholder ? placeholderBackground : isDragging ? 'action.selected' : firebaseRowBackground,
        boxShadow: isDragging ? 4 : 0,
        borderLeft: `3px solid ${placeholderBorder}`,
        transition: 'background-color 0.15s ease',
        '&:hover': {
          bgcolor: isPlaceholder
            ? placeholderBackground
            : isDragging
              ? 'action.selected'
              : firebaseRowHoverBackground,
        },
      }}
    >
      <Box
        {...attributes}
        {...listeners}
        data-no-row-nav="true"
        sx={{
          display: 'flex',
          alignItems: 'center',
          cursor: dragDisabled ? 'default' : isDragging ? 'grabbing' : 'grab',
          color: 'text.disabled',
          touchAction: 'none',
          '&:hover': { color: 'text.secondary' },
        }}
      >
        <DragIndicatorIcon />
      </Box>

      <Typography
        variant="body2"
        sx={{
          width: { xs: 24, sm: 32 },
          textAlign: 'center',
          color: 'text.secondary',
          fontWeight: 600,
          fontSize: '0.75rem',
        }}
      >
        {index + 1}
      </Typography>

      <AvatarWithDefaultImage
        image={getPreferredListItemImage(item.images)}
        altName={item.title || 'Sermon'}
        width={44}
        height={44}
        borderRadius={6}
        sx={{ flexShrink: 0 }}
      />

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="subtitle2"
          sx={{
            fontWeight: 600,
            color: isPlaceholder ? placeholderPrimaryText : 'text.primary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.title || `Sermon ${item.id}`}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mt: 0.5 }}>
          {item.dateString ? (
            <Typography variant="caption" color={isPlaceholder ? placeholderSecondaryText : 'text.secondary'}>
              {item.dateString}
            </Typography>
          ) : null}
          {speakerNames ? (
            <Typography variant="caption" color={isPlaceholder ? placeholderSecondaryText : 'text.secondary'}>
              {speakerNames}
            </Typography>
          ) : null}
          {item.rowType && item.rowType !== 'media-item' ? (
            <Typography variant="caption" color={isPlaceholder ? placeholderSecondaryText : 'text.secondary'}>
              {formatListType(item.rowType)}
            </Typography>
          ) : null}
        </Box>
      </Box>

      <Chip
        icon={isSyncedToList ? <CheckCircleIcon /> : <PendingIcon />}
        label={isPlaceholder ? 'Subsplash only' : isSyncedToList ? 'Synced' : 'Local only'}
        color={isSyncedToList ? 'success' : isPlaceholder ? 'warning' : 'default'}
        size="small"
        variant={isSyncedToList || isPlaceholder ? 'filled' : 'outlined'}
        sx={
          isPlaceholder
            ? {
              flexShrink: 0,
              color: isDarkMode
                ? alpha(theme.palette.warning.light, 0.95)
                : theme.palette.warning.dark,
              borderColor: alpha(theme.palette.warning.main, isDarkMode ? 0.3 : 0.2),
              bgcolor: alpha(theme.palette.warning.main, isDarkMode ? 0.14 : 0.12),
            }
            : { flexShrink: 0 }
        }
      />
      {showPhysicalPlacement ? (
        <Chip
          label={physicalListTagLabel}
          size="small"
          color={placementDirty ? 'default' : 'info'}
          variant={placementDirty ? 'outlined' : 'filled'}
          title={item.sourceListName}
          sx={{ flexShrink: 0 }}
        />
      ) : null}
      {item.isOverflowCandidate && item.linkedListId ? (
        <Button
          size="small"
          variant="outlined"
          data-no-row-nav="true"
          onClick={() => onMarkOverflow?.(item)}
          disabled={overflowMarkDisabled || overflowMarkLoading}
          sx={{ flexShrink: 0, textTransform: 'none' }}
        >
          {overflowMarkLoading ? (
            <CircularProgress size={14} />
          ) : (
            `Mark as overflow list ${item.sourceDepth + 1}`
          )}
        </Button>
      ) : null}
    </Box>
  );
};

export const loadListDetailsPageData = async ({
  listId,
  getListOverflowChain,
  getListDoc,
  getRootItems,
  replaceRoute,
}: LoadListDetailsPageDependencies): Promise<LoadListDetailsPageResult> => {
  const chainState = await getListOverflowChain({ listId });

  if (chainState.redirectListId && chainState.redirectListId !== listId) {
    await replaceRoute(`/admin/lists/${chainState.redirectListId}`);
    return {
      redirected: true,
    };
  }

  const [listData, rootItems] = await Promise.all([
    getListDoc(chainState.rootListId),
    getRootItems(chainState.rootListId),
  ]);

  const displayItems = chainState.remoteItems && chainState.remoteItems.length > 0
    ? buildRemoteListPageItems({ remoteItems: chainState.remoteItems, rootItems })
    : rootItems;
  const chainView = buildListOverflowChainView(chainState, {
    [chainState.rootListId]: displayItems,
  });
  const items = normalizeListItemPositions(chainView.items);

  return {
    list: listData,
    chainView: {
      ...chainView,
      items,
    },
    items,
    publishedDrift: null,
  };
};

const loadListDetailsPageDataSingleFlight = (
  key: string,
  dependencies: LoadListDetailsPageDependencies
): Promise<LoadListDetailsPageResult> => {
  const existingLoad = inFlightListDetailsLoads.get(key);
  if (existingLoad) {
    return existingLoad;
  }

  const nextLoad = loadListDetailsPageData(dependencies).finally(() => {
    if (inFlightListDetailsLoads.get(key) === nextLoad) {
      inFlightListDetailsLoads.delete(key);
    }
  });
  inFlightListDetailsLoads.set(key, nextLoad);
  return nextLoad;
};

const ListDetailsPage = () => {
  const router = useRouter();
  const theme = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const originalItemsRef = useRef<ListPageItem[]>([]);
  const listId = typeof router.query.listId === 'string' ? router.query.listId : '';
  const [list, setList] = useState<List | null>(null);
  const [items, setItems] = useState<ListPageItem[]>([]);
  const [chainView, setChainView] = useState<ListOverflowChainView<ListDetailItem> | null>(null);
  const [publishedDrift, setPublishedDrift] = useState<GetListPublishedDriftOutputType | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [markingOverflowRowId, setMarkingOverflowRowId] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [isAdvancedDebugOpen, setIsAdvancedDebugOpen] = useState(false);
  const [isPublishedDriftExpanded, setIsPublishedDriftExpanded] = useState(false);
  const [isPublishedDriftLoading, setIsPublishedDriftLoading] = useState(false);
  const [visibleItemsCount, setVisibleItemsCount] = useState(200);

  useEffect(() => {
    if (!router.isReady || !listId) {
      return;
    }

    let cancelled = false;

    const loadListDetails = async () => {
      setIsLoading(true);

      try {
        const result = await loadListDetailsPageDataSingleFlight(
          `${listId}:${reloadNonce}`,
          {
            listId,
            getListOverflowChain: createGetListOverflowChain,
            getListDoc: async (rootListId) => {
              const rootListRef = doc(firestore, 'lists', rootListId).withConverter(listConverter);
              const listSnapshot = await getDoc(rootListRef);

              if (!listSnapshot.exists()) {
                throw new Error('List not found.');
              }

              return listSnapshot.data();
            },
            getRootItems: async (rootListId) => {
              const listItemsRef = collection(
                firestore,
                'lists',
                rootListId,
                'listItems'
              ).withConverter(sermonConverter);
              const canonicalMembershipSnapshot = await getDocs(
                query(collectionGroup(firestore, 'sermonLists').withConverter(sermonListConverter), where('id', '==', rootListId))
              );
              const canonicalMembershipBySermonId = new Map<string, CanonicalListMembershipStatus>();
              canonicalMembershipSnapshot.docs.forEach((membershipDoc) => {
                const sermonId = membershipDoc.ref.parent.parent?.id;
                if (!sermonId) {
                  return;
                }
                canonicalMembershipBySermonId.set(sermonId, {
                  uploadStatus: membershipDoc.data().uploadStatus,
                });
              });
              const listItemsSnapshot = await getDocs(listItemsRef);

              return mergeRootItemsWithCanonicalMemberships({
                items: sortListOverflowChainSourceItems(
                  listItemsSnapshot.docs.map((itemDoc) => {
                    const data = itemDoc.data() as Partial<ListDetailItem>;
                    const derivedUploadStatus =
                      data.uploadStatus ??
                      (data.subsplashId
                        ? ({ status: uploadStatus.UPLOADED } as listUploadStatus)
                        : undefined);

                    return {
                      ...data,
                      id: itemDoc.id,
                      uploadStatus: derivedUploadStatus,
                    } as ListDetailItem;
                  })
                ),
                canonicalMembershipBySermonId,
              });
            },
            replaceRoute: (href) => router.replace(href),
          }
        );

        if (cancelled) {
          return;
        }

        if (result.redirected) {
          return;
        }

        setList(result.list ?? null);
        setChainView(result.chainView ?? null);
        setItems(result.items ?? []);
        setPublishedDrift(result.publishedDrift ?? null);
        originalItemsRef.current = cloneListItems(result.items ?? []);
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load list details', error);
          alert(getErrorMessage(error, 'Failed to load list details.'));
          setList(null);
          setChainView(null);
          setItems([]);
          setPublishedDrift(null);
          originalItemsRef.current = [];
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadListDetails();

    return () => {
      cancelled = true;
    };
  }, [listId, reloadNonce, router]);

  useEffect(() => {
    const rootListId = chainView?.rootListId;
    if (!rootListId) {
      return;
    }

    return subscribeToListDetailsLiveUpdates({
      rootListId,
      scheduleReload: () => setReloadNonce((value) => value + 1),
    });
  }, [chainView?.rootListId]);

  useEffect(() => {
    setVisibleItemsCount(200);
  }, [items.length, listId]);

  useEffect(() => {
    setIsPublishedDriftExpanded(false);
  }, [listId, publishedDrift?.rootListId, publishedDrift?.inSync]);

  useEffect(() => {
    if (!isAdvancedDebugOpen || !list?.subsplashId || !chainView?.rootListId || publishedDrift || isPublishedDriftLoading) {
      return;
    }

    let cancelled = false;

    const loadPublishedDrift = async () => {
      setIsPublishedDriftLoading(true);

      try {
        const nextPublishedDrift = await createGetListPublishedDrift({ listId: chainView.rootListId });
        if (!cancelled) {
          setPublishedDrift(nextPublishedDrift);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load published drift diagnostics', error);
          alert(getErrorMessage(error, 'Failed to load published drift diagnostics.'));
        }
      } finally {
        if (!cancelled) {
          setIsPublishedDriftLoading(false);
        }
      }
    };

    void loadPublishedDrift();

    return () => {
      cancelled = true;
    };
  }, [chainView?.rootListId, isAdvancedDebugOpen, isPublishedDriftLoading, list?.subsplashId, publishedDrift]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const restrictToContainer: Modifier = ({ transform, draggingNodeRect }) => {
    if (!containerRef.current || !draggingNodeRect) {
      return transform;
    }

    const containerRect = containerRef.current.getBoundingClientRect();
    const minY = containerRect.top - draggingNodeRect.top;
    const maxY = containerRect.bottom - draggingNodeRect.bottom;

    return {
      ...transform,
      y: Math.min(Math.max(transform.y, minY), maxY),
    };
  };

  const hasOrderChanges =
    items.length !== originalItemsRef.current.length ||
    items.some((item, index) => item.id !== originalItemsRef.current[index]?.id);

  const syncedItemsCount = items.filter((item) => item.isTrackedInFirebase !== false).length;
  const localOnlyItemsCount = items.filter((item) => item.isSubsplashOnlyPlaceholder).length;
  const hasOverflowPages = (chainView?.nodes.length ?? 0) > 1;
  const isReadOnlySurface = isStrictListActionLocked({ chainView, publishedDrift });
  const publishedDriftIssueMessages = getPublishedDriftIssueMessages(publishedDrift);
  const publishedDriftWarningMessage = getPublishedDriftWarningMessage({
    publishedDrift,
    ignored: false,
  });
  const totalItemsCount = items.length;
  const renderedItems = items.slice(0, visibleItemsCount);
  const hasMoreVisibleItems = renderedItems.length < items.length;
  const subsplashListUrl = list?.subsplashId
    ? `https://dashboard.subsplash.com/-d/#/library/lists/standard/${list.subsplashId}`
    : undefined;

  const handleDragEnd = (event: DragEndEvent) => {
    if (isReadOnlySurface) {
      return;
    }

    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    setItems((previousItems) => {
      const oldIndex = previousItems.findIndex((item) => item.id === active.id);
      const newIndex = previousItems.findIndex((item) => item.id === over.id);

      return normalizeListItemPositions(arrayMove(previousItems, oldIndex, newIndex));
    });
  };

  const revertOrder = () => {
    setItems(cloneListItems(originalItemsRef.current));
  };

  const saveOrderChanges = async () => {
    if (!list || !hasOrderChanges || isReadOnlySurface || chainView?.canSaveOrder === false) {
      return;
    }

    const previousItems = cloneListItems(originalItemsRef.current);
    setIsSaving(true);

    try {
      const persistedItems = await persistListDetailsPageOrder({
        rootListId: chainView?.rootListId ?? listId,
        rootSubsplashId: list.subsplashId,
        items,
        chainView,
        publishedDrift,
        reorderListItems: createReorderListItems,
      });

      setItems(cloneListItems(persistedItems));
      originalItemsRef.current = cloneListItems(persistedItems);
    } catch (error) {
      console.error('Failed to save list order', error);
      setItems(previousItems);
      alert(getErrorMessage(error, 'Failed to save list order. The view was reset to the last synced order.'));
    } finally {
      setIsSaving(false);
    }
  };

  const markOverflowLink = async (item: ListPageItem) => {
    if (!chainView || !item.rowId) {
      return;
    }

    setMarkingOverflowRowId(item.rowId);
    try {
      await createMarkListOverflowLink({
        rootListId: chainView.rootListId,
        physicalFirestoreListId: item.sourceListId,
        rowId: item.rowId,
      });
      setReloadNonce((value) => value + 1);
    } catch (error) {
      console.error('Failed to mark overflow list row', error);
      alert(getErrorMessage(error, 'Failed to mark this list row as the overflow page.'));
    } finally {
      setMarkingOverflowRowId(null);
    }
  };

  const title = list?.name || listId || 'List Details';

  return (
    <>
      <Head>
        <title>{title}</title>
        <meta property="og:title" content={title} key="title" />
        <meta
          name="description"
          content={`Manage sermons in the ${title} list.`}
          key="description"
        />
      </Head>

      <Box sx={{ maxWidth: 1200, mx: 'auto', px: { xs: 2, sm: 3 }, py: { xs: 3, sm: 4 } }}>
        <Box sx={{ mb: 3 }}>
          <Box>
            <Breadcrumbs separator={<NavigateNextIcon fontSize="small" />} sx={{ mb: 1 }}>
              <Link href="/admin/lists">Lists</Link>
              <Typography color="text.primary">{title}</Typography>
            </Breadcrumbs>
            <Typography variant="h4" fontWeight={700}>
              {title}
            </Typography>
          </Box>
        </Box>

        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}>
            <CircularProgress />
          </Box>
        ) : !list ? (
          <Alert severity="error">This list could not be loaded.</Alert>
        ) : (
          <>
            <Card
              sx={{
                position: 'relative',
                overflow: 'hidden',
                mb: 3,
                border: `1px solid ${alpha(theme.palette.primary.main, 0.14)}`,
                boxShadow: `0 16px 40px ${alpha(theme.palette.common.black, 0.08)}`,
                '&::before': {
                  content: '""',
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  height: 4,
                  background: `linear-gradient(90deg, ${theme.palette.primary.main} 0%, ${theme.palette.primary.light} 100%)`,
                },
              }}
            >
              <CardContent sx={{ p: { xs: 2, sm: 3, md: 4 } }}>
                <Box
                  sx={{
                    display: 'flex',
                    flexDirection: { xs: 'column', sm: 'row' },
                    gap: { xs: 2, sm: 3, md: 4 },
                  }}
                >
                  <AvatarWithDefaultImage
                    image={list.images?.find((image) => image.type === 'square')}
                    altName={list.name}
                    width={140}
                    height={140}
                    borderRadius={12}
                    sx={{
                      flexShrink: 0,
                      boxShadow: 3,
                      alignSelf: { xs: 'center', sm: 'flex-start' },
                    }}
                  />

                  <Box sx={{ flex: 1 }}>
                    <Typography variant="h6" color="text.secondary" sx={{ mb: 1, fontWeight: 400 }}>
                      {formatListType(list.type)}
                    </Typography>

                    <Box
                      sx={{
                        display: 'flex',
                        flexDirection: { xs: 'column', sm: 'row' },
                        justifyContent: 'space-between',
                        gap: 2,
                        pt: 2,
                        borderTop: 1,
                        borderColor: 'divider',
                      }}
                    >
                      <Box sx={{ display: 'flex', gap: 4 }}>
                        <Box>
                          <Typography variant="h5" fontWeight={700} color="primary.main">
                            {totalItemsCount}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            Total Items
                          </Typography>
                        </Box>
                        <Box>
                          <Typography variant="h5" fontWeight={700} color="success.main">
                            {syncedItemsCount}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            Synced
                          </Typography>
                        </Box>
                      </Box>

                      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: { xs: 'flex-start', sm: 'flex-end' }, gap: 1 }}>
                        {list.subsplashId ? (
                          <Chip
                            icon={<CheckCircleIcon />}
                            label="Connected to Subsplash"
                            color="success"
                            size="small"
                          />
                        ) : (
                          <Chip
                            icon={<PendingIcon />}
                            label="Local only"
                            color="warning"
                            size="small"
                          />
                        )}
                        {subsplashListUrl ? (
                          <Button
                            component="a"
                            href={subsplashListUrl}
                            target="_blank"
                            rel="noreferrer"
                            size="small"
                            endIcon={<OpenInNewIcon sx={{ fontSize: 14 }} />}
                            sx={{
                              minWidth: 0,
                              px: 0,
                              py: 0,
                              textTransform: 'none',
                              color: 'warning.main',
                              fontWeight: 600,
                              '&:hover': {
                                bgcolor: 'transparent',
                                color: 'warning.dark',
                              },
                            }}
                          >
                            Open in Subsplash
                          </Button>
                        ) : null}
                        {localOnlyItemsCount > 0 ? (
                          <Chip
                            label={`${localOnlyItemsCount} Subsplash only`}
                            variant="outlined"
                            size="small"
                            color="warning"
                          />
                        ) : null}
                      </Box>
                    </Box>
                  </Box>
                </Box>
              </CardContent>
            </Card>

            {chainView?.warningMessage ? (
              <Alert severity="warning" sx={{ mb: 3 }}>
                {chainView.warningMessage}
              </Alert>
            ) : null}

            {chainView ? (
              <Accordion
                disableGutters
                expanded={isAdvancedDebugOpen}
                onChange={(_event, expanded) => setIsAdvancedDebugOpen(expanded)}
                sx={{
                  mb: 2.5,
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 1,
                  boxShadow: 'none',
                  overflow: 'hidden',
                  '&::before': {
                    display: 'none',
                  },
                }}
              >
                <AccordionSummary
                  expandIcon={<ExpandMoreIcon />}
                  aria-controls="advanced-debug-content"
                  id="advanced-debug-header"
                  sx={{
                    minHeight: 0,
                    px: 1.5,
                    py: 0.25,
                    bgcolor: alpha(theme.palette.info.main, 0.04),
                    '& .MuiAccordionSummary-content': {
                      my: 0.75,
                    },
                  }}
                >
                  <Box>
                    <Typography variant="subtitle2" fontWeight={600}>
                      Advanced Debug
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Overflow chain diagnostics and physical page mapping.
                    </Typography>
                  </Box>
                </AccordionSummary>
                <AccordionDetails sx={{ p: 2 }}>
                  {hasOverflowPages && !chainView.warningMessage ? (
                    <Alert severity="info" sx={{ mb: 2 }}>
                      This root detail page now saves one logical order for the whole overflow chain and remaps
                      Subsplash page boundaries behind the scenes.
                    </Alert>
                  ) : null}
                  {isPublishedDriftLoading ? (
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1,
                        mb: 2,
                        color: 'text.secondary',
                      }}
                    >
                      <CircularProgress size={16} />
                      <Typography variant="body2">Loading published drift diagnostics…</Typography>
                    </Box>
                  ) : null}
                  {publishedDriftWarningMessage ? (
                    <Box
                      sx={{
                        mb: 2,
                        border: 1,
                        borderColor: alpha(theme.palette.warning.main, 0.24),
                        bgcolor: alpha(theme.palette.warning.main, 0.08),
                        borderRadius: 1,
                        overflow: 'hidden',
                      }}
                    >
                      <Box
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 1.5,
                          px: 1.5,
                          py: 1.25,
                        }}
                      >
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {publishedDriftWarningMessage}
                        </Typography>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Button color="inherit" size="small" variant="outlined" disabled>
                            Firebase Sync Disabled
                          </Button>
                          <Button
                            size="small"
                            color="warning"
                            onClick={() => setIsPublishedDriftExpanded((value) => !value)}
                            endIcon={
                              <ExpandMoreIcon
                                sx={{
                                  transform: isPublishedDriftExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                                  transition: 'transform 0.2s ease',
                                }}
                              />
                            }
                          >
                            {isPublishedDriftExpanded ? 'Hide Details' : 'Show Details'}
                          </Button>
                        </Box>
                      </Box>
                      {isPublishedDriftExpanded && publishedDriftIssueMessages.length > 0 ? (
                        <Box sx={{ px: 1.5, pb: 1.5 }}>
                          <Box component="ul" sx={{ pl: 2.5, mb: 0 }}>
                            {publishedDriftIssueMessages.map((message) => (
                              <Box component="li" key={message}>
                                <Typography variant="body2">{message}</Typography>
                              </Box>
                            ))}
                          </Box>
                        </Box>
                      ) : null}
                    </Box>
                  ) : null}
                  <OverflowChainPanel nodes={chainView.nodes} />
                </AccordionDetails>
              </Accordion>
            ) : null}

            <Box
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', sm: 'row' },
                justifyContent: 'space-between',
                alignItems: { xs: 'flex-start', sm: 'center' },
                gap: 2,
                mb: 3,
              }}
            >
              <Typography variant="h5" fontWeight={600}>
                List Sermons
              </Typography>

              <Box sx={{ display: 'flex', gap: 1.5 }}>
                <Button
                  variant="outlined"
                  color="inherit"
                  startIcon={<UndoIcon />}
                  onClick={revertOrder}
                  disabled={isSaving || isReadOnlySurface || !hasOrderChanges}
                >
                  Revert
                </Button>
                <Button
                  variant="contained"
                  color="primary"
                  startIcon={isSaving ? <CircularProgress size={18} color="inherit" /> : <SaveIcon />}
                  onClick={saveOrderChanges}
                  disabled={isSaving || isReadOnlySurface || !hasOrderChanges}
                >
                  Save Order
                </Button>
              </Box>
            </Box>

            {items.length === 0 ? (
              <Card
                sx={{
                  textAlign: 'center',
                  py: 6,
                  px: 3,
                  border: '2px dashed',
                  borderColor: 'divider',
                  bgcolor: 'transparent',
                }}
              >
                <CollectionsIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 2 }} />
                <Typography variant="h6" color="text.secondary" gutterBottom>
                  No sermons in this list yet
                </Typography>
                <Typography variant="body2" color="text.disabled">
                  Add sermons to the list, then return here to fine-tune the order.
                </Typography>
              </Card>
            ) : (
              <Card ref={containerRef} sx={{ overflow: 'hidden' }}>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  modifiers={[restrictToVerticalAxis, restrictToContainer]}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext items={renderedItems.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                    {renderedItems.map((item, index) => (
                      <Box key={item.id}>
                        <SortableListSermonItem
                          item={item}
                          index={index}
                          dragDisabled={isReadOnlySurface || item.reconstructible === false}
                          overflowMarkDisabled={
                            hasOrderChanges ||
                            Boolean(
                              chainView?.nodes.find((node) => node.firestoreListId === item.sourceListId)
                                ?.nextSubsplashListId
                            )
                          }
                          overflowMarkLoading={markingOverflowRowId === item.rowId}
                          placementDirty={hasOrderChanges}
                          showPhysicalPlacement={isAdvancedDebugOpen}
                          onMarkOverflow={markOverflowLink}
                          onOpenSermon={(sermonId) => {
                            void router.push(`/admin/sermons/${sermonId}`);
                          }}
                        />
                        {index < renderedItems.length - 1 ? <Divider /> : null}
                      </Box>
                    ))}
                  </SortableContext>
                </DndContext>
              </Card>
            )}
            {hasMoreVisibleItems ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                <Button variant="outlined" onClick={() => setVisibleItemsCount((value) => value + 200)}>
                  Load More
                </Button>
              </Box>
            ) : null}
          </>
        )}
      </Box>
    </>
  );
};

const ProtectedListDetailsPage = () => {
  const { user } = useAuth();

  if (!user?.isAdmin()) {
    return null;
  }

  return <ListDetailsPage />;
};

ProtectedListDetailsPage.PageLayout = AppLayout;

export default ProtectedListDetailsPage;
