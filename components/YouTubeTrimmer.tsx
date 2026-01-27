import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import { Dispatch, FunctionComponent, memo, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Gesture,
} from '@vidstack/react';
import styles from '../styles/AudioTrimmer.module.css';
import YouTubeTrimmerControls from './YouTubeTrimmerControls';
import { AudioSource } from '../pages/api/uploadFile';
import { UploaderFieldError } from '../context/types';
import { getErrorMessage, showError } from './uploaderComponents/utils';
import useDebounce from '@/hooks/useDebounce';
import { EditableTimeInput, TrimSlider, useTrimmerStore, useVidstackTrimmerSync } from './trimmer';

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

function getBufferedEnd(buffered: TimeRanges | null | undefined): number {
  if (!buffered || buffered.length === 0) return 0;
  let maxEnd = 0;
  for (let i = 0; i < buffered.length; i += 1) {
    const end = buffered.end(i);
    if (end > maxEnd) maxEnd = end;
  }
  return maxEnd;
}

interface YouTubePlayerStateSyncProps {
  debouncedInput: string;
  normalizedUrl: string | null;
  remoteRef: React.MutableRefObject<ReturnType<typeof useMediaRemote> | null>;
  handleDurationChange: (duration: number) => void;
  setAudioSource: Dispatch<SetStateAction<AudioSource | undefined>>;
  setAudioSourceError: (error: boolean, message: string) => void;
  setIsLoading: (isLoading: boolean) => void;
  setIsReady: (isReady: boolean) => void;
  setBufferedEnd: (bufferedEnd: number) => void;
}

