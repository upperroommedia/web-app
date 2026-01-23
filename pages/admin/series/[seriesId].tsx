/**
 * Series Details Page
 * - View and edit series metadata
 * - Manage items in the series (add, remove, reorder)
 * - Show publish status for each item
 */
import { useRouter } from 'next/router';
import Head from 'next/head';
import { useCallback, useEffect, useState } from 'react';
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
import SearchIcon from '@mui/icons-material/Search';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PendingIcon from '@mui/icons-material/Pending';
import SaveIcon from '@mui/icons-material/Save';
import Link from 'next/link';

import AdminLayout from '../../../layout/adminLayout';
import AvatarWithDefaultImage from '../../../components/AvatarWithDefaultImage';
import NewSeriesPopup from '../../../components/NewSeriesPopup';
import DeleteEntityPopup from '../../../components/DeleteEntityPopup';
import firestore, { doc, getDoc, collection, getDocs, query, orderBy, where, limit, deleteDoc, setDoc, updateDoc } from '../../../firebase/firestore';
import { Series, seriesConverter } from '../../../types/Series';
import { SeriesItem, seriesItemConverter } from '../../../types/SeriesItem';
import { Sermon, sermonStatusType } from '../../../types/SermonTypes';
import { uploadStatus } from '../../../types/SermonTypes';
import useAuth from '../../../context/user/UserContext';
import { createFunctionV2 } from '../../../utils/createFunction';
import { ReorderSeriesItemsInputType, ReorderSeriesItemsOutputType } from '../../../functions/src/reorderSeriesItems';
import { serverTimestamp } from 'firebase/firestore';

interface SeriesItemWithSermon extends SeriesItem {
  sermon?: Sermon;
}

