/**
 * BottomAudioBar - A floating audio player with glassmorphism effect
 * Inspired by modern music players like Spotify
 */
import { FunctionComponent } from 'react';
import { MediaProvider } from '@vidstack/react';
import {
  VolumeSlider,
  TimeSlider,
  Time,
  MuteButton,
  Controls,
  PlayButton,
  SeekButton,
  Tooltip,
  useMediaState,
  type TooltipPlacement,
} from '@vidstack/react';
import {
  MuteIcon,
  PauseIcon,
  PlayIcon,
  SeekBackward10Icon,
  SeekForward10Icon,
  VolumeHighIcon,
  VolumeLowIcon,
} from '@vidstack/react/icons';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import { useTheme, alpha } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';

interface MediaButtonProps {
  tooltipPlacement: TooltipPlacement;
}

interface SeekButtonProps extends MediaButtonProps {
  seconds: number;
}

// Time Slider Component
function Slider() {
  const theme = useTheme();
  return (
    <TimeSlider.Root className="vds-time-slider vds-slider">
      <TimeSlider.Chapters className="vds-slider-chapters">
        {(cues, forwardRef) =>
          cues.map((cue) => (
            <div className="vds-slider-chapter" key={cue.startTime} ref={forwardRef}>
              <TimeSlider.Track className="vds-slider-track" />
              <TimeSlider.TrackFill className="vds-slider-track-fill vds-slider-track" />
              <TimeSlider.Progress className="vds-slider-progress vds-slider-track" />
            </div>
          ))
        }
      </TimeSlider.Chapters>
      <TimeSlider.Thumb className="vds-slider-thumb" />
      <TimeSlider.Preview className="vds-slider-preview" noClamp style={{ backgroundColor: 'transparent' }}>
        <TimeSlider.Value style={{ color: theme.palette.text.primary, fontSize: '12px', backgroundColor: 'transparent' }} />
      </TimeSlider.Preview>
    </TimeSlider.Root>
  );
}

