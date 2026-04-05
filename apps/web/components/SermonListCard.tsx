/**
 * SermonListCard: A component to display sermons in a list
 * Mobile-first responsive design with:
 * - Fixed height cards with square image
 * - Mobile: Actions stacked on right side
 * - Desktop: Actions in bottom row
 * - Publishing status badges (SoundCloud, Subsplash)
 * - Series tag with image and name
 * - Click to navigate to details page
 */
import React, { FunctionComponent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import type { GetUsersByIdsInputType, GetUsersByIdsOutputType } from '@upperroom/contracts/getUsersByIds';
import Card from '@mui/material/Card';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';

import { Sermon, sermonStatusType, uploadStatus } from '../types/SermonTypes';
import { Series, seriesConverter } from '../types/Series';

import useMediaQuery from '@mui/material/useMediaQuery';
import { alpha, useTheme } from '@mui/material/styles';
import { ErrorBoundary } from 'react-error-boundary';
import ErrorIcon from '@mui/icons-material/Error';
import CloudIcon from '@mui/icons-material/Cloud';
import CollectionsIcon from '@mui/icons-material/Collections';
import RefreshIcon from '@mui/icons-material/Refresh';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import PendingIcon from '@mui/icons-material/Pending';

import { useObject } from 'react-firebase-hooks/database';
import { useDocument } from 'react-firebase-hooks/firestore';
import database, { ref } from '../firebase/database';
import firestore, { doc, getDoc } from '../firebase/firestore';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import { User } from '../types/User';
import { createFunctionV2 } from '../utils/createFunction';
import { createIdleDestinationActivityState } from '../utils/sermonPublishActions';
import type { DestinationActivityState } from '../utils/sermonPublishActions';
import UserAvatar from './UserAvatar';
import useAuth from '../context/user/UserContext';
import LinearProgress from '@mui/material/LinearProgress';
import { sermonConverter } from '../types/Sermon';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import { parseProcessingProgress } from '../utils/processAudioProgress';

const ManagePublishingPopup = dynamic(() => import('./ManagePublishingPopup'), { ssr: false });

const uploaderCache = new Map<string, User>();
const pendingUploaderIds = new Set<string>();
const pendingUploaderResolvers = new Map<string, Array<(user: User | undefined) => void>>();
let uploaderBatchScheduled = false;
let uploaderBatchInFlight = false;
const seriesCache = new Map<string, Series | null>();
const pendingSeriesRequests = new Map<string, Promise<Series | null>>();

const resolvePendingUploader = (uid: string, user: User | undefined) => {
  const resolvers = pendingUploaderResolvers.get(uid);
  if (!resolvers) {
    return;
  }
  for (const resolve of resolvers) {
    resolve(user);
  }
  pendingUploaderResolvers.delete(uid);
};

const flushUploaderBatch = async () => {
  if (uploaderBatchInFlight || pendingUploaderIds.size === 0) {
    return;
  }

  uploaderBatchInFlight = true;
  const requestedUids = Array.from(pendingUploaderIds);
  pendingUploaderIds.clear();

  try {
    const getUsersByIds = createFunctionV2<GetUsersByIdsInputType, GetUsersByIdsOutputType>('getusersbyids');
    const result = await getUsersByIds({ uids: requestedUids });

    if (result.status === 'success') {
      const returnedUsers = new Map(result.data.map((lookupUser) => [lookupUser.uid, lookupUser]));

      for (const uid of requestedUids) {
        const matchedUser = returnedUsers.get(uid);
        if (matchedUser) {
          uploaderCache.set(uid, matchedUser);
        }
        resolvePendingUploader(uid, matchedUser);
      }
      return;
    }

    for (const uid of requestedUids) {
      resolvePendingUploader(uid, undefined);
    }
  } catch (error) {
    console.error('Failed batch uploader lookup:', error);
    for (const uid of requestedUids) {
      resolvePendingUploader(uid, undefined);
    }
  } finally {
    uploaderBatchInFlight = false;
    if (pendingUploaderIds.size > 0) {
      uploaderBatchScheduled = true;
      setTimeout(() => {
        uploaderBatchScheduled = false;
        flushUploaderBatch().catch((error) => {
          console.error('Failed to flush queued uploader lookup:', error);
        });
      }, 0);
    }
  }
};

const requestUploaderInBatch = (uid: string): Promise<User | undefined> => {
  const cachedUser = uploaderCache.get(uid);
  if (cachedUser) {
    return Promise.resolve(cachedUser);
  }

  return new Promise((resolve) => {
    const existingResolvers = pendingUploaderResolvers.get(uid);
    if (existingResolvers) {
      existingResolvers.push(resolve);
    } else {
      pendingUploaderResolvers.set(uid, [resolve]);
    }
    pendingUploaderIds.add(uid);

    if (!uploaderBatchScheduled) {
      uploaderBatchScheduled = true;
      setTimeout(() => {
        uploaderBatchScheduled = false;
        flushUploaderBatch().catch((error) => {
          console.error('Failed to flush uploader lookup batch:', error);
        });
      }, 0);
    }
  });
};

const fetchSeriesWithCache = async (seriesId: string): Promise<Series | null> => {
  const cachedSeries = seriesCache.get(seriesId);
  if (cachedSeries !== undefined) {
    return cachedSeries;
  }

  const inFlightRequest = pendingSeriesRequests.get(seriesId);
  if (inFlightRequest) {
    return inFlightRequest;
  }

  const request = getDoc(doc(firestore, 'series', seriesId).withConverter(seriesConverter))
    .then((seriesDoc) => {
      const resolvedSeries = seriesDoc.exists() ? seriesDoc.data() : null;
      seriesCache.set(seriesId, resolvedSeries);
      return resolvedSeries;
    })
    .catch((error) => {
      console.error('Error fetching series:', error);
      return null;
    })
    .finally(() => {
      pendingSeriesRequests.delete(seriesId);
    });

  pendingSeriesRequests.set(seriesId, request);
  return request;
};

interface Props {
  sermon: Sermon;
  playing: boolean;
  remainingTimeComponent: React.ReactNode;
  trackProgressComponent: React.ReactNode;
  audioPlayerCurrentSermonId: string | undefined;
  audioPlayerSetCurrentSermon: (sermon: Sermon | undefined) => void;
  minimal?: boolean;
  onRefresh?: () => void;
  /** When true, parent already subscribes to sermon doc; skip internal useDocument to avoid duplicate listeners. */
  subscriptionOwnedByParent?: boolean;
  enableProcessingProgress?: boolean;
  enableSeriesRealtime?: boolean;
}

const SermonListCard: FunctionComponent<Props> = ({
  sermon,
  playing,
  remainingTimeComponent: _remainingTimeComponent,
  trackProgressComponent: _trackProgressComponent,
  audioPlayerCurrentSermonId,
  audioPlayerSetCurrentSermon,
  minimal: _minimal,
  onRefresh,
  subscriptionOwnedByParent = false,
  enableProcessingProgress = true,
  enableSeriesRealtime = true,
}: Props) => {
  const router = useRouter();
  const { user } = useAuth();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const isTablet = useMediaQuery(theme.breakpoints.up('sm'));
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const docRef = useMemo(
    () => (sermon.id ? doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter) : null),
    [sermon.id]
  );
  const [sermonSnapshot, _sermonLoading, _sermonError] = useDocument(
    subscriptionOwnedByParent ? null : docRef,
    { snapshotListenOptions: { includeMetadataChanges: false } }
  );
  const realTimeSermon = sermonSnapshot?.data();
  const currentSermon = subscriptionOwnedByParent ? sermon : (realTimeSermon || sermon);

  const audioStatus = currentSermon.status.audioStatus;
  const canPublish = user?.canPublish() ?? false;
  const isProcessed = audioStatus === sermonStatusType.PROCESSED;
  const isPending = audioStatus === sermonStatusType.PENDING;
  const isProcessing = audioStatus === sermonStatusType.PROCESSING;
  const isError = audioStatus === sermonStatusType.ERROR;
  const isSoundCloudUploaded = currentSermon.status.soundCloud === uploadStatus.UPLOADED;
  const subsplashUploaded = currentSermon.numberOfListsUploadedTo ?? 0;
  const subsplashTotal = currentSermon.numberOfLists ?? 0;
  const isSubsplashPartial = subsplashUploaded > 0 && subsplashUploaded < subsplashTotal;
  const isSubsplashComplete = subsplashTotal > 0 && subsplashUploaded === subsplashTotal;
  const isCurrentlyPlaying = audioPlayerCurrentSermonId === currentSermon.id && playing;
  const shouldSubscribeToProcessingProgress = enableProcessingProgress || isProcessing;
  const processingProgressRef = useMemo(
    () => (shouldSubscribeToProcessingProgress && isProcessing ? ref(database, `addIntroOutro/${currentSermon.id}`) : null),
    [shouldSubscribeToProcessingProgress, isProcessing, currentSermon.id]
  );

  const [snapshot, _loading, _error] = useObject(processingProgressRef);
  const [uploader, setUploader] = useState<User>();
  const [uploaderLoading, setUploaderLoading] = useState(false);
  const [showUploaderTooltip, setShowUploaderTooltip] = useState(false);
  const [publishPopup, setPublishPopup] = useState(false);
  const [publishTaskActivity, setPublishTaskActivity] = useState<DestinationActivityState>(() => createIdleDestinationActivityState());
  const [series, setSeries] = useState<Series | null>(null);
  const seriesItemRef = useMemo(
    () => (
      enableSeriesRealtime && currentSermon.seriesId && currentSermon.id
        ? doc(firestore, `series/${currentSermon.seriesId}/seriesItems`, currentSermon.id)
        : null
    ),
    [currentSermon.seriesId, currentSermon.id, enableSeriesRealtime]
  );
  const [seriesItemSnapshot] = useDocument(seriesItemRef, {
    snapshotListenOptions: { includeMetadataChanges: false }
  });
  const seriesPublishedToSubsplash = enableSeriesRealtime
    ? seriesItemSnapshot?.exists() && seriesItemSnapshot.data()?.publishedToSubsplash === true
    : currentSermon.seriesPublishedToSubsplash === true;
  const persistedPublishTaskActivity = currentSermon.publishActivity ?? createIdleDestinationActivityState();

  const effectivePublishTaskActivity = (
    publishTaskActivity.listOperation !== 'idle'
    || publishTaskActivity.seriesOperation !== 'idle'
    || publishTaskActivity.soundCloudOperation !== 'idle'
  ) ? publishTaskActivity : persistedPublishTaskActivity;
  const publishTaskRunning = (
    effectivePublishTaskActivity.listOperation !== 'idle'
    || effectivePublishTaskActivity.seriesOperation !== 'idle'
    || effectivePublishTaskActivity.soundCloudOperation !== 'idle'
  );
  const subsplashListsPublishing = effectivePublishTaskActivity.listOperation !== 'idle';
  const soundCloudPublishing = effectivePublishTaskActivity.soundCloudOperation !== 'idle';
  const seriesPublishing = effectivePublishTaskActivity.seriesOperation !== 'idle';
  const listsUnpublishing = effectivePublishTaskActivity.listOperation === 'unpublish';
  const soundCloudUnpublishing = effectivePublishTaskActivity.soundCloudOperation === 'unpublish';

  const uploaderName =
    currentSermon.uploaderDisplayName ||
    currentSermon.uploaderEmail ||
    (`${uploader?.firstName ?? ''} ${uploader?.lastName ?? ''}`.trim() || uploader?.displayName) ||
    uploader?.email ||
    currentSermon.uploaderId ||
    'uploader';

  // Resolve uploader details using cache + batched backend lookup (avoids one network call per card).
  useEffect(() => {
    if (currentSermon.uploaderDisplayName || currentSermon.uploaderEmail) {
      queueMicrotask(() => {
        setUploader(undefined);
        setUploaderLoading(false);
      });
      return;
    }

    const uid = currentSermon.uploaderId;
    if (!uid) {
      queueMicrotask(() => {
        setUploader(undefined);
        setUploaderLoading(false);
      });
      return;
    }

    const cachedUser = uploaderCache.get(uid);
    if (cachedUser) {
      queueMicrotask(() => {
        setUploader(cachedUser);
        setUploaderLoading(false);
      });
      return;
    }

    // Non-admin uploader view only shows their own sermons; avoid backend lookup when it is the signed-in user.
    if (user?.uid === uid) {
      uploaderCache.set(uid, user);
      queueMicrotask(() => {
        setUploader(user);
        setUploaderLoading(false);
      });
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      setUploaderLoading(true);
    });
    requestUploaderInBatch(uid)
      .then((lookupUser) => {
        if (cancelled) {
          return;
        }
        setUploader(lookupUser);
      })
      .finally(() => {
        if (!cancelled) {
          setUploaderLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentSermon.uploaderDisplayName, currentSermon.uploaderEmail, currentSermon.uploaderId, user]);

  useEffect(() => {
    let cancelled = false;
    const seriesId = currentSermon.seriesId;
    if (currentSermon.seriesName) {
      queueMicrotask(() => {
        setSeries({
          id: seriesId || '',
          name: currentSermon.seriesName || '',
          subtitle: '',
          summary: '',
          images: currentSermon.seriesImage ? [currentSermon.seriesImage] : [],
          itemCount: 0,
          publishedItemCount: 0,
          status: 'draft',
          subsplashId: '',
          ownerId: '',
          createdAt: null,
          updatedAt: null,
        });
      });
      return;
    }

    if (!seriesId) {
      queueMicrotask(() => {
        setSeries(null);
      });
      return;
    }

    const cachedSeries = seriesCache.get(seriesId);
    if (cachedSeries !== undefined) {
      queueMicrotask(() => {
        setSeries(cachedSeries);
      });
      return;
    }

    fetchSeriesWithCache(seriesId).then((resolvedSeries) => {
      if (!cancelled) {
        setSeries(resolvedSeries);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [currentSermon.seriesId, currentSermon.seriesImage, currentSermon.seriesName]);

  const handleCardClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('[role="button"]') || target.closest('a')) {
      return;
    }
    router.push(`/admin/sermons/${currentSermon.id}`);
  };

  const handlePublishClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (canPublish && isProcessed) {
      setPublishPopup(true);
    }
  };

  const handlePlayPause = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (audioPlayerCurrentSermonId !== currentSermon.id) {
      audioPlayerSetCurrentSermon(currentSermon);
    } else {
      audioPlayerSetCurrentSermon(undefined);
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatDate = (millis: number) => {
    const date = new Date(millis);
    if (isTablet) {
      return date.toLocaleDateString('en-US', { dateStyle: 'medium' });
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
  };

  const processingProgressState = parseProcessingProgress(snapshot?.val());
  const processingProgress = processingProgressState?.percent ?? 0;
  const processingStageLabel = processingProgressState?.stageLabel ?? 'Processing';
  const isQueuedForProcessing = processingProgressState?.stage === 'queued';
  const isProcessingProgressIndeterminate = isQueuedForProcessing || !processingProgressState?.hasPercent;
  const imageSize = isDesktop ? 150 : isTablet ? 90 : 70;
  const sermonImage = currentSermon.images?.find((image) => image.type === 'square');
  const seriesImage = series?.images?.find((img) => img.type === 'wide')
    || series?.images?.find((img) => img.type === 'banner')
    || series?.images?.find((img) => img.type === 'square');

  const renderUploaderAvatar = () => (
    <Tooltip
      open={showUploaderTooltip}
      onOpen={() => setShowUploaderTooltip(true)}
      onClose={() => setShowUploaderTooltip(false)}
      placement="top"
      title={uploader ? `Uploaded by: ${uploaderName}` : currentSermon.uploaderId ? `Uploader ID: ${currentSermon.uploaderId}` : 'No Uploader Found'}
    >
      <Box
        onClick={(e) => {
          e.stopPropagation();
          setShowUploaderTooltip((previousOpen) => !previousOpen);
        }}
        sx={{ flexShrink: 0 }}
      >
        <UserAvatar
          user={uploader}
          fallbackLabel={uploaderName}
          sx={{ width: { xs: 18, sm: 24, md: 40 }, height: { xs: 18, sm: 24, md: 40 } }}
          loading={uploaderLoading}
        />
      </Box>
    </Tooltip>
  );

  const renderPlayButton = () => (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
      <IconButton
        onClick={handlePlayPause}
        size="small"
        sx={{
          bgcolor: theme.palette.primary.main,
          color: theme.palette.primary.contrastText,
          width: { xs: 18, md: 30 },
          height: { xs: 18, md: 30 },
          flexShrink: 0,
          '&:hover': { bgcolor: theme.palette.primary.dark },
        }}
      >
        {isCurrentlyPlaying ? <PauseIcon sx={{ fontSize: { xs: 12, md: 18 } }} /> : <PlayArrowIcon sx={{ fontSize: { xs: 12, md: 18 } }} />}
      </IconButton>
    </Box>
  );

  const renderSubsplashStatus = () => (
    <Tooltip
      title={
        subsplashListsPublishing
          ? listsUnpublishing
            ? 'Unpublishing from Subsplash lists…'
            : 'Publishing to Subsplash lists…'
          : `Published to ${subsplashUploaded} of ${subsplashTotal} lists`
      }
    >
      <Chip
        icon={
          subsplashListsPublishing
            ? <CircularProgress size={13} color="inherit" />
            : <CollectionsIcon sx={{ fontSize: 13 }} />
        }
        label={subsplashListsPublishing ? (listsUnpublishing ? 'Unpublishing…' : 'Publishing…') : `${subsplashUploaded}/${subsplashTotal}`}
        size="small"
        variant={subsplashListsPublishing || isSubsplashComplete ? 'filled' : 'outlined'}
        color={subsplashListsPublishing ? 'info' : isSubsplashComplete ? 'success' : isSubsplashPartial ? 'warning' : 'default'}
        onClick={handlePublishClick}
        sx={{
          height: { xs: 16, sm: 22 },
          cursor: 'pointer',
          '& .MuiChip-label': { fontSize: { xs: '0.52rem', sm: '0.65rem' }, px: { xs: 0.35, sm: 0.5 } },
          '& .MuiChip-icon': { fontSize: { xs: 10, sm: 13 }, ml: { xs: 0.35, sm: 0.5 }, mr: { xs: 0.25, sm: 0.5 } },
          '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.1) }
        }}
      />
    </Tooltip>
  );

  const renderSoundCloudStatus = () => (
    <Tooltip
      title={
        soundCloudPublishing
          ? soundCloudUnpublishing
            ? 'Unpublishing from SoundCloud…'
            : 'Publishing to SoundCloud…'
          : isSoundCloudUploaded
            ? 'Published to SoundCloud'
            : 'Not on SoundCloud'
      }
    >
      <Chip
        icon={soundCloudPublishing ? <CircularProgress size={13} color="inherit" /> : <CloudIcon sx={{ fontSize: 13 }} />}
        label={soundCloudPublishing ? (soundCloudUnpublishing ? 'Unpublishing…' : 'Publishing…') : 'SC'}
        size="small"
        variant={isSoundCloudUploaded || soundCloudPublishing ? 'filled' : 'outlined'}
        color={isSoundCloudUploaded ? 'success' : soundCloudPublishing ? 'info' : 'default'}
        onClick={handlePublishClick}
        sx={{
          height: { xs: 16, sm: 22 },
          cursor: 'pointer',
          '& .MuiChip-label': { fontSize: { xs: '0.52rem', sm: '0.65rem' }, px: { xs: 0.35, sm: 0.5 } },
          '& .MuiChip-icon': { fontSize: { xs: 10, sm: 13 }, ml: { xs: 0.35, sm: 0.5 }, mr: { xs: 0.25, sm: 0.5 } },
          '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.1) }
        }}
      />
    </Tooltip>
  );

  const renderSeriesTag = (compact: boolean) => (
    series ? (
      <Link
        href={`/admin/series/${series.id}`}
        onClick={(e) => e.stopPropagation()}
        style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
      >
        <Chip
          avatar={
            <AvatarWithDefaultImage
              image={seriesImage}
              altName={series.name}
              width={compact ? 32 : 40}
              height={compact ? 18 : 26}
              borderRadius={0}
            />
          }
          label={
            <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
              <Box
                component="span"
                sx={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {series.name}
              </Box>
              {seriesPublishing ? <CircularProgress size={compact ? 9 : 11} color="inherit" /> : null}
            </Stack>
          }
          size="small"
          variant="filled"
          sx={{
            height: compact ? 18 : { sm: 22, md: 26 },
            cursor: 'pointer',
            overflow: 'hidden',
            maxWidth: compact ? 120 : 'none',
            bgcolor: seriesPublishing
              ? alpha(theme.palette.info.main, 0.14)
              : seriesPublishedToSubsplash
              ? alpha(theme.palette.success.main, 0.12)
              : alpha(theme.palette.warning.main, 0.16),
            border: `1px solid ${seriesPublishing
              ? alpha(theme.palette.info.main, 0.34)
              : seriesPublishedToSubsplash
              ? alpha(theme.palette.success.main, 0.35)
              : alpha(theme.palette.warning.main, 0.4)}`,
            '& .MuiChip-label': {
              fontSize: compact ? '0.48rem' : { sm: '0.58rem', md: '0.68rem' },
              pl: compact ? 0.2 : { sm: 0.35, md: 0.45 },
              pr: compact ? 0.45 : { sm: 0.75, md: 1 },
              fontWeight: 500,
              color: seriesPublishing
                ? theme.palette.info.dark
                : seriesPublishedToSubsplash
                  ? theme.palette.success.dark
                  : theme.palette.warning.dark,
            },
            '& .MuiChip-avatar': {
              ml: 0,
              mr: compact ? 0.2 : { sm: 0.35, md: 0.45 },
              width: compact ? 26 : { sm: 34, md: 40 },
              height: compact ? 18 : { sm: 22, md: 26 },
              borderRadius: 0,
            },
            '&:hover': {
              bgcolor: seriesPublishing
                ? alpha(theme.palette.info.main, 0.2)
                : seriesPublishedToSubsplash
                ? alpha(theme.palette.success.main, 0.18)
                : alpha(theme.palette.warning.main, 0.24),
              borderColor: seriesPublishing
                ? theme.palette.info.main
                : seriesPublishedToSubsplash
                  ? theme.palette.success.main
                  : theme.palette.warning.main,
            }
          }}
        />
      </Link>
    ) : null
  );

  const renderProcessingChip = () => (
    isProcessing ? (
      <Chip
        label={`${processingStageLabel}${processingProgressState?.hasPercent && processingProgress > 0 ? ` ${processingProgress}%` : ''}`}
        size="small"
        color="warning"
        variant="outlined"
        sx={{
          height: { xs: 16, sm: 20 },
          width: 'fit-content',
          maxWidth: 'none',
          flexShrink: 0,
          '& .MuiChip-label': {
            fontSize: { xs: '0.5rem', sm: '0.6rem' },
            px: 0.25,
            mr: 0.25,
            p: 1,
            whiteSpace: 'nowrap',
          },
        }}
      />
    ) : null
  );

  const renderPendingChip = () => (
    isPending ? (
      <Chip
        icon={<PendingIcon />}
        label="PENDING"
        size="small"
        color="default"
        variant="outlined"
        sx={{
          height: { xs: 16, sm: 20 },
          width: 'fit-content',
          maxWidth: 'none',
          flexShrink: 0,
          '& .MuiChip-label': {
            fontSize: { xs: '0.5rem', sm: '0.6rem' },
            px: 0.5,
            whiteSpace: 'nowrap',
          },
          '& .MuiChip-icon': {
            ml: 0.5,
            mr: -0.25,
            fontSize: { xs: '0.7rem', sm: '0.85rem' },
          },
        }}
      />
    ) : null
  );

  const renderErrorIndicator = () => (
    isError ? (
      <Tooltip title={currentSermon.status.message || 'Error'}>
        <ErrorIcon sx={{ fontSize: 12, color: 'error.main' }} />
      </Tooltip>
    ) : null
  );

  // Desktop Actions Component (horizontal bottom row)
  const renderDesktopActions = () => (
    <Stack
      direction="row"
      spacing={0.5}
      alignItems="center"
      justifyContent="space-between"
      sx={{ mt: 0.5 }}
    >
      {isProcessed && canPublish && (
        <Stack direction="row" spacing={0.5} alignItems="center">
          {renderSoundCloudStatus()}
          {renderSubsplashStatus()}
          {isError && onRefresh && (
            <Tooltip title="Retry processing">
              <IconButton
                size="small"
                onClick={(e) => { e.stopPropagation(); onRefresh(); }}
                sx={{ width: 20, height: 20, color: 'error.main' }}
              >
                <RefreshIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          )}
        </Stack>
      )}
    </Stack>
  );

  return (
    <ErrorBoundary fallback={<Box>Error Loading Card</Box>}>
      <Card
        onClick={handleCardClick}
        sx={{
          display: 'flex',
          flexDirection: 'row',
          borderRadius: 1,
          cursor: 'pointer',
          overflow: 'hidden',
          mb: { xs: 1, sm: 1.5 },
          height: isMobile ? 'auto' : imageSize,
          minHeight: imageSize,
          width: '100%',
          position: 'relative',
          contentVisibility: 'auto',
          containIntrinsicSize: `${imageSize}px`,
          '&::before': {
            content: '""',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            bgcolor: alpha(theme.palette.primary.main, 0.05),
            opacity: 0,
            pointerEvents: 'none',
            zIndex: 0,
          },
          '&:hover::before': {
            opacity: 1,
          },
          '& > *': {
            position: 'relative',
            zIndex: 1,
          },
        }}
      >
        {/* Square Image */}
        <Box
          sx={{
            flexShrink: 0,
            width: imageSize,
            height: imageSize,
            bgcolor: sermonImage?.averageColorHex || 'action.hover',
            backgroundImage: sermonImage?.downloadLink
              ? `url(${sermonImage.downloadLink})`
              : 'url(/URM_icon.png)',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        />

        {/* Content Area */}
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'row',
            p: { xs: 0.5, sm: 1, md: 1 },
            overflow: 'hidden',
          }}
        >
          {isMobile ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.45, flex: 1, minWidth: 0, justifyContent: 'space-between' }}>
              <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 0.5, minWidth: 0 }}>
                <Typography
                  fontWeight={600}
                  noWrap
                  sx={{
                    lineHeight: 1.2,
                    fontSize: '0.7rem',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                    flex: 1,
                  }}
                >
                  {currentSermon.title}
                </Typography>
                {renderUploaderAvatar()}
              </Box>

              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 0.5, minWidth: 0 }}>
                <Typography
                  color="text.secondary"
                  noWrap
                  sx={{
                    lineHeight: 1.2,
                    fontSize: '0.55rem',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                    flex: 1,
                  }}
                >
                  {currentSermon.speakers?.map((speaker) => speaker.name).join(', ') || 'Unknown Speaker'}
                </Typography>
                {isProcessed ? renderSeriesTag(true) : null}
              </Box>

              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 0.5, minWidth: 0 }}>
                <Stack direction="row" spacing={0.35} alignItems="center" sx={{ minWidth: 0, flexShrink: 0 }}>
                  {isProcessed ? renderPlayButton() : null}
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.55rem', whiteSpace: 'nowrap' }}>
                    {formatDate(currentSermon.dateMillis)}
                  </Typography>
                  {currentSermon.durationSeconds > 0 ? (
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.55rem', whiteSpace: 'nowrap' }}>
                      • {formatDuration(currentSermon.durationSeconds)}
                    </Typography>
                  ) : null}
                </Stack>

                <Stack direction="row" spacing={0.35} alignItems="center" sx={{ minWidth: 0, flexShrink: 1 }}>
                  {renderProcessingChip()}
                  {renderErrorIndicator()}
                </Stack>

                {isProcessed && canPublish ? (
                  <Stack direction="row" spacing={0.35} alignItems="center" sx={{ flexShrink: 0 }}>
                    {renderSoundCloudStatus()}
                    {renderSubsplashStatus()}
                  </Stack>
                ) : <Box sx={{ width: 1, minWidth: 0 }} />}
              </Box>
            </Box>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, flex: 1, minHeight: 0, minWidth: 0, justifyContent: 'space-between' }}>
              <Box sx={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', minWidth: 0, overflow: 'hidden', width: '100%' }}>

                <Stack gap={0.5} sx={{ flex: 1, minWidth: 0, width: 0, overflow: 'hidden' }}>

                  <Typography
                    fontWeight={600}
                    noWrap
                    sx={{
                      lineHeight: 1.2,
                      fontSize: { xs: '0.7rem', sm: '0.75rem', md: '0.8rem', lg: '1rem' },
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                      width: '100%',
                    }}
                  >
                    {currentSermon.title}
                  </Typography>

                  {currentSermon.speakers?.length > 0 && (
                    <Typography
                      color="text.secondary"
                      noWrap
                      sx={{
                        lineHeight: 1.2,
                        fontSize: { xs: '0.55rem', sm: '0.7rem', md: '0.75rem' },
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                      }}
                    >
                      {currentSermon.speakers.map((speaker) => speaker.name).join(', ')}
                    </Typography>
                  )}
                </Stack>
                {renderUploaderAvatar()}
              </Box>
              {isDesktop && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    fontSize: { xs: '0.55rem', sm: '0.65rem' },
                    minHeight: 0,
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: 3,
                    overflow: 'hidden',
                    wordBreak: 'break-word',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {currentSermon.description}
                </Typography>
              )}

              <Box sx={{ display: 'flex', flexDirection: 'row', gap: { xs: 0.35, sm: 0.5 }, flexShrink: 0 }}>
                <Stack direction="column" spacing={{ xs: 0.35, sm: 0.5 }} flex={1} sx={{ overflow: 'hidden', minWidth: 0 }}>
                  <Stack direction="row" spacing={{ xs: 0.35, sm: 0.5 }} alignItems="center" sx={{ overflow: 'hidden', minWidth: 0 }}>
                    {isProcessed ? renderPlayButton() : null}
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontSize: { xs: '0.55rem', sm: '0.65rem' }, whiteSpace: 'nowrap' }}
                    >
                      {formatDate(currentSermon.dateMillis)}
                    </Typography>
                    {currentSermon.durationSeconds > 0 && (
                      <Typography variant="caption" color="text.secondary" sx={{ fontSize: { xs: '0.55rem', sm: '0.65rem' } }}>
                        • {formatDuration(currentSermon.durationSeconds)}
                      </Typography>
                    )}
                    {isProcessed && renderSeriesTag(false)}
                    <Stack direction="row" spacing={{ xs: 0.35, sm: 0.5 }} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', minWidth: 0 }}>
                      {renderPendingChip()}
                      {renderProcessingChip()}
                      {renderErrorIndicator()}
                    </Stack>
                  </Stack>
                </Stack>
                <Stack direction="column" spacing={0.5} justifyContent="center" alignItems="center" flexShrink={0}>
                  {isTablet ? renderDesktopActions() : null}
                </Stack>
              </Box>

              {isProcessing && processingProgressState && (
                <LinearProgress
                  variant={isProcessingProgressIndeterminate ? 'indeterminate' : 'determinate'}
                  value={isProcessingProgressIndeterminate ? undefined : processingProgress}
                  sx={{
                    height: 2,
                    borderRadius: 1,
                    overflow: 'hidden',
                    mt: 0.5,
                    bgcolor: alpha(theme.palette.warning.main, 0.15),
                    '& .MuiLinearProgress-bar': {
                      bgcolor: 'warning.main',
                      borderRadius: 0,
                    }
                  }}
                />
              )}
              {publishTaskRunning && (
                <LinearProgress
                  sx={{
                    height: 2,
                    borderRadius: 1,
                    mt: 0.5,
                    bgcolor: alpha(theme.palette.info.main, 0.12),
                    '& .MuiLinearProgress-bar': { bgcolor: 'info.main' }
                  }}
                />
              )}
            </Box>
          )}
        </Box>


      </Card>
      <ManagePublishingPopup
        sermon={currentSermon}
        open={publishPopup}
        onClose={() => setPublishPopup(false)}
        onUpdate={onRefresh}
        onBusyStateChange={setPublishTaskActivity}
      />
    </ErrorBoundary>
  );
};

export default SermonListCard;