const SeriesDetailsPage = () => {
  const router = useRouter();
  const { user } = useAuth();
  const seriesId = router.query.seriesId as string;

  const [series, setSeries] = useState<Series | null>(null);
  const [items, setItems] = useState<SeriesItemWithSermon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editPopup, setEditPopup] = useState(false);
  const [deletePopup, setDeletePopup] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hasOrderChanges, setHasOrderChanges] = useState(false);
  const [addItemPopup, setAddItemPopup] = useState(false);
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

  // Move item up in the list
  const moveItemUp = (index: number) => {
    if (index === 0) return;
    const newItems = [...items];
    [newItems[index - 1], newItems[index]] = [newItems[index], newItems[index - 1]];
    // Update positions
    newItems.forEach((item, i) => {
      item.position = i + 1;
    });
    setItems(newItems);
    setHasOrderChanges(true);
  };

  // Move item down in the list
  const moveItemDown = (index: number) => {
    if (index === items.length - 1) return;
    const newItems = [...items];
    [newItems[index], newItems[index + 1]] = [newItems[index + 1], newItems[index]];
    // Update positions
    newItems.forEach((item, i) => {
      item.position = i + 1;
    });
    setItems(newItems);
    setHasOrderChanges(true);
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
      setHasOrderChanges(false);
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

      // Update local state
      setItems((prev) => prev.filter((item) => item.id !== itemId));
      
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
        seriesId: seriesId,
      });

      // Update series item count
      if (series) {
        await updateDoc(doc(firestore, 'series', seriesId), {
          itemCount: (series.itemCount || 0) + 1,
          updatedAt: serverTimestamp(),
        });
        setSeries((prev) => prev ? { ...prev, itemCount: (prev.itemCount || 0) + 1 } : prev);
      }

      // Update local state
      const newItem: SeriesItemWithSermon = {
        id: sermon.id,
        position: newPosition,
        publishedToSubsplash: false,
        sermonSubsplashId: sermon.subsplashId,
        addedAt: null,
        sermon,
      };
      setItems((prev) => [...prev, newItem]);
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
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="50vh">
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="50vh">
        <Alert severity="error">{error}</Alert>
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

      <Box p={3} maxWidth="1200px" mx="auto">
        {/* Header */}
        <Box display="flex" alignItems="center" gap={2} mb={3}>
          <Link href="/admin/series">
            <IconButton>
              <ArrowBackIcon />
            </IconButton>
          </Link>
          <Typography variant="h4" flex={1}>
            {series.name}
          </Typography>
          <Box display="flex" gap={1}>
            <Button
              variant="outlined"
              startIcon={<EditIcon />}
              onClick={() => setEditPopup(true)}
            >
              Edit
            </Button>
            <Button
              variant="outlined"
              color="error"
              startIcon={<DeleteIcon />}
              onClick={() => setDeletePopup(true)}
            >
              Delete
            </Button>
          </Box>
        </Box>

        {/* Series Info Card */}
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Box display="flex" gap={3}>
              <AvatarWithDefaultImage
                image={series.images?.find((img) => img.type === 'square')}
                altName={series.name}
                width={120}
                height={120}
                borderRadius={12}
              />
              <Box flex={1}>
                <Box display="flex" gap={1} mb={1}>
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
                  <Typography variant="subtitle1" color="text.secondary" mb={1}>
                    {series.subtitle}
                  </Typography>
                )}
                {series.summary && (
                  <Typography variant="body2" color="text.secondary">
                    {series.summary}
                  </Typography>
                )}
                <Box display="flex" gap={3} mt={2}>
                  <Typography variant="body2">
                    <strong>{items.length}</strong> items
                  </Typography>
                  <Typography variant="body2">
                    <strong>{items.filter((i) => i.publishedToSubsplash).length}</strong> published
                  </Typography>
                </Box>
              </Box>
            </Box>
          </CardContent>
        </Card>

        {/* Items Section */}
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
          <Typography variant="h6">Series Items</Typography>
          <Box display="flex" gap={1}>
            {hasOrderChanges && (
              <Button
                variant="contained"
                color="primary"
                startIcon={isSaving ? <CircularProgress size={20} /> : <SaveIcon />}
                onClick={saveOrderChanges}
                disabled={isSaving}
              >
                Save Order
              </Button>
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
          </Box>
        </Box>

        {items.length === 0 ? (
          <Card>
            <CardContent>
              <Box display="flex" flexDirection="column" alignItems="center" py={4}>
                <Typography color="text.secondary" mb={2}>
                  No items in this series yet
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
              </Box>
            </CardContent>
          </Card>
        ) : (
          <Card>
            {items.map((item, index) => (
              <Box key={item.id}>
                <Box
                  display="flex"
                  alignItems="center"
                  gap={2}
                  p={2}
                  sx={{
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ width: 30, textAlign: 'center' }}
                  >
                    {index + 1}
                  </Typography>

                  <AvatarWithDefaultImage
                    image={item.sermon?.images?.find((img) => img.type === 'square')}
                    altName={item.sermon?.title || 'Sermon'}
                    width={50}
                    height={50}
                    borderRadius={6}
                  />

                  <Box flex={1}>
                    <Typography variant="subtitle2">
                      {item.sermon?.title || `Sermon ${item.id}`}
                    </Typography>
                    <Box display="flex" gap={1} alignItems="center">
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
                          sx={{ height: 20, '& .MuiChip-label': { px: 1, py: 0 } }}
                        />
                      ) : (
                        <Chip
                          icon={<PendingIcon />}
                          label="Pending"
                          size="small"
                          color="warning"
                          variant="outlined"
                          sx={{ height: 20, '& .MuiChip-label': { px: 1, py: 0 } }}
                        />
                      )}
                    </Box>
                  </Box>

                  <Box display="flex" gap={0.5}>
                    <Tooltip title="Move up">
                      <span>
                        <IconButton
                          size="small"
                          onClick={() => moveItemUp(index)}
                          disabled={index === 0}
                        >
                          <ArrowUpwardIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title="Move down">
                      <span>
                        <IconButton
                          size="small"
                          onClick={() => moveItemDown(index)}
                          disabled={index === items.length - 1}
                        >
                          <ArrowDownwardIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title="Remove from series">
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => removeItem(item.id)}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </Box>
                {index < items.length - 1 && <Divider />}
              </Box>
            ))}
          </Card>
        )}
      </Box>

      {/* Edit Series Popup */}
      <NewSeriesPopup
        open={editPopup}
        setOpen={setEditPopup}
        existingSeries={series}
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
      {addItemPopup && (
        <Box
          sx={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            bgcolor: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1300,
          }}
          onClick={() => {
            setSermonSearchQuery('');
            setAddItemPopup(false);
          }}
        >
          <Card
            sx={{ maxWidth: 600, maxHeight: '80vh', overflow: 'auto', m: 2 }}
            onClick={(e) => e.stopPropagation()}
          >
            <CardContent>
              <Typography variant="h6" mb={2}>
                Add Item to Series
              </Typography>
              <TextField
                fullWidth
                size="small"
                placeholder="Search sermons by title..."
                value={sermonSearchQuery}
                onChange={(e) => setSermonSearchQuery(e.target.value)}
                sx={{ mb: 2 }}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon color="action" />
                    </InputAdornment>
                  ),
                }}
              />
              {loadingSermons ? (
                <Box display="flex" justifyContent="center" p={3}>
                  <CircularProgress />
                </Box>
              ) : availableSermons.length === 0 ? (
                <Typography color="text.secondary">
                  No available sermons to add. Upload some sermons first!
                </Typography>
              ) : (
                <Box display="flex" flexDirection="column" gap={1} sx={{ maxHeight: 400, overflow: 'auto' }}>
                  {availableSermons
                    .filter((sermon) => !items.some((item) => item.id === sermon.id))
                    .filter((sermon) => 
                      !sermonSearchQuery || 
                      sermon.title.toLowerCase().includes(sermonSearchQuery.toLowerCase())
                    )
                    .map((sermon) => (
                      <Box
                        key={sermon.id}
                        display="flex"
                        alignItems="center"
                        gap={2}
                        p={1}
                        sx={{
                          borderRadius: 1,
                          cursor: 'pointer',
                          '&:hover': { bgcolor: 'action.hover' },
                        }}
                        onClick={() => addItemToSeries(sermon)}
                      >
                        <AvatarWithDefaultImage
                          image={sermon.images?.find((img) => img.type === 'square')}
                          altName={sermon.title}
                          width={40}
                          height={40}
                          borderRadius={4}
                        />
                        <Box flex={1}>
                          <Typography variant="body2">{sermon.title}</Typography>
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
                    <Typography color="text.secondary" textAlign="center" py={2}>
                      No sermons found matching &quot;{sermonSearchQuery}&quot;
                    </Typography>
                  )}
                </Box>
              )}
              <Box display="flex" justifyContent="flex-end" mt={2}>
                <Button onClick={() => {
                  setSermonSearchQuery('');
                  setAddItemPopup(false);
                }}>Close</Button>
              </Box>
            </CardContent>
          </Card>
        </Box>
      )}
    </>
  );
};

SeriesDetailsPage.PageLayout = AdminLayout;

const ProtectedSeriesDetailsPage = () => {
  const { user } = useAuth();
  
  if (!user?.canPublish()) {
    return (
      <Box display="flex" justifyContent="center" padding={3}>
        <Typography>You don&apos;t have permission to view this page.</Typography>
      </Box>
    );
  }
  
  return <SeriesDetailsPage />;
};

export default ProtectedSeriesDetailsPage;
