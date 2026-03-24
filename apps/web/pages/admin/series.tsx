/**
 * Admin page for managing media series
 * - Publishers see only their own series
 * - Admins see all series with owner info
 * - Click to navigate to series details page
 */
import Box from '@mui/material/Box';
import AppLayout from '../../layout/AppLayout';
import Button from '@mui/material/Button';
import firestore, { collection, limit, orderBy, query, where, getDocs, QueryConstraint } from '../../firebase/firestore';
import DeleteEntityPopup from '../../components/DeleteEntityPopup';
import { memo, useCallback, useEffect, useState } from 'react';
import NewSeriesPopup from '../../components/NewSeriesPopup';
import AvatarWithDefaultImage from '../../components/AvatarWithDefaultImage';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { createFunctionV2 } from '../../utils/createFunction';
import { DeleteSeriesInputType, DeleteSeriesOutputType } from '@upperroom/contracts/deleteSeries';
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
import UserAvatar from '../../components/UserAvatar';
import type { User as AppUser } from '../../types/User';
import type { GetUsersByIdsInputType, GetUsersByIdsOutputType } from '@upperroom/contracts/getUsersByIds';
import {
  createOperationKey,
  formatLockBusyRetryMessage,
  parseLockBusyDetails,
} from '../../utils/callableConcurrency';

const ITEMS_PER_PAGE = 20;

type FilterType = 'all' | 'published' | 'draft';

const getLockBusyMessage = (error: unknown, fallbackMessage: string): string => {
  const lockBusyDetails = parseLockBusyDetails(error);
  if (!lockBusyDetails) {
    return fallbackMessage;
  }

  return formatLockBusyRetryMessage(fallbackMessage, lockBusyDetails);
};

const getErrorMessage = (error: unknown, fallbackMessage: string): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallbackMessage;
};

interface SeriesListItemRowProps {
  series: Series;
  isAdmin: boolean;
  currentUserId: string | undefined;
  owner?: AppUser;
  disableButtons: boolean;
  onEdit: (series: Series) => void;
  onDelete: (series: Series) => void;
}

