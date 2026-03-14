/**
 * Series Details Page
 * - View and edit series metadata
 * - Manage items in the series (add, remove, reorder)
 * - Show publish status for each item
 */
import { useRouter } from 'next/router';
import Head from 'next/head';
import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Stack from '@mui/material/Stack';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import SearchIcon from '@mui/icons-material/Search';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PendingIcon from '@mui/icons-material/Pending';
import SaveIcon from '@mui/icons-material/Save';
import UndoIcon from '@mui/icons-material/Undo';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import CollectionsIcon from '@mui/icons-material/Collections';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import Link from 'next/link';
import { alpha, useTheme } from '@mui/material/styles';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import type { Modifier } from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import AppLayout from '../../../layout/AppLayout';
import AvatarWithDefaultImage from '../../../components/AvatarWithDefaultImage';
import NewSeriesPopup from '../../../components/NewSeriesPopup';
import DeleteEntityPopup from '../../../components/DeleteEntityPopup';
import firestore, { doc, getDoc, collection, getDocs, query, orderBy, where, limit, deleteDoc, setDoc, updateDoc, writeBatch } from '../../../firebase/firestore';
import storage, { getDownloadURL, ref } from '../../../firebase/storage';
import { isDevelopment } from '../../../firebase/firebase';
import { Series, seriesConverter } from '../../../types/Series';
import { SeriesItem } from '../../../types/SeriesItem';
import { Sermon, uploadStatus } from '../../../types/SermonTypes';
import useAuth from '../../../context/user/UserContext';
import { createFunctionV2 } from '../../../utils/createFunction';
import {
  createOperationKey,
  createPublishedMembershipHash,
  createRetryIntentKey,
  parseLockBusyDetails,
} from '../../../utils/callableConcurrency';
import { canPublishSermonToSeries, SERIES_PUBLISH_BLOCKED_MESSAGE } from '../../../utils/seriesPublishUtils';
import { UPLOAD_TO_SUBSPLASH_INCOMING_DATA } from '@upperroom/contracts/uploadToSubsplash';
import { ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType } from '@upperroom/contracts/reorderSeriesItems';
import { RemoveFromSeriesInputType, RemoveFromSeriesOutputType } from '@upperroom/contracts/removeFromSeries';
import { AddToSeriesInputType, AddToSeriesOutputType } from '@upperroom/contracts/addToSeries';
import { CreateSeriesInputType, CreateSeriesOutputType } from '@upperroom/contracts/createSeries';
import { DeleteSeriesInputType, DeleteSeriesOutputType } from '@upperroom/contracts/deleteSeries';
import type { BulkAddToSeriesInputType, BulkAddToSeriesOutputType } from '@upperroom/contracts/bulkAddToSeries';
import { serverTimestamp, deleteField } from 'firebase/firestore';

interface SeriesItemWithSermon extends SeriesItem {
  sermon?: Sermon;
}

const getLockBusyMessage = (error: unknown, fallbackMessage: string): string => {
  const busyDetails = parseLockBusyDetails(error);
  if (!busyDetails) {
    return fallbackMessage;
  }

  const retryInSeconds = Math.max(1, Math.ceil(busyDetails.retry_after_ms / 1000));
  const lockedKeys = busyDetails.locked_keys.length > 0 ? ` Locked keys: ${busyDetails.locked_keys.join(', ')}.` : '';
  return `${fallbackMessage} Another publishing action is in progress.${lockedKeys} Retry in about ${retryInSeconds}s.`;
};

const getErrorField = (error: unknown, field: 'code' | 'message'): string | undefined => {
  if (field === 'message' && error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error !== 'object' || error === null || !(field in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
};

const getErrorMessage = (error: unknown, fallbackMessage: string): string =>
  getErrorField(error, 'message') || fallbackMessage;

const cloneSeriesItems = (source: SeriesItemWithSermon[]): SeriesItemWithSermon[] =>
  source.map((item) => ({
    ...item,
    sermon: item.sermon ? { ...item.sermon } : undefined,
  }));

interface SortableItemProps {
  item: SeriesItemWithSermon;
  index: number;
  onOpenSermon: (id: string) => void;
  onRequestPublish: (item: SeriesItemWithSermon) => void;
  onRequestUnpublish: (item: SeriesItemWithSermon) => void;
  onRequestRemove: (item: SeriesItemWithSermon) => void;
  isPublishing: boolean;
  isUnpublishing: boolean;
  actionsDisabled: boolean;
  canPublish: boolean;
  publishBlockedReason?: string;
}

const SortableItem = ({
  item,
  index,
  onOpenSermon,
  onRequestPublish,
  onRequestUnpublish,
  onRequestRemove,
  isPublishing,
  isUnpublishing,
  actionsDisabled,
  canPublish,
  publishBlockedReason,
}: SortableItemProps) => {
  const theme = useTheme();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : 0,
    position: 'relative' as const,
  };

  const handleRowClick = (event: React.MouseEvent<HTMLDivElement>) => {
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
      {/* Drag Handle */}
      <Box
        {...attributes}
        {...listeners}
        data-no-row-nav="true"
        sx={{
          display: 'flex',
          alignItems: 'center',
          cursor: isDragging ? 'grabbing' : 'grab',
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
          color: 'text.tertiary',
          fontWeight: 600,
          fontSize: '0.75rem',
        }}
      >
        {index + 1}
      </Typography>

      <AvatarWithDefaultImage
        image={item.sermon?.images?.find((img) => img.type === 'square')}
        altName={item.sermon?.title || 'Sermon'}
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
          {item.sermon?.title || `Sermon ${item.id}`}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mt: 0.5 }}>
          {item.sermon?.dateString && (
            <Typography variant="caption" color="text.secondary">
              {item.sermon.dateString}
            </Typography>
          )}
          {item.publishedToSubsplash ? (
            <Chip
              icon={<CheckCircleIcon />}
              label="Published"
              size="small"
              color="success"
              variant="outlined"
              sx={{ height: 22, '& .MuiChip-label': { px: 1 } }}
            />
          ) : (
            <Chip
              icon={<PendingIcon />}
              label="Not Published"
              size="small"
              color="warning"
              variant="outlined"
              sx={{ height: 22, '& .MuiChip-label': { px: 1 } }}
            />
          )}
        </Box>
      </Box>

      {item.publishedToSubsplash ? (
        <Button
          size="small"
          color="warning"
          variant="outlined"
          startIcon={isUnpublishing ? <CircularProgress size={14} /> : <CloudOffIcon fontSize="small" />}
          onClick={(event) => {
            event.stopPropagation();
            onRequestUnpublish(item);
          }}
          disabled={actionsDisabled || isUnpublishing}
        >
          Unpublish
        </Button>
      ) : (
        <Button
          size="small"
          color="primary"
          variant="contained"
          startIcon={isPublishing ? <CircularProgress size={14} color="inherit" /> : <CloudUploadIcon fontSize="small" />}
          onClick={(event) => {
            event.stopPropagation();
            onRequestPublish(item);
          }}
          disabled={actionsDisabled || isPublishing || !canPublish}
          title={!canPublish ? (publishBlockedReason || SERIES_PUBLISH_BLOCKED_MESSAGE) : undefined}
        >
          Publish
        </Button>
      )}

      <Tooltip title="Remove from series">
        <IconButton
          size="small"
          onClick={(event) => {
            event.stopPropagation();
            onRequestRemove(item);
          }}
          disabled={actionsDisabled}
          sx={{
            color: 'error.main',
            flexShrink: 0,
            '&:hover': {
              bgcolor: alpha(theme.palette.error.main, 0.15),
              color: 'error.main',
            },
          }}
        >
          <DeleteIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );
};

