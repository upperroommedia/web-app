import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
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
import { ReorderListItemsInputType, ReorderListItemsOutputType } from '@upperroom/contracts/reorderListItems';
import AvatarWithDefaultImage from '../../../components/AvatarWithDefaultImage';
import ListBoundaryMarker from '../../../components/admin/lists/ListBoundaryMarker';
import OverflowChainPanel from '../../../components/admin/lists/OverflowChainPanel';
import useAuth from '../../../context/user/UserContext';
import firestore, {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  query,
  updateDoc,
  where,
} from '../../../firebase/firestore';
import AppLayout from '../../../layout/AppLayout';
import { listConverter, List } from '../../../types/List';
import { sermonListConverter, SermonList, listUploadStatus } from '../../../types/SermonList';
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
  getListDoc: (rootListId: string) => Promise<List>;
  getNodeItems: (firestoreListId: string, subsplashId?: string) => Promise<LoadListDetailsPageItem[]>;
  replaceRoute: (href: string) => Promise<unknown> | unknown;
}

interface LoadListDetailsPageResult {
  redirected?: boolean;
  list?: List;
  chainView?: ListOverflowChainView<LoadListDetailsPageItem>;
  items?: ListPageItem[];
}

interface SortableItemProps {
  item: ListPageItem;
  index: number;
  onOpenSermon: (id: string) => void;
  dragDisabled?: boolean;
}

const createGetListOverflowChain = createFunctionV2<
  GetListOverflowChainInputType,
  GetListOverflowChainOutputType
>('getlistoverflowchain');

const createReorderListItems = createFunctionV2<ReorderListItemsInputType, ReorderListItemsOutputType>(
  'reorderlistitems'
);

const getErrorMessage = (error: unknown, fallbackMessage: string): string =>
  error instanceof Error && error.message ? error.message : fallbackMessage;

const cloneListItems = (items: ListPageItem[]): ListPageItem[] => items.map((item) => ({ ...item }));

const normalizeListItemPositions = (items: ListPageItem[]): ListPageItem[] =>
  items.map((item, index) => ({
    ...item,
    position: index + 1,
    logicalPosition: index + 1,
  }));

const formatListType = (value?: string): string => {
  if (!value) {
    return 'List';
  }

  return value
    .split('-')
    .map((segment) => `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`)
    .join(' ');
};

const SortableListSermonItem = ({ item, index, onOpenSermon, dragDisabled = false }: SortableItemProps) => {
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
    </Box>
  );
};

