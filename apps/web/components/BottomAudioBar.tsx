/**
 * BottomAudioBar - A floating audio player with glassmorphism effect
 * Inspired by modern music players like Spotify
 */
import { useEffect, useRef, useState } from 'react';
import { Audio, usePlayer } from '@videojs/react/audio';
import { Container } from '@videojs/react';
import { connectAudioMediaSession } from '../utils/audioMediaSession';
import MuiSlider from '@mui/material/Slider';
import Tooltip from '@mui/material/Tooltip';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import VolumeDownIcon from '@mui/icons-material/VolumeDown';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import Replay10Icon from '@mui/icons-material/Replay10';
import Forward10Icon from '@mui/icons-material/Forward10';
import { usePlaybackActions, usePlaybackFeedback } from '../context/audio/audioPlayback';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import CloseIcon from '@mui/icons-material/Close';
import { useTheme, alpha } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';

const ROOT_PLAYER_OFFSET_CSS_VAR = '--floating-player-offset';
const PLAYER_BOTTOM_GAP_PX = 20;

interface MediaButtonProps {
  tooltipPlacement: 'top' | 'bottom';
}

function formatTime(value: number) {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function Slider() {
  const { currentTime, duration } = usePlayer((state) => ({
    currentTime: state.currentTime,
    duration: state.duration,
  }));
  const { seek } = usePlaybackActions();
  const { getSource } = usePlaybackFeedback();
  const interactionSource = useRef<string | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const max = Number.isFinite(duration) && duration > 0 ? duration : 0;
  return (
    <MuiSlider
      aria-label="Playback position"
      getAriaValueText={formatTime}
      min={0}
      max={max || 1}
      step={0.1}
      value={Math.min(max, draft ?? currentTime)}
      disabled={!max}
      onChange={(_event, value) => {
        interactionSource.current ??= getSource();
        setDraft(Number(value));
      }}
      onChangeCommitted={(_event, value) => {
        const originalSource = interactionSource.current;
        interactionSource.current = null;
        setDraft(null);
        if (originalSource === getSource()) void seek(Number(value));
      }}
      valueLabelDisplay="auto"
      valueLabelFormat={formatTime}
      size="small"
      sx={{ width: '100%', py: 1.5, color: 'text.primary' }}
    />
  );
}

export function Seek({ seconds, tooltipPlacement }: MediaButtonProps & { seconds: number }) {
  const player = usePlayer();
  const duration = usePlayer((state) => state.duration);
  const { seek } = usePlaybackActions();
  const label = seconds < 0 ? 'Seek backward 10 seconds' : 'Seek forward 10 seconds';
  return (
    <Tooltip title={label} placement={tooltipPlacement}>
      <span>
        <IconButton
          className="floating-player-btn"
          aria-label={label}
          disabled={!(duration > 0)}
          onClick={() => void seek(player.state.currentTime + seconds)}
        >
          {seconds < 0 ? <Replay10Icon /> : <Forward10Icon />}
        </IconButton>
      </span>
    </Tooltip>
  );
}

function Mute({ tooltipPlacement }: MediaButtonProps) {
  const player = usePlayer();
  const { volume, muted, availability } = usePlayer((state) => ({
    volume: state.volume,
    muted: state.muted,
    availability: state.mutedAvailability,
  }));
  if (availability !== 'available') return null;
  const label = muted || volume === 0 ? 'Unmute' : 'Mute';
  return (
    <Tooltip title={label} placement={tooltipPlacement}>
      <IconButton
        className="floating-player-btn"
        aria-label={label}
        onClick={() => player.setMuted(!(muted || volume === 0))}
      >
        {muted || volume === 0 ? <VolumeOffIcon /> : volume < 0.5 ? <VolumeDownIcon /> : <VolumeUpIcon />}
      </IconButton>
    </Tooltip>
  );
}

function Play({ tooltipPlacement }: MediaButtonProps) {
  const { paused, waiting } = usePlayer((state) => ({ paused: state.paused, waiting: state.waiting }));
  const { ready, error } = usePlaybackFeedback();
  const { togglePaused } = usePlaybackActions();
  const loading = !error && (waiting || !ready);
  const label = paused ? 'Play' : 'Pause';
  return (
    <Tooltip title={loading ? 'Loading audio' : label} placement={tooltipPlacement}>
      <span>
        <IconButton
          className="floating-player-play-btn"
          aria-label={label}
          aria-busy={loading}
          disabled={loading && paused}
          onClick={togglePaused}
        >
          {loading ? (
            <CircularProgress color="inherit" size={20} thickness={5} />
          ) : paused ? (
            <PlayArrowIcon />
          ) : (
            <PauseIcon />
          )}
        </IconButton>
      </span>
    </Tooltip>
  );
}

function CurrentTime() {
  const time = usePlayer((state) => Math.floor(state.currentTime));
  return <span className="floating-time-current">{formatTime(time)}</span>;
}

function DurationTime() {
  const duration = usePlayer((state) => state.duration);
  return <span className="floating-time-duration">{formatTime(duration)}</span>;
}

function Volume() {
  const player = usePlayer();
  const volume = usePlayer((state) => (state.muted ? 0 : state.volume));
  const availability = usePlayer((state) => state.volumeAvailability);
  if (availability !== 'available') return null;
  return (
    <MuiSlider
      aria-label="Volume"
      getAriaValueText={(value) => `${Math.round(value * 100)} percent`}
      min={0}
      max={1}
      step={0.01}
      value={volume}
      onChange={(_event, value) => player.setVolume(Number(value))}
      size="small"
      sx={{ width: 80, color: 'text.primary' }}
    />
  );
}

function PlaybackMedia({ source, sourceError }: { source: string; sourceError?: string }) {
  const { setReady, setError, getSource } = usePlaybackFeedback();
  const attemptedSource = useRef('');
  const generation = useRef(0);
  useEffect(() => {
    setReady(false);
    setError(sourceError);
    attemptedSource.current = '';
    const current = ++generation.current;
    return () => {
      if (generation.current === current) generation.current++;
    };
  }, [source, sourceError, setReady, setError]);
  return (
    <Audio
      src={source || undefined}
      preload="auto"
      onLoadStart={() => setReady(false)}
      onEmptied={() => setReady(false)}
      onCanPlay={(event) => {
        setReady(true);
        if (!source || attemptedSource.current === source) return;
        attemptedSource.current = source;
        // Capture blocked autoplay rather than leaving the player spinning forever.
        const current = generation.current;
        const sourceKey = getSource();
        const media = event.currentTarget;
        void Promise.resolve()
          .then(() => media.play())
          .catch((error: unknown) => {
            if (generation.current !== current || getSource() !== sourceKey) return;
            if (error instanceof Error && error.name === 'AbortError') return;
            setError('Select Play to start audio.');
          });
      }}
      onError={(event) => {
        if (event.currentTarget.currentSrc && event.currentTarget.currentSrc !== source) return;
        setReady(false);
        setError('Audio could not load. Please try another sermon or reopen this one.');
      }}
    />
  );
}

const BottomAudioBar = ({
  source,
  sermonId,
  sourceError,
  onRetrySource,
}: {
  source: string;
  sermonId?: string;
  sourceError?: string;
  onRetrySource: () => void;
}) => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const downLG = useMediaQuery(theme.breakpoints.down('lg'));
  const sidebarHidden = useMediaQuery(theme.breakpoints.down('lg'));
  const { currentSermon, setCurrentSermon } = useAudioPlayer();
  const remote = usePlaybackActions();
  const player = usePlayer();
  const { error: playbackError, getSource } = usePlaybackFeedback();
  const error = sourceError || playbackError;
  const [retry, setRetry] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const artworkBorderRadius = downLG ? 2 : '50%';
  const artworkImageBorderRadius = downLG ? 8 : 9999;

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
    const metadata =
      typeof MediaMetadata === 'undefined'
        ? null
        : new MediaMetadata({ title: currentSermon?.title || 'Sermon audio' });
    return connectAudioMediaSession(navigator.mediaSession, metadata, player, remote, getSource);
  }, [currentSermon?.title, source, sermonId, player, remote, getSource]);

  useEffect(() => {
    const docEl = document.documentElement;
    const el = rootRef.current;
    if (!el || !docEl) return;

    const updateOffset = () => {
      const measuredHeight = el.getBoundingClientRect().height;
      const totalOffset = Math.ceil(measuredHeight + PLAYER_BOTTOM_GAP_PX);
      docEl.style.setProperty(ROOT_PLAYER_OFFSET_CSS_VAR, `${totalOffset}px`);
    };

    const clearOffset = () => {
      docEl.style.setProperty(ROOT_PLAYER_OFFSET_CSS_VAR, '0px');
    };

    const ro = new ResizeObserver(updateOffset);
    ro.observe(el);
    updateOffset();

    return () => {
      ro.disconnect();
      clearOffset();
    };
  }, []);

  // Get the sermon image
  const sermonImage = currentSermon?.images?.find((image) => image.type === 'square');

  // Sidebar width for desktop positioning (260px sidebar + some margin)
  const sidebarOffset = sidebarHidden ? 0 : 130; // Half of 260px to offset center

  return (
    <Box
      ref={rootRef}
      component={Container}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
        const target = event.target as HTMLElement;
        if (target.closest('button, input, textarea, select, [role="slider"], [contenteditable="true"]')) return;
        switch (event.key.toLowerCase()) {
          case ' ':
          case 'k':
            remote.togglePaused();
            break;
          case 'j':
            void remote.seek(player.state.currentTime - 10);
            break;
          case 'l':
            void remote.seek(player.state.currentTime + 10);
            break;
          case 'arrowleft':
            void remote.seek(player.state.currentTime - 5);
            break;
          case 'arrowright':
            void remote.seek(player.state.currentTime + 5);
            break;
          case 'm':
            if (player.state.mutedAvailability !== 'available') return;
            player.setMuted(!player.state.muted);
            break;
          default:
            return;
        }
        event.preventDefault();
      }}
      role="region"
      aria-label="Sermon audio player"
      className="media-player"
      data-testid="floating-audio-bar"
      sx={{
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 3 },
        position: 'fixed',
        bottom: `${PLAYER_BOTTOM_GAP_PX}px`,
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
      {error && (
        <Box sx={{ px: 2, pt: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography role="status" aria-live="polite" sx={{ fontSize: '0.8rem' }}>
            {error}
          </Typography>
          <Button
            size="small"
            onClick={() => {
              if (sourceError) onRetrySource();
              else setRetry((attempt) => attempt + 1);
            }}
          >
            Retry audio
          </Button>
        </Box>
      )}
      <PlaybackMedia key={`${sermonId}:${retry}`} source={source} sourceError={sourceError} />
      <div>
        {/* Main Player Content */}
        <div>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              gap: { xs: 1.5, sm: 2 },
              px: { xs: 1.5, sm: 2 },
              py: { xs: 1.5, sm: 1.25 },
              position: 'relative',
            }}
          >
            {/* Album Art */}
            <Box
              sx={{
                position: 'relative',
                flexShrink: 0,
                borderRadius: artworkBorderRadius,
                overflow: 'hidden',
                boxShadow: `0 4px 12px ${alpha(theme.palette.common.black, 0.3)}`,
              }}
            >
              <AvatarWithDefaultImage
                width={isMobile ? 48 : downLG ? 56 : 72}
                height={isMobile ? 48 : downLG ? 56 : 72}
                altName={currentSermon?.title || 'Sermon'}
                image={sermonImage}
                borderRadius={artworkImageBorderRadius}
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
                  color:
                    theme.palette.mode === 'dark' ? alpha(theme.palette.common.white, 0.75) : theme.palette.grey[700],
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
                    color:
                      theme.palette.mode === 'dark' ? alpha(theme.palette.common.white, 0.85) : theme.palette.grey[700],
                  },
                  '& .floating-time-current': {
                    textAlign: 'right',
                  },
                  '& .floating-time-duration': {
                    textAlign: 'left',
                    color:
                      theme.palette.mode === 'dark' ? alpha(theme.palette.common.white, 0.5) : theme.palette.grey[500],
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
                    '& .MuiSlider-rail': {
                      position: 'absolute',
                      top: '50%',
                      left: 0,
                      right: 0,
                      transform: 'translateY(-50%)',
                      height: 'var(--media-slider-track-height)',
                      borderRadius: 'var(--media-slider-track-height)',
                      backgroundColor:
                        theme.palette.mode === 'dark'
                          ? alpha(theme.palette.common.white, 0.2)
                          : alpha(theme.palette.grey[900], 0.12),
                    },
                    '& .MuiSlider-track': {
                      position: 'absolute',
                      top: '50%',
                      left: 0,
                      transform: 'translateY(-50%)',
                      height: 'var(--media-slider-track-height)',
                      borderRadius: 'var(--media-slider-track-height)',
                      backgroundColor:
                        theme.palette.mode === 'dark' ? theme.palette.common.white : theme.palette.grey[800],
                    },
                    '& .MuiSlider-thumb': {
                      position: 'absolute',
                      top: '50%',
                      transform: 'translate(-50%, -50%)',
                      width: 'var(--media-slider-thumb-size)',
                      height: 'var(--media-slider-thumb-size)',
                      borderRadius: '50%',
                      backgroundColor:
                        theme.palette.mode === 'dark' ? theme.palette.common.white : theme.palette.grey[900],
                      // boxShadow: `0 0 10px ${alpha(theme.palette.primary.main, 0.4)}`,
                    },
                  }}
                >
                  <Slider key={`${sermonId}:${source}`} />
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
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color:
                    theme.palette.mode === 'dark' ? alpha(theme.palette.common.white, 0.9) : theme.palette.grey[700],
                  transition: 'all 0.2s ease',
                  '&:hover': {
                    color: theme.palette.mode === 'dark' ? theme.palette.common.white : theme.palette.grey[900],
                    transform: 'scale(1.1)',
                  },
                  '& > svg': {
                    width: { xs: 20, sm: 24 },
                    height: { xs: 20, sm: 24 },
                  },
                },
                '& .floating-player-play-btn': {
                  width: { xs: 44, sm: 48 },
                  height: { xs: 44, sm: 48 },
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.palette.mode === 'dark' ? theme.palette.common.white : theme.palette.grey[900],
                  color: theme.palette.mode === 'dark' ? theme.palette.primary.main : theme.palette.common.white,
                  borderRadius: '50%',
                  transition: 'all 0.2s ease',
                  boxShadow: `0 4px 12px ${alpha(theme.palette.common.black, 0.3)}`,
                  '&:hover': {
                    transform: 'scale(1.08)',
                    boxShadow: `0 6px 16px ${alpha(theme.palette.common.black, 0.4)}`,
                  },
                  '& > svg': {
                    width: { xs: 24, sm: 28 },
                    height: { xs: 24, sm: 28 },
                  },
                  '& .MuiCircularProgress-root': {
                    display: 'block',
                    flexShrink: 0,
                  },
                  '& .MuiCircularProgress-svg': {
                    display: 'block',
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
                    color:
                      theme.palette.mode === 'dark' ? alpha(theme.palette.common.white, 0.8) : theme.palette.grey[600],
                    '&:hover': {
                      color: theme.palette.mode === 'dark' ? theme.palette.common.white : theme.palette.grey[900],
                    },
                    '& svg': {
                      width: 20,
                      height: 20,
                    },
                  },
                  '& .MuiSlider-rail': {
                    backgroundColor:
                      theme.palette.mode === 'dark'
                        ? alpha(theme.palette.common.white, 0.2)
                        : alpha(theme.palette.grey[900], 0.15),
                  },
                  '& .MuiSlider-track': {
                    backgroundColor:
                      theme.palette.mode === 'dark' ? alpha(theme.palette.common.white, 0.8) : theme.palette.grey[700],
                  },
                  '& .MuiSlider-thumb': {
                    backgroundColor:
                      theme.palette.mode === 'dark' ? theme.palette.common.white : theme.palette.grey[800],
                  },
                }}
              >
                <Mute tooltipPlacement="top" />
                <Volume />
              </Box>
            )}

            {/* Close Button */}
            <IconButton
              onClick={() => {
                remote.pause();
                setCurrentSermon(undefined);
              }}
              aria-label="Close audio player"
              size="small"
              sx={{
                color: theme.palette.mode === 'dark' ? alpha(theme.palette.common.white, 0.7) : theme.palette.grey[600],
                '&:hover': {
                  color: theme.palette.mode === 'dark' ? theme.palette.common.white : theme.palette.grey[900],
                  backgroundColor:
                    theme.palette.mode === 'dark'
                      ? alpha(theme.palette.common.white, 0.1)
                      : alpha(theme.palette.grey[900], 0.1),
                },
              }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Box>
        </div>

        {/* Mobile/Tablet: Progress slider at bottom */}
        {downLG && (
          <div>
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
                  color:
                    theme.palette.mode === 'dark' ? alpha(theme.palette.common.white, 0.8) : theme.palette.grey[600],
                },
                '& .floating-time-current': {
                  textAlign: 'right',
                },
                '& .floating-time-duration': {
                  textAlign: 'left',
                  color:
                    theme.palette.mode === 'dark' ? alpha(theme.palette.common.white, 0.5) : theme.palette.grey[500],
                },
              }}
            >
              <CurrentTime />
              <Box
                sx={{
                  flex: 1,
                  '& .MuiSlider-rail': {
                    position: 'absolute',
                    top: '50%',
                    left: 0,
                    right: 0,
                    transform: 'translateY(-50%)',
                    height: 'var(--media-slider-track-height)',
                    borderRadius: 'var(--media-slider-track-height)',
                    backgroundColor:
                      theme.palette.mode === 'dark'
                        ? alpha(theme.palette.common.white, 0.2)
                        : alpha(theme.palette.grey[900], 0.12),
                  },
                  '& .MuiSlider-track': {
                    position: 'absolute',
                    top: '50%',
                    left: 0,
                    transform: 'translateY(-50%)',
                    height: 'var(--media-slider-track-height)',
                    borderRadius: 'var(--media-slider-track-height)',
                    backgroundColor:
                      theme.palette.mode === 'dark' ? theme.palette.common.white : theme.palette.grey[800],
                  },
                  '& .MuiSlider-thumb': {
                    position: 'absolute',
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: 'var(--media-slider-thumb-size)',
                    height: 'var(--media-slider-thumb-size)',
                    borderRadius: '50%',
                    backgroundColor:
                      theme.palette.mode === 'dark' ? theme.palette.common.white : theme.palette.grey[900],
                  },
                }}
              >
                <Slider key={`${sermonId}:${source}`} />
              </Box>
              <DurationTime />
            </Box>
          </div>
        )}
      </div>
    </Box>
  );
};

export default BottomAudioBar;