function YouTubePlayerStateSync({
  debouncedInput,
  normalizedUrl,
  remoteRef,
  handleDurationChange,
  setAudioSource,
  setAudioSourceError,
  setIsLoading,
  setIsReady,
  setBufferedEnd,
}: YouTubePlayerStateSyncProps) {
  const mediaDuration = useMediaState('duration');
  const canPlay = useMediaState('canPlay');
  const buffered = useMediaState('buffered');
  const waiting = useMediaState('waiting');
  const remote = useMediaRemote();
  const lastBufferedRef = useRef<number | null>(null);

  useEffect(() => {
    remoteRef.current = remote;
  }, [remote, remoteRef]);

  useEffect(() => {
    if (mediaDuration > 0) {
      handleDurationChange(mediaDuration);
    }
  }, [canPlay, handleDurationChange, mediaDuration, remote, waiting]);

  useEffect(() => {
    setIsLoading(waiting);
  }, [setIsLoading, waiting]);

  useEffect(() => {
    const bufferedEnd = getBufferedEnd(buffered);
    const nextBuffered = bufferedEnd === 0 && canPlay && mediaDuration > 0 ? mediaDuration : bufferedEnd;
    if (lastBufferedRef.current === nextBuffered) {
      return;
    }
    lastBufferedRef.current = nextBuffered;
    setBufferedEnd(nextBuffered);
  }, [buffered, canPlay, mediaDuration, setBufferedEnd]);

  useEffect(() => {
    if (normalizedUrl && mediaDuration > 0 && canPlay) {
      setIsReady(true);
      setIsLoading(false);
      setAudioSource({ source: debouncedInput, type: 'YoutubeUrl' });
      setAudioSourceError(false, '');
    }
  }, [canPlay, debouncedInput, mediaDuration, normalizedUrl, setAudioSource, setAudioSourceError, setIsLoading, setIsReady]);

  return null;
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
  trimStart: _trimStart,
  duration: _duration,
  setTrimStart,
  setDuration,
  audioSourceError,
  setAudioSourceError,
}) => {
  const [inputText, setInputText] = useState('');
  const [hasProviderError, setHasProviderError] = useState(false);
  const mediaPlayerRef = useRef<MediaPlayerInstance>(null);
  const remoteRef = useRef<ReturnType<typeof useMediaRemote> | null>(null);
  const lastSeekTimeRef = useRef(0);
  const pendingSeekTimeRef = useRef<number | null>(null);
  const lastFinalSeekRef = useRef<number | null>(null);
  const debouncedInput = useDebounce(inputText, 500);
  const normalizedUrl = useMemo(() => normalizeYouTubeUrl(debouncedInput), [debouncedInput]);

  // Trimmer store state and actions
  const storeTrimStart = useTrimmerStore((state) => state.trimStart);
  const storeTrimEnd = useTrimmerStore((state) => state.trimEnd);
  const isScrubbing = useTrimmerStore((state) => state.isScrubbing);
  const isReady = useTrimmerStore((state) => state.isReady);
  const isLoading = useTrimmerStore((state) => state.isLoading);
  const setBufferedEnd = useTrimmerStore((state) => state.setBufferedEnd);
  const setIsLoading = useTrimmerStore((state) => state.setIsLoading);
  const setIsReady = useTrimmerStore((state) => state.setIsReady);
  const reset = useTrimmerStore((state) => state.reset);
  const { togglePlayPause, subscribeToPlayer, handleDurationChange } = useVidstackTrimmerSync(mediaPlayerRef, {
    autoPauseAtEnd: true,
  });

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
    const player = mediaPlayerRef.current;
    if (!player || !normalizedUrl) return;
    player.startLoading();
    player.startLoadingPoster();
  }, [normalizedUrl]);

  // Subscribe to player state once it's mounted.
  useEffect(() => {
    const player = mediaPlayerRef.current;
    if (!player) return;
    return subscribeToPlayer(player);
  }, [subscribeToPlayer]);

  // Reset state when URL is cleared or invalid.
  useEffect(() => {
    if (!debouncedInput.trim() || !normalizedUrl) {
      setAudioSource(undefined);
      setHasProviderError(false);
      setIsReady(false);
      setIsLoading(false);
      setBufferedEnd(0);
      pendingSeekTimeRef.current = null;
      lastFinalSeekRef.current = null;
      reset();
    } else {
      setHasProviderError(false);
      setIsReady(false);
      setIsLoading(true);
    }
  }, [debouncedInput, normalizedUrl, reset, setAudioSource, setBufferedEnd, setIsLoading, setIsReady]);

  // Surface invalid URL errors after a short delay.
  useEffect(() => {
    if (!debouncedInput.trim()) {
      setAudioSourceError(false, '');
      return;
    }

    if (normalizedUrl) {
      setAudioSourceError(false, '');
      return;
    }

    const timeoutId = setTimeout(() => {
      setAudioSourceError(true, 'Could not find YouTube video, please make sure the link is valid');
    }, 5000);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [debouncedInput, normalizedUrl, setAudioSourceError]);

  function onProviderChange(provider: MediaProviderAdapter | null, _nativeEvent: MediaProviderChangeEvent) {
    if (isYouTubeProvider(provider)) {
      setHasProviderError(false);
    } else if (provider === null) {
      setAudioSource(undefined);
      setHasProviderError(true);
      setIsReady(false);
      setIsLoading(false);
    }
  }

  const commitSeek = useCallback((time: number) => {
    pendingSeekTimeRef.current = time;
    lastFinalSeekRef.current = time;
    if (remoteRef.current) {
      remoteRef.current.seek(time);
    } else if (mediaPlayerRef.current) {
      mediaPlayerRef.current.currentTime = time;
    }
  }, []);

  const requestSeeking = useCallback((time: number) => {
    pendingSeekTimeRef.current = time;
    lastFinalSeekRef.current = null;
    const now = Date.now();
    if (now - lastSeekTimeRef.current < 100) return;
    lastSeekTimeRef.current = now;

    if (remoteRef.current) {
      remoteRef.current.seeking(time);
    } else if (mediaPlayerRef.current) {
      mediaPlayerRef.current.currentTime = time;
    }
  }, []);

  // Skip to trim start/end: read from store in handler so callbacks stay stable
  // and YouTubeTrimmerControls doesn't re-render when trim bounds change.
  const handleSkipToStart = useCallback(() => {
    const start = useTrimmerStore.getState().trimStart;
    commitSeek(start);
  }, [commitSeek]);

  const handleSkipToEnd = useCallback(() => {
    const { trimStart, trimEnd } = useTrimmerStore.getState();
    const endPreview = Math.max(trimStart, trimEnd - 3);
    commitSeek(endPreview);
  }, [commitSeek]);

  const handleTextFieldChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setInputText(event.target.value);
  }, []);

  // Finalize seek when playhead scrubbing ends.
  useEffect(() => {
    if (!isScrubbing && pendingSeekTimeRef.current !== null) {
      const target = pendingSeekTimeRef.current;
      if (target !== lastFinalSeekRef.current) {
        commitSeek(target);
      }
    }
  }, [commitSeek, isScrubbing]);

  // Handle trim handle drag end - seek to the target time directly.
  const handleTrimDragEnd = useCallback(
    (time: number) => {
      commitSeek(time);
    },
    [commitSeek]
  );

  const showPlayer = Boolean(normalizedUrl) && !hasProviderError;
  const showLoading = showPlayer && (isLoading || !isReady);

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
      {!showError(audioSourceError) && !normalizedUrl && inputText.trim() && <CircularProgress />}
      {/* Video Player with custom controls */}
      <Box sx={{ position: 'relative', width: '100%', display: showPlayer ? 'block' : 'none' }}>
        <MediaPlayer
          ref={mediaPlayerRef}
          className={`${styles.player} media-player`}
          src={normalizedUrl || undefined}
          load="custom"
          posterLoad="custom"
          onProviderChange={onProviderChange}
          crossOrigin
          playsInline
          viewType="video"
          onError={() => {
            setHasProviderError(true);
            setAudioSource(undefined);
            setIsLoading(false);
            setIsReady(false);
            setAudioSourceError(true, 'Could not load YouTube video, please check the link');
          }}
        >
          <MediaProvider iframeProps={{ style: { height: '100%', width: '100%' } }} />
          <YouTubePlayerStateSync
            debouncedInput={debouncedInput}
            normalizedUrl={normalizedUrl}
            remoteRef={remoteRef}
            handleDurationChange={handleDurationChange}
            setAudioSource={setAudioSource}
            setAudioSourceError={setAudioSourceError}
            setIsLoading={setIsLoading}
            setIsReady={setIsReady}
            setBufferedEnd={setBufferedEnd}
          />

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
              <TrimSlider onSeek={requestSeeking} onTrimDragEnd={handleTrimDragEnd} height={14} />
            </Controls.Group>

            {/* Bottom control bar */}
            <Controls.Group className={styles.controlsBottomBar}>
              <YouTubeTrimmerControls
                onSkipToStart={handleSkipToStart}
                onSkipToEnd={handleSkipToEnd}
                onPlayPause={togglePlayPause}
              />
            </Controls.Group>
          </Controls.Root>
        </MediaPlayer>
        {showLoading && (
          <Box
            data-testid="player-loading-overlay"
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: 'rgba(0, 0, 0, 0.3)',
              zIndex: 5,
            }}
          >
            <CircularProgress />
          </Box>
        )}
      </Box>

      {/* Time inputs - only show when video is loaded */}
      {isReady && (
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