// Seek Button Component
export function Seek({ seconds, tooltipPlacement }: SeekButtonProps) {
  const isBackward = seconds < 0;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <SeekButton className="vds-button floating-player-btn" seconds={seconds}>
          {isBackward ? <SeekBackward10Icon /> : <SeekForward10Icon />}
        </SeekButton>
      </Tooltip.Trigger>
      <Tooltip.Content className="vds-tooltip-content" placement={tooltipPlacement}>
        {isBackward ? 'Seek Backward' : 'Seek Forward'}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

// Mute Button Component
function Mute({ tooltipPlacement }: MediaButtonProps) {
  const volume = useMediaState('volume');
  const isMuted = useMediaState('muted');
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <MuteButton className="vds-button floating-player-btn">
          {isMuted || volume === 0 ? <MuteIcon /> : volume < 0.5 ? <VolumeLowIcon /> : <VolumeHighIcon />}
        </MuteButton>
      </Tooltip.Trigger>
      <Tooltip.Content className="vds-tooltip-content" placement={tooltipPlacement}>
        {isMuted ? 'Unmute' : 'Mute'}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

// Play/Pause Button Component
function Play({ tooltipPlacement }: MediaButtonProps) {
  const isPaused = useMediaState('paused');
  const theme = useTheme();
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <PlayButton className="vds-button floating-player-play-btn" style={{ backgroundColor: theme.palette.primary.main }}>
          {isPaused ? <PlayIcon /> : <PauseIcon />}
        </PlayButton>
      </Tooltip.Trigger>
      <Tooltip.Content className="vds-tooltip-content" placement={tooltipPlacement}>
        {isPaused ? 'Play' : 'Pause'}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

// Current Time Display
function CurrentTime() {
  return <Time className="vds-time floating-time-current" type="current" />;
}

// Duration Time Display  
function DurationTime() {
  return <Time className="vds-time floating-time-duration" type="duration" />;
}

// Volume Slider Component
function Volume() {
  const theme = useTheme();
  return (
    <VolumeSlider.Root className="vds-volume-slider vds-slider floating-player-volume">
      <VolumeSlider.Track className="vds-slider-track" />
      <VolumeSlider.TrackFill className="vds-slider-track-fill vds-slider-track" />
      <VolumeSlider.Preview className="vds-slider-preview" noClamp style={{ backgroundColor: 'transparent' }}>
        <VolumeSlider.Value style={{ color: theme.palette.text.primary, fontSize: '12px', backgroundColor: 'transparent' }} />
      </VolumeSlider.Preview>
      <VolumeSlider.Thumb className="vds-slider-thumb" />
    </VolumeSlider.Root>
  );
}

const BottomAudioBar: FunctionComponent = () => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const downLG = useMediaQuery(theme.breakpoints.down('lg'));
  const sidebarHidden = useMediaQuery(theme.breakpoints.down('md'));
  const { currentSermon, setCurrentSermon } = useAudioPlayer();

  // Get the sermon image
  const sermonImage = currentSermon?.images?.find((image) => image.type === 'square');

  // Sidebar width for desktop positioning (260px sidebar + some margin)
  const sidebarOffset = sidebarHidden ? 0 : 130; // Half of 260px to offset center

  return (
    <Box
      className="media-player"
      sx={{
        position: 'fixed',
        bottom: 20,
        // Center in the main content area (account for sidebar on desktop)
        left: { xs: '50%', md: `calc(50% + ${sidebarOffset}px)` },
        transform: 'translateX(-50%)',
        width: { xs: 'calc(100% - 16px)', sm: 'calc(100% - 32px)', md: 'calc(100% - 300px)' },
        maxWidth: 1200,
        zIndex: 1200, // Below navbar (typically 1300) but above content
        borderRadius: downLG ? 3 : 100, // Slightly rounded when compact/multiline, pill shape when single-line
        overflow: 'hidden',
        // Glassmorphism effect
        background: alpha(theme.palette.background.paper, 0.1),
        backdropFilter: 'blur(50px) saturate(180%)',
        WebkitBackdropFilter: 'blur(28px) saturate(180%)',
        boxShadow: `0 8px 32px ${alpha(theme.palette.common.black, 0.2)}, 
                    0 0 40px ${alpha(theme.palette.primary.main, 0.1)}`,
        '&::before': {
          content: '""',
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: `linear-gradient(180deg, 
            ${alpha(theme.palette.common.white, 0.06)} 0%, 
            transparent 60%)`,
          pointerEvents: 'none',
          borderRadius: 'inherit',
        },
      }}
    >
      <MediaProvider />
      <Controls.Root className="vds-controls">
        {/* Main Player Content */}
        <Controls.Group>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              gap: { xs: 1.5, sm: 2 },
              p: { xs: 1.5, sm: 2 },
              position: 'relative',
            }}
          >
            {/* Album Art */}
            <Box
              sx={{
                position: 'relative',
                flexShrink: 0,
                borderRadius: 2,
                overflow: 'hidden',
                boxShadow: `0 4px 12px ${alpha(theme.palette.common.black, 0.3)}`,
              }}
            >
              <AvatarWithDefaultImage
                width={isMobile ? 48 : 56}
                height={isMobile ? 48 : 56}
                altName={currentSermon?.title || 'Sermon'}
                image={sermonImage}
                borderRadius={8}
              />
              {/* Subtle glow effect on album art */}
              <Box
                sx={{
                  position: 'absolute',
                  inset: -4,
                  background: `radial-gradient(circle, ${alpha(theme.palette.primary.main, 0.3)} 0%, transparent 70%)`,
                  pointerEvents: 'none',
                  zIndex: -1,
                }}
              />
            </Box>

            {/* Song Info */}
            <Box
              sx={{
                flex: 1,
                minWidth: { xs: 0, md: 120, lg: 150 },
                display: 'flex',
                flexDirection: 'column',
                gap: 0.25,
              }}
            >
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600,
                  color: theme.palette.mode === 'dark' ? theme.palette.common.white : theme.palette.grey[900],
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: { xs: '0.875rem', sm: '0.9375rem' },
                }}
              >
                {currentSermon?.title || 'Now Playing'}
              </Typography>
              <Typography
                variant="caption"
                sx={{
                  color: theme.palette.mode === 'dark'
                    ? alpha(theme.palette.common.white, 0.75)
                    : theme.palette.grey[700],
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: { xs: '0.75rem', sm: '0.8125rem' },
                }}
              >
                {currentSermon?.speakers?.map((s) => s.name).join(', ') || 'Unknown Speaker'}
              </Typography>
            </Box>

            {/* Desktop: Progress Slider with time on either side */}
            {!downLG && (
              <Box
                sx={{
                  flex: { md: 2, lg: 3 },
                  display: 'flex',
                  alignItems: 'center',
                  gap: { md: 1, lg: 2 },
                  '& .floating-time-current, & .floating-time-duration': {
                    fontFamily: '"SF Mono", "Roboto Mono", "Fira Code", monospace',
                    fontSize: '0.8125rem',
                    fontWeight: 500,
                    letterSpacing: '0.02em',
                    minWidth: 48,
                    lineHeight: 1,
                    color: theme.palette.mode === 'dark'
                      ? alpha(theme.palette.common.white, 0.85)
                      : theme.palette.grey[700],
                  },
                  '& .floating-time-current': {
                    textAlign: 'right',
                  },
                  '& .floating-time-duration': {
                    textAlign: 'left',
                    color: theme.palette.mode === 'dark'
                      ? alpha(theme.palette.common.white, 0.5)
                      : theme.palette.grey[500],
                  },
                }}
              >
                <CurrentTime />
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 120,
                    display: 'flex',
                    alignItems: 'center',
                    '--media-slider-height': '20px',
                    '--media-slider-track-height': '4px',
                    '--media-slider-thumb-size': '14px',
                    '& .vds-time-slider': {
                      display: 'flex',
                      alignItems: 'center',
                      width: '100%',
                      height: 'var(--media-slider-height)',
                      position: 'relative',
                    },
                    '& .vds-slider-chapters': {
                      display: 'flex',
                      alignItems: 'center',
                      width: '100%',
                      height: '100%',
                      position: 'relative',
                    },
                    '& .vds-slider-chapter': {
                      display: 'flex',
                      alignItems: 'center',
                      flex: 1,
                      height: '100%',
                      position: 'relative',
                    },
                    '& .vds-slider-track': {
                      position: 'absolute',
                      top: '50%',
                      left: 0,
                      right: 0,
                      transform: 'translateY(-50%)',
                      height: 'var(--media-slider-track-height)',
                      borderRadius: 'var(--media-slider-track-height)',
                      backgroundColor: theme.palette.mode === 'dark'
                        ? alpha(theme.palette.common.white, 0.2)
                        : alpha(theme.palette.grey[900], 0.12),
                    },
                    '& .vds-slider-track-fill': {
                      position: 'absolute',
                      top: '50%',
                      left: 0,
                      transform: 'translateY(-50%)',
                      height: 'var(--media-slider-track-height)',
                      borderRadius: 'var(--media-slider-track-height)',
                      backgroundColor: theme.palette.mode === 'dark'
                        ? theme.palette.common.white
                        : theme.palette.grey[800],
                    },
                    '& .vds-slider-thumb': {
                      position: 'absolute',
                      top: '50%',
                      transform: 'translate(-50%, -50%)',
                      width: 'var(--media-slider-thumb-size)',
                      height: 'var(--media-slider-thumb-size)',
                      borderRadius: '50%',
                      backgroundColor: theme.palette.mode === 'dark'
                        ? theme.palette.common.white
                        : theme.palette.grey[900],
                      // boxShadow: `0 0 10px ${alpha(theme.palette.primary.main, 0.4)}`,
                    },
                  }}
                >
                  <Slider />
                </Box>
                <DurationTime />
              </Box>
            )}

            {/* Playback Controls */}
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: { xs: 0.5, sm: 1 },
                '& .floating-player-btn': {
                  width: { xs: 36, sm: 40 },
                  height: { xs: 36, sm: 40 },
                  color: theme.palette.mode === 'dark'
                    ? alpha(theme.palette.common.white, 0.9)
                    : theme.palette.grey[700],
                  transition: 'all 0.2s ease',
                  '&:hover': {
                    color: theme.palette.mode === 'dark'
                      ? theme.palette.common.white
                      : theme.palette.grey[900],
                    transform: 'scale(1.1)',
                  },
                  '& svg': {
                    width: { xs: 20, sm: 24 },
                    height: { xs: 20, sm: 24 },
                  },
                },
                '& .floating-player-play-btn': {
                  width: { xs: 44, sm: 48 },
                  height: { xs: 44, sm: 48 },
                  backgroundColor: theme.palette.mode === 'dark'
                    ? theme.palette.common.white
                    : theme.palette.grey[900],
                  color: theme.palette.mode === 'dark'
                    ? theme.palette.primary.main
                    : theme.palette.common.white,
                  borderRadius: '50%',
                  transition: 'all 0.2s ease',
                  boxShadow: `0 4px 12px ${alpha(theme.palette.common.black, 0.3)}`,
                  '&:hover': {
                    transform: 'scale(1.08)',
                    boxShadow: `0 6px 16px ${alpha(theme.palette.common.black, 0.4)}`,
                  },
                  '& svg': {
                    width: { xs: 24, sm: 28 },
                    height: { xs: 24, sm: 28 },
                  },
                },
              }}
            >
              {!isMobile && <Seek seconds={-10} tooltipPlacement="top" />}
              <Play tooltipPlacement="top" />
              {!isMobile && <Seek seconds={10} tooltipPlacement="top" />}
            </Box>

            {/* Volume Control - Desktop only */}
            {!downLG && (
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  '--media-slider-height': '32px',
                  '--media-slider-width': '80px',
                  '& .floating-player-btn': {
                    width: 36,
                    height: 36,
                    color: theme.palette.mode === 'dark'
                      ? alpha(theme.palette.common.white, 0.8)
                      : theme.palette.grey[600],
                    '&:hover': {
                      color: theme.palette.mode === 'dark'
                        ? theme.palette.common.white
                        : theme.palette.grey[900],
                    },
                    '& svg': {
                      width: 20,
                      height: 20,
                    },
                  },
                  '& .vds-slider-track': {
                    backgroundColor: theme.palette.mode === 'dark'
                      ? alpha(theme.palette.common.white, 0.2)
                      : alpha(theme.palette.grey[900], 0.15),
                  },
                  '& .vds-slider-track-fill': {
                    backgroundColor: theme.palette.mode === 'dark'
                      ? alpha(theme.palette.common.white, 0.8)
                      : theme.palette.grey[700],
                  },
                  '& .vds-slider-thumb': {
                    backgroundColor: theme.palette.mode === 'dark'
                      ? theme.palette.common.white
                      : theme.palette.grey[800],
                  },
                }}
              >
                <Mute tooltipPlacement="top" />
                <Volume />
              </Box>
            )}

            {/* Close Button */}
            <IconButton
              onClick={() => setCurrentSermon(undefined)}
              size="small"
              sx={{
                color: theme.palette.mode === 'dark'
                  ? alpha(theme.palette.common.white, 0.7)
                  : theme.palette.grey[600],
                '&:hover': {
                  color: theme.palette.mode === 'dark'
                    ? theme.palette.common.white
                    : theme.palette.grey[900],
                  backgroundColor: theme.palette.mode === 'dark'
                    ? alpha(theme.palette.common.white, 0.1)
                    : alpha(theme.palette.grey[900], 0.1),
                },
              }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Box>
        </Controls.Group>

        {/* Mobile/Tablet: Progress slider at bottom */}
        {downLG && (
          <Controls.Group>
            <Box
              sx={{
                width: '100%',
                px: 2.5,
                pb: 1.5,
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                '--media-slider-height': '24px',
                '--media-slider-track-height': '3px',
                '--media-slider-thumb-size': '12px',
                '& .floating-time-current, & .floating-time-duration': {
                  fontFamily: '"SF Mono", "Roboto Mono", monospace',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  minWidth: 40,
                  color: theme.palette.mode === 'dark'
                    ? alpha(theme.palette.common.white, 0.8)
                    : theme.palette.grey[600],
                },
                '& .floating-time-current': {
                  textAlign: 'right',
                },
                '& .floating-time-duration': {
                  textAlign: 'left',
                  color: theme.palette.mode === 'dark'
                    ? alpha(theme.palette.common.white, 0.5)
                    : theme.palette.grey[500],
                },
              }}
            >
              <CurrentTime />
              <Box
                sx={{
                  flex: 1,
                  '& .vds-time-slider': {
                    display: 'flex',
                    alignItems: 'center',
                    width: '100%',
                    height: 'var(--media-slider-height)',
                    position: 'relative',
                  },
                  '& .vds-slider-chapters': {
                    display: 'flex',
                    alignItems: 'center',
                    width: '100%',
                    height: '100%',
                    position: 'relative',
                  },
                  '& .vds-slider-chapter': {
                    display: 'flex',
                    alignItems: 'center',
                    flex: 1,
                    height: '100%',
                    position: 'relative',
                  },
                  '& .vds-slider-track': {
                    position: 'absolute',
                    top: '50%',
                    left: 0,
                    right: 0,
                    transform: 'translateY(-50%)',
                    height: 'var(--media-slider-track-height)',
                    borderRadius: 'var(--media-slider-track-height)',
                    backgroundColor: theme.palette.mode === 'dark'
                      ? alpha(theme.palette.common.white, 0.2)
                      : alpha(theme.palette.grey[900], 0.12),
                  },
                  '& .vds-slider-track-fill': {
                    position: 'absolute',
                    top: '50%',
                    left: 0,
                    transform: 'translateY(-50%)',
                    height: 'var(--media-slider-track-height)',
                    borderRadius: 'var(--media-slider-track-height)',
                    backgroundColor: theme.palette.mode === 'dark'
                      ? theme.palette.common.white
                      : theme.palette.grey[800],
                  },
                  '& .vds-slider-thumb': {
                    position: 'absolute',
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: 'var(--media-slider-thumb-size)',
                    height: 'var(--media-slider-thumb-size)',
                    borderRadius: '50%',
                    backgroundColor: theme.palette.mode === 'dark'
                      ? theme.palette.common.white
                      : theme.palette.grey[900],
                  },
                }}
              >
                <Slider />
              </Box>
              <DurationTime />
            </Box>
          </Controls.Group>
        )}
      </Controls.Root>
    </Box>
  );
};

export default BottomAudioBar;
