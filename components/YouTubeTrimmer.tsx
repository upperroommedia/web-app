import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import { Dispatch, FunctionComponent, memo, SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import {
  MediaPlayer,
  MediaProvider,
  MediaProviderAdapter,
  MediaProviderChangeEvent,
  isYouTubeProvider,
  MediaPlayerInstance,
  useMediaState,
  useMediaRemote,
  Controls,
  PlayButton,
  MuteButton,
  FullscreenButton,
  Time,
  Gesture,
} from '@vidstack/react';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import styles from '../styles/AudioTrimmer.module.css';
import { AudioSource } from '../pages/api/uploadFile';
import CircularProgress from '@mui/material/CircularProgress';
import { UploaderFieldError } from '../context/types';
import { getErrorMessage, showError } from './uploaderComponents/utils';
import useDebounce from '@/hooks/useDebounce';
import { EditableTimeInput, TrimSlider, useTrimmerStore } from './trimmer';
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious';
import SkipNextIcon from '@mui/icons-material/SkipNext';

/**
 * Extract YouTube video ID from various URL formats.
 */
function extractYouTubeVideoId(input: string): string | null {
  if (!input) return null;

  const value = input.trim();

  // If it's already just an ID (11 characters typical)
  if (/^[\w-]{11}$/.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '');

    let videoId: string | null = null;

    switch (host) {
      case 'youtube.com':
      case 'youtube-nocookie.com':
        if (url.pathname === '/watch') {
          videoId = url.searchParams.get('v');
        } else if (url.pathname.startsWith('/embed/')) {
          videoId = url.pathname.split('/embed/')[1];
        } else if (url.pathname.startsWith('/live/')) {
          videoId = url.pathname.split('/live/')[1];
        } else if (url.pathname.startsWith('/shorts/')) {
          videoId = url.pathname.split('/shorts/')[1];
        }
        break;

      case 'youtu.be':
        videoId = url.pathname.split('/')[1];
        break;

      default:
        return null;
    }

    if (!videoId) return null;

    // Clean up videoId (remove query params or fragments)
    videoId = videoId.split('?')[0].split('&')[0].split('#')[0];

    // Validate it looks like a proper YouTube video ID
    if (!/^[\w-]{11}$/.test(videoId)) return null;

    return videoId;
  } catch {
    // If it's not a URL, maybe it's just a malformed ID string
    return value.match(/[\w-]{11}/)?.[0] || null;
  }
}

/**
 * Normalize a YouTube URL or ID into a standard embed URL.
 * Handles live, short, and other YouTube link variants.
 * Adds parameters to hide native controls and recommended videos.
 */
export function normalizeYouTubeUrl(input: string): string | null {
  const videoId = extractYouTubeVideoId(input);
  if (!videoId) return null;

  // Build embed URL with parameters:
  // - controls=0: Hide native YouTube controls (we use our own)
  // - rel=0: Don't show related videos at end
  // - modestbranding=1: Minimal YouTube branding
  // - iv_load_policy=3: Disable video annotations
  // - disablekb=1: Disable keyboard controls (we handle them)
  const params = new URLSearchParams({
    controls: '0',
    rel: '0',
    modestbranding: '1',
    iv_load_policy: '3',
    disablekb: '1',
  });

  // Use youtube-nocookie.com for privacy mode (helps reduce recommendations)
  return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
}

interface YouTubeTrimmerProps {
  setAudioSource: Dispatch<SetStateAction<AudioSource | undefined>>;
  trimStart: number;
  duration: number;
  setTrimStart: (trimStartTime: number) => void;
  setDuration: (duration: number) => void;
  audioSourceError?: UploaderFieldError;
  setAudioSourceError: (error: boolean, message: string) => void;
}

