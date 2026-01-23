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
import React, { FunctionComponent, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { GetUserInputType, GetUserOutputType } from '../functions/src/getUser';
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
import PendingIcon from '@mui/icons-material/Pending';
import CloudIcon from '@mui/icons-material/Cloud';
import CollectionsIcon from '@mui/icons-material/Collections';
import RefreshIcon from '@mui/icons-material/Refresh';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';

import { useObject } from 'react-firebase-hooks/database';
import database, { ref } from '../firebase/database';
import firestore, { doc, getDoc } from '../firebase/firestore';
import Tooltip from '@mui/material/Tooltip';
import { User } from '../types/User';
import { createFunctionV2 } from '../utils/createFunction';
import UserAvatar from './UserAvatar';
import useAuth from '../context/user/UserContext';
import LinearProgress from '@mui/material/LinearProgress';

const ManagePublishingPopup = dynamic(() => import('./ManagePublishingPopup'), { ssr: false });

interface Props {
  sermon: Sermon;
  playing: boolean;
  remainingTimeComponent: React.ReactNode;
  trackProgressComponent: React.ReactNode;
  audioPlayerCurrentSermonId: string | undefined;
  audioPlayerSetCurrentSermon: (sermon: Sermon | undefined) => void;
  minimal?: boolean;
  onRefresh?: () => void;
}

const SermonListCard: FunctionComponent<Props> = ({
  sermon,
  playing,
  remainingTimeComponent,
  trackProgressComponent,
  audioPlayerCurrentSermonId,
  audioPlayerSetCurrentSermon,
  minimal,
  onRefresh,
}: Props) => {
  const router = useRouter();
  const { user } = useAuth();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const isTablet = useMediaQuery(theme.breakpoints.up('sm'));
  const [snapshot, _loading, _error] = useObject(ref(database, `addIntroOutro/${sermon.id}`));
  const [uploader, setUploader] = useState<User>();
  const [uploaderLoading, setUploaderLoading] = useState(false);
  const [showUploaderTooltip, setShowUploaderTooltip] = useState(false);
  const [publishPopup, setPublishPopup] = useState(false);
  const [series, setSeries] = useState<Series | null>(null);

  const uploaderName = (`${uploader?.firstName ?? ''} ${uploader?.lastName ?? ''}`.trim() || uploader?.displayName) ??
    uploader?.email ?? 'uploader';

  const canPublish = user?.canPublish() ?? false;
  const isProcessed = sermon.status.audioStatus === sermonStatusType.PROCESSED;
  const isProcessing = sermon.status.audioStatus === sermonStatusType.PROCESSING;
  const isError = sermon.status.audioStatus === sermonStatusType.ERROR;
  const isSoundCloudUploaded = sermon.status.soundCloud === uploadStatus.UPLOADED;
  const subsplashUploaded = sermon.numberOfListsUploadedTo ?? 0;
  const subsplashTotal = sermon.numberOfLists ?? 0;
  const isSubsplashPartial = subsplashUploaded > 0 && subsplashUploaded < subsplashTotal;
  const isSubsplashComplete = subsplashTotal > 0 && subsplashUploaded === subsplashTotal;
  const isCurrentlyPlaying = audioPlayerCurrentSermonId === sermon.id && playing;

  // Fetch uploader
  useEffect(() => {
    const getUser = createFunctionV2<GetUserInputType, GetUserOutputType>('getuser');
    const fetchUser = async () => {
      setUploaderLoading(true);
      if (sermon.uploaderId) {
        const result = await getUser({ uid: sermon.uploaderId });
        if (result.status === 'success') {
          setUploader(result.data);
        }
      }
      setUploaderLoading(false);
    };
    fetchUser();
  }, [sermon.uploaderId]);

  // Fetch series if sermon has seriesId
  useEffect(() => {
    const fetchSeries = async () => {
      if (!sermon.seriesId) {
        setSeries(null);
        return;
      }
      try {
        const seriesDoc = await getDoc(doc(firestore, 'series', sermon.seriesId).withConverter(seriesConverter));
        if (seriesDoc.exists()) {
          setSeries(seriesDoc.data());
        }
      } catch (err) {
        console.error('Error fetching series:', err);
      }
    };
    fetchSeries();
  }, [sermon.seriesId]);

  const handleCardClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('[role="button"]') || target.closest('a')) {
      return;
    }
    router.push(`/admin/sermons/${sermon.id}`);
  };

  const handlePublishClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (canPublish && isProcessed) {
      setPublishPopup(true);
    }
  };

  const handlePlayPause = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (audioPlayerCurrentSermonId !== sermon.id) {
      audioPlayerSetCurrentSermon(sermon);
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
  const sermonImage = sermon.images?.find((image) => image.type === 'square');
  const seriesImage = series?.images?.find((img) => img.type === 'square');

  const UploaderAvatar = () => (
    <Tooltip
      open={showUploaderTooltip}
      onOpen={() => setShowUploaderTooltip(true)}
      onClose={() => setShowUploaderTooltip(false)}
      placement="top"
      title={uploader ? `Uploaded by: ${uploaderName}` : 'No Uploader Found'}
    >
      <Box
        onClick={(e) => { e.stopPropagation(); setShowUploaderTooltip((prev) => !prev); }}
        sx={{ flexShrink: 0 }}
      >
        <UserAvatar user={uploader} sx={{ width: { xs: 20, sm: 24, md: 40 }, height: { xs: 20, sm: 24, md: 40 } }} loading={uploaderLoading} />
      </Box>
    </Tooltip>
  );

  const PlayButton = () => (
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
      {audioPlayerCurrentSermonId === sermon.id && !minimal && remainingTimeComponent}
    </Box>
  );

  const SubsplashStatus = () => (
    <Tooltip title={`Published to ${subsplashUploaded} of ${subsplashTotal} lists`}>
      <Chip
        icon={<CollectionsIcon sx={{ fontSize: 13 }} />}
        label={`${subsplashUploaded}/${subsplashTotal}`}
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

  const SoundCloudStatus = () => (
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
  const MobileActions = () => (
    <Box sx={{ display: 'flex', flexDirection: 'row', gap: 0.5 }}>
      {/* Publishing Status */}
      {isProcessed && canPublish && (
        <>
          <SoundCloudStatus />
          <SubsplashStatus />
        </>
      )}
      {/* Play Button */}
      {isProcessed && (
        <PlayButton />
      )}
    </Box>
  );

  // Desktop Actions Component (horizontal bottom row)
  const DesktopActions = () => (
    <Stack
      direction="row"
      spacing={0.5}
      alignItems="center"
      justifyContent="space-between"
      sx={{ mt: 0.5 }}
    >
      {isProcessed && canPublish && (
        <Stack direction="row" spacing={0.5} alignItems="center">
          <SoundCloudStatus />
          <SubsplashStatus />
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
              : 'url(/URM_Icon.png)',
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
                  {sermon.title}
                </Typography>

                {/* Speaker */}
                {sermon.speakers?.length > 0 && (
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
                    {sermon.speakers.map(s => s.name).join(', ')}
                  </Typography>
                )}
              </Stack>
              <UploaderAvatar />
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
                {sermon.description}
              </Typography>
            )}

            <Box sx={{ display: 'flex', flexDirection: 'row', gap: 0.5, flexShrink: 0 }}>
              <Stack direction="row" spacing={0.5} alignItems="center" flex={1} sx={{ mt: 0.25, overflow: 'hidden', minWidth: 0 }}>
                {isProcessed && isTablet && (
                  <PlayButton />
                )}
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontSize: { xs: '0.55rem', sm: '0.65rem' }, whiteSpace: 'nowrap' }}
                >
                  {formatDate(sermon.dateMillis)}
                </Typography>
                {sermon.durationSeconds > 0 && (
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: { xs: '0.55rem', sm: '0.65rem' } }}>
                    • {formatDuration(sermon.durationSeconds)}
                  </Typography>
                )}

                {/* Series Tag - Only on tablet+ */}
                {series && isTablet && (
                  <Link href={`/admin/series/${series.id}`} onClick={(e) => e.stopPropagation()} style={{ textDecoration: 'none' }}>
                    <Chip
                      avatar={<Avatar src={seriesImage?.downloadLink || '/URM_Icon.png'} alt={series.name} sx={{ width: 14, height: 14 }} />}
                      label={series.name}
                      size="small"
                      variant="outlined"
                      color="primary"
                      sx={{
                        height: 18,
                        cursor: 'pointer',
                        maxWidth: 100,
                        '& .MuiChip-label': { fontSize: '0.55rem', px: 0.5, overflow: 'hidden', textOverflow: 'ellipsis' },
                        '& .MuiChip-avatar': { ml: 0.5 },
                        '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.1) }
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
                  <Tooltip title={sermon.status.message || 'Error'}>
                    <ErrorIcon sx={{ fontSize: 12, color: 'error.main' }} />
                  </Tooltip>
                )}
              </Stack>
              <Stack direction="column" spacing={0.5} justifyContent="space-between" alignItems="center" flexShrink={0}>
                {!isTablet && <MobileActions />}
                {isTablet && <DesktopActions />}
              </Stack>
            </Box>

            {/* Processing Progress Bar */}
            {isProcessing && processingProgress > 0 && (
              <LinearProgress
                variant="determinate"
                // value={processingProgress}
                value={50}
                sx={{
                  height: 2,
                  borderRadius: 1,
                  mt: 0.5,
                  bgcolor: alpha(theme.palette.warning.main, 0.15),
                  '& .MuiLinearProgress-bar': { bgcolor: 'warning.main' }
                }}
              />
            )}
          </Box>

          {/* Meta Row */}
        </Box>


      </Card>

      {publishPopup && (
        <ManagePublishingPopup
          sermon={sermon}
          open={publishPopup}
          onClose={() => setPublishPopup(false)}
          onUpdate={onRefresh}
        />
      )}
    </ErrorBoundary>
  );
};

export default SermonListCard;
