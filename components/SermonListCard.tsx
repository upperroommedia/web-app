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
  const imageSize = isDesktop ? 100 : isTablet ? 90 : 64;
  const sermonImage = sermon.images?.find((image) => image.type === 'square');
  const seriesImage = series?.images?.find((img) => img.type === 'square');

  // Mobile Actions Component (stacked vertically on right)
  const MobileActions = () => (
    <Stack 
      direction="column" 
      spacing={0.5} 
      alignItems="center"
      sx={{ flexShrink: 0, ml: 0.5 }}
    >
      {/* Play Button */}
      {isProcessed && (
        <IconButton
          onClick={handlePlayPause}
          size="small"
          sx={{
            bgcolor: theme.palette.primary.main,
            color: theme.palette.primary.contrastText,
            width: 24,
            height: 24,
            '&:hover': { bgcolor: theme.palette.primary.dark },
          }}
        >
          {isCurrentlyPlaying ? (
            <PauseIcon sx={{ fontSize: 14 }} />
          ) : (
            <PlayArrowIcon sx={{ fontSize: 14 }} />
          )}
        </IconButton>
      )}

      {/* Publishing Status */}
      {isProcessed && canPublish && (
        <>
          <Tooltip title={isSoundCloudUploaded ? 'SoundCloud ✓' : 'Not on SC'}>
            <Box
              onClick={handlePublishClick}
              sx={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: isSoundCloudUploaded ? 'success.main' : 'action.disabledBackground',
                color: isSoundCloudUploaded ? 'success.contrastText' : 'text.disabled',
                cursor: 'pointer',
              }}
            >
              <CloudIcon sx={{ fontSize: 12 }} />
            </Box>
          </Tooltip>
          <Tooltip title={`Subsplash: ${subsplashUploaded}/${subsplashTotal}`}>
            <Box
              onClick={handlePublishClick}
              sx={{
                minWidth: 20,
                height: 20,
                borderRadius: 10,
                px: 0.5,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: isSubsplashComplete ? 'success.main' : isSubsplashPartial ? 'warning.main' : 'action.disabledBackground',
                color: isSubsplashComplete || isSubsplashPartial ? 'white' : 'text.disabled',
                cursor: 'pointer',
                fontSize: '0.55rem',
                fontWeight: 600,
              }}
            >
              {subsplashUploaded}/{subsplashTotal}
            </Box>
          </Tooltip>
        </>
      )}
    </Stack>
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
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        {isProcessed && (
          <IconButton
            onClick={handlePlayPause}
            size="small"
            sx={{
              bgcolor: theme.palette.primary.main,
              color: theme.palette.primary.contrastText,
              width: 30,
              height: 30,
              '&:hover': { bgcolor: theme.palette.primary.dark },
            }}
          >
            {isCurrentlyPlaying ? <PauseIcon sx={{ fontSize: 18 }} /> : <PlayArrowIcon sx={{ fontSize: 18 }} />}
          </IconButton>
        )}
        {audioPlayerCurrentSermonId === sermon.id && !minimal && remainingTimeComponent}
      </Box>

      {isProcessed && canPublish && (
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Tooltip title={isSoundCloudUploaded ? 'Published to SoundCloud' : 'Not on SoundCloud'}>
            <Chip
              icon={<CloudIcon sx={{ fontSize: 13 }} />}
              label="SC"
              size="small"
              variant={isSoundCloudUploaded ? 'filled' : 'outlined'}
              color={isSoundCloudUploaded ? 'success' : 'default'}
              onClick={handlePublishClick}
              sx={{ 
                height: 22,
                cursor: 'pointer',
                '& .MuiChip-label': { fontSize: '0.65rem', px: 0.5 },
                '& .MuiChip-icon': { ml: 0.5 },
                '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.1) }
              }}
            />
          </Tooltip>
          <Tooltip title={`Published to ${subsplashUploaded} of ${subsplashTotal} lists`}>
            <Chip
              icon={<CollectionsIcon sx={{ fontSize: 13 }} />}
              label={`${subsplashUploaded}/${subsplashTotal}`}
              size="small"
              variant={isSubsplashComplete ? 'filled' : 'outlined'}
              color={isSubsplashComplete ? 'success' : isSubsplashPartial ? 'warning' : 'default'}
              onClick={handlePublishClick}
              sx={{ 
                height: 22,
                cursor: 'pointer',
                '& .MuiChip-label': { fontSize: '0.65rem', px: 0.5 },
                '& .MuiChip-icon': { ml: 0.5 },
                '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.1) }
              }}
            />
          </Tooltip>
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
            p: { xs: 0.5, sm: 1, md: 1.5 }, 
            overflow: 'hidden',
          }}
        >
          {/* Text Content */}
          <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', overflow: 'hidden' }}>
            {/* Title */}
            <Typography
              fontWeight={600}
              noWrap
              sx={{
                lineHeight: 1.2,
                fontSize: { xs: '0.75rem', sm: '0.85rem', md: '0.95rem' },
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
                }}
              >
                {sermon.speakers.map(s => s.name).join(', ')}
              </Typography>
            )}

            {/* Meta Row */}
            <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.25, flexWrap: 'nowrap', overflow: 'hidden' }}>
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
                  icon={<PendingIcon sx={{ fontSize: 10 }} />}
                  label={processingProgress > 0 ? `${processingProgress}%` : '...'}
                  size="small"
                  color="warning"
                  variant="outlined"
                  sx={{ height: 16, '& .MuiChip-label': { fontSize: '0.5rem', px: 0.25 }, '& .MuiChip-icon': { ml: 0.25 } }}
                />
              )}

              {isError && (
                <Tooltip title={sermon.status.message || 'Error'}>
                  <ErrorIcon sx={{ fontSize: 12, color: 'error.main' }} />
                </Tooltip>
              )}
            </Stack>

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

            {/* Desktop: Actions at bottom */}
            {isTablet && <DesktopActions />}
          </Box>

          {/* Mobile: Actions on right side (stacked) */}
          {!isTablet && <MobileActions />}

          {/* Uploader Avatar - tablet+ only */}
          {isTablet && (
            <Tooltip
              open={showUploaderTooltip}
              onOpen={() => setShowUploaderTooltip(true)}
              onClose={() => setShowUploaderTooltip(false)}
              placement="top"
              title={uploader ? `Uploaded by: ${uploaderName}` : 'No Uploader Found'}
            >
              <Box 
                onClick={(e) => { e.stopPropagation(); setShowUploaderTooltip((prev) => !prev); }} 
                sx={{ flexShrink: 0, ml: 1, alignSelf: 'flex-start' }}
              >
                <UserAvatar user={uploader} sx={{ width: 24, height: 24 }} loading={uploaderLoading} />
              </Box>
            </Tooltip>
          )}
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
