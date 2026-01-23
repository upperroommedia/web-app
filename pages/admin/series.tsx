/**
 * Admin page for managing media series
 * - Publishers see only their own series
 * - Admins see all series with owner info
 * - Click to navigate to series details page
 */
import Box from '@mui/material/Box';
import AdminLayout from '../../layout/adminLayout';
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
import MaterialList from '@mui/material/List';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PendingIcon from '@mui/icons-material/Pending';
import ListItemButton from '@mui/material/ListItemButton';
import { Series, seriesConverter } from '../../types/Series';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import InputLabel from '@mui/material/InputLabel';
import FormControl from '@mui/material/FormControl';
import Chip from '@mui/material/Chip';
import useAuth from '../../context/user/UserContext';

const ITEMS_PER_PAGE = 20;

type FilterType = 'all' | 'published' | 'draft';

const AdminSeriesPage = () => {
  const { user } = useAuth();
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
      <Box display="flex" justifyContent="center" padding={3}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <>
      <Box display="flex" justifyContent="center" padding={3} width={1}>
        {error ? (
          <Typography color="error">{`Error: ${error}`}</Typography>
        ) : loading ? (
          <CircularProgress />
        ) : (
          <Box display="flex" flexDirection="column" gap={2} width={1}>
            <Box display="flex" justifyContent="center" gap={2} alignItems="center">
              <Typography variant="h4">Manage Series</Typography>
              <Button
                color="primary"
                variant="contained"
                size="small"
                onClick={() => setNewSeriesPopup(true)}
              >
                Add Series
              </Button>
            </Box>

            <Box display="flex" width="100%" gap={2}>
              <TextField
                placeholder="Search series by name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                sx={{ flex: 2 }}
              />
              <FormControl sx={{ flex: 1, minWidth: 150 }}>
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

            {filteredSeries.length === 0 ? (
              <Box display="flex" flexDirection="column" alignItems="center" gap={2} py={4}>
                <Typography color="text.secondary">
                  {searchQuery || filter !== 'all'
                    ? 'No series found matching your filters'
                    : 'No series yet. Create one to get started!'}
                </Typography>
                {!searchQuery && filter === 'all' && (
                  <Button variant="outlined" onClick={() => setNewSeriesPopup(true)}>
                    Create Your First Series
                  </Button>
                )}
              </Box>
            ) : (
              <MaterialList>
                {filteredSeries.map((series) => (
                  <Box key={series.id}>
                    <Link href={`/admin/series/${series.id}`}>
                      <ListItemButton
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          py: 2,
                        }}
                      >
                        <Box display="flex" alignItems="center" gap={2}>
                          <AvatarWithDefaultImage
                            image={series.images?.find((image) => image.type === 'square')}
                            altName={`Image of Series: ${series.name}`}
                            width={60}
                            height={60}
                            borderRadius={8}
                          />
                          <Box display="flex" flexDirection="column" gap={0.5}>
                            <Typography variant="subtitle1" fontWeight="medium">
                              {series.name}
                            </Typography>
                            <Box display="flex" gap={1} alignItems="center">
                              <Typography variant="body2" color="text.secondary">
                                {series.itemCount} items
                              </Typography>
                              {series.subsplashId ? (
                                <Tooltip title="Published to Subsplash">
                                  <Chip
                                    icon={<CheckCircleIcon />}
                                    label="Published"
                                    size="small"
                                    color="success"
                                    variant="outlined"
                                  />
                                </Tooltip>
                              ) : (
                                <Tooltip title="Not yet published to Subsplash">
                                  <Chip
                                    icon={<PendingIcon />}
                                    label="Draft"
                                    size="small"
                                    color="warning"
                                    variant="outlined"
                                  />
                                </Tooltip>
                              )}
                              {isAdmin && series.ownerId !== user.uid && (
                                <Chip
                                  label={`Owner: ${series.ownerId.slice(0, 8)}...`}
                                  size="small"
                                  variant="outlined"
                                />
                              )}
                            </Box>
                          </Box>
                        </Box>

                        <Box display="flex" gap={1}>
                          <Tooltip title="Edit Series">
                            <span>
                              <IconButton
                                disabled={disableButtons}
                                aria-label="edit series"
                                color="info"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setSelectedSeries(series);
                                  setEditSeriesPopup(true);
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
                                color="error"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setSelectedSeries(series);
                                  setDeleteSeriesPopup(true);
                                }}
                              >
                                <DeleteIcon />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Box>
                      </ListItemButton>
                    </Link>
                    <Divider />
                  </Box>
                ))}
              </MaterialList>
            )}
          </Box>
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
      <Box display="flex" justifyContent="center" padding={3}>
        <Typography>You don&apos;t have permission to view this page.</Typography>
      </Box>
    );
  }
  
  return <AdminSeriesPage />;
};

ProtectedAdminSeriesPage.PageLayout = AdminLayout;

export default ProtectedAdminSeriesPage;