const SeriesDetailsPage = () => {
  const router = useRouter();
  const { user } = useAuth();
  const theme = useTheme();
  const seriesId = router.query.seriesId as string;

  const [series, setSeries] = useState<Series | null>(null);
  const [items, setItems] = useState<SeriesItemWithSermon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editPopup, setEditPopup] = useState(false);
  const [deletePopup, setDeletePopup] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [addItemPopup, setAddItemPopup] = useState(false);

  // Store original item order for revert functionality
  const originalItemsRef = useRef<SeriesItemWithSermon[]>([]);

  // Ref for the sortable container to restrict drag bounds
  const containerRef = useRef<HTMLDivElement>(null);
  const [availableSermons, setAvailableSermons] = useState<Sermon[]>([]);
  const [loadingSermons, setLoadingSermons] = useState(false);
  const [sermonSearchQuery, setSermonSearchQuery] = useState('');
  const [selectedSermonIds, setSelectedSermonIds] = useState<Set<string>>(new Set());
  const [isAddingSelectedSermons, setIsAddingSelectedSermons] = useState(false);
  const [activeAddingSermonId, setActiveAddingSermonId] = useState<string | null>(null);
  const [publishingItemId, setPublishingItemId] = useState<string | null>(null);
  const [unpublishingItemId, setUnpublishingItemId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SeriesItemWithSermon | null>(null);
  const [unpublishTarget, setUnpublishTarget] = useState<SeriesItemWithSermon | null>(null);
  const [isRemovingItem, setIsRemovingItem] = useState(false);

  const isAdmin = user?.isAdmin() ?? false;

  // Fetch series and items
  const fetchSeriesData = useCallback(async () => {
    if (!seriesId) return;

    setLoading(true);
    setError(null);

    try {
      // Fetch series
      const seriesDoc = await getDoc(doc(firestore, 'series', seriesId).withConverter(seriesConverter));
      if (!seriesDoc.exists()) {
        setError('Series not found');
        setLoading(false);
        return;
      }

      const seriesData = seriesDoc.data();

      // Check ownership (non-admins can only view their own series)
      if (!isAdmin && seriesData.ownerId !== user?.uid) {
        setError('You do not have permission to view this series');
        setLoading(false);
        return;
      }

      setSeries(seriesData);

      // Fetch series items
      const itemsQuery = query(
        collection(firestore, `series/${seriesId}/seriesItems`),
        // Subsplash semantics: position 1 is the bottom item, so show highest position first.
        orderBy('position', 'desc')
      );

      const itemsSnapshot = await getDocs(itemsQuery);
      const itemsData = itemsSnapshot.docs.map((itemDoc) => {
        const rawItem = itemDoc.data() as Partial<SeriesItem> & { sermonSubsplashId?: string | null };

        return {
          id: itemDoc.id,
          position: typeof rawItem.position === 'number' ? rawItem.position : 0,
          addedAt: rawItem.addedAt ?? null,
          sermonSubsplashId: rawItem.sermonSubsplashId ?? undefined,
          publishedToSubsplash: rawItem.publishedToSubsplash === true,
        } as SeriesItem;
      });

      // Fetch sermon data for each item
      const itemsWithSermons: SeriesItemWithSermon[] = await Promise.all(
        itemsData.map(async (item) => {
          try {
            const sermonDoc = await getDoc(doc(firestore, 'sermons', item.id));
            if (sermonDoc.exists()) {
              return { ...item, sermon: sermonDoc.data() as Sermon };
            }
          } catch (err) {
            console.error(`Error fetching sermon ${item.id}:`, err);
          }
          return item;
        })
      );

      setItems(itemsWithSermons);
      // Store original order for revert functionality
      originalItemsRef.current = cloneSeriesItems(itemsWithSermons);
    } catch (err: unknown) {
      console.error('Error fetching series:', err);
      setError(getErrorMessage(err, 'Failed to fetch series'));
    }

    setLoading(false);
  }, [seriesId, user?.uid, isAdmin]);

  useEffect(() => {
    fetchSeriesData();
  }, [fetchSeriesData]);

  // Fetch available sermons for adding to series
  const fetchAvailableSermons = useCallback(async () => {
    if (!user) return;

    setLoadingSermons(true);
    try {
      // Admins can see all sermons, non-admins only see their own
      const sermonsQuery = isAdmin
        ? query(
          collection(firestore, 'sermons'),
          orderBy('createdAtMillis', 'desc'),
          limit(100)
        )
        : query(
          collection(firestore, 'sermons'),
          where('uploaderId', '==', user.uid),
          orderBy('createdAtMillis', 'desc'),
          limit(50)
        );

      const sermonsSnapshot = await getDocs(sermonsQuery);
      const sermons = sermonsSnapshot.docs
        .map((doc) => ({ ...doc.data(), id: doc.id } as Sermon))
        .filter((sermon) => !sermon.seriesId || sermon.seriesId === seriesId); // Show sermons not in any series, or already in this series

      setAvailableSermons(sermons);
    } catch (err) {
      console.error('Error fetching sermons:', err);
    }
    setLoadingSermons(false);
  }, [user, seriesId, isAdmin]);

  const closeAddItemDialog = useCallback(() => {
    if (isAddingSelectedSermons) {
      return;
    }
    setSermonSearchQuery('');
    setSelectedSermonIds(new Set());
    setAddItemPopup(false);
  }, [isAddingSelectedSermons]);

  const isSermonPublishedToSubsplash = useCallback((sermon: Sermon | undefined): boolean => {
    if (!sermon) {
      return false;
    }

    return Boolean(
      sermon.subsplashId ||
      sermon.status?.subsplash === uploadStatus.UPLOADED
    );
  }, []);

  const ensureSeriesSubsplashId = useCallback(async (): Promise<string> => {
    if (!series) {
      throw new Error('Series not found.');
    }

    if (series.subsplashId) {
      return series.subsplashId;
    }

    const createSeriesFunction = createFunctionV2<CreateSeriesInputType, CreateSeriesOutputType>('createseries');
    const createResult = await createSeriesFunction({
      title: series.name,
      summary: series.summary,
      ownerId: series.ownerId,
      firestoreId: series.id,
      skipSubsplash: false,
      images: series.images,
      operationKey: createOperationKey('series-admin-create-series', series.id),
    });

    if (createResult.status !== 'success' || !createResult.subsplashId) {
      throw new Error(createResult.error || 'Failed to create series in Subsplash.');
    }
    const createdSubsplashId = createResult.subsplashId;

    await updateDoc(doc(firestore, 'series', series.id), {
      subsplashId: createdSubsplashId,
      status: 'published',
    });

    setSeries((previousSeries) => (
      previousSeries
        ? { ...previousSeries, subsplashId: createdSubsplashId, status: 'published' }
        : previousSeries
    ));

    return createdSubsplashId;
  }, [series]);

  const uploadSermonToSubsplash = useCallback(async (sermon: Sermon): Promise<string> => {
    if (sermon.subsplashId) {
      return sermon.subsplashId;
    }

    const uploadToSubsplashFunction = createFunctionV2<UPLOAD_TO_SUBSPLASH_INCOMING_DATA, unknown>('uploadToSubsplash');
    const audioUrl = await getDownloadURL(ref(storage, `intro-outro-sermons/${sermon.id}`));
    const uploadPayload: UPLOAD_TO_SUBSPLASH_INCOMING_DATA = {
      title: sermon.title,
      subtitle: sermon.subtitle,
      speakers: sermon.speakers,
      autoPublish: !isDevelopment,
      audioTitle: sermon.title,
      audioUrl,
      topics: sermon.topics,
      description: sermon.description,
      images: sermon.images,
      date: new Date(sermon.dateMillis),
      operationKey: createOperationKey('series-admin-upload', sermon.id),
      lockKey: sermon.id,
    };

    const uploadResult = await uploadToSubsplashFunction(uploadPayload);
    if (!uploadResult || typeof uploadResult === 'string' || typeof uploadResult !== 'object') {
      throw new Error(typeof uploadResult === 'string' ? uploadResult : 'Failed to upload sermon to Subsplash.');
    }

    const uploadResultData = uploadResult as { id?: string };
    if (!uploadResultData.id) {
      throw new Error('Subsplash upload did not return a media item ID.');
    }

    const mediaItemId = uploadResultData.id;
    await updateDoc(doc(firestore, 'sermons', sermon.id), {
      subsplashId: mediaItemId,
      status: { ...sermon.status, subsplash: uploadStatus.UPLOADED },
      approverId: user?.uid ?? null,
    });

    setItems((previousItems) => previousItems.map((item) => (
      item.id === sermon.id && item.sermon
        ? {
          ...item,
          sermonSubsplashId: mediaItemId,
          sermon: {
            ...item.sermon,
            subsplashId: mediaItemId,
            status: { ...item.sermon.status, subsplash: uploadStatus.UPLOADED },
          },
        }
        : item
    )));

    return mediaItemId;
  }, [user?.uid]);

  const reorderPublishedItemsInSubsplash = useCallback(async (
    targetSermonId: string,
    targetMediaItemId: string
  ) => {
    const orderedItemsSnapshot = await getDocs(
      query(collection(firestore, `series/${seriesId}/seriesItems`), orderBy('position', 'desc'))
    );
    const orderedItems = orderedItemsSnapshot.docs.map((seriesItemDoc) => {
      const data = seriesItemDoc.data() as {
        publishedToSubsplash?: boolean;
        sermonSubsplashId?: string;
      };

      return {
        sermonId: seriesItemDoc.id,
        published: seriesItemDoc.id === targetSermonId ? true : data.publishedToSubsplash === true,
        mediaItemId: seriesItemDoc.id === targetSermonId
          ? targetMediaItemId
          : data.sermonSubsplashId,
      };
    });

    const targetExists = orderedItems.some((item) => item.sermonId === targetSermonId);
    if (!targetExists) {
      throw new Error('Published item is missing from series order.');
    }

    const publishedItems = orderedItems.filter((item) => item.published);

    const missingMediaIdItem = publishedItems.find((item) => !item.mediaItemId);
    if (missingMediaIdItem) {
      throw new Error(`Missing Subsplash media ID for sermon ${missingMediaIdItem.sermonId}.`);
    }

    const reorderFunction = createFunctionV2<ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType>('reorderseriesitems');
    const reorderResult = await reorderFunction({
      firestoreSeriesId: seriesId,
      itemOrder: publishedItems.map((item, index) => ({
        mediaItemId: item.mediaItemId as string,
        // Subsplash uses inverted ordering semantics: position 1 is the bottom item.
        position: publishedItems.length - index,
      })),
      operationKey: createOperationKey('series-admin-reorder', seriesId),
    });

    if (reorderResult.status !== 'success') {
      throw new Error(reorderResult.message || 'Subsplash reorder failed.');
    }
  }, [seriesId]);

  const syncSeriesItemPublishedState = useCallback(async (
    seriesItemId: string,
    options: { publishedToSubsplash: boolean; sermonSubsplashId?: string }
  ) => {
    await setDoc(
      doc(firestore, `series/${seriesId}/seriesItems`, seriesItemId),
      {
        publishedToSubsplash: options.publishedToSubsplash,
        sermonSubsplashId: options.publishedToSubsplash
          ? options.sermonSubsplashId
          : deleteField(),
      },
      { merge: true }
    );

    setItems((previousItems) => previousItems.map((item) => (
      item.id === seriesItemId
        ? {
          ...item,
          publishedToSubsplash: options.publishedToSubsplash,
          sermonSubsplashId: options.publishedToSubsplash ? options.sermonSubsplashId : undefined,
        }
        : item
    )));
    originalItemsRef.current = originalItemsRef.current.map((item) => (
      item.id === seriesItemId
        ? {
          ...item,
          publishedToSubsplash: options.publishedToSubsplash,
          sermonSubsplashId: options.publishedToSubsplash ? options.sermonSubsplashId : undefined,
        }
        : item
    ));
  }, [seriesId]);

  const publishItemToSeries = useCallback(async (
    seriesItem: SeriesItemWithSermon,
    options?: { suppressAlert?: boolean }
  ): Promise<boolean> => {
    if (!seriesItem.sermon) {
      if (!options?.suppressAlert) {
        alert('Sermon details are missing for this item. Refresh and retry.');
      }
      return false;
    }

    if (!canPublishSermonToSeries(seriesItem.sermon)) {
      if (!options?.suppressAlert) {
        alert(SERIES_PUBLISH_BLOCKED_MESSAGE);
      }
      return false;
    }

    setPublishingItemId(seriesItem.id);
    try {
      const seriesSubsplashId = await ensureSeriesSubsplashId();
      const mediaItemId = await uploadSermonToSubsplash(seriesItem.sermon);
      const addToSeriesFunction = createFunctionV2<AddToSeriesInputType, AddToSeriesOutputType>('addtoseries');
      const addResult = await addToSeriesFunction({
        seriesSubsplashId,
        mediaItemId,
        operationKey: createOperationKey('series-admin-add-item', seriesItem.id),
      });

      if (!addResult || addResult.status !== 'success') {
        throw new Error(addResult?.error || 'Failed to add sermon to series in Subsplash.');
      }

      const confirmedMediaItemId = addResult.mediaItemId || mediaItemId;
      // Subsplash is source of truth: once add succeeds, persist published state immediately.
      await syncSeriesItemPublishedState(seriesItem.id, {
        publishedToSubsplash: true,
        sermonSubsplashId: confirmedMediaItemId,
      });

      try {
        await reorderPublishedItemsInSubsplash(seriesItem.id, confirmedMediaItemId);
      } catch (reorderError: unknown) {
        const removeFromSeriesFunction = createFunctionV2<RemoveFromSeriesInputType, RemoveFromSeriesOutputType>('removefromseries');
        try {
          await removeFromSeriesFunction({
            mediaItemId: confirmedMediaItemId,
            operationKey: createOperationKey('series-admin-rollback-remove', seriesItem.id),
          });
          await syncSeriesItemPublishedState(seriesItem.id, {
            publishedToSubsplash: false,
          });
          throw new Error(getErrorMessage(reorderError, 'Series reorder failed after publish.'));
        } catch (rollbackError: unknown) {
          // Rollback failure means item likely remains published in Subsplash.
          await syncSeriesItemPublishedState(seriesItem.id, {
            publishedToSubsplash: true,
            sermonSubsplashId: confirmedMediaItemId,
          });
          const partialFailureMessage =
            `Series reorder failed and rollback failed. ${seriesItem.sermon?.title || 'This sermon'} remains published in Subsplash and has been kept published locally. Reorder error: ${getErrorMessage(reorderError, 'Unknown')}; rollback error: ${getErrorMessage(rollbackError, 'Unknown')}.`;
          console.error(partialFailureMessage);
          if (!options?.suppressAlert) {
            alert(partialFailureMessage);
          }
          return true;
        }
      }

      return true;
    } catch (err: unknown) {
      console.error('Error publishing series item:', err);
      if (!options?.suppressAlert) {
        alert(`Error publishing item to series: ${getLockBusyMessage(err, getErrorMessage(err, 'Unknown error'))}`);
      }
      return false;
    } finally {
      setPublishingItemId(null);
    }
  }, [ensureSeriesSubsplashId, reorderPublishedItemsInSubsplash, syncSeriesItemPublishedState, uploadSermonToSubsplash]);

  const unpublishItemFromSeries = useCallback(async (seriesItem: SeriesItemWithSermon) => {
    setUnpublishingItemId(seriesItem.id);
    try {
      const mediaItemId = seriesItem.sermonSubsplashId || seriesItem.sermon?.subsplashId;
      if (mediaItemId) {
        const removeFromSeriesFunction = createFunctionV2<RemoveFromSeriesInputType, RemoveFromSeriesOutputType>('removefromseries');
        await removeFromSeriesFunction({
          mediaItemId,
          operationKey: createOperationKey('series-admin-unpublish-item', seriesItem.id),
        });
      }

      await updateDoc(doc(firestore, `series/${seriesId}/seriesItems`, seriesItem.id), {
        publishedToSubsplash: false,
        sermonSubsplashId: deleteField(),
      });

      setItems((previousItems) => previousItems.map((item) => (
        item.id === seriesItem.id
          ? { ...item, publishedToSubsplash: false, sermonSubsplashId: undefined }
          : item
      )));
      originalItemsRef.current = originalItemsRef.current.map((item) => (
        item.id === seriesItem.id
          ? { ...item, publishedToSubsplash: false, sermonSubsplashId: undefined }
          : item
      ));
    } catch (err: unknown) {
      console.error('Error unpublishing series item:', err);
      alert(`Error unpublishing item from series: ${getLockBusyMessage(err, getErrorMessage(err, 'Unknown error'))}`);
    } finally {
      setUnpublishingItemId(null);
      setUnpublishTarget(null);
    }
  }, [seriesId]);

  // Custom modifier to restrict drag to container bounds
  const restrictToContainer: Modifier = ({ transform, draggingNodeRect, containerNodeRect: _containerNodeRect }) => {
    if (!containerRef.current || !draggingNodeRect) {
      return transform;
    }

    const containerRect = containerRef.current.getBoundingClientRect();

    // Calculate the bounds
    const minY = containerRect.top - draggingNodeRect.top;
    const maxY = containerRect.bottom - draggingNodeRect.bottom;

    return {
      ...transform,
      y: Math.min(Math.max(transform.y, minY), maxY),
    };
  };

  // DnD sensors for drag-and-drop sorting
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

  // Check if order has changed from original
  const hasOrderChanges = items.length !== originalItemsRef.current.length ||
    items.some((item, index) => item.id !== originalItemsRef.current[index]?.id);

  // Handle drag end to reorder items
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setItems((prevItems) => {
        const oldIndex = prevItems.findIndex((item) => item.id === active.id);
        const newIndex = prevItems.findIndex((item) => item.id === over.id);

        const newItems = arrayMove(prevItems, oldIndex, newIndex);
        // Update positions
        newItems.forEach((item, i) => {
          item.position = newItems.length - i;
        });
        return newItems;
      });
    }
  };

  // Revert to original order
  const revertOrder = () => {
    setItems(cloneSeriesItems(originalItemsRef.current));
  };

  // Save order changes
  const saveOrderChanges = async () => {
    if (!series || !hasOrderChanges) return;

    setIsSaving(true);
    const previousItems = cloneSeriesItems(originalItemsRef.current);
    try {
      // If series is published to Subsplash, use the reorder function
      if (series.subsplashId) {
        const reorderFunction = createFunctionV2<ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType>(
          'reorderseriesitems'
        );
        const publishedItems = items.filter((item) => item.publishedToSubsplash);
        const publishedItemsMissingIds = publishedItems.filter(
          (item) => !item.sermonSubsplashId && !item.sermon?.subsplashId
        );
        if (publishedItemsMissingIds.length > 0) {
          throw new Error('One or more published items are missing Subsplash IDs. Refresh and try again.');
        }

        const reorderResult = await reorderFunction({
          firestoreSeriesId: seriesId,
          itemOrder: publishedItems.map((item, index) => ({
            mediaItemId: item.sermonSubsplashId || item.sermon?.subsplashId || '',
            // Subsplash uses inverted ordering semantics: position 1 is the bottom item.
            position: publishedItems.length - index,
          })),
          operationKey: createOperationKey('series-admin-reorder', seriesId),
        });
        if (reorderResult.status !== 'success') {
          throw new Error(reorderResult.message || 'Subsplash reorder failed.');
        }
      }

      // Persist order in Firestore only after Subsplash succeeds.
      await Promise.all(
        items.map(async (item, index) => {
          const itemRef = doc(firestore, `series/${seriesId}/seriesItems`, item.id);
          try {
            await updateDoc(itemRef, { position: items.length - index });
          } catch (err: unknown) {
            // Item might have been deleted by another user - skip it
            if (getErrorField(err, 'code') === 'not-found' || getErrorMessage(err, '').includes('NOT_FOUND')) {
              console.warn(`SeriesItem ${item.id} not found - may have been removed`);
            } else {
              throw err;
            }
          }
        })
      );

      // Update original order reference after successful save
      originalItemsRef.current = cloneSeriesItems(items);
    } catch (err: unknown) {
      console.error('Error saving order:', err);
      setItems(previousItems);
      alert(`Error saving order. Reverted to last synced state.\n${getLockBusyMessage(err, getErrorMessage(err, 'Unknown error'))}`);
    } finally {
      setIsSaving(false);
    }
  };

  const executeRemoveItem = async () => {
    if (!removeTarget || isRemovingItem) {
      return;
    }

    setIsRemovingItem(true);
    try {
      const mediaItemId = removeTarget.sermonSubsplashId || removeTarget.sermon?.subsplashId;
      if (series?.subsplashId && removeTarget.publishedToSubsplash === true && mediaItemId) {
        const removeFromSeriesCallable = createFunctionV2<RemoveFromSeriesInputType, RemoveFromSeriesOutputType>('removefromseries');
        try {
          await removeFromSeriesCallable({
            mediaItemId,
            operationKey: createOperationKey('series-admin-remove-item', removeTarget.id),
          });
        } catch (removeErr: unknown) {
          if (getErrorField(removeErr, 'code') !== 'functions/not-found') {
            throw removeErr;
          }
        }
      }

      await deleteDoc(doc(firestore, `series/${seriesId}/seriesItems`, removeTarget.id));

      try {
        await updateDoc(doc(firestore, 'sermons', removeTarget.id), {
          seriesId: null,
        });
      } catch (sermonErr: unknown) {
        if (getErrorField(sermonErr, 'code') === 'not-found' || getErrorMessage(sermonErr, '').includes('NOT_FOUND')) {
          console.warn(`Sermon ${removeTarget.id} not found - may have been deleted`);
        } else {
          throw sermonErr;
        }
      }

      const updatedItems = items
        .filter((item) => item.id !== removeTarget.id)
        .map((item, index, source) => ({ ...item, position: source.length - index }));

      await Promise.all(
        updatedItems.map((item) => updateDoc(doc(firestore, `series/${seriesId}/seriesItems`, item.id), {
          position: item.position,
        }))
      );

      setItems(updatedItems);
      originalItemsRef.current = cloneSeriesItems(updatedItems);
      setRemoveTarget(null);
    } catch (err: unknown) {
      console.error('Error removing item:', err);
      alert(`Error removing item: ${getLockBusyMessage(err, getErrorMessage(err, 'Unknown error'))}`);
    } finally {
      setIsRemovingItem(false);
    }
  };

  // Add item to series
  const addItemToSeries = useCallback(async (sermon: Sermon): Promise<boolean> => {
    try {
      if (items.some((item) => item.id === sermon.id)) {
        return false;
      }
      const latestPositionSnapshot = await getDocs(
        query(
          collection(firestore, `series/${seriesId}/seriesItems`),
          orderBy('position', 'desc'),
          limit(1)
        )
      );
      const latestPosition = latestPositionSnapshot.docs[0]?.data()?.position;
      const newPosition = typeof latestPosition === 'number' ? latestPosition + 1 : 1;

      const sermonDoc = await getDoc(doc(firestore, 'sermons', sermon.id));
      if (!sermonDoc.exists()) {
        alert('This sermon no longer exists. It may have been deleted.');
        setAvailableSermons((previousSermons) => previousSermons.filter((candidate) => candidate.id !== sermon.id));
        return false;
      }

      const latestSermon = { ...sermonDoc.data(), id: sermon.id } as Sermon;
      const previousSeriesId = latestSermon.seriesId ?? null;

      const seriesDoc = await getDoc(doc(firestore, 'series', seriesId));
      if (!seriesDoc.exists()) {
        alert('This series no longer exists. Redirecting to series list.');
        router.push('/admin/series');
        return false;
      }

      const seriesItemData: Partial<SeriesItem> = {
        id: latestSermon.id,
        position: newPosition,
        publishedToSubsplash: false,
        ...(latestSermon.subsplashId !== undefined && { sermonSubsplashId: latestSermon.subsplashId }),
      };

      await setDoc(
        doc(firestore, `series/${seriesId}/seriesItems`, latestSermon.id),
        {
          ...seriesItemData,
          addedAt: serverTimestamp(),
        }
      );

      await updateDoc(doc(firestore, 'sermons', latestSermon.id), {
        seriesId,
      });

      const newItem: SeriesItemWithSermon = {
        id: latestSermon.id,
        position: newPosition,
        publishedToSubsplash: false,
        sermonSubsplashId: latestSermon.subsplashId,
        addedAt: null,
        sermon: { ...latestSermon, seriesId },
      };

      setItems((previousItems) => [newItem, ...previousItems]);
      originalItemsRef.current = [newItem, ...originalItemsRef.current];

      // Keep state fully consistent: if sermon is already in Subsplash, immediately publish it to series too.
      if (isSermonPublishedToSubsplash(latestSermon)) {
        const publishSucceeded = await publishItemToSeries(newItem, { suppressAlert: true });
        if (!publishSucceeded) {
          await deleteDoc(doc(firestore, `series/${seriesId}/seriesItems`, latestSermon.id));
          await updateDoc(doc(firestore, 'sermons', latestSermon.id), { seriesId: previousSeriesId });
          setItems((previousItems) => previousItems.filter((item) => item.id !== latestSermon.id));
          originalItemsRef.current = originalItemsRef.current.filter((item) => item.id !== latestSermon.id);
          throw new Error(
            `${latestSermon.title} is already published to Subsplash, but automatic series publish failed. The sermon was not added to this series.`
          );
        }
      }

      return true;
    } catch (err: unknown) {
      console.error('Error adding item:', err);
      alert(`Error adding item: ${getErrorMessage(err, 'Unknown error')}`);
      return false;
    }
  }, [isSermonPublishedToSubsplash, items, publishItemToSeries, router, seriesId]);

  const addSelectedSermons = useCallback(async () => {
    if (isAddingSelectedSermons) {
      return;
    }

    const sermonsToAdd = availableSermons
      .filter((sermon) => selectedSermonIds.has(sermon.id))
      .filter((sermon) => !items.some((item) => item.id === sermon.id));

    if (sermonsToAdd.length === 0) {
      return;
    }

    setIsAddingSelectedSermons(true);
    try {
      if (sermonsToAdd.length === 1) {
        setActiveAddingSermonId(sermonsToAdd[0].id);
        const added = await addItemToSeries(sermonsToAdd[0]);
        if (added) {
          setSermonSearchQuery('');
          setSelectedSermonIds(new Set());
          setAddItemPopup(false);
        }
        return;
      }

      const seriesDoc = await getDoc(doc(firestore, 'series', seriesId));
      if (!seriesDoc.exists()) {
        alert('This series no longer exists. Redirecting to series list.');
        router.push('/admin/series');
        return;
      }

      const currentMaxPosition = items.length > 0
        ? Math.max(...items.map((item) => item.position))
        : 0;

      const additions = sermonsToAdd.map((sermon, index, source) => ({
        sermon,
        previousSeriesId: sermon.seriesId ?? null,
        position: currentMaxPosition + (source.length - index),
      }));

      const MAX_SERMONS_PER_BATCH = 200;
      for (let index = 0; index < additions.length; index += MAX_SERMONS_PER_BATCH) {
        const chunk = additions.slice(index, index + MAX_SERMONS_PER_BATCH);
        const batch = writeBatch(firestore);

        chunk.forEach(({ sermon, position }) => {
          batch.set(
            doc(firestore, `series/${seriesId}/seriesItems`, sermon.id),
            {
              id: sermon.id,
              position,
              publishedToSubsplash: false,
              ...(sermon.subsplashId !== undefined && { sermonSubsplashId: sermon.subsplashId }),
              addedAt: serverTimestamp(),
            }
          );
          batch.update(doc(firestore, 'sermons', sermon.id), {
            seriesId,
          });
        });

        await batch.commit();
      }

      const newItems = additions.map(({ sermon, position }) => ({
        id: sermon.id,
        position,
        publishedToSubsplash: false,
        sermonSubsplashId: sermon.subsplashId,
        addedAt: null,
        sermon: { ...sermon, seriesId },
      } as SeriesItemWithSermon));
      const orderedNewItems = [...newItems].sort((a, b) => b.position - a.position);

      setItems((previousItems) => [...orderedNewItems, ...previousItems]);
      originalItemsRef.current = [...orderedNewItems, ...originalItemsRef.current];

      const publishedCandidates = orderedNewItems.filter((seriesItem) => isSermonPublishedToSubsplash(seriesItem.sermon));
      if (publishedCandidates.length > 0) {
        const priorSeriesIdsBySermonId = new Map(additions.map((entry) => [entry.sermon.id, entry.previousSeriesId]));
        const mediaItemIdBySermonId = new Map<string, string>();
        for (const seriesItem of publishedCandidates) {
          if (!seriesItem.sermon) {
            throw new Error(`Sermon details missing for ${seriesItem.id}.`);
          }

          setActiveAddingSermonId(seriesItem.id);
          const mediaItemId = seriesItem.sermon.subsplashId
            ? seriesItem.sermon.subsplashId
            : await uploadSermonToSubsplash(seriesItem.sermon);
          mediaItemIdBySermonId.set(seriesItem.id, mediaItemId);
        }

        const seriesSubsplashId = await ensureSeriesSubsplashId();
        const publishedCandidateIds = new Set(publishedCandidates.map((item) => item.id));
        const reorderedItems = [...orderedNewItems, ...items];
        const publishedItemOrderWithGaps = reorderedItems
          .filter((item) => item.publishedToSubsplash === true || publishedCandidateIds.has(item.id))
          .map((item) => mediaItemIdBySermonId.get(item.id) || item.sermonSubsplashId || item.sermon?.subsplashId);
        const publishedItemOrder = publishedItemOrderWithGaps.filter((mediaItemId): mediaItemId is string => Boolean(mediaItemId));

        if (publishedItemOrder.length === 0 || publishedItemOrder.length !== publishedItemOrderWithGaps.length) {
          throw new Error('Cannot publish to series because one or more published sermons are missing Subsplash media IDs.');
        }

        const currentPublishedMembershipWithGaps = items
          .filter((item) => item.publishedToSubsplash === true)
          .map((item) => item.sermonSubsplashId || item.sermon?.subsplashId);
        const currentPublishedMembership = currentPublishedMembershipWithGaps.filter((mediaItemId): mediaItemId is string => Boolean(mediaItemId));
        if (currentPublishedMembership.length !== currentPublishedMembershipWithGaps.length) {
          throw new Error('Cannot publish to series because an existing published sermon is missing a Subsplash media ID.');
        }
        const expectedPublishedMembershipHash = createPublishedMembershipHash(currentPublishedMembership);

        const bulkAdds = publishedCandidates.map((item) => {
          const mediaItemId = mediaItemIdBySermonId.get(item.id);
          if (!mediaItemId) {
            throw new Error(`Cannot publish sermon ${item.id} because it is missing a Subsplash media ID.`);
          }

          return {
            sermonId: item.id,
            mediaItemId,
          };
        });
        const intentFingerprint = [
          ...bulkAdds.map((entry) => `${entry.sermonId}:${entry.mediaItemId}`).sort(),
          `order:${publishedItemOrder.join(',')}`,
          `snapshot:${expectedPublishedMembershipHash}`,
        ].join('|');
        const operationKey = createRetryIntentKey('series-admin-bulk-add', seriesId, intentFingerprint);

        const bulkAddToSeriesFunction = createFunctionV2<BulkAddToSeriesInputType, BulkAddToSeriesOutputType>('bulkaddtoseries');
        const bulkResult = await bulkAddToSeriesFunction({
          firestoreSeriesId: seriesId,
          seriesSubsplashId,
          operationKey,
          expectedPublishedMembershipHash,
          adds: bulkAdds,
          publishedItemOrder,
          maxConcurrency: 4,
          rollbackOnFailure: true,
        });

        if (bulkResult.status !== 'success' || bulkResult.failed > 0 || !bulkResult.reorderApplied) {
          const rolledBackMediaItemIds = new Set(bulkResult.rolledBackMediaItemIds || []);
          const resultBySermonId = new Map(
            bulkResult.results
              .filter((result) => Boolean(result.sermonId))
              .map((result) => [result.sermonId as string, result])
          );

          const idsToRemoveLocally = new Set<string>();
          const idsToKeepPublished = new Set<string>();
          const titlesToRetry: string[] = [];
          const titlesKeptPublished: string[] = [];

          publishedCandidates.forEach((seriesItem) => {
            const mediaItemId = mediaItemIdBySermonId.get(seriesItem.id);
            const result = resultBySermonId.get(seriesItem.id);
            const wasAdded = result?.status === 'success';
            const wasRolledBack = mediaItemId ? rolledBackMediaItemIds.has(mediaItemId) : false;

            if (wasAdded && !wasRolledBack) {
              idsToKeepPublished.add(seriesItem.id);
              titlesKeptPublished.push(seriesItem.sermon?.title || seriesItem.id);
            } else {
              idsToRemoveLocally.add(seriesItem.id);
              titlesToRetry.push(seriesItem.sermon?.title || seriesItem.id);
            }
          });

          if (idsToRemoveLocally.size > 0) {
            const rollbackBatch = writeBatch(firestore);
            idsToRemoveLocally.forEach((sermonId) => {
              rollbackBatch.delete(doc(firestore, `series/${seriesId}/seriesItems`, sermonId));
              rollbackBatch.update(doc(firestore, 'sermons', sermonId), {
                seriesId: priorSeriesIdsBySermonId.get(sermonId) ?? null,
              });
            });
            await rollbackBatch.commit();
          }

          if (idsToKeepPublished.size > 0) {
            const keepBatch = writeBatch(firestore);
            idsToKeepPublished.forEach((sermonId) => {
              const mediaItemId = mediaItemIdBySermonId.get(sermonId);
              keepBatch.set(
                doc(firestore, `series/${seriesId}/seriesItems`, sermonId),
                {
                  publishedToSubsplash: true,
                  sermonSubsplashId: mediaItemId,
                },
                { merge: true }
              );
            });
            await keepBatch.commit();
          }

          setItems((previousItems) => previousItems
            .filter((item) => !idsToRemoveLocally.has(item.id))
            .map((item) => (
              idsToKeepPublished.has(item.id)
                ? {
                  ...item,
                  publishedToSubsplash: true,
                  sermonSubsplashId: mediaItemIdBySermonId.get(item.id) || item.sermonSubsplashId,
                }
                : item
            )));
          originalItemsRef.current = originalItemsRef.current
            .filter((item) => !idsToRemoveLocally.has(item.id))
            .map((item) => (
              idsToKeepPublished.has(item.id)
                ? {
                  ...item,
                  publishedToSubsplash: true,
                  sermonSubsplashId: mediaItemIdBySermonId.get(item.id) || item.sermonSubsplashId,
                }
                : item
            ));
          setSelectedSermonIds(new Set(idsToRemoveLocally));

          const keptPublishedMessage = titlesKeptPublished.length > 0
            ? `\n\nThese sermons were added in Subsplash and were kept published locally:\n${titlesKeptPublished.join('\n')}`
            : '';
          const retryMessage = titlesToRetry.length > 0
            ? `\n\nThese sermons were not safely published and were removed locally:\n${titlesToRetry.join('\n')}`
            : '';
          const rollbackFailureMessage = bulkResult.rollbackFailures.length > 0
            ? `\n\nRollback failures:\n${bulkResult.rollbackFailures.map((failure) => `${failure.mediaItemId}: ${failure.error}`).join('\n')}`
            : '';
          alert(
            `Automatic Subsplash series publish did not fully complete.\n${bulkResult.message}${retryMessage}${keptPublishedMessage}${rollbackFailureMessage}`
          );
          return;
        }

        const publishBatch = writeBatch(firestore);
        const publishedSermonIds = new Set<string>();
        bulkResult.results.forEach((result) => {
          if (result.status !== 'success' || !result.sermonId) {
            return;
          }
          publishedSermonIds.add(result.sermonId);
          publishBatch.set(
            doc(firestore, `series/${seriesId}/seriesItems`, result.sermonId),
            {
              publishedToSubsplash: true,
              sermonSubsplashId: result.mediaItemId,
            },
            { merge: true }
          );
        });
        await publishBatch.commit();

        setItems((previousItems) => previousItems.map((item) => {
          if (!publishedSermonIds.has(item.id)) {
            return item;
          }
          return {
            ...item,
            publishedToSubsplash: true,
            sermonSubsplashId: mediaItemIdBySermonId.get(item.id) || item.sermonSubsplashId,
          };
        }));
        originalItemsRef.current = originalItemsRef.current.map((item) => {
          if (!publishedSermonIds.has(item.id)) {
            return item;
          }
          return {
            ...item,
            publishedToSubsplash: true,
            sermonSubsplashId: mediaItemIdBySermonId.get(item.id) || item.sermonSubsplashId,
          };
        });
      }

      if (orderedNewItems.length > 0) {
        setSermonSearchQuery('');
        setSelectedSermonIds(new Set());
        setAddItemPopup(false);
      }
    } catch (err: unknown) {
      console.error('Error adding selected sermons:', err);
      alert(`Error adding selected sermons: ${getLockBusyMessage(err, getErrorMessage(err, 'Unknown error'))}`);
    } finally {
      setActiveAddingSermonId(null);
      setIsAddingSelectedSermons(false);
    }
  }, [
    addItemToSeries,
    availableSermons,
    ensureSeriesSubsplashId,
    isAddingSelectedSermons,
    isSermonPublishedToSubsplash,
    items,
    router,
    selectedSermonIds,
    seriesId,
    uploadSermonToSubsplash,
  ]);

  // Delete series
  const handleDeleteSeries = async () => {
    if (!series) return;

    setIsDeleting(true);
    try {
      // Always use callable so remote unlink/verify/delete semantics are enforced.
      const deleteSeriesCallable = createFunctionV2<DeleteSeriesInputType, DeleteSeriesOutputType>('deleteseries');
      await deleteSeriesCallable({
        firestoreId: seriesId,
        operationKey: createOperationKey('series-admin-delete-series', seriesId),
      });
      router.push('/admin/series');
    } catch (err: unknown) {
      console.error('Error deleting series:', err);
      alert(`Error deleting series: ${getLockBusyMessage(err, getErrorMessage(err, 'Unknown error'))}`);
    }
    setIsDeleting(false);
  };

  if (loading) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '50vh',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '50vh',
        }}
      >
        <Alert severity="error" sx={{ maxWidth: 400 }}>
          {error}
        </Alert>
      </Box>
    );
  }

  if (!series) {
    return null;
  }

  const title = series.name || 'Series Details';
  const publishedItemsCount = items.filter((item) => item.publishedToSubsplash).length;
  const derivedSeriesSubtitle = `${publishedItemsCount} part series`;
  const filteredAddableSermons = availableSermons
    .filter((sermon) => !items.some((item) => item.id === sermon.id))
    .filter((sermon) => (
      !sermonSearchQuery ||
      sermon.title.toLowerCase().includes(sermonSearchQuery.toLowerCase())
    ));
  const displayedAddableSermons = sermonSearchQuery.trim().length === 0
    ? [...filteredAddableSermons].sort((first, second) => {
      const firstSelected = selectedSermonIds.has(first.id);
      const secondSelected = selectedSermonIds.has(second.id);
      if (firstSelected === secondSelected) {
        return 0;
      }
      return firstSelected ? -1 : 1;
    })
    : filteredAddableSermons;
  const selectedSermonCount = selectedSermonIds.size;
  const allVisibleSermonsSelected = filteredAddableSermons.length > 0 &&
    filteredAddableSermons.every((sermon) => selectedSermonIds.has(sermon.id));
  const someVisibleSermonsSelected = filteredAddableSermons.some((sermon) => selectedSermonIds.has(sermon.id));
  const listActionsDisabled = isSaving || isAddingSelectedSermons || isRemovingItem;

  return (
    <>
      <Head>
        <title>{title} | Upper Room Media</title>
        <meta property="og:title" content={title} key="title" />
      </Head>

      <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
        {/* Breadcrumbs */}
        <Breadcrumbs
          separator={<NavigateNextIcon fontSize="small" />}
          sx={{ mb: 3 }}
        >
          <Link href="/admin/series" passHref>
            <Typography
              component="span"
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                color: 'text.secondary',
                cursor: 'pointer',
                '&:hover': { color: 'primary.main' },
              }}
            >
              <CollectionsIcon fontSize="small" />
              Series
            </Typography>
          </Link>
          <Typography color="text.primary" fontWeight={500}>
            {series.name}
          </Typography>
        </Breadcrumbs>

        {/* Header */}
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            alignItems: { xs: 'flex-start', sm: 'center' },
            justifyContent: 'space-between',
            gap: 2,
            mb: 4,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Link href="/admin/series">
              <IconButton
                sx={{
                  bgcolor: 'background.paper',
                  border: 1,
                  borderColor: 'divider',
                  '&:hover': { borderColor: 'primary.main' },
                }}
              >
                <ArrowBackIcon />
              </IconButton>
            </Link>
            <Typography variant="h4" fontWeight={700}>
              {series.name}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1}>
            <Button
              variant="outlined"
              startIcon={<EditIcon />}
              onClick={() => setEditPopup(true)}
              size="medium"
            >
              Edit
            </Button>
            <Button
              variant="outlined"
              color="error"
              startIcon={<DeleteIcon />}
              onClick={() => setDeletePopup(true)}
              size="medium"
            >
              Delete
            </Button>
          </Stack>
        </Box>

        {/* Series Info Card */}
        <Card
          sx={{
            mb: 4,
            bgcolor: 'background.paper',
            border: 1,
            borderColor: 'divider',
            position: 'relative',
            overflow: 'visible',
            '&::before': {
              content: '""',
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 4,
              background: `linear-gradient(90deg, ${theme.palette.primary.main} 0%, ${theme.palette.primary.light} 100%)`,
              borderRadius: '12px 12px 0 0',
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
                image={series.images?.find((img) => img.type === 'square')}
                altName={series.name}
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
                  {derivedSeriesSubtitle}
                </Typography>
                {series.summary && (
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2, lineHeight: 1.7 }}>
                    {series.summary}
                  </Typography>
                )}
                <Box
                  sx={{
                    display: 'flex',
                    gap: 4,
                    pt: 2,
                    borderTop: 1,
                    borderColor: 'divider',
                  }}
                >
                  <Box
                    sx={{
                      width: 1,
                      display: 'flex',
                      justifyContent: 'space-between',
                    }}
                  >

                    <Box
                      sx={{
                        display: 'flex',
                        gap: 4,
                      }}
                    >
                      <Box>
                        <Typography variant="h5" fontWeight={700} color="primary.main">
                          {items.length}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Total Items
                        </Typography>
                      </Box>
                      <Box>
                        <Typography variant="h5" fontWeight={700} color="success.main">
                          {publishedItemsCount}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Published
                        </Typography>
                      </Box>
                    </Box>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
                      {series.subsplashId ? (
                        <Chip
                          icon={<CheckCircleIcon />}
                          label="Published to Subsplash"
                          color="success"
                          size="small"
                        />
                      ) : (
                        <Chip
                          icon={<PendingIcon />}
                          label="Not Published"
                          color="warning"
                          size="small"
                        />
                      )}
                    </Box>
                  </Box>
                </Box>
              </Box>
            </Box>
          </CardContent>
        </Card>

        {/* Items Section Header */}
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
            Series Items
          </Typography>
          <Stack direction="row" spacing={1.5}>
            {hasOrderChanges && (
              <>
                <Button
                  variant="outlined"
                  color="inherit"
                  startIcon={<UndoIcon />}
                  onClick={revertOrder}
                  disabled={isSaving}
                >
                  Revert
                </Button>
                <Button
                  variant="contained"
                  color="primary"
                  startIcon={isSaving ? <CircularProgress size={18} color="inherit" /> : <SaveIcon />}
                  onClick={saveOrderChanges}
                  disabled={isSaving}
                >
                  Save Order
                </Button>
              </>
            )}
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={() => {
                fetchAvailableSermons();
                setSermonSearchQuery('');
                setSelectedSermonIds(new Set());
                setAddItemPopup(true);
              }}
            >
              Add Item
            </Button>
          </Stack>
        </Box>

        {/* Items List */}
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
              No items in this series yet
            </Typography>
            <Typography variant="body2" color="text.disabled" sx={{ mb: 3 }}>
              Add sermons to this series to organize your content
            </Typography>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => {
                fetchAvailableSermons();
                setSermonSearchQuery('');
                setSelectedSermonIds(new Set());
                setAddItemPopup(true);
              }}
            >
              Add Your First Item
            </Button>
          </Card>
        ) : (
          <Card ref={containerRef} sx={{ overflow: 'hidden' }}>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
              modifiers={[restrictToVerticalAxis, restrictToContainer]}
            >
              <SortableContext
                items={items.map((item) => item.id)}
                strategy={verticalListSortingStrategy}
              >
                {items.map((item, index) => (
                  <Box key={item.id}>
                    <SortableItem
                      item={item}
                      index={index}
                      onOpenSermon={(id) => router.push(`/admin/sermons/${id}`)}
                      onRequestPublish={publishItemToSeries}
                      onRequestUnpublish={setUnpublishTarget}
                      onRequestRemove={setRemoveTarget}
                      isPublishing={publishingItemId === item.id}
                      isUnpublishing={unpublishingItemId === item.id}
                      actionsDisabled={listActionsDisabled}
                      canPublish={canPublishSermonToSeries(item.sermon)}
                      publishBlockedReason={SERIES_PUBLISH_BLOCKED_MESSAGE}
                    />
                    {index < items.length - 1 && <Divider />}
                  </Box>
                ))}
              </SortableContext>
            </DndContext>
          </Card>
        )}
      </Box>

      {/* Edit Series Popup */}
      <NewSeriesPopup
        open={editPopup}
        setOpen={setEditPopup}
        existingSeries={series}
        onSeriesCreated={(updatedSeries) => {
          setSeries(updatedSeries);
        }}
      />

      {/* Delete Confirmation Popup */}
      <DeleteEntityPopup
        entityBeingDeleted="series"
        handleDelete={handleDeleteSeries}
        deleteConfirmationPopup={deletePopup}
        setDeleteConfirmationPopup={setDeletePopup}
        isDeleting={isDeleting}
      />

      <Dialog
        open={Boolean(removeTarget)}
        onClose={() => !isRemovingItem && setRemoveTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Remove Sermon From Series?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {removeTarget?.sermon?.title || 'This sermon'} will be removed from this series.
            This also removes it from the Subsplash series when applicable.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoveTarget(null)} disabled={isRemovingItem}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={executeRemoveItem}
            startIcon={isRemovingItem ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon fontSize="small" />}
            disabled={isRemovingItem}
          >
            Remove
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(unpublishTarget)}
        onClose={() => !unpublishingItemId && setUnpublishTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Unpublish From Series?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {unpublishTarget?.sermon?.title || 'This sermon'} will be removed from the Subsplash series,
            but will stay in this app series.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUnpublishTarget(null)} disabled={Boolean(unpublishingItemId)}>
            Cancel
          </Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() => {
              if (unpublishTarget) {
                unpublishItemFromSeries(unpublishTarget);
              }
            }}
            startIcon={unpublishingItemId ? <CircularProgress size={16} color="inherit" /> : <CloudOffIcon fontSize="small" />}
            disabled={!!unpublishingItemId}
          >
            Unpublish
          </Button>
        </DialogActions>
      </Dialog>

      {/* Add Item Dialog */}
      <Dialog
        open={addItemPopup}
        onClose={closeAddItemDialog}
        maxWidth="sm"
        fullWidth
        PaperProps={{
          sx: {
            maxHeight: '80vh',
          },
        }}
      >
        <DialogTitle sx={{ pb: 1 }}>
          Add Item to Series
        </DialogTitle>
        <DialogContent>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 1, mb: 1 }}>
            <FormControlLabel
              label="Select all visible"
              control={(
                <Checkbox
                  checked={allVisibleSermonsSelected}
                  indeterminate={!allVisibleSermonsSelected && someVisibleSermonsSelected}
                  onChange={(event) => {
                    if (isAddingSelectedSermons) {
                      return;
                    }
                    setSelectedSermonIds((previousSelected) => {
                      const nextSelected = new Set(previousSelected);
                      if (event.target.checked) {
                        filteredAddableSermons.forEach((sermon) => nextSelected.add(sermon.id));
                      } else {
                        filteredAddableSermons.forEach((sermon) => nextSelected.delete(sermon.id));
                      }
                      return nextSelected;
                    });
                  }}
                  disabled={isAddingSelectedSermons || filteredAddableSermons.length === 0}
                />
              )}
            />
            <Chip
              size="small"
              color={selectedSermonCount > 0 ? 'primary' : 'default'}
              label={`${selectedSermonCount} selected`}
            />
          </Stack>

          <TextField
            fullWidth
            size="small"
            placeholder="Search sermons by title..."
            value={sermonSearchQuery}
            onChange={(e) => setSermonSearchQuery(e.target.value)}
            sx={{ mt: 1, mb: 2 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon color="action" />
                </InputAdornment>
              ),
            }}
          />
          {loadingSermons ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress />
            </Box>
          ) : filteredAddableSermons.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 4 }}>
              <Typography color="text.secondary">
                {availableSermons.length === 0
                  ? 'No available sermons to add. Upload some sermons first!'
                  : `No sermons found matching "${sermonSearchQuery}".`}
              </Typography>
            </Box>
          ) : (
            <Box sx={{ maxHeight: 400, overflow: 'auto' }}>
              {displayedAddableSermons.map((sermon) => (
                <Box
                  key={sermon.id}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                    p: 1.5,
                    borderRadius: 2,
                    cursor: isAddingSelectedSermons ? 'default' : 'pointer',
                    transition: 'background-color 0.15s ease',
                    bgcolor: selectedSermonIds.has(sermon.id) ? alpha(theme.palette.primary.main, 0.08) : 'transparent',
                    '&:hover': {
                      bgcolor: isAddingSelectedSermons
                        ? 'transparent'
                        : (selectedSermonIds.has(sermon.id)
                          ? alpha(theme.palette.primary.main, 0.12)
                          : 'action.hover'),
                    },
                  }}
                  onClick={() => {
                    if (isAddingSelectedSermons) {
                      return;
                    }
                    setSelectedSermonIds((previousSelected) => {
                      const nextSelected = new Set(previousSelected);
                      if (nextSelected.has(sermon.id)) {
                        nextSelected.delete(sermon.id);
                      } else {
                        nextSelected.add(sermon.id);
                      }
                      return nextSelected;
                    });
                  }}
                >
                  <Checkbox
                    checked={selectedSermonIds.has(sermon.id)}
                    disabled={isAddingSelectedSermons}
                    onChange={(event) => {
                      event.stopPropagation();
                      if (isAddingSelectedSermons) {
                        return;
                      }
                      setSelectedSermonIds((previousSelected) => {
                        const nextSelected = new Set(previousSelected);
                        if (event.target.checked) {
                          nextSelected.add(sermon.id);
                        } else {
                          nextSelected.delete(sermon.id);
                        }
                        return nextSelected;
                      });
                    }}
                  />
                  <AvatarWithDefaultImage
                    image={sermon.images?.find((img) => img.type === 'square')}
                    altName={sermon.title}
                    width={48}
                    height={48}
                    borderRadius={6}
                  />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography
                      variant="body2"
                      fontWeight={500}
                      sx={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {sermon.title}
                    </Typography>
                    {sermon.dateString && (
                      <Typography variant="caption" color="text.secondary">
                        {sermon.dateString}
                      </Typography>
                    )}
                  </Box>
                  <IconButton size="small" color="primary" disabled>
                    {activeAddingSermonId === sermon.id
                      ? <CircularProgress size={16} />
                      : <AddIcon />}
                  </IconButton>
                </Box>
              ))}
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={closeAddItemDialog}
            disabled={isAddingSelectedSermons}
          >
            Close
          </Button>
          <Button
            variant="contained"
            startIcon={isAddingSelectedSermons ? <CircularProgress size={16} color="inherit" /> : <AddIcon fontSize="small" />}
            disabled={selectedSermonCount === 0 || isAddingSelectedSermons}
            onClick={addSelectedSermons}
          >
            {isAddingSelectedSermons
              ? 'Adding...'
              : `Add ${selectedSermonCount} sermon${selectedSermonCount === 1 ? '' : 's'}`}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

const ProtectedSeriesDetailsPage = () => {
  const { user } = useAuth();

  if (!user?.canPublish()) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '50vh',
        }}
      >
        <Typography color="text.secondary">
          You don&apos;t have permission to view this page.
        </Typography>
      </Box>
    );
  }

  return <SeriesDetailsPage />;
};

ProtectedSeriesDetailsPage.PageLayout = AppLayout;

export default ProtectedSeriesDetailsPage;
