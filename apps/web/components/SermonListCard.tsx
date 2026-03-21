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
import Avatar from '@mui/material/Avatar';

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

import { useObject } from 'react-firebase-hooks/database';
import { useDocument } from 'react-firebase-hooks/firestore';
import database, { ref } from '../firebase/database';
import firestore, { doc, getDoc } from '../firebase/firestore';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import { User } from '../types/User';
import { createFunctionV2 } from '../utils/createFunction';
import UserAvatar from './UserAvatar';
import useAuth from '../context/user/UserContext';
import LinearProgress from '@mui/material/LinearProgress';
import { sermonConverter } from '../types/Sermon';

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
  const isProcessing = audioStatus === sermonStatusType.PROCESSING;
  const isError = audioStatus === sermonStatusType.ERROR;
  const isSoundCloudUploaded = currentSermon.status.soundCloud === uploadStatus.UPLOADED;
  const subsplashUploaded = currentSermon.numberOfListsUploadedTo ?? 0;
  const subsplashTotal = currentSermon.numberOfLists ?? 0;
  const isSubsplashPartial = subsplashUploaded > 0 && subsplashUploaded < subsplashTotal;
  const isSubsplashComplete = subsplashTotal > 0 && subsplashUploaded === subsplashTotal;
  const isCurrentlyPlaying = audioPlayerCurrentSermonId === currentSermon.id && playing;
  const processingProgressRef = useMemo(
    () => (enableProcessingProgress && isProcessing ? ref(database, `addIntroOutro/${currentSermon.id}`) : null),
    [enableProcessingProgress, isProcessing, currentSermon.id]
  );

  const [snapshot, _loading, _error] = useObject(processingProgressRef);
  const [uploader, setUploader] = useState<User>();
  const [uploaderLoading, setUploaderLoading] = useState(false);
  const [showUploaderTooltip, setShowUploaderTooltip] = useState(false);
  const [publishPopup, setPublishPopup] = useState(false);
  const [publishTaskRunning, setPublishTaskRunning] = useState(false);
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

  const processingProgress = snapshot?.val() ? Number(snapshot.val()) : 0;
  const imageSize = isDesktop ? 150 : isTablet ? 90 : 64;
  const sermonImage = currentSermon.images?.find((image) => image.type === 'square');
  const seriesImage = series?.images?.find((img) => img.type === 'square');

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
          sx={{ width: { xs: 20, sm: 24, md: 40 }, height: { xs: 20, sm: 24, md: 40 } }}
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
          width: { xs: 20, md: 30 },
          height: { xs: 20, md: 30 },
          flexShrink: 0,
          '&:hover': { bgcolor: theme.palette.primary.dark },
        }}
      >
        {isCurrentlyPlaying ? <PauseIcon sx={{ fontSize: { xs: 14, md: 18 } }} /> : <PlayArrowIcon sx={{ fontSize: { xs: 14, md: 18 } }} />}
      </IconButton>
    </Box>
  );

  const renderSubsplashStatus = () => (
    <Tooltip title={`Published to ${subsplashUploaded} of ${subsplashTotal} lists`}>
      <Chip
        icon={
          publishTaskRunning
            ? <CircularProgress size={13} color="inherit" />
            : <CollectionsIcon sx={{ fontSize: 13 }} />
        }
        label={publishTaskRunning ? 'Publishing…' : `${subsplashUploaded}/${subsplashTotal}`}
        size="small"
        variant={isSubsplashComplete ? 'filled' : 'outlined'}
        color={isSubsplashComplete ? 'success' : isSubsplashPartial ? 'warning' : 'default'}
        onClick={handlePublishClick}
        sx={{
          height: { xs: 18, sm: 22 },
          cursor: 'pointer',
          '& .MuiChip-label': { fontSize: { xs: '0.6rem', sm: '0.65rem' }, px: 0.5 },
          '& .MuiChip-icon': { fontSize: { xs: 12, sm: 13 }, ml: 0.5, mr: 0.5 },
          '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.1) }
        }}
      />
    </Tooltip>
  );

  const renderSoundCloudStatus = () => (
    <Tooltip title={isSoundCloudUploaded ? 'Published to SoundCloud' : 'Not on SoundCloud'}>
      <Chip
        icon={<CloudIcon sx={{ fontSize: 13 }} />}
        label="SC"
        size="small"
        variant={isSoundCloudUploaded ? 'filled' : 'outlined'}
        color={isSoundCloudUploaded ? 'success' : 'default'}
        onClick={handlePublishClick}
        sx={{
          height: { xs: 18, sm: 22 },
          cursor: 'pointer',
          '& .MuiChip-label': { fontSize: { xs: '0.6rem', sm: '0.65rem' }, px: 0.5 },
          '& .MuiChip-icon': { fontSize: { xs: 12, sm: 13 }, ml: 0.5, mr: 0.5 },
          '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.1) }
        }}
      />
    </Tooltip>
  );
  // Mobile Actions Component (stacked vertically on right)
  const renderMobileActions = () => (
    <Box sx={{ display: 'flex', flexDirection: 'row', gap: 0.5 }}>
      {/* Publishing Status */}
      {isProcessed && canPublish && (
        <>
          {renderSoundCloudStatus()}
          {renderSubsplashStatus()}
        </>
      )}
      {/* Play Button */}
      {isProcessed && (
        renderPlayButton()
      )}
    </Box>
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
          cursor: 'pointer',
          overflow: 'hidden',
          mb: { xs: 1, sm: 1.5 },
          height: imageSize,
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
          {/* Text Content */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, flex: 1, minHeight: 0, minWidth: 0, justifyContent: 'space-between' }}>
            <Box sx={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', minWidth: 0, overflow: 'hidden', width: '100%' }}>

              <Stack gap={0.5} sx={{ flex: 1, minWidth: 0, width: 0, overflow: 'hidden' }}>

                {/* Title */}
                <Typography
                  fontWeight={600}
                  noWrap
                  sx={{
                    lineHeight: 1.2,
                    fontSize: { xs: '0.75rem', sm: '0.75rem', md: '0.8rem', lg: '1rem' },
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                    width: '100%',
                  }}
                >
                  {currentSermon.title}
                </Typography>

                {/* Speaker */}
                {currentSermon.speakers?.length > 0 && (
                  <Typography
                    color="text.secondary"
                    noWrap
                    sx={{
                      lineHeight: 1.2,
                      fontSize: { xs: '0.6rem', sm: '0.7rem', md: '0.75rem' },
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                      width: '100%',
                    }}
                  >
                    {currentSermon.speakers.map(s => s.name).join(', ')}
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

            <Box sx={{ display: 'flex', flexDirection: 'row', gap: 0.5, flexShrink: 0 }}>
              <Stack direction="row" spacing={0.5} alignItems="center" flex={1} sx={{ mt: 0.25, overflow: 'hidden', minWidth: 0 }}>
                {isProcessed && isTablet && (
                  renderPlayButton()
                )}
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

                {/* Series Tag - Only on tablet+ */}
                {series && isTablet && (
                  <Link href={`/admin/series/${series.id}`} onClick={(e) => e.stopPropagation()} style={{ textDecoration: 'none' }}>
                    <Chip
                      avatar={
                        <Avatar 
                          src={seriesImage?.downloadLink || '/URM_icon.png'} 
                          alt={series.name} 
                          sx={{ 
                            width: { sm: 18, md: 22 }, 
                            height: { sm: 18, md: 22 },
                          }} 
                        />
                      }
                      label={series.name}
                      size="small"
                      variant="filled"
                        sx={{
                          height: { sm: 22, md: 26 },
                          cursor: 'pointer',
                          maxWidth: { sm: 140, md: 180 },
                          bgcolor: seriesPublishedToSubsplash
                            ? alpha(theme.palette.success.main, 0.12)
                            : alpha(theme.palette.warning.main, 0.16),
                          border: `1px solid ${seriesPublishedToSubsplash
                            ? alpha(theme.palette.success.main, 0.35)
                            : alpha(theme.palette.warning.main, 0.4)}`,
                          '& .MuiChip-label': { 
                            fontSize: { sm: '0.65rem', md: '0.75rem' }, 
                            px: { sm: 0.75, md: 1 }, 
                            fontWeight: 500,
                            overflow: 'hidden', 
                            textOverflow: 'ellipsis',
                            color: seriesPublishedToSubsplash ? theme.palette.success.dark : theme.palette.warning.dark,
                          },
                          '& .MuiChip-avatar': { 
                            ml: 0.5,
                            width: { sm: 18, md: 22 },
                            height: { sm: 18, md: 22 },
                          },
                          '&:hover': { 
                            bgcolor: seriesPublishedToSubsplash
                              ? alpha(theme.palette.success.main, 0.18)
                              : alpha(theme.palette.warning.main, 0.24),
                            borderColor: seriesPublishedToSubsplash ? theme.palette.success.main : theme.palette.warning.main,
                          }
                        }}
                    />
                  </Link>
                )}

                {/* Processing Status */}
                {isProcessing && (
                  <Chip
                    label={`Processing...${processingProgress > 0 ? `${processingProgress}%` : ''}`}
                    size="small"
                    color="warning"
                    variant="outlined"
                    sx={{
                      height: { xs: 16, sm: 20 },
                      '& .MuiChip-label': { fontSize: { xs: '0.5rem', sm: '0.6rem' }, px: 0.25, mr: 0.25, p: 1 }
                    }}
                  />
                )}

                {isError && (
                  <Tooltip title={currentSermon.status.message || 'Error'}>
                    <ErrorIcon sx={{ fontSize: 12, color: 'error.main' }} />
                  </Tooltip>
                )}
              </Stack>
              <Stack direction="column" spacing={0.5} justifyContent="space-between" alignItems="center" flexShrink={0}>
                {!isTablet && renderMobileActions()}
                {isTablet && renderDesktopActions()}
              </Stack>
            </Box>

            {/* Processing Progress Bar */}
            {isProcessing && processingProgress > 0 && (
              <LinearProgress
                variant="determinate"
                value={processingProgress}
                sx={{
                  height: 2,
                  borderRadius: 1,
                  mt: 0.5,
                  bgcolor: alpha(theme.palette.warning.main, 0.15),
                  '& .MuiLinearProgress-bar': { bgcolor: 'warning.main' }
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

          {/* Meta Row */}
        </Box>


      </Card>
      <ManagePublishingPopup
        sermon={currentSermon}
        open={publishPopup}
        onClose={() => setPublishPopup(false)}
        onUpdate={onRefresh}
        onBusyStateChange={setPublishTaskRunning}
      />
    </ErrorBoundary>
  );
};

export default SermonListCard;
