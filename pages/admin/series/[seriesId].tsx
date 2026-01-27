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
import firestore, { doc, getDoc, collection, getDocs, query, orderBy, where, limit, deleteDoc, setDoc, updateDoc } from '../../../firebase/firestore';
import { Series, seriesConverter } from '../../../types/Series';
import { SeriesItem, seriesItemConverter } from '../../../types/SeriesItem';
import { Sermon } from '../../../types/SermonTypes';
import useAuth from '../../../context/user/UserContext';
import { createFunctionV2 } from '../../../utils/createFunction';
import { ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType } from '../../../functions/src/reorderSeriesItems';
import { serverTimestamp } from 'firebase/firestore';

interface SeriesItemWithSermon extends SeriesItem {
  sermon?: Sermon;
}

interface SortableItemProps {
  item: SeriesItemWithSermon;
  index: number;
  onRemove: (id: string) => void;
}

const SortableItem = ({ item, index, onRemove }: SortableItemProps) => {
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

  return (
    <Box
      ref={setNodeRef}
      style={style}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: { xs: 1.5, sm: 2 },
        p: { xs: 2, sm: 2.5 },
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
              label="Draft (Not Published)"
              size="small"
              color="warning"
              variant="outlined"
              sx={{ height: 22, '& .MuiChip-label': { px: 1 } }}
            />
          )}
        </Box>
      </Box>

      <Tooltip title="Remove from series">
        <IconButton
          size="small"
          onClick={() => onRemove(item.id)}
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
        orderBy('position', 'asc')
      ).withConverter(seriesItemConverter);

      const itemsSnapshot = await getDocs(itemsQuery);
      const itemsData = itemsSnapshot.docs.map((doc) => doc.data());

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
      originalItemsRef.current = itemsWithSermons;
    } catch (err: any) {
      console.error('Error fetching series:', err);
      setError(err.message || 'Failed to fetch series');
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
          item.position = i + 1;
        });
        return newItems;
      });
    }
  };

  // Revert to original order
  const revertOrder = () => {
    setItems([...originalItemsRef.current]);
  };

  // Save order changes
  const saveOrderChanges = async () => {
    if (!series || !hasOrderChanges) return;

    setIsSaving(true);
    try {
      // If series is published to Subsplash, use the reorder function
      if (series.subsplashId) {
        const reorderFunction = createFunctionV2<ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType>(
          'reorderseriesitems'
        );
        await reorderFunction({
          firestoreSeriesId: seriesId,
          itemOrder: items.map((item, index) => ({
            mediaItemId: item.sermonSubsplashId || item.id,
            position: index + 1,
          })),
        });
      } else {
        // Just update Firestore positions (gracefully handle missing items)
        await Promise.all(
          items.map(async (item, index) => {
            const itemRef = doc(firestore, `series/${seriesId}/seriesItems`, item.id);
            try {
              await updateDoc(itemRef, { position: index + 1 });
            } catch (err: any) {
              // Item might have been deleted by another user - skip it
              if (err?.code === 'not-found' || err?.message?.includes('NOT_FOUND')) {
                console.warn(`SeriesItem ${item.id} not found - may have been removed`);
              } else {
                throw err;
              }
            }
          })
        );
      }
      // Update original order reference after successful save
      originalItemsRef.current = [...items];
    } catch (err: any) {
      console.error('Error saving order:', err);
      alert(`Error saving order: ${err.message || 'Unknown error'}`);
    }
    setIsSaving(false);
  };

  // Remove item from series
  const removeItem = async (itemId: string) => {
    if (!confirm('Are you sure you want to remove this item from the series?')) return;

    try {
      // Delete from Firestore seriesItems subcollection
      await deleteDoc(doc(firestore, `series/${seriesId}/seriesItems`, itemId));

      // Update sermon to remove seriesId (gracefully handle if sermon was already deleted)
      try {
        await updateDoc(doc(firestore, 'sermons', itemId), {
          seriesId: null,
        });
      } catch (sermonErr: any) {
        // Sermon might have been deleted - that's okay, just log and continue
        if (sermonErr?.code === 'not-found' || sermonErr?.message?.includes('NOT_FOUND')) {
          console.warn(`Sermon ${itemId} not found - may have been deleted`);
        } else {
          // Re-throw unexpected errors
          throw sermonErr;
        }
      }

      // Update local state and original reference
      setItems((prev) => prev.filter((item) => item.id !== itemId));
      originalItemsRef.current = originalItemsRef.current.filter((item) => item.id !== itemId);
      
      // Update series item count
      if (series) {
        await updateDoc(doc(firestore, 'series', seriesId), {
          itemCount: (series.itemCount || 1) - 1,
          updatedAt: serverTimestamp(),
        });
        setSeries((prev) => prev ? { ...prev, itemCount: (prev.itemCount || 1) - 1 } : prev);
      }
    } catch (err: any) {
      console.error('Error removing item:', err);
      alert(`Error removing item: ${err.message || 'Unknown error'}`);
    }
  };

  // Add item to series
  const addItemToSeries = async (sermon: Sermon) => {
    try {
      const newPosition = items.length + 1;
      
      // Verify sermon still exists before adding
      const sermonDoc = await getDoc(doc(firestore, 'sermons', sermon.id));
      if (!sermonDoc.exists()) {
        alert('This sermon no longer exists. It may have been deleted.');
        // Remove from available sermons list
        setAvailableSermons((prev) => prev.filter((s) => s.id !== sermon.id));
        return;
      }

      // Verify series still exists
      const seriesDoc = await getDoc(doc(firestore, 'series', seriesId));
      if (!seriesDoc.exists()) {
        alert('This series no longer exists. Redirecting to series list.');
        router.push('/admin/series');
        return;
      }

      // Add to series items collection
      // Only include sermonSubsplashId if it exists (Firestore doesn't accept undefined values)
      const seriesItemData: Partial<SeriesItem> = {
        id: sermon.id,
        position: newPosition,
        publishedToSubsplash: false,
        ...(sermon.subsplashId !== undefined && { sermonSubsplashId: sermon.subsplashId }),
      };

      await setDoc(
        doc(firestore, `series/${seriesId}/seriesItems`, sermon.id),
        {
          ...seriesItemData,
          addedAt: serverTimestamp(),
        }
      );

      // Update sermon with seriesId
      await updateDoc(doc(firestore, 'sermons', sermon.id), {
        seriesId,
      });

      // Update series item count
      if (series) {
        await updateDoc(doc(firestore, 'series', seriesId), {
          itemCount: (series.itemCount || 0) + 1,
          updatedAt: serverTimestamp(),
        });
        setSeries((prev) => prev ? { ...prev, itemCount: (prev.itemCount || 0) + 1 } : prev);
      }

      // Update local state and original reference
      const newItem: SeriesItemWithSermon = {
        id: sermon.id,
        position: newPosition,
        publishedToSubsplash: false,
        sermonSubsplashId: sermon.subsplashId,
        addedAt: null,
        sermon,
      };
      setItems((prev) => [...prev, newItem]);
      originalItemsRef.current = [...originalItemsRef.current, newItem];
      setAddItemPopup(false);
    } catch (err: any) {
      console.error('Error adding item:', err);
      alert(`Error adding item: ${err.message || 'Unknown error'}`);
    }
  };

  // Delete series
  const handleDeleteSeries = async () => {
    if (!series) return;

    setIsDeleting(true);
    try {
      // Delete series from Firestore
      await deleteDoc(doc(firestore, 'series', seriesId));
      router.push('/admin/series');
    } catch (err: any) {
      console.error('Error deleting series:', err);
      alert(`Error deleting series: ${err.message || 'Unknown error'}`);
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
                      label="Draft (Not Published)"
                      color="warning"
                      size="small"
                    />
                  )}
                </Box>
                {series.subtitle && (
                  <Typography variant="h6" color="text.secondary" sx={{ mb: 1, fontWeight: 400 }}>
                    {series.subtitle}
                  </Typography>
                )}
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
                      {items.filter((i) => i.publishedToSubsplash).length}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Published
                    </Typography>
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
                      onRemove={removeItem}
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

      {/* Add Item Dialog */}
      <Dialog
        open={addItemPopup}
        onClose={() => {
          setSermonSearchQuery('');
          setAddItemPopup(false);
        }}
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
          ) : availableSermons.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 4 }}>
              <Typography color="text.secondary">
                No available sermons to add. Upload some sermons first!
              </Typography>
            </Box>
          ) : (
            <Box sx={{ maxHeight: 400, overflow: 'auto' }}>
              {availableSermons
                .filter((sermon) => !items.some((item) => item.id === sermon.id))
                .filter((sermon) => 
                  !sermonSearchQuery || 
                  sermon.title.toLowerCase().includes(sermonSearchQuery.toLowerCase())
                )
                .map((sermon) => (
                  <Box
                    key={sermon.id}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 2,
                      p: 1.5,
                      borderRadius: 2,
                      cursor: 'pointer',
                      transition: 'background-color 0.15s ease',
                      '&:hover': { bgcolor: 'action.hover' },
                    }}
                    onClick={() => addItemToSeries(sermon)}
                  >
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
                    <IconButton size="small" color="primary">
                      <AddIcon />
                    </IconButton>
                  </Box>
                ))}
              {sermonSearchQuery && availableSermons
                .filter((sermon) => !items.some((item) => item.id === sermon.id))
                .filter((sermon) => sermon.title.toLowerCase().includes(sermonSearchQuery.toLowerCase()))
                .length === 0 && (
                <Box sx={{ textAlign: 'center', py: 3 }}>
                  <Typography color="text.secondary">
                    No sermons found matching &quot;{sermonSearchQuery}&quot;
                  </Typography>
                </Box>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => {
              setSermonSearchQuery('');
              setAddItemPopup(false);
            }}
          >
            Close
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