const YouTubeTrimmer: FunctionComponent<YouTubeTrimmerProps> = ({
  setAudioSource,
  trimStart,
  duration,
  setTrimStart,
  setDuration,
  audioSourceError,
  setAudioSourceError,
}) => {
  const [inputText, setInputText] = useState('');
  const [isValidYouTubeUrl, setIsValidYouTubeUrl] = useState(false);
  const mediaPlayerRef = useRef<MediaPlayerInstance>(null);
  const remoteRef = useRef<ReturnType<typeof useMediaRemote> | null>(null);
  const hasLoadedRef = useRef(false);
  const lastSeekTimeRef = useRef(0);
  const pendingSeekTimeRef = useRef<number | null>(null); // Track the target seek time during scrubbing
  const debouncedInput = useDebounce(inputText, 500);

  // Trimmer store state and actions
  const storeTrimStart = useTrimmerStore((state) => state.trimStart);
  const storeTrimEnd = useTrimmerStore((state) => state.trimEnd);
  const isScrubbing = useTrimmerStore((state) => state.isScrubbing);
  const storeSetTrimStart = useTrimmerStore((state) => state.setTrimStart);
  const storeSetTrimEnd = useTrimmerStore((state) => state.setTrimEnd);
  const setCurrentTime = useTrimmerStore((state) => state.setCurrentTime);
  const storeSetDuration = useTrimmerStore((state) => state.setDuration);
  const initialize = useTrimmerStore((state) => state.initialize);
  const reset = useTrimmerStore((state) => state.reset);
  const setIsPlaying = useTrimmerStore((state) => state.setIsPlaying);

  // Sync store changes to parent props
  useEffect(() => {
    setTrimStart(storeTrimStart);
  }, [storeTrimStart, setTrimStart]);

  useEffect(() => {
    const trimDuration = storeTrimEnd - storeTrimStart;
    if (trimDuration > 0) {
      setDuration(trimDuration);
    }
  }, [storeTrimStart, storeTrimEnd, setDuration]);

  useEffect(() => {
    if (!mediaPlayerRef.current) return;
    mediaPlayerRef.current.startLoading();
    mediaPlayerRef.current.startLoadingPoster();
  }, [debouncedInput]);

  // Clear audio source and valid state when URL is cleared
  useEffect(() => {
    if (!debouncedInput.trim() || !normalizeYouTubeUrl(debouncedInput)) {
      setAudioSource(undefined);
      setIsValidYouTubeUrl(false);
      hasLoadedRef.current = false;
      reset();
    } else {
      hasLoadedRef.current = false;
    }
  }, [debouncedInput, setAudioSource, reset]);

  function onProviderChange(provider: MediaProviderAdapter | null, _nativeEvent: MediaProviderChangeEvent) {
    if (isYouTubeProvider(provider)) {
      // Provider is set, wait for metadata
    } else if (provider === null) {
      setAudioSource(undefined);
      setIsValidYouTubeUrl(false);
    }
  }

  // Custom player controls component
  const PlayerControls = () => {
    const isPaused = useMediaState('paused');
    const isMuted = useMediaState('muted');

    return (
      <>
        {/* Skip to Start Button */}
        <button
          className={styles.controlButton}
          onClick={handleSkipToStart}
          title="Skip to trim start"
        >
          <SkipPreviousIcon sx={{ fontSize: 20 }} />
        </button>

        {/* Play/Pause Button */}
        <PlayButton className={styles.controlButton}>
          {isPaused ? (
            <PlayArrowIcon sx={{ fontSize: 20 }} />
          ) : (
            <PauseIcon sx={{ fontSize: 20 }} />
          )}
        </PlayButton>

        {/* Skip to End Button */}
        <button
          className={styles.controlButton}
          onClick={handleSkipToEnd}
          title="Skip to trim end"
        >
          <SkipNextIcon sx={{ fontSize: 20 }} />
        </button>

        {/* Mute Button */}
        <MuteButton className={styles.controlButton}>
          {isMuted ? (
            <VolumeOffIcon sx={{ fontSize: 20 }} />
          ) : (
            <VolumeUpIcon sx={{ fontSize: 20 }} />
          )}
        </MuteButton>

        {/* Current Time / Duration */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'white', fontSize: '0.8rem', fontFamily: 'monospace', ml: 1 }}>
          <Time type="current" />
          <span>/</span>
          <Time type="duration" />
        </Box>

        {/* Spacer */}
        <Box sx={{ flex: 1 }} />

        {/* Fullscreen Button */}
        <FullscreenButton className={styles.controlButton}>
          <FullscreenIcon sx={{ fontSize: 20 }} />
        </FullscreenButton>
      </>
    );
  };

  // Inner component to track media state and detect when video is loaded
  const VideoLoadDetector = () => {
    const mediaDuration = useMediaState('duration');
    const canPlay = useMediaState('canPlay');
    const currentTime = useMediaState('currentTime');
    const paused = useMediaState('paused');
    const remote = useMediaRemote();

    // Store remote ref for external use
    useEffect(() => {
      remoteRef.current = remote;
    }, [remote]);

    // Initialize store when duration is available
    useEffect(() => {
      if (mediaDuration > 0 && debouncedInput.trim() && normalizeYouTubeUrl(debouncedInput) && !hasLoadedRef.current) {
        setIsValidYouTubeUrl(true);
        setAudioSource({ source: debouncedInput, type: 'YoutubeUrl' });
        setAudioSourceError(false, '');
        hasLoadedRef.current = true;

        // Initialize trimmer store with video duration
        initialize({
          duration: mediaDuration,
          trimStart: 0,
          trimEnd: mediaDuration,
        });
      }
    }, [mediaDuration, canPlay]);

    // Sync current time from player to store (only when not scrubbing)
    useEffect(() => {
      if (hasLoadedRef.current && !isScrubbing) {
        // If there's a pending seek, use that time instead of stale player time
        // Clear the pending ref only when player time matches (seek completed)
        const pending = pendingSeekTimeRef.current;
        let timeToSync: number;
        
        if (pending !== null) {
          // Player hasn't caught up yet - use pending time
          timeToSync = pending;
          // Clear pending only when player is close to target (seek completed)
          if (Math.abs(currentTime - pending) < 1) {
            pendingSeekTimeRef.current = null;
          }
        } else {
          timeToSync = currentTime;
        }
        
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/1facfdfd-3568-4e23-b8ca-4f6abb249e0b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'YouTubeTrimmer.tsx:VideoLoadDetector:timeSync',message:'Player time update -> store',data:{currentTime:currentTime.toFixed(2),timeToSync:timeToSync.toFixed(2),pending:pending?.toFixed(2),isScrubbing},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1-H3'})}).catch(()=>{});
        // #endregion
        setCurrentTime(timeToSync, 'media');
      }
    }, [currentTime, isScrubbing]);

    // Sync play state
    useEffect(() => {
      if (hasLoadedRef.current) {
        setIsPlaying(!paused);
      }
    }, [paused]);

    // Auto-pause at trim end boundary
    useEffect(() => {
      if (hasLoadedRef.current && !paused && currentTime >= storeTrimEnd) {
        mediaPlayerRef.current?.pause();
      }
    }, [currentTime, paused]);

    return null;
  };

  // Skip to trim start
  const handleSkipToStart = useCallback(() => {
    if (remoteRef.current) {
      remoteRef.current.seek(storeTrimStart);
    } else if (mediaPlayerRef.current) {
      mediaPlayerRef.current.currentTime = storeTrimStart;
    }
  }, [storeTrimStart]);

  // Skip to trim end (minus a small offset to preview the end)
  const handleSkipToEnd = useCallback(() => {
    // Go to 3 seconds before trim end, or trim start if shorter
    const endPreview = Math.max(storeTrimStart, storeTrimEnd - 3);
    if (remoteRef.current) {
      remoteRef.current.seek(endPreview);
    } else if (mediaPlayerRef.current) {
      mediaPlayerRef.current.currentTime = endPreview;
    }
  }, [storeTrimStart, storeTrimEnd]);

  // Error timeout
  useEffect(() => {
    if (isValidYouTubeUrl || !inputText.trim()) return;
    const timeoutId = setTimeout(() => {
      if (!isValidYouTubeUrl) {
        setAudioSourceError(true, 'Could not find YouTube video, please make sure the link is valid');
      }
    }, 5000);

    return () => {
      setAudioSourceError(false, '');
      clearTimeout(timeoutId);
    };
  }, [inputText, isValidYouTubeUrl, setAudioSourceError]);

  const handleTextFieldChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setInputText(event.target.value);
    },
    [setInputText]
  );

  // Handle seeking during drag - uses remote.seeking() to notify UI without actually seeking
  // Following VidStack TimeSlider pattern: seeking() during drag, seek() on release
  const handleSeeking = useCallback((time: number) => {
    // Always save the pending seek time during scrubbing
    if (isScrubbing) {
      pendingSeekTimeRef.current = time;
    }

    const now = Date.now();
    // Throttle seeking requests to 100ms (matching VidStack's seekingRequestThrottle)
    if (isScrubbing && now - lastSeekTimeRef.current < 100) {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/1facfdfd-3568-4e23-b8ca-4f6abb249e0b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'YouTubeTrimmer.tsx:handleSeeking',message:'Seeking throttled (saved pending)',data:{time:time.toFixed(2),pendingTime:pendingSeekTimeRef.current?.toFixed(2)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H2'})}).catch(()=>{});
      // #endregion
      return;
    }
    
    lastSeekTimeRef.current = now;

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/1facfdfd-3568-4e23-b8ca-4f6abb249e0b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'YouTubeTrimmer.tsx:handleSeeking',message:'Dispatching remote.seeking()',data:{time:time.toFixed(2),isScrubbing,hasRemote:!!remoteRef.current},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1-H5'})}).catch(()=>{});
    // #endregion

    if (remoteRef.current) {
      // Use remote.seeking() during drag - notifies player of seeking intent
      // This updates the preview but doesn't perform the actual seek
      remoteRef.current.seeking(time);
    }
  }, [isScrubbing]);

  // Finalize seek when playhead scrubbing ends - call remote.seek() to actually perform seek
  // Following VidStack TimeSlider pattern: seeking() during drag, seek() on release
  // NOTE: Don't clear pendingSeekTimeRef here - VideoLoadDetector clears it when player catches up
  useEffect(() => {
    if (!isScrubbing && pendingSeekTimeRef.current !== null && remoteRef.current) {
      const targetTime = pendingSeekTimeRef.current;
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/1facfdfd-3568-4e23-b8ca-4f6abb249e0b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'YouTubeTrimmer.tsx:scrubEnd',message:'Finalizing seek with remote.seek()',data:{targetTime:targetTime.toFixed(2)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H6'})}).catch(()=>{});
      // #endregion
      // remote.seek() actually performs the seek (after series of seeking() calls)
      remoteRef.current.seek(targetTime);
      // pendingSeekTimeRef cleared by VideoLoadDetector when player catches up
    }
  }, [isScrubbing]);

  // Handle trim handle drag end - seek to the target time directly
  const handleTrimDragEnd = useCallback((time: number) => {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/1facfdfd-3568-4e23-b8ca-4f6abb249e0b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'YouTubeTrimmer.tsx:handleTrimDragEnd',message:'Seeking after trim handle release',data:{time:time.toFixed(2)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H6'})}).catch(()=>{});
    // #endregion
    // Clear pending seek to prevent double-seek from scrubEnd effect
    pendingSeekTimeRef.current = null;
    if (remoteRef.current) {
      remoteRef.current.seek(time);
    } else if (mediaPlayerRef.current) {
      mediaPlayerRef.current.currentTime = time;
    }
  }, []);

  return (
    <Box display="flex" width={1} flexDirection="column" justifyContent="center" alignItems="center" gap={1}>
      <Box display="flex" width={1} justifyContent="center" alignItems="center" gap={1}>
        <TextField
          sx={{
            display: 'block',
            width: 1,
          }}
          fullWidth
          id="youtube-url-input"
          label="Youtube Link"
          name="Youtube Link"
          variant="outlined"
          required
          error={showError(audioSourceError)}
          helperText={getErrorMessage(audioSourceError)}
          value={inputText}
          onChange={handleTextFieldChange}
        />
      </Box>
      {!showError(audioSourceError) && !isValidYouTubeUrl && inputText.trim() && <CircularProgress />}
      {/* Video Player with custom controls */}
      <Box sx={{ position: 'relative', width: '100%', display: isValidYouTubeUrl ? 'block' : 'none' }}>
        <MediaPlayer
          ref={mediaPlayerRef}
          className={`${styles.player} media-player`}
          src={normalizeYouTubeUrl(debouncedInput) || undefined}
          load="custom"
          posterLoad="custom"
          onProviderChange={onProviderChange}
          crossOrigin
          playsInline
          viewType="video"
          onError={() => {
            setIsValidYouTubeUrl(false);
            setAudioSource(undefined);
            setAudioSourceError(true, 'Could not load YouTube video, please check the link');
          }}
        >
          <MediaProvider iframeProps={{ style: { height: '100%', width: '100%' } }} />
          <VideoLoadDetector />

          {/* Click to play/pause */}
          <Gesture
            className={styles.gestureLayer}
            event="pointerup"
            action="toggle:paused"
          />

          {/* Custom Controls Overlay */}
          <Controls.Root
            hideDelay={3000}
            hideOnMouseLeave={false}
            className={styles.controlsRoot}
          >
            {/* Trim Slider - our custom timeline */}
            <Controls.Group className={styles.controlsSliderGroup}>
              <TrimSlider onSeek={handleSeeking} onTrimDragEnd={handleTrimDragEnd} height={14} />
            </Controls.Group>

            {/* Bottom control bar */}
            <Controls.Group className={styles.controlsBottomBar}>
              <PlayerControls />
            </Controls.Group>
          </Controls.Root>
        </MediaPlayer>
      </Box>

      {/* Time inputs - only show when video is loaded */}
      {isValidYouTubeUrl && (
        <Stack
          direction="row"
          spacing={2}
          alignItems="center"
          justifyContent="space-between"
          sx={{ mt: 2, width: '100%' }}
        >
          <EditableTimeInput type="start" label="Start" />
          <EditableTimeInput type="end" label="End" />
        </Stack>
      )}
    </Box>
  );
};

export default memo(YouTubeTrimmer);