export const loadListDetailsPageData = async ({
  listId,
  getListOverflowChain,
  getListDoc,
  getNodeItems,
  replaceRoute,
}: LoadListDetailsPageDependencies): Promise<LoadListDetailsPageResult> => {
  const chainState = await getListOverflowChain({ listId });

  if (chainState.redirectListId && chainState.redirectListId !== listId) {
    await replaceRoute(`/admin/lists/${chainState.redirectListId}`);
    return {
      redirected: true,
    };
  }

  const [listData, nodeItemsByListId] = await Promise.all([
    getListDoc(chainState.rootListId),
    Promise.all(
      chainState.nodes.map(async (node) => {
        const items = await getNodeItems(node.firestoreListId, node.subsplashId);
        return [node.firestoreListId, items] as const;
      })
    ),
  ]);

  const chainView = buildListOverflowChainView(chainState, Object.fromEntries(nodeItemsByListId));
  const items = normalizeListItemPositions(chainView.items);

  return {
    list: listData,
    chainView: {
      ...chainView,
      items,
    },
    items,
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
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

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
          getListDoc: async (rootListId) => {
            const rootListRef = doc(firestore, 'lists', rootListId).withConverter(listConverter);
            const listSnapshot = await getDoc(rootListRef);

            if (!listSnapshot.exists()) {
              throw new Error('List not found.');
            }

            return listSnapshot.data();
          },
          getNodeItems: async (firestoreListId, subsplashId) => {
            const listItemsRef = collection(
              firestore,
              'lists',
              firestoreListId,
              'listItems'
            ).withConverter(sermonConverter);
            const listItemsSnapshot = await getDocs(listItemsRef);

            let uploadStatusBySermonId = new Map<string, listUploadStatus | undefined>();

            if (subsplashId) {
              const sermonListsSnapshot = await getDocs(
                query(
                  collectionGroup(firestore, 'sermonLists').withConverter(sermonListConverter),
                  where('subsplashId', '==', subsplashId)
                )
              );

              uploadStatusBySermonId = new Map(
                sermonListsSnapshot.docs.map((sermonListDoc) => {
                  const sermonId = sermonListDoc.ref.parent.parent?.id || '';
                  const sermonList = sermonListDoc.data() as SermonList;
                  return [sermonId, sermonList.uploadStatus];
                })
              );
            }

            return sortListOverflowChainSourceItems(
              listItemsSnapshot.docs.map((itemDoc) => {
                const data = itemDoc.data() as Partial<ListDetailItem>;

                return {
                  ...data,
                  id: itemDoc.id,
                  uploadStatus: uploadStatusBySermonId.get(itemDoc.id),
                } as ListDetailItem;
              })
            );
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
        originalItemsRef.current = cloneListItems(result.items ?? []);
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load list details', error);
          alert(getErrorMessage(error, 'Failed to load list details.'));
          setList(null);
          setChainView(null);
          setItems([]);
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
  }, [listId, router]);

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
  const isReadOnlySurface = Boolean(chainView?.isReadOnly || hasOverflowPages);
  const boundaryMarkersByItemId = Object.fromEntries(
    (chainView?.boundaryMarkers ?? []).map((marker) => [marker.beforeItemId, marker])
  );

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
      if (list.subsplashId) {
        const syncedItemsMissingRemoteId = items.filter(
          (item) => item.uploadStatus?.status === uploadStatus.UPLOADED && !item.subsplashId
        );

        if (syncedItemsMissingRemoteId.length > 0) {
          throw new Error('One or more synced sermons are missing Subsplash IDs. Refresh and try again.');
        }

        const syncedItems = items.filter(
          (item) => item.uploadStatus?.status === uploadStatus.UPLOADED && item.subsplashId
        );

        if (syncedItems.length > 0) {
          const reorderResult = await createReorderListItems({
            firestoreListId: listId,
            itemOrder: syncedItems.map((item, index) => ({
              mediaItemId: item.subsplashId as string,
              position: index + 1,
            })),
            operationKey: createOperationKey('list-admin-reorder', listId),
          });

          if (reorderResult.status !== 'success') {
            throw new Error(reorderResult.message || 'Subsplash reorder failed.');
          }
        }
      }

      await Promise.all(
        items.map((item, index) =>
          updateDoc(doc(firestore, 'lists', listId, 'listItems', item.id), {
            position: index + 1,
          })
        )
      );

      originalItemsRef.current = cloneListItems(items);
    } catch (error) {
      console.error('Failed to save list order', error);
      setItems(previousItems);
      alert(getErrorMessage(error, 'Failed to save list order. The view was reset to the last synced order.'));
    } finally {
      setIsSaving(false);
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

            {list.subsplashId && localOnlyItemsCount > 0 ? (
              <Alert severity="info" sx={{ mb: 3 }}>
                This list contains sermons that are only local right now. Saving order will update Firestore for every
                row and reorder the synced Subsplash items in their relative order.
              </Alert>
            ) : null}

            {chainView?.warningMessage ? (
              <Alert severity="warning" sx={{ mb: 3 }}>
                {chainView.warningMessage}
              </Alert>
            ) : null}

            {hasOverflowPages && !chainView?.warningMessage ? (
              <Alert severity="info" sx={{ mb: 3 }}>
                This root detail page now shows the whole overflow chain in one view. Reorder and destructive actions
                stay disabled here until chain-aware save support lands.
              </Alert>
            ) : null}

            {chainView ? <OverflowChainPanel nodes={chainView.nodes} /> : null}

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
                        {boundaryMarkersByItemId[item.id] ? (
                          <ListBoundaryMarker marker={boundaryMarkersByItemId[item.id]} />
                        ) : null}
                        <SortableListSermonItem
                          item={item}
                          index={index}
                          dragDisabled={isReadOnlySurface}
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
