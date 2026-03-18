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
import PendingIcon from '@mui/icons-material/Pending';
import SaveIcon from '@mui/icons-material/Save';
import Typography from '@mui/material/Typography';
import UndoIcon from '@mui/icons-material/Undo';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
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
} from '@upperroom/contracts/getListOverflowChain';
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
import type {
  ResolveListPublishedDriftInputType,
  ResolveListPublishedDriftOutputType,
} from '@upperroom/contracts/resolveListPublishedDrift';
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
import { createOperationKey } from '../../../utils/callableConcurrency';
import { createFunctionV2 } from '../../../utils/createFunction';
import {
  buildListOverflowChainView,
  ListOverflowChainView,
  ListOverflowChainViewItem,
  sortListOverflowChainSourceItems,
} from '../../../utils/lists/listOverflowChainView';

type ListDetailItem = Sermon & {
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

interface SortableItemProps {
  item: ListPageItem;
  index: number;
  onOpenSermon: (id: string) => void;
  dragDisabled?: boolean;
  placementDirty?: boolean;
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
const createResolveListPublishedDrift = createFunctionV2<
  ResolveListPublishedDriftInputType,
  ResolveListPublishedDriftOutputType
>('resolvelistpublisheddrift');

const createReorderListItems = createFunctionV2<ReorderListItemsInputType, ReorderListItemsOutputType>(
  'reorderlistitems'
);

const getErrorMessage = (error: unknown, fallbackMessage: string): string =>
  error instanceof Error && error.message ? error.message : fallbackMessage;

const cloneListItems = (items: ListPageItem[]): ListPageItem[] => items.map((item) => ({ ...item }));

const AUTO_RESOLUTION_BLOCKING_CODES = new Set<PublishedListDriftIssue['code']>([
  'REMOTE_ONLY_AMBIGUOUS_MATCH',
  'REMOTE_ONLY_UNSUPPORTED_TYPE',
  'CONTINUATION_ROW_INVALID',
  'CHAIN_STRUCTURE_INVALID',
]);

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

const buildFirestoreOrderUpdatePlan = ({
  rootListId,
  items,
  assignments,
}: {
  rootListId: string;
  items: ListPageItem[];
  assignments: ReorderListItemsAssignment[];
}) => {
  const assignmentByMediaItemId = new Map(assignments.map((assignment) => [assignment.mediaItemId, assignment]));

  return items.map((item, index) => {
    const mediaAssignment =
      item.subsplashId && assignmentByMediaItemId.has(item.subsplashId)
        ? assignmentByMediaItemId.get(item.subsplashId)
        : undefined;
    const targetListId = mediaAssignment?.firestoreListId ?? item.sourceListId ?? rootListId;

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
    const assignment = assignments.find((entry) => entry.mediaItemId === item.subsplashId);
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
  const assignmentByMediaItemId = new Map(assignments.map((assignment) => [assignment.mediaItemId, assignment]));
  const nodeByFirestoreListId = new Map(chainView.nodes.map((node) => [node.firestoreListId, node]));

  return normalizeListItemPositions(
    items.map((item) => {
      const assignment = item.subsplashId ? assignmentByMediaItemId.get(item.subsplashId) : undefined;
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

  const syncedItemsMissingRemoteId = items.filter(
    (item) => item.uploadStatus?.status === uploadStatus.UPLOADED && !item.subsplashId
  );

  if (syncedItemsMissingRemoteId.length > 0) {
    throw new Error('One or more synced sermons are missing Subsplash IDs. Refresh and try again.');
  }

  const syncedItems = items.filter(
    (item) => item.uploadStatus?.status === uploadStatus.UPLOADED && item.subsplashId
  );

  const reorderResult =
    syncedItems.length > 0
      ? await reorderListItems({
        rootListId,
        logicalItemOrder: syncedItems.map((item, index) => ({
          mediaItemId: item.subsplashId as string,
          position: index + 1,
        })),
        operationKey: createOperationKey('list-admin-reorder', rootListId),
      })
      : {
        status: 'success' as const,
        message: 'No synced items to reorder.',
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
  dragDisabled = false,
  placementDirty = false,
}: SortableItemProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: dragDisabled });
  const isSyncedToList = item.uploadStatus?.status === uploadStatus.UPLOADED;
  const speakerNames = item.speakers?.map((speaker) => speaker.name).filter(Boolean).join(', ');
  const physicalListTagLabel = getPhysicalListTagLabel(item);

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
        gap: { xs: 1.5, sm: 2 },
        p: { xs: 2, sm: 2.5 },
        cursor: 'pointer',
        bgcolor: isDragging ? 'action.selected' : 'background.paper',
        boxShadow: isDragging ? 4 : 0,
        transition: 'background-color 0.15s ease',
        '&:hover': { bgcolor: isDragging ? 'action.selected' : 'action.hover' },
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
        image={item.images?.find((image) => image.type === 'square')}
        altName={item.title || 'Sermon'}
        width={56}
        height={56}
        borderRadius={8}
        sx={{ flexShrink: 0 }}
      />

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="subtitle2"
          sx={{
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.title || `Sermon ${item.id}`}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mt: 0.5 }}>
          {item.dateString ? (
            <Typography variant="caption" color="text.secondary">
              {item.dateString}
            </Typography>
          ) : null}
          {speakerNames ? (
            <Typography variant="caption" color="text.secondary">
              {speakerNames}
            </Typography>
          ) : null}
        </Box>
      </Box>

      <Chip
        icon={isSyncedToList ? <CheckCircleIcon /> : <PendingIcon />}
        label={isSyncedToList ? 'Synced' : 'Local only'}
        color={isSyncedToList ? 'success' : 'warning'}
        size="small"
        variant={isSyncedToList ? 'filled' : 'outlined'}
        sx={{ flexShrink: 0 }}
      />
      <Chip
        label={physicalListTagLabel}
        size="small"
        color={placementDirty ? 'default' : 'info'}
        variant={placementDirty ? 'outlined' : 'filled'}
        title={item.sourceListName}
        sx={{ flexShrink: 0 }}
      />
    </Box>
  );
};

export const loadListDetailsPageData = async ({
  listId,
  getListOverflowChain,
  getListPublishedDrift,
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
  const publishedDrift =
    listData.subsplashId && getListPublishedDrift
      ? await getListPublishedDrift({ listId: chainState.rootListId })
      : null;

  const chainView = buildListOverflowChainView(chainState, {
    [chainState.rootListId]: rootItems,
  });
  const items = normalizeListItemPositions(chainView.items);

  return {
    list: listData,
    chainView: {
      ...chainView,
      items,
    },
    items,
    publishedDrift,
  };
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
  const [publishedDriftIgnored, setPublishedDriftIgnored] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isResolvingPublishedDrift, setIsResolvingPublishedDrift] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!router.isReady || !listId) {
      return;
    }

    let cancelled = false;

    const loadListDetails = async () => {
      setIsLoading(true);

      try {
        const result = await loadListDetailsPageData({
          listId,
          getListOverflowChain: createGetListOverflowChain,
          getListPublishedDrift: createGetListPublishedDrift,
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
        });

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
        setPublishedDriftIgnored(false);
        originalItemsRef.current = cloneListItems(result.items ?? []);
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load list details', error);
          alert(getErrorMessage(error, 'Failed to load list details.'));
          setList(null);
          setChainView(null);
          setItems([]);
          setPublishedDrift(null);
          setPublishedDriftIgnored(false);
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

  const syncedItemsCount = items.filter((item) => item.uploadStatus?.status === uploadStatus.UPLOADED).length;
  const localOnlyItemsCount = items.length - syncedItemsCount;
  const hasOverflowPages = (chainView?.nodes.length ?? 0) > 1;
  const isReadOnlySurface = isStrictListActionLocked({ chainView, publishedDrift });
  const publishedDriftIssueMessages = getPublishedDriftIssueMessages(publishedDrift);
  const publishedDriftWarningMessage = getPublishedDriftWarningMessage({
    publishedDrift,
    ignored: publishedDriftIgnored,
  });
  const canAutoResolveDrift = canAutoResolvePublishedDrift(publishedDrift);

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

  const resolvePublishedDrift = async () => {
    if (!publishedDrift || publishedDrift.inSync || !chainView) {
      return;
    }

    setIsResolvingPublishedDrift(true);
    try {
      await createResolveListPublishedDrift({
        listId: chainView.rootListId,
        strategy: 'FIREBASE_FROM_SUBSPLASH',
      });
      setReloadNonce((value) => value + 1);
    } catch (error) {
      console.error('Failed to resolve published drift', error);
      alert(getErrorMessage(error, 'Failed to update Firebase to match Subsplash.'));
    } finally {
      setIsResolvingPublishedDrift(false);
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
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, mb: 3 }}>
          <Box>
            <Breadcrumbs separator={<NavigateNextIcon fontSize="small" />} sx={{ mb: 1 }}>
              <Link href="/admin/lists">Lists</Link>
              <Typography color="text.primary">{title}</Typography>
            </Breadcrumbs>
            <Typography variant="h4" fontWeight={700}>
              {title}
            </Typography>
          </Box>

          <Button
            component={Link}
            href="/admin/lists"
            variant="outlined"
            startIcon={<ArrowBackIcon />}
          >
            Back
          </Button>
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
                            {chainView?.expectedPhysicalCount ?? items.length}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            Total Sermons
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

                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
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
                        {localOnlyItemsCount > 0 ? (
                          <Chip
                            label={`${localOnlyItemsCount} local only`}
                            variant="outlined"
                            size="small"
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

            {publishedDriftWarningMessage ? (
              <Alert
                severity={publishedDrift?.issues.some((issue) => issue.severity === 'blocking') ? 'warning' : 'info'}
                sx={{ mb: 3 }}
                action={
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                    <Button
                      color="inherit"
                      size="small"
                      variant="outlined"
                      disabled={!canAutoResolveDrift || isResolvingPublishedDrift}
                      onClick={() => void resolvePublishedDrift()}
                    >
                      {isResolvingPublishedDrift ? 'Resolving…' : 'Update Firebase To Match Subsplash'}
                    </Button>
                    <Button
                      color="inherit"
                      size="small"
                      variant="text"
                      onClick={() => setPublishedDriftIgnored(true)}
                      disabled={publishedDriftIgnored}
                    >
                      {publishedDriftIgnored ? 'Ignored' : 'Ignore For Now'}
                    </Button>
                  </Box>
                }
              >
                <Typography variant="body2" sx={{ fontWeight: 600, mb: publishedDriftIssueMessages.length > 0 ? 1 : 0 }}>
                  {publishedDriftWarningMessage}
                </Typography>
                {publishedDriftIssueMessages.length > 0 ? (
                  <Box component="ul" sx={{ pl: 2.5, mb: 0 }}>
                    {publishedDriftIssueMessages.map((message) => (
                      <Box component="li" key={message}>
                        <Typography variant="body2">{message}</Typography>
                      </Box>
                    ))}
                  </Box>
                ) : null}
              </Alert>
            ) : null}

            {chainView ? (
              <Accordion
                disableGutters
                sx={{
                  mb: 3,
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 3,
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
                    px: 2.5,
                    py: 0.5,
                    bgcolor: alpha(theme.palette.info.main, 0.04),
                  }}
                >
                  <Box>
                    <Typography variant="subtitle1" fontWeight={700}>
                      Advanced Debug
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Overflow chain diagnostics and physical page mapping.
                    </Typography>
                  </Box>
                </AccordionSummary>
                <AccordionDetails sx={{ p: 2.5 }}>
                  {hasOverflowPages && !chainView.warningMessage ? (
                    <Alert severity="info" sx={{ mb: 2 }}>
                      This root detail page now saves one logical order for the whole overflow chain and remaps
                      Subsplash page boundaries behind the scenes.
                    </Alert>
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
                  <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                    {items.map((item, index) => (
                      <Box key={item.id}>
                        <SortableListSermonItem
                          item={item}
                          index={index}
                          dragDisabled={isReadOnlySurface}
                          placementDirty={hasOrderChanges}
                          onOpenSermon={(sermonId) => {
                            void router.push(`/admin/sermons/${sermonId}`);
                          }}
                        />
                        {index < items.length - 1 ? <Divider /> : null}
                      </Box>
                    ))}
                  </SortableContext>
                </DndContext>
              </Card>
            )}
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