const SeriesListItemRow = memo(function SeriesListItemRow({
  series,
  isAdmin,
  currentUserId,
  owner,
  disableButtons,
  onEdit,
  onDelete,
}: SeriesListItemRowProps) {
  const theme = useTheme();
  const compactSeriesRow = theme.breakpoints.down(750);
  const seriesImage = series.images?.find((image) => image.type === 'wide')
    || series.images?.find((image) => image.type === 'banner')
    || series.images?.find((image) => image.type === 'square');
  const ownerDisplayName = owner
    ? (`${owner.firstName ?? ''} ${owner.lastName ?? ''}`.trim() || owner.displayName || owner.email || owner.uid)
    : series.ownerId;
  return (
    <Box>
      <Link href={`/admin/series/${series.id}`} style={{ textDecoration: 'none' }}>
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'stretch',
            justifyContent: 'space-between',
            minHeight: { xs: 88, sm: 96 },
            gap: 0,
            cursor: 'pointer',
            transition: 'background-color 0.15s ease',
            '&:hover': { bgcolor: 'action.hover' },
            [compactSeriesRow]: {
              flexDirection: 'column',
            },
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'stretch',
              gap: 0,
              flex: 1,
              minWidth: 0,
            }}
          >
            <AvatarWithDefaultImage
              image={seriesImage}
              altName={`Image of Series: ${series.name}`}
              width={1}
              height={1}
              sizes="(max-width: 750px) 135px, 170px"
              borderRadius={0}
              sx={{
                flexShrink: 0,
                width: 'auto',
                height: '100%',
                aspectRatio: '16 / 9',
                [compactSeriesRow]: {
                  height: 76,
                },
              }}
            />
            <Box
              sx={{
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                px: { xs: 1.5, sm: 2 },
                py: { xs: 1.25, sm: 1.5 },
                [compactSeriesRow]: {
                  py: 0.75,
                  px: 1,
                },
              }}
            >
              <Typography
                variant="subtitle1"
                fontWeight={600}
                sx={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  [compactSeriesRow]: {
                    fontSize: '0.84rem',
                    lineHeight: 1.2,
                  },
                }}
              >
                {series.name}
              </Typography>
              <Box
                sx={{
                  display: 'flex',
                  gap: { xs: 0.75, sm: 1 },
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  mt: 0.5,
                  [compactSeriesRow]: {
                    gap: 0.5,
                    mt: 0.35,
                  },
                }}
              >
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{
                    [compactSeriesRow]: {
                      fontSize: '0.72rem',
                      lineHeight: 1.2,
                    },
                  }}
                >
                  {series.itemCount || 0} items
                </Typography>
                {series.subsplashId ? (
                  <Chip
                    icon={<CheckCircleIcon />}
                    label="Published"
                    size="small"
                    color="success"
                    variant="outlined"
                    sx={{
                      height: 22,
                      [compactSeriesRow]: {
                        height: 18,
                        '& .MuiChip-icon': {
                          fontSize: '0.8rem',
                          ml: '5px',
                          mr: '-3px',
                        },
                        '& .MuiChip-label': {
                          fontSize: '0.64rem',
                          px: 0.5,
                        },
                      },
                      '& .MuiChip-label': {
                        px: 0.75,
                      },
                    }}
                  />
                ) : (
                  <Chip
                    icon={<PendingIcon />}
                    label="Draft"
                    size="small"
                    color="warning"
                    variant="outlined"
                    sx={{
                      height: 22,
                      [compactSeriesRow]: {
                        height: 18,
                        '& .MuiChip-icon': {
                          fontSize: '0.8rem',
                          ml: '5px',
                          mr: '-3px',
                        },
                        '& .MuiChip-label': {
                          fontSize: '0.64rem',
                          px: 0.5,
                        },
                      },
                      '& .MuiChip-label': {
                        px: 0.75,
                      },
                    }}
                  />
                )}
                {isAdmin && series.ownerId !== currentUserId && (
                  <Chip
                    avatar={(
                      <UserAvatar
                        user={owner}
                        fallbackLabel={ownerDisplayName}
                        sx={{ width: { xs: 18, sm: 20 }, height: { xs: 18, sm: 20 } }}
                      />
                    )}
                    label={ownerDisplayName}
                    size="small"
                    variant="outlined"
                    sx={{
                      height: { xs: 22, sm: 26 },
                      borderRadius: 999,
                      pl: { xs: '1px', sm: '2px' },
                      bgcolor: alpha(theme.palette.primary.main, 0.08),
                      maxWidth: {
                        xs: '100%',
                        sm: 'min(100%, 240px)',
                      },
                      [compactSeriesRow]: {
                        height: 18,
                        minWidth: 0,
                        maxWidth: '100%',
                        pl: '1px',
                      },
                      '& .MuiChip-label': {
                        fontSize: { xs: '0.6rem', sm: '0.7rem' },
                        fontWeight: 700,
                        px: { xs: '5px', sm: '8px' },
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        [compactSeriesRow]: {
                          fontSize: '0.58rem',
                          px: '4px',
                        },
                      },
                      '& .MuiChip-avatar': {
                        ml: 0,
                        mr: { xs: '3px', sm: '4px' },
                        width: { xs: 18, sm: 20 },
                        height: { xs: 18, sm: 20 },
                        [compactSeriesRow]: {
                          width: 16,
                          height: 16,
                          mr: '2px',
                        },
                      },
                    }}
                  />
                )}
              </Box>
            </Box>
          </Box>

          <Stack
            direction="row"
            spacing={0.5}
            sx={{
              flexShrink: 0,
              alignItems: 'center',
              px: { xs: 1, sm: 1.5 },
              [compactSeriesRow]: {
                justifyContent: 'flex-end',
                px: 1,
                pb: 0.75,
                pt: 0,
              },
            }}
          >
            <Tooltip title="Edit Series">
              <span>
                <IconButton
                  disabled={disableButtons}
                  aria-label="edit series"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onEdit(series);
                  }}
                  sx={{
                    '&:hover': {
                      bgcolor: alpha(theme.palette.primary.main, 0.15),
                      color: 'primary.main',
                    },
                    [compactSeriesRow]: {
                      width: 28,
                      height: 28,
                      '& svg': {
                        fontSize: '1rem',
                      },
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
                    onDelete(series);
                  }}
                  sx={{
                    color: 'error.main',
                    '&:hover': {
                      bgcolor: alpha(theme.palette.error.main, 0.15),
                    },
                    [compactSeriesRow]: {
                      width: 28,
                      height: 28,
                      '& svg': {
                        fontSize: '1rem',
                      },
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
    </Box>
  );
});

const AdminSeriesPage = () => {
  const { user } = useAuth();
  const [seriesList, setSeriesList] = useState<Series[]>([]);
  const [ownerById, setOwnerById] = useState<Record<string, AppUser>>({});
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
    } catch (err: unknown) {
      console.error('Error fetching series:', err);
      setError(getErrorMessage(err, 'Failed to fetch series'));
    }

    setLoading(false);
  }, [user, isAdmin]);

  useEffect(() => {
    fetchSeries();
  }, [fetchSeries]);

  useEffect(() => {
    if (!isAdmin) {
      setOwnerById({});
      return;
    }

    const ownerIds = Array.from(
      new Set(
        seriesList
          .map((series) => series.ownerId)
          .filter((ownerId): ownerId is string => Boolean(ownerId && ownerId !== user?.uid))
      )
    );

    if (ownerIds.length === 0) {
      setOwnerById({});
      return;
    }

    let cancelled = false;
    const getUsersByIds = createFunctionV2<GetUsersByIdsInputType, GetUsersByIdsOutputType>('getusersbyids');

    getUsersByIds({ uids: ownerIds })
      .then((result) => {
        if (cancelled || result.status !== 'success') {
          return;
        }

        const nextOwnerById: Record<string, AppUser> = {};
        result.data.forEach((owner) => {
          nextOwnerById[owner.uid] = owner as AppUser;
        });
        setOwnerById(nextOwnerById);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Error fetching series owners:', err);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isAdmin, seriesList, user?.uid]);

  const handleSeriesDelete = async () => {
    if (!selectedSeries) return;

    try {
      setIsDeleting(true);

      // Always route through callable to enforce consistent remote/local deletion semantics.
      const deleteSeries = createFunctionV2<DeleteSeriesInputType, DeleteSeriesOutputType>('deleteseries');
      await deleteSeries({
        firestoreId: selectedSeries.id,
        operationKey: createOperationKey('series-admin-delete', selectedSeries.id),
      });

      setSeriesList((prev) => prev.filter((s) => s.id !== selectedSeries.id));
      setDeleteSeriesPopup(false);
    } catch (err: unknown) {
      console.error('Error deleting series:', err);
      const fallbackMessage = `Error deleting series: ${getErrorMessage(err, 'Unknown error')}`;
      alert(getLockBusyMessage(err, fallbackMessage));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSeriesCreated = (newSeries: Series) => {
    setSeriesList((prev) => [newSeries, ...prev]);
  };

  const handleEditSeries = useCallback((s: Series) => {
    setSelectedSeries(s);
    setEditSeriesPopup(true);
  }, []);

  const handleDeleteSeriesClick = useCallback((s: Series) => {
    setSelectedSeries(s);
    setDeleteSeriesPopup(true);
  }, []);

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
              <FormControl size="small" sx={{ flex: 1, minWidth: { xs: 0, sm: 160 } }}>
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
                  borderRadius: 1,
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
              <Card sx={{ borderRadius: 1 }}>
                {filteredSeries.map((series, index) => (
                  <Box key={series.id}>
                    <SeriesListItemRow
                      series={series}
                      isAdmin={isAdmin}
                      currentUserId={user?.uid}
                      owner={series.ownerId ? ownerById[series.ownerId] : undefined}
                      disableButtons={disableButtons}
                      onEdit={handleEditSeries}
                      onDelete={handleDeleteSeriesClick}
                    />
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
