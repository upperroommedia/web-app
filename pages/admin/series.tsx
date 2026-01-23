/**
 * Admin page for managing media series
 * - Publishers see only their own series
 * - Admins see all series with owner info
 * - Click to navigate to series details page
 */
import Box from '@mui/material/Box';
import AppLayout from '../../layout/AppLayout';
import Button from '@mui/material/Button';
import firestore, { collection, deleteDoc, doc, limit, orderBy, query, where, getDocs, QueryConstraint } from '../../firebase/firestore';
import DeleteEntityPopup from '../../components/DeleteEntityPopup';
import { useCallback, useEffect, useState } from 'react';
import NewSeriesPopup from '../../components/NewSeriesPopup';
import AvatarWithDefaultImage from '../../components/AvatarWithDefaultImage';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { createFunctionV2 } from '../../utils/createFunction';
import { DeleteSeriesInputType, DeleteSeriesOutputType } from '../../functions/src/deleteSeries';
import Link from 'next/link';
import Card from '@mui/material/Card';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PendingIcon from '@mui/icons-material/Pending';
import AddIcon from '@mui/icons-material/Add';
import CollectionsIcon from '@mui/icons-material/Collections';
import { Series, seriesConverter } from '../../types/Series';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import InputLabel from '@mui/material/InputLabel';
import FormControl from '@mui/material/FormControl';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import InputAdornment from '@mui/material/InputAdornment';
import SearchIcon from '@mui/icons-material/Search';
import useAuth from '../../context/user/UserContext';
import { alpha, useTheme } from '@mui/material/styles';

const ITEMS_PER_PAGE = 20;

type FilterType = 'all' | 'published' | 'draft';

