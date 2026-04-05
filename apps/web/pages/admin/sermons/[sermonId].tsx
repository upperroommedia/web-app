/**
 * Sermon Details Page
 * - View full sermon metadata
 * - Play controls
 * - Series information
 * - Inline publishing status (no popup)
 * - Edit and Delete actions
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Autocomplete from '@mui/material/Autocomplete';
import ListItem from '@mui/material/ListItem';
import InputAdornment from '@mui/material/InputAdornment';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import PauseCircleIcon from '@mui/icons-material/PauseCircle';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import PendingIcon from '@mui/icons-material/Pending';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import RefreshIcon from '@mui/icons-material/Refresh';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import UploadIcon from '@mui/icons-material/Upload';
import AddIcon from '@mui/icons-material/Add';
import Link from 'next/link';
import { alpha, useTheme } from '@mui/material/styles';

import AppLayout from '../../../layout/AppLayout';
import AvatarWithDefaultImage from '../../../components/AvatarWithDefaultImage';
import DeleteEntityPopup from '../../../components/DeleteEntityPopup';
import SermonPublishPanel from '../../../components/SermonPublishPanel';
import firestore, { doc, getDoc, getDocs, collection, updateDoc, setDoc, query, orderBy, where, limit, serverTimestamp } from '../../../firebase/firestore';
import { sermonStatusType } from '../../../types/SermonTypes';
import { sermonConverter } from '../../../types/Sermon';
import { Series, seriesConverter } from '../../../types/Series';
import useAuth from '../../../context/user/UserContext';
import useAudioPlayer from '../../../context/audio/audioPlayerContext';
import { useMediaState, useMediaRemote } from '@vidstack/react';
import { createFunctionV2 } from '../../../utils/createFunction';
import { createOperationKey } from '../../../utils/callableConcurrency';
import { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import UserAvatar from '../../../components/UserAvatar';
import { User } from '../../../types/User';
import { GetUsersByIdsInputType, GetUsersByIdsOutputType } from '@upperroom/contracts/getUsersByIds';
import { useDocument } from 'react-firebase-hooks/firestore';
import { useObject } from 'react-firebase-hooks/database';
import database, { ref as dbRef } from '../../../firebase/database';
import LinearProgress from '@mui/material/LinearProgress';
import { getIntroAndOutro } from '../../../utils/uploadUtils';
import { canEditSermonRecord, isSermonProcessingLocked, isSermonPublishedExternally } from '../../../utils/sermonEditing';
import { parseProcessingProgress } from '../../../utils/processAudioProgress';
import { reportHandledError, reportHandledMessage } from '../../../utils/reportHandledError';

const getErrorField = (error: unknown, field: 'code' | 'details' | 'message'): string | undefined => {
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

const SermonDetailsPage = () => {
  const router = useRouter();
  const { user } = useAuth();
  const theme = useTheme();
  const sermonId = router.query.sermonId as string;
  const { currentSermon, setCurrentSermon } = useAudioPlayer();
  const remote = useMediaRemote();
  const playing = useMediaState('playing');
  const pageContainerSx = { maxWidth: 1400, mx: 'auto', width: '100%', px: { xs: 0.5, sm: 2, md: 3 } };

  const [series, setSeries] = useState<Series | null>(null);
  const [uploader, setUploader] = useState<User | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [showStatusTooltip, setShowStatusTooltip] = useState(false);
  const [deletePopup, setDeletePopup] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRetryingProcessing, setIsRetryingProcessing] = useState(false);

  // Publishing-related series assignment state
  const [addToSeriesDialogOpen, setAddToSeriesDialogOpen] = useState(false);
  const [ownedSeriesOptions, setOwnedSeriesOptions] = useState<Series[]>([]);
  const [loadingOwnedSeries, setLoadingOwnedSeries] = useState(false);
  const [selectedOwnedSeriesId, setSelectedOwnedSeriesId] = useState('');
  const [ownedSeriesSearchQuery, setOwnedSeriesSearchQuery] = useState('');
  const [isAddingToSeries, setIsAddingToSeries] = useState(false);

  // Real-time sermon document listener
  const [sermonSnapshot, sermonLoading, sermonError] = useDocument(
    sermonId ? doc(firestore, 'sermons', sermonId).withConverter(sermonConverter) : null,
    {
      snapshotListenOptions: { includeMetadataChanges: true },
    }
  );
  const sermon = sermonSnapshot?.data();
  // Real-time processing progress from Firebase Realtime Database
  const [progressSnapshot] = useObject(sermonId ? dbRef(database, `addIntroOutro/${sermonId}`) : null);
  const processingProgressState = parseProcessingProgress(progressSnapshot?.val());
  const processingProgress = processingProgressState?.percent ?? 0;
  const processingStageLabel = processingProgressState?.stageLabel ?? 'Processing';
  const isQueuedForProcessing = processingProgressState?.stage === 'queued';

  const isAdmin = user?.isAdmin() ?? false;
  const canPublish = user?.canPublish() ?? false;
  const isCurrentlyPlaying = currentSermon?.id === sermonId && playing;
  const buildSeriesPreview = useCallback((seriesId: string): Series => ({
    id: seriesId,
    name: sermon?.seriesName || 'Series',
    subtitle: '',
    summary: '',
    images: sermon?.seriesImage ? [sermon.seriesImage] : [],
    itemCount: 0,
    publishedItemCount: 0,
    status: 'draft',
    subsplashId: '',
    ownerId: '',
    createdAt: null,
    updatedAt: null,
  }), [sermon?.seriesImage, sermon?.seriesName]);
  const refreshSeriesState = useCallback(async (seriesId: string) => {
    const latestSeriesSnapshot = await getDoc(doc(firestore, 'series', seriesId).withConverter(seriesConverter));
    if (latestSeriesSnapshot.exists()) {
      setSeries(latestSeriesSnapshot.data());
    } else {
      setSeries(null);
    }
  }, []);

  // Fetch series and uploader when relevant ids change (narrow deps to avoid refetch on every sermon snapshot)
  useEffect(() => {
    if (!sermon) return;

    if (!isAdmin && !canPublish && sermon.uploaderId !== user?.uid) {
      setError('You do not have permission to view this sermon');
      return;
    }
    setError(null);

    if (sermon.seriesId) {
      setSeries(buildSeriesPreview(sermon.seriesId));
      getDoc(doc(firestore, 'series', sermon.seriesId).withConverter(seriesConverter))
        .then((seriesDoc) => {
          if (seriesDoc.exists()) {
            setSeries(seriesDoc.data());
          }
        })
        .catch((err) => {
          console.error('Error fetching series:', err);
        });
    } else {
      setSeries(null);
    }

    if (sermon.uploaderId) {
      if (user?.uid === sermon.uploaderId) {
        setUploader(user);
      } else {
        const getUsersByIds = createFunctionV2<GetUsersByIdsInputType, GetUsersByIdsOutputType>('getusersbyids');
        getUsersByIds({ uids: [sermon.uploaderId] })
          .then((result) => {
            if (result.status === 'success') {
              setUploader(result.data[0]);
            }
          })
          .catch((err) => {
            console.error('Error fetching uploader:', err);
          });
      }
    } else {
      setUploader(undefined);
    }
    // Intentionally depend on ids only to avoid refetch on every sermon snapshot (e.g. metadata-only updates)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sermon read for permission/seriesId/uploaderId; ids are sufficient
  }, [buildSeriesPreview, sermon?.id, sermon?.seriesId, sermon?.uploaderId, isAdmin, canPublish, user?.uid]);

  // Handle errors from real-time listener
  useEffect(() => {
    if (sermonError) {
      console.error('Error fetching sermon:', sermonError);
      setError(sermonError.message || 'Failed to fetch sermon');
    }
  }, [sermonError]);

  // Check if sermon exists
  useEffect(() => {
    if (!sermonLoading && sermonId && sermonSnapshot && !sermonSnapshot.exists()) {
      setError('Sermon not found');
    }
  }, [sermonLoading, sermonId, sermonSnapshot]);

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!sermon || isDeleting) return;

    setIsDeleting(true);
    try {
      if (currentSermon?.id === sermon.id) {
        setCurrentSermon(undefined);
      }

      const deleteIntentQuery: Record<string, string> = {
        deleteIntent: 'sermon',
        deleteSermonId: sermon.id,
      };

      if (sermon.subsplashId) {
        deleteIntentQuery.deleteSubsplashId = sermon.subsplashId;
      }
      if (sermon.soundCloudTrackId) {
        deleteIntentQuery.deleteSoundCloudTrackId = sermon.soundCloudTrackId;
      }

      await router.replace({
        pathname: '/admin/sermons',
        query: deleteIntentQuery,
      });
    } catch (err) {
      console.error('Error deleting sermon:', err);
      const message = err instanceof Error ? err.message : 'Failed to start delete';
      reportHandledError(err, {
        area: 'sermon-details',
        action: 'delete-sermon',
        extras: {
          sermonId,
        },
      });
      alert(message);
      setIsDeleting(false);
    }
  }, [sermon, currentSermon, isDeleting, setCurrentSermon, router, sermonId]);

  const retryProcessing = useCallback(async () => {
    if (!sermon || isRetryingProcessing) return;
    if (typeof sermon.trimDurationSeconds !== 'number' || sermon.trimDurationSeconds <= 0) {
      reportHandledMessage('This sermon cannot be reprocessed because it does not have saved trim-source settings.', {
        area: 'sermon-details',
        action: 'retry-processing-missing-trim-settings',
        level: 'warning',
        extras: {
          sermonId: sermon.id,
        },
      });
      alert('This sermon cannot be reprocessed because it does not have saved trim-source settings.');
      return;
    }

    setIsRetryingProcessing(true);
    try {
      const generateAddIntroOutroTask = createFunctionV2<AddIntroOutroInputType>('addintrooutrotaskgenerator');
      const { introRef, outroRef } = await getIntroAndOutro(sermon);
      const payload: AddIntroOutroInputType = sermon.youtubeUrl
        ? {
          id: sermon.id,
          youtubeUrl: sermon.youtubeUrl,
          startTime: sermon.sourceStartTime,
          duration: sermon.trimDurationSeconds ?? 0,
          deleteOriginal: true,
          introUrl: introRef,
          outroUrl: outroRef,
        }
        : {
          id: sermon.id,
          storageFilePath: `sermons/${sermon.id}`,
          startTime: sermon.sourceStartTime,
          duration: sermon.trimDurationSeconds ?? 0,
          deleteOriginal: true,
          introUrl: introRef,
          outroUrl: outroRef,
        };

      await generateAddIntroOutroTask(payload, {
        metadata: { operationKey: createOperationKey('sermon-details-retry-processing', sermon.id) },
      });
    } catch (retryError) {
      console.error('Error retrying sermon processing:', retryError);
      reportHandledError(retryError, {
        area: 'sermon-details',
        action: 'retry-processing',
        extras: {
          sermonId: sermon.id,
        },
      });
      alert(getErrorMessage(retryError, 'Failed to retry sermon processing'));
    } finally {
      setIsRetryingProcessing(false);
    }
  }, [isRetryingProcessing, sermon]);

  const openAddToSeriesDialog = useCallback(async () => {
    if (!user?.uid) {
      return;
    }

    setAddToSeriesDialogOpen(true);
    setLoadingOwnedSeries(true);
    setOwnedSeriesOptions([]);
    setSelectedOwnedSeriesId('');
    setOwnedSeriesSearchQuery('');
    try {
      const ownedSeriesSnapshot = await getDocs(
        query(
          collection(firestore, 'series').withConverter(seriesConverter),
          where('ownerId', '==', user.uid),
          limit(100)
        )
      );
      const ownedSeries = ownedSeriesSnapshot.docs
        .map((seriesDoc) => seriesDoc.data())
        .sort((a, b) => a.name.localeCompare(b.name));
      setOwnedSeriesOptions(ownedSeries);
      if (ownedSeries.length === 1) {
        setSelectedOwnedSeriesId(ownedSeries[0].id);
      }
    } catch (err: unknown) {
      console.error('Error loading owned series:', err);
      reportHandledError(err, {
        area: 'sermon-details',
        action: 'load-owned-series',
        extras: {
          sermonId,
          userId: user?.uid,
        },
      });
      alert(getErrorMessage(err, 'Failed to load your series'));
    } finally {
      setLoadingOwnedSeries(false);
    }
  }, [user?.uid, sermonId]);

  const addSermonToSelectedSeries = useCallback(async () => {
    if (!sermon || !user?.uid || !selectedOwnedSeriesId || isAddingToSeries) {
      return;
    }

    setIsAddingToSeries(true);
    try {
      const selectedSeriesRef = doc(firestore, 'series', selectedOwnedSeriesId).withConverter(seriesConverter);
      const selectedSeriesSnapshot = await getDoc(selectedSeriesRef);
      if (!selectedSeriesSnapshot.exists()) {
        throw new Error('Selected series no longer exists.');
      }

      const selectedSeries = selectedSeriesSnapshot.data();
      if (selectedSeries.ownerId !== user.uid) {
        throw new Error('You can only add sermons to series you own.');
      }
      if (sermon.seriesId && sermon.seriesId !== selectedSeries.id) {
        throw new Error('This sermon is already assigned to another series.');
      }

      const latestPositionSnapshot = await getDocs(
        query(
          collection(firestore, `series/${selectedSeries.id}/seriesItems`),
          orderBy('position', 'desc'),
          limit(1)
        )
      );
      const latestPosition = latestPositionSnapshot.docs[0]?.data()?.position;
      const nextPosition = typeof latestPosition === 'number' ? latestPosition + 1 : 1;

      await setDoc(
        doc(firestore, `series/${selectedSeries.id}/seriesItems`, sermon.id),
        {
          id: sermon.id,
          position: nextPosition,
          publishedToSubsplash: false,
          ...(sermon.subsplashId ? { sermonSubsplashId: sermon.subsplashId } : {}),
          addedAt: serverTimestamp(),
        }
      );
      await updateDoc(doc(firestore, 'sermons', sermon.id), { seriesId: selectedSeries.id });

      await refreshSeriesState(selectedSeries.id);
      setAddToSeriesDialogOpen(false);
      setSelectedOwnedSeriesId('');
      setOwnedSeriesSearchQuery('');
    } catch (err: unknown) {
      console.error('Error adding sermon to selected series:', err);
      reportHandledError(err, {
        area: 'sermon-details',
        action: 'add-sermon-to-series',
        extras: {
          sermonId: sermon.id,
          selectedOwnedSeriesId,
        },
      });
      alert(getErrorMessage(err, 'Failed to add sermon to series'));
    } finally {
      setIsAddingToSeries(false);
    }
  }, [isAddingToSeries, refreshSeriesState, selectedOwnedSeriesId, sermon, user?.uid]);

  // Play/pause toggle
  const handlePlayPause = () => {
    if (!sermon) return;
    if (currentSermon?.id !== sermon.id) {
      setCurrentSermon(sermon);
    } else {
      remote.togglePaused();
    }
  };

  // Format duration to nearest second
  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Get status chip info
  const getStatusInfo = () => {
    if (!sermon) return null;
    const status = sermon.status.audioStatus;
    if (status === sermonStatusType.PROCESSED) {
      return { color: 'success' as const, icon: <CheckCircleIcon fontSize="small" />, label: 'Processed' };
    }
    if (status === sermonStatusType.PROCESSING) {
      return { color: 'warning' as const, icon: <PendingIcon fontSize="small" />, label: 'Processing' };
    }
    if (status === sermonStatusType.ERROR) {
      return { color: 'error' as const, icon: <ErrorIcon fontSize="small" />, label: 'Error' };
    }
    return { color: 'default' as const, icon: <PendingIcon fontSize="small" />, label: status };
  };

  const statusInfo = getStatusInfo();
  const selectedOwnedSeries = ownedSeriesOptions.find((candidate) => candidate.id === selectedOwnedSeriesId) || null;
  const uploaderName = uploader
    ? (`${uploader.firstName ?? ''} ${uploader.lastName ?? ''}`.trim() || uploader.displayName || uploader.email)
    : 'Unknown';
  const derivedSeriesSubtitle = series ? `${series.publishedItemCount || 0} part series` : null;
  const seriesCardImage = series?.images?.find((img) => img.type === 'wide')
    || series?.images?.find((img) => img.type === 'banner')
    || series?.images?.find((img) => img.type === 'square');

  // Check if user can edit/delete
  const canEdit = sermon && (canPublish || user?.canUpload()) && canEditSermonRecord(sermon);

  const canDelete = sermon && (
    canPublish ||
    (user?.canUpload() &&
      !isSermonPublishedExternally(sermon) &&
      !isSermonProcessingLocked(sermon))
  );

  if (sermonLoading) {
    return (
      <Box sx={{ ...pageContainerSx, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !sermon) {
    return (
      <Box sx={{ ...pageContainerSx, py: 2 }}>
        <Alert severity="error">{error || 'Sermon not found'}</Alert>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push('/admin/sermons')}
          sx={{ mt: 2 }}
        >
          Back to Sermons
        </Button>
      </Box>
    );
  }

  return (
    <>
      <Head>
        <title>{sermon.title} | Admin | Upper Room Media</title>
      </Head>

      <Box sx={pageContainerSx}>
        {/* Breadcrumbs */}
        <Breadcrumbs separator={<NavigateNextIcon fontSize="small" />} sx={{ mb: { xs: 1, sm: 2 } }}>
          <Link href="/admin/sermons" style={{ textDecoration: 'none' }}>
            <Typography sx={{ color: 'text.secondary', '&:hover': { color: 'primary.main' }, fontSize: { xs: '0.8rem', sm: '1rem' } }}>
              Sermons
            </Typography>
          </Link>
          <Typography color="text.primary" fontWeight={500} noWrap sx={{ maxWidth: { xs: 200, sm: 'none' }, fontSize: { xs: '0.8rem', sm: '1rem' } }}>
            {sermon.title}
          </Typography>
        </Breadcrumbs>

        {/* Main Card */}
        <Card sx={{ overflow: 'visible' }}>
          <CardContent sx={{ p: { xs: 1.5, sm: 2, md: 3 } }}>
            {/* Header with Image, Info, and Actions */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'row',
                gap: { xs: 1.5, sm: 2, md: 3 },
                mb: { xs: 2, sm: 3 },
                alignItems: 'flex-start',
              }}
            >
              {/* Cover Image - On the left */}
              <Box sx={{ flexShrink: 0 }}>
                <Stack spacing={1.25} sx={{ width: { xs: 80, sm: 120, md: 160 } }}>
                  <Box
                    sx={{
                      width: { xs: 80, sm: 120, md: 160 },
                      height: { xs: 80, sm: 120, md: 160 },
                      borderRadius: { xs: 1, sm: 2 },
                      overflow: 'hidden',
                      boxShadow: 2,
                      bgcolor: sermon.images?.find((img) => img.type === 'square')?.averageColorHex || 'action.hover',
                      backgroundImage: sermon.images?.find((img) => img.type === 'square')?.downloadLink
                        ? `url(${sermon.images.find((img) => img.type === 'square')?.downloadLink})`
                        : 'url(/URM_icon.png)',
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                    }}
                  />
                  {sermon.status.audioStatus === sermonStatusType.PROCESSED && (
                    <Button
                      variant="contained"
                      size="medium"
                      startIcon={isCurrentlyPlaying ? <PauseCircleIcon /> : <PlayCircleIcon />}
                      onClick={handlePlayPause}
                      fullWidth
                      sx={{
                        minHeight: { xs: 28, sm: 34, md: 38 },
                        px: { xs: 0.75, sm: 1.25 },
                        py: { xs: 0.35, sm: 0.75 },
                        fontSize: { xs: '0.68rem', sm: '0.82rem', md: '0.88rem' },
                        '& .MuiButton-startIcon svg': {
                          fontSize: { xs: '0.88rem', sm: '1.05rem', md: '1.15rem' },
                        },
                      }}
                    >
                      {isCurrentlyPlaying ? 'Pause' : 'Play'}
                    </Button>
                  )}
                </Stack>
              </Box>

              {/* Info Section - Center */}
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack spacing={{ xs: 1.25, sm: 1.75, md: 2 }}>
                  <Box>
                    <Typography
                      variant="h4"
                      fontWeight={700}
                      gutterBottom
                      sx={{
                        fontSize: { xs: '1.25rem', sm: '1.5rem', md: '2rem' },
                      }}
                    >
                      {sermon.title}
                    </Typography>

                    {sermon.subtitle && (
                      <Typography variant="h6" color="text.secondary" gutterBottom sx={{ fontSize: { xs: '0.9rem', sm: '1rem', md: '1.25rem' } }}>
                        {sermon.subtitle}
                      </Typography>
                    )}

                    <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 0.75 }}>
                      {sermon.speakers.map((speaker) => (
                        <Chip
                          key={speaker.id}
                          component={Link}
                          href={`/admin/speakers/${speaker.id}`}
                          clickable
                          avatar={
                            <AvatarWithDefaultImage
                              altName={speaker.name}
                              image={speaker.images?.find((image) => image.type === 'square')}
                              width={20}
                              height={20}
                              borderRadius={999}
                            />
                          }
                          label={speaker.name}
                          size="small"
                          variant="outlined"
                          sx={{
                            height: { xs: 24, sm: 30 },
                            cursor: 'pointer',
                            borderRadius: 999,
                            pl: { xs: '2px', sm: '3px' },
                            bgcolor: alpha(theme.palette.primary.main, 0.08),
                            textDecoration: 'none',
                            transition: theme.transitions.create(['background-color', 'border-color', 'box-shadow']),
                            '& .MuiChip-label': {
                              fontSize: { xs: '0.68rem', sm: '0.78rem' },
                              fontWeight: 700,
                              px: { xs: '7px', sm: '9px' },
                            },
                            '& .MuiChip-avatar': {
                              ml: 0,
                              mr: { xs: '4px', sm: '5px' },
                              width: { xs: 20, sm: 22 },
                              height: { xs: 20, sm: 22 },
                            },
                            '&:hover': {
                              backgroundColor: alpha(theme.palette.primary.main, 0.14),
                              borderColor: 'primary.main',
                            },
                            '&:focus-visible': {
                              boxShadow: `0 0 0 2px ${alpha(theme.palette.primary.main, 0.3)}`,
                            },
                          }}
                        />
                      ))}
                    </Stack>
                  </Box>

                  <Stack
                    direction={{ xs: 'column', md: 'row' }}
                    spacing={{ xs: 1.25, md: 2.5 }}
                    alignItems={{ xs: 'stretch', md: 'flex-end' }}
                    justifyContent="space-between"
                  >
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      spacing={{ xs: 1.25, sm: 2, md: 2.5 }}
                      alignItems={{ xs: 'flex-start', sm: 'center' }}
                      flexWrap="wrap"
                      useFlexGap
                      sx={{ flex: 1, minWidth: 0 }}
                    >
                      <Stack spacing={0.5}>
                        <Stack direction="row" spacing={0.5} alignItems="center">
                          <CalendarTodayIcon sx={{ fontSize: { xs: 14, sm: 18 }, color: 'text.secondary' }} />
                          <Typography variant="body2" color="text.secondary" sx={{ fontSize: { xs: '0.7rem', sm: '0.85rem' } }}>
                            <strong>Date:</strong> {new Date(sermon.dateMillis).toLocaleDateString('en-US', { dateStyle: 'medium' })}
                          </Typography>
                        </Stack>
                        <Stack direction="row" spacing={0.5} alignItems="center">
                          <UploadIcon sx={{ fontSize: { xs: 14, sm: 18 }, color: 'text.secondary' }} />
                          <Typography variant="body2" color="text.secondary" sx={{ fontSize: { xs: '0.7rem', sm: '0.85rem' } }}>
                            <strong>Uploaded:</strong> {new Date(sermon.createdAtMillis).toLocaleDateString('en-US', { dateStyle: 'medium' })}
                          </Typography>
                        </Stack>
                        {sermon.durationSeconds > 0 && (
                          <Typography variant="body2" color="text.secondary" sx={{ fontSize: { xs: '0.7rem', sm: '0.85rem' } }}>
                            <strong>Duration:</strong> {formatDuration(sermon.durationSeconds)}
                          </Typography>
                        )}
                      </Stack>

                      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
                        {statusInfo && sermon.status.audioStatus !== sermonStatusType.PROCESSED && (
                          <Box>
                            {sermon.status.audioStatus === sermonStatusType.ERROR ? (
                              <Stack direction="row" spacing={0.5} alignItems="center">
                                <Tooltip
                                  open={showStatusTooltip}
                                  onOpen={() => setShowStatusTooltip(true)}
                                  onClose={() => setShowStatusTooltip(false)}
                                  placement="top"
                                  title={sermon.status.message || 'Error'}
                                >
                                  <Box
                                    onClick={() => setShowStatusTooltip((previousOpen) => !previousOpen)}
                                    sx={{ display: 'inline-flex', cursor: 'pointer' }}
                                  >
                                    <Chip
                                      icon={statusInfo.icon}
                                      label={statusInfo.label}
                                      size="small"
                                      color={statusInfo.color}
                                      variant="outlined"
                                    />
                                  </Box>
                                </Tooltip>
                                <Tooltip title="Retry processing">
                                  <span>
                                    <Button
                                      size="small"
                                      color="error"
                                      variant="text"
                                      startIcon={isRetryingProcessing ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon fontSize="small" />}
                                      onClick={retryProcessing}
                                      disabled={isRetryingProcessing}
                                      sx={{ minWidth: 'auto', px: 1, py: 0.25 }}
                                    >
                                      Retry
                                    </Button>
                                  </span>
                                </Tooltip>
                              </Stack>
                            ) : (
                              <Chip
                                icon={statusInfo.icon}
                                label={
                                  sermon.status.audioStatus === sermonStatusType.PROCESSING
                                    ? processingProgressState
                                      ? `${processingStageLabel}${processingProgress > 0 && !isQueuedForProcessing ? ` (${processingProgress}%)` : ''}`
                                      : statusInfo.label
                                    : statusInfo.label
                                }
                                size="small"
                                color={statusInfo.color}
                                variant="outlined"
                              />
                            )}
                            {sermon.status.audioStatus === sermonStatusType.PROCESSING && processingProgressState && (
                              <Box sx={{ mt: 1, maxWidth: 220 }}>
                                <LinearProgress
                                  variant={isQueuedForProcessing ? 'indeterminate' : 'determinate'}
                                  value={isQueuedForProcessing ? undefined : processingProgress}
                                  sx={{
                                    height: 6,
                                    borderRadius: 3,
                                    overflow: 'hidden',
                                    bgcolor: alpha(theme.palette.warning.main, 0.15),
                                    '& .MuiLinearProgress-bar': {
                                      bgcolor: 'warning.main',
                                      borderRadius: 0,
                                    }
                                  }}
                                />
                              </Box>
                            )}
                          </Box>
                        )}
                      </Stack>
                    </Stack>
                  </Stack>
                </Stack>
              </Box>

              {/* Action Buttons - On the right */}
              <Box
                sx={{
                  flexShrink: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  minWidth: { xs: 92, sm: 120, md: 160 },
                  minHeight: { xs: 120, sm: 160, md: 205 },
                }}
              >
                <Stack spacing={0.75} sx={{ width: '100%' }}>
                  {canEdit && (
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={<EditIcon />}
                      onClick={() => router.push(`/admin/sermons/${sermonId}/edit`)}
                      sx={{ fontSize: { xs: '0.7rem', sm: '0.8rem' }, minHeight: { sm: 40 } }}
                    >
                      Edit
                    </Button>
                  )}
                  {canDelete && (
                    <Button
                      variant="outlined"
                      color="error"
                      size="small"
                      startIcon={<DeleteIcon />}
                      onClick={() => setDeletePopup(true)}
                      sx={{ fontSize: { xs: '0.7rem', sm: '0.8rem' }, minHeight: { sm: 40 } }}
                    >
                      Delete
                    </Button>
                  )}
                </Stack>
                <Stack direction="row" spacing={1} alignItems="center" justifyContent="flex-end" sx={{ mt: 1.5 }}>
                  <UserAvatar user={uploader} sx={{ width: { xs: 20, sm: 28 }, height: { xs: 20, sm: 28 } }} />
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ fontSize: { xs: '0.7rem', sm: '0.8rem' }, textAlign: 'right' }}
                  >
                    Uploaded by {uploaderName}
                  </Typography>
                </Stack>
              </Box>
            </Box>

            <Divider sx={{ my: 3 }} />

            {/* Description */}
            <Box sx={{ mb: { xs: 2, sm: 3 } }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom sx={{ fontSize: { xs: '0.9rem', sm: '1rem' } }}>
                Description
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap', fontSize: { xs: '0.8rem', sm: '0.9rem' } }}>
                {sermon.description || 'No description provided.'}
              </Typography>
            </Box>

            {/* Topics */}
            {sermon.topics && sermon.topics.length > 0 && (
              <Box sx={{ mb: { xs: 2, sm: 3 } }}>
                <Typography variant="subtitle1" fontWeight={600} gutterBottom sx={{ fontSize: { xs: '0.9rem', sm: '1rem' } }}>
                  Topics
                </Typography>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {sermon.topics.map((topic) => (
                    <Chip key={topic} label={topic} size="small" variant="outlined" sx={{ height: { xs: 22, sm: 26 }, '& .MuiChip-label': { fontSize: { xs: '0.7rem', sm: '0.8rem' } } }} />
                  ))}
                </Stack>
              </Box>
            )}

            {/* Series Info */}
            {series && (
              <>
                <Divider sx={{ my: { xs: 2, sm: 3 } }} />
                <Box sx={{ mb: { xs: 2, sm: 3 } }}>
                  <Typography variant="subtitle1" fontWeight={600} gutterBottom sx={{ fontSize: { xs: '0.9rem', sm: '1rem' } }}>
                    Series
                  </Typography>
                  <Link href={`/admin/series/${series.id}`} style={{ textDecoration: 'none' }}>
                    <Card
                      variant="outlined"
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: { xs: 1, sm: 2 },
                        p: { xs: 1, sm: 2 },
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                        '&:hover': { borderColor: 'primary.main', bgcolor: alpha(theme.palette.primary.main, 0.04) },
                      }}
                    >
                      <AvatarWithDefaultImage
                        width={104}
                        height={58}
                        altName={series.name}
                        borderRadius={6}
                        image={seriesCardImage}
                      />
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="subtitle1" fontWeight={600} sx={{ fontSize: { xs: '0.85rem', sm: '1rem' } }}>
                          {series.name}
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ fontSize: { xs: '0.75rem', sm: '0.85rem' } }}>
                          {derivedSeriesSubtitle}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ fontSize: { xs: '0.7rem', sm: '0.75rem' } }}>
                          {series.itemCount} items
                        </Typography>
                      </Box>
                    </Card>
                  </Link>
                </Box>
              </>
            )}

            {/* Publishing Status - Inline */}
            {canPublish && sermon.status.audioStatus === sermonStatusType.PROCESSED && (
              <>
                <Divider sx={{ my: { xs: 2, sm: 3 } }} />
                <Box>
                  <Typography variant="subtitle1" fontWeight={600} gutterBottom>
                    Publish Sermon
                  </Typography>
                  <SermonPublishPanel
                    sermon={sermon}
                    onUpdate={() => {
                      if (sermon.seriesId) {
                        void refreshSeriesState(sermon.seriesId);
                      }
                    }}
                    onRequestAddToSeries={openAddToSeriesDialog}
                  />
                </Box>
              </>
            )}
          </CardContent>
        </Card>
      </Box>

      <Dialog
        open={addToSeriesDialogOpen}
        onClose={() => {
          if (isAddingToSeries) {
            return;
          }
          setAddToSeriesDialogOpen(false);
          setOwnedSeriesSearchQuery('');
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Add Sermon To Series</DialogTitle>
        <DialogContent>
          {loadingOwnedSeries ? (
            <Box sx={{ py: 3, display: 'flex', justifyContent: 'center' }}>
              <CircularProgress size={24} />
            </Box>
          ) : ownedSeriesOptions.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              You don&apos;t have any series yet. Create one first from the series page.
            </Typography>
          ) : (
            <Autocomplete
              fullWidth
              options={ownedSeriesOptions}
              value={selectedOwnedSeries}
              disabled={isAddingToSeries}
              inputValue={ownedSeriesSearchQuery}
              onInputChange={(_, newInputValue) => setOwnedSeriesSearchQuery(newInputValue)}
              onChange={(_, newValue) => {
                setSelectedOwnedSeriesId(newValue?.id || '');
              }}
              getOptionLabel={(option) => option.name}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              renderOption={(renderProps, option) => (
                <ListItem {...renderProps} key={option.id}>
                  <AvatarWithDefaultImage
                    defaultImageURL="/sermon_default.png"
                    altName={option.name}
                    width={28}
                    height={28}
                    image={option.images?.find((image) => image.type === 'square')}
                    borderRadius={5}
                    sx={{ marginRight: '12px' }}
                  />
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" noWrap>{option.name}</Typography>
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {option.publishedItemCount || 0} part series
                    </Typography>
                  </Box>
                </ListItem>
              )}
              renderInput={(params) => (
                <TextField
                  {...params}
                  margin="dense"
                  label="Select your series"
                  placeholder="Search your series..."
                  InputProps={{
                    ...params.InputProps,
                    startAdornment: selectedOwnedSeries ? (
                      <InputAdornment position="start">
                        <AvatarWithDefaultImage
                          defaultImageURL="/sermon_default.png"
                          altName={selectedOwnedSeries.name}
                          width={26}
                          height={26}
                          image={selectedOwnedSeries.images?.find((image) => image.type === 'square')}
                          borderRadius={5}
                        />
                      </InputAdornment>
                    ) : params.InputProps.startAdornment,
                  }}
                />
              )}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setAddToSeriesDialogOpen(false);
              setOwnedSeriesSearchQuery('');
            }}
            disabled={isAddingToSeries}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={addSermonToSelectedSeries}
            disabled={isAddingToSeries || loadingOwnedSeries || ownedSeriesOptions.length === 0 || !selectedOwnedSeriesId}
            startIcon={isAddingToSeries ? <CircularProgress size={16} color="inherit" /> : <AddIcon fontSize="small" />}
          >
            Add To Series
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Popup */}
      {deletePopup && (
        <DeleteEntityPopup
          entityBeingDeleted="sermon"
          handleDelete={handleDelete}
          deleteConfirmationPopup={deletePopup}
          setDeleteConfirmationPopup={setDeletePopup}
          isDeleting={isDeleting}
        />
      )}
    </>
  );
};

const ProtectedSermonDetailsPage = () => {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  if (loading || !user) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  return <SermonDetailsPage />;
};

ProtectedSermonDetailsPage.PageLayout = AppLayout;

export default ProtectedSermonDetailsPage;