const AdminSeriesPage = () => {
  const { user } = useAuth();
  const theme = useTheme();
  const [seriesList, setSeriesList] = useState<Series[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filter, setFilter] = useState<FilterType>('all');
  const [newSeriesPopup, setNewSeriesPopup] = useState<boolean>(false);
  const [editSeriesPopup, setEditSeriesPopup] = useState<boolean>(false);
  const [deleteSeriesPopup, setDeleteSeriesPopup] = useState<boolean>(false);
  const [selectedSeries, setSelectedSeries] = useState<Series | undefined>();
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const disableButtons = isDeleting;

  const isAdmin = user?.isAdmin() ?? false;

  const fetchSeries = useCallback(async () => {
    if (!user) return;

    setLoading(true);
    setError(null);

    try {
      const queryConstraints: QueryConstraint[] = [
        orderBy('updatedAt', 'desc'),
        limit(ITEMS_PER_PAGE * 5), // Fetch more to allow client-side filtering
      ];

      // Non-admins can only see their own series
      if (!isAdmin) {
        queryConstraints.push(where('ownerId', '==', user.uid));
      }

      const seriesQuery = query(
        collection(firestore, 'series'),
        ...queryConstraints
      ).withConverter(seriesConverter);

      const snapshot = await getDocs(seriesQuery);
      const allSeries = snapshot.docs.map((doc) => doc.data());
      setSeriesList(allSeries);
    } catch (err: any) {
      console.error('Error fetching series:', err);
      setError(err.message || 'Failed to fetch series');
    }

    setLoading(false);
  }, [user, isAdmin]);

  useEffect(() => {
    fetchSeries();
  }, [fetchSeries]);

  const handleSeriesDelete = async () => {
    if (!selectedSeries) return;

    try {
      setIsDeleting(true);

      // If the series has a subsplashId, delete from Subsplash first
      if (selectedSeries.subsplashId) {
        const deleteSeries = createFunctionV2<DeleteSeriesInputType, DeleteSeriesOutputType>('deleteseries');
        await deleteSeries({ firestoreId: selectedSeries.id });
      } else {
        // Only delete from Firestore
        await deleteDoc(doc(firestore, 'series', selectedSeries.id));
      }

      setSeriesList((prev) => prev.filter((s) => s.id !== selectedSeries.id));
      setDeleteSeriesPopup(false);
    } catch (err: any) {
      console.error('Error deleting series:', err);
      alert(`Error deleting series: ${err.message || 'Unknown error'}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSeriesCreated = (newSeries: Series) => {
    setSeriesList((prev) => [newSeries, ...prev]);
  };

  // Filter series based on search query and filter type
  const filteredSeries = seriesList.filter((series) => {
    // Search filter
    const matchesSearch = searchQuery
      ? series.name.toLowerCase().includes(searchQuery.toLowerCase())
      : true;

    // Status filter
    let matchesFilter = true;
    if (filter === 'published') {
      matchesFilter = !!series.subsplashId;
    } else if (filter === 'draft') {
      matchesFilter = !series.subsplashId;
    }

    return matchesSearch && matchesFilter;
  }).slice(0, ITEMS_PER_PAGE);

  if (!user) {
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

  return (
    <>
      <Box sx={{ maxWidth: 1200, mx: 'auto', width: '100%' }}>
        {error ? (
          <Box sx={{ textAlign: 'center', py: 4 }}>
            <Typography color="error">{`Error: ${error}`}</Typography>
          </Box>
        ) : loading ? (
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
        ) : (
          <>
            {/* Header */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', sm: 'row' },
                justifyContent: 'space-between',
                alignItems: { xs: 'flex-start', sm: 'center' },
                gap: 2,
                mb: 4,
              }}
            >
              <Typography variant="h4" fontWeight={700}>
                Manage Series
              </Typography>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => setNewSeriesPopup(true)}
              >
                Add Series
              </Button>
            </Box>

            {/* Filters */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', sm: 'row' },
                gap: 2,
                mb: 3,
              }}
            >
              <TextField
                placeholder="Search series by name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                size="small"
                sx={{ flex: 2 }}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon color="action" />
                    </InputAdornment>
                  ),
                }}
              />
              <FormControl size="small" sx={{ flex: 1, minWidth: 160 }}>
                <InputLabel id="status-filter-label">Status</InputLabel>
                <Select
                  value={filter}
                  label="Status"
                  labelId="status-filter-label"
                  onChange={(e) => setFilter(e.target.value as FilterType)}
                >
                  <MenuItem value="all">All</MenuItem>
                  <MenuItem value="published">Published to Subsplash</MenuItem>
                  <MenuItem value="draft">Draft (Not Published)</MenuItem>
                </Select>
              </FormControl>
            </Box>

            {/* Series List */}
            {filteredSeries.length === 0 ? (
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
                  {searchQuery || filter !== 'all'
                    ? 'No series found matching your filters'
                    : 'No series yet'}
                </Typography>
                <Typography variant="body2" color="text.disabled" sx={{ mb: 3 }}>
                  {searchQuery || filter !== 'all'
                    ? 'Try adjusting your search or filter'
                    : 'Create your first series to organize your content'}
                </Typography>
                {!searchQuery && filter === 'all' && (
                  <Button
                    variant="contained"
                    startIcon={<AddIcon />}
                    onClick={() => setNewSeriesPopup(true)}
                  >
                    Create Your First Series
                  </Button>
                )}
              </Card>
            ) : (
              <Card>
                {filteredSeries.map((series, index) => (
                  <Box key={series.id}>
                    <Link href={`/admin/series/${series.id}`} style={{ textDecoration: 'none' }}>
                      <Box
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          p: { xs: 2, sm: 2.5 },
                          gap: 2,
                          cursor: 'pointer',
                          transition: 'background-color 0.15s ease',
                          '&:hover': { bgcolor: 'action.hover' },
                        }}
                      >
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1, minWidth: 0 }}>
                          <AvatarWithDefaultImage
                            image={series.images?.find((image) => image.type === 'square')}
                            altName={`Image of Series: ${series.name}`}
                            width={64}
                            height={64}
                            borderRadius={10}
                            sx={{ flexShrink: 0 }}
                          />
                          <Box sx={{ minWidth: 0 }}>
                            <Typography
                              variant="subtitle1"
                              fontWeight={600}
                              sx={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {series.name}
                            </Typography>
                            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mt: 0.5 }}>
                              <Typography variant="body2" color="text.secondary">
                                {series.itemCount || 0} items
                              </Typography>
                              {series.subsplashId ? (
                                <Chip
                                  icon={<CheckCircleIcon />}
                                  label="Published"
                                  size="small"
                                  color="success"
                                  variant="outlined"
                                  sx={{ height: 22 }}
                                />
                              ) : (
                                <Chip
                                  icon={<PendingIcon />}
                                  label="Draft"
                                  size="small"
                                  color="warning"
                                  variant="outlined"
                                  sx={{ height: 22 }}
                                />
                              )}
                              {isAdmin && series.ownerId !== user.uid && (
                                <Chip
                                  label={`Owner: ${series.ownerId.slice(0, 8)}...`}
                                  size="small"
                                  variant="outlined"
                                  sx={{ height: 22 }}
                                />
                              )}
                            </Box>
                          </Box>
                        </Box>

                        <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
                          <Tooltip title="Edit Series">
                            <span>
                              <IconButton
                                disabled={disableButtons}
                                aria-label="edit series"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setSelectedSeries(series);
                                  setEditSeriesPopup(true);
                                }}
                                sx={{
                                  '&:hover': {
                                    bgcolor: alpha(theme.palette.primary.main, 0.15),
                                    color: 'primary.main',
                                  },
                                }}
                              >
                                <EditIcon />
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title="Delete Series">
                            <span>
                              <IconButton
                                disabled={disableButtons}
                                aria-label="delete series"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setSelectedSeries(series);
                                  setDeleteSeriesPopup(true);
                                }}
                                sx={{
                                  color: 'error.main',
                                  '&:hover': {
                                    bgcolor: alpha(theme.palette.error.main, 0.15),
                                  },
                                }}
                              >
                                <DeleteIcon />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Stack>
                      </Box>
                    </Link>
                    {index < filteredSeries.length - 1 && <Divider />}
                  </Box>
                ))}
              </Card>
            )}
          </>
        )}
      </Box>

      <DeleteEntityPopup
        entityBeingDeleted="series"
        handleDelete={handleSeriesDelete}
        deleteConfirmationPopup={deleteSeriesPopup}
        setDeleteConfirmationPopup={setDeleteSeriesPopup}
        isDeleting={isDeleting}
      />

      <NewSeriesPopup
        open={newSeriesPopup}
        setOpen={setNewSeriesPopup}
        onSeriesCreated={handleSeriesCreated}
      />

      {editSeriesPopup && selectedSeries && (
        <NewSeriesPopup
          open={editSeriesPopup}
          setOpen={setEditSeriesPopup}
          existingSeries={selectedSeries}
        />
      )}
    </>
  );
};

const ProtectedAdminSeriesPage = () => {
  const { user } = useAuth();
  
  // Allow both admins and publishers to see this page
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
  
  return <AdminSeriesPage />;
};

ProtectedAdminSeriesPage.PageLayout = AppLayout;

export default ProtectedAdminSeriesPage;
