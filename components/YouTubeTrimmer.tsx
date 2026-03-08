import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import Button from '@mui/material/Button';
import { Dispatch, FunctionComponent, memo, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from '../styles/AudioTrimmer.module.css';
import YouTubeTrimmerControls from './YouTubeTrimmerControls';
import { AudioSource } from '../pages/api/uploadFile';
import { UploaderFieldError } from '../context/types';
import { getErrorMessage, showError } from './uploaderComponents/utils';
import useDebounce from '@/hooks/useDebounce';
import { EditableTimeInput, TrimSlider, useTrimmerStore } from './trimmer';
import { logTrimmerDebug } from '@/utils/trimmerDebug';
import { TrimmerPlayerSnapshot } from './trimmer/playerAdapter';
import { YouTubeIframeAdapter } from './trimmer/youtubeIframeAdapter';

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
 * Normalize a YouTube URL or ID into a canonical watch URL.
 */
export function normalizeYouTubeUrl(input: string): string | null {
  const videoId = extractYouTubeVideoId(input);
  if (!videoId) return null;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Detect iOS (iPhone, iPad, iPod). Used to defer YouTube iframe load until user tap
 * (iOS Safari often blocks automatic load without user gesture). See docs/YOUTUBE_TRIMMER_IOS.md.
 */
function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const userAgent = navigator.userAgent;
  const isAppleMobile = /iPad|iPhone|iPod/.test(userAgent);
  const isIPadDesktopMode = /Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1;
  return isAppleMobile || isIPadDesktopMode;
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
  const [hasUserTappedToLoad, setHasUserTappedToLoad] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isIframeVisible, setIsIframeVisible] = useState(false);
  const [playheadTime, setPlayheadTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);

  const playerShellRef = useRef<HTMLDivElement | null>(null);
  const playerHostRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef<YouTubeIframeAdapter | null>(null);
  const latestSnapshotRef = useRef<TrimmerPlayerSnapshot | null>(null);

  const handleSnapshotRef = useRef<(snapshot: TrimmerPlayerSnapshot) => void>(() => {});
  const handleErrorRef = useRef<(message: string) => void>(() => {});

  const lastMediaTimeRef = useRef(0);
  const lastReadyRef = useRef(false);
  const lastLoadingRef = useRef(false);
  const lastIsPlayingRef = useRef(false);
  const lastMutedRef = useRef(false);

  const debouncedInput = useDebounce(inputText, 500);
  const debouncedInputRef = useRef(debouncedInput);
  const videoId = useMemo(() => extractYouTubeVideoId(debouncedInput), [debouncedInput]);

  // Trimmer store state and actions
  const storeTrimStart = useTrimmerStore((state) => state.trimStart);
  const storeTrimEnd = useTrimmerStore((state) => state.trimEnd);
  const isReady = useTrimmerStore((state) => state.isReady);
  const isLoading = useTrimmerStore((state) => state.isLoading);
  const setBufferedEnd = useTrimmerStore((state) => state.setBufferedEnd);
  const setStoreIsLoading = useTrimmerStore((state) => state.setIsLoading);
  const setStoreIsReady = useTrimmerStore((state) => state.setIsReady);
  const initialize = useTrimmerStore((state) => state.initialize);
  const setStoreDuration = useTrimmerStore((state) => state.setDuration);
  const reset = useTrimmerStore((state) => state.reset);

  const shouldLoad = Boolean(videoId) && (!isIOS() || hasUserTappedToLoad);
  const shouldLoadRef = useRef(shouldLoad);

  useEffect(() => {
    debouncedInputRef.current = debouncedInput;
  }, [debouncedInput]);

  useEffect(() => {
    shouldLoadRef.current = shouldLoad;
  }, [shouldLoad]);

  const normalizeSeekTarget = useCallback((time: number) => {
    // Known edge-case guard around absolute zero seeks.
    return time <= 0 ? 0.01 : time;
  }, []);

  const handleDurationChange = useCallback(
    (durationSeconds: number) => {
      if (durationSeconds <= 0) return;

      const state = useTrimmerStore.getState();
      if (state.duration === 0 || state.trimEnd === 0) {
        initialize({
          duration: durationSeconds,
          trimStart: 0,
          trimEnd: durationSeconds,
        });
        return;
      }

      setStoreDuration(durationSeconds);
    },
    [initialize, setStoreDuration]
  );

  useEffect(() => {
    handleSnapshotRef.current = (snapshot: TrimmerPlayerSnapshot) => {
      latestSnapshotRef.current = snapshot;

      if (snapshot.duration > 0) {
        handleDurationChange(snapshot.duration);
      }

      const nextBufferedEnd = snapshot.bufferedEnd === 0 && snapshot.ready && snapshot.duration > 0
        ? snapshot.duration
        : snapshot.bufferedEnd;
      setBufferedEnd(nextBufferedEnd);

      setPlayheadTime((prev) => (Math.abs(prev - snapshot.currentTime) > 0.05 ? snapshot.currentTime : prev));
      setMediaDuration((prev) => (Math.abs(prev - snapshot.duration) > 0.05 ? snapshot.duration : prev));

      const storeState = useTrimmerStore.getState();
      if (!storeState.isScrubbing && Math.abs(snapshot.currentTime - lastMediaTimeRef.current) > 0.05) {
        lastMediaTimeRef.current = snapshot.currentTime;
        storeState.setCurrentTime(snapshot.currentTime, 'media');
      }

      const isPlaying = !snapshot.paused;
      if (isPlaying !== lastIsPlayingRef.current) {
        lastIsPlayingRef.current = isPlaying;
        storeState.setIsPlaying(isPlaying);
      }

      if (snapshot.muted !== lastMutedRef.current) {
        lastMutedRef.current = snapshot.muted;
        setIsMuted(snapshot.muted);
      }

      const loading = shouldLoadRef.current && (!snapshot.ready || (snapshot.buffering && !snapshot.paused));
      if (loading !== lastLoadingRef.current) {
        lastLoadingRef.current = loading;
        setStoreIsLoading(loading);
      }

      if (snapshot.ready !== lastReadyRef.current) {
        lastReadyRef.current = snapshot.ready;
        setStoreIsReady(snapshot.ready);
      }

      if (snapshot.ready && shouldLoadRef.current) {
        setAudioSource({ source: debouncedInputRef.current, type: 'YoutubeUrl' });
        setAudioSourceError(false, '');
      }

      // Pause automatically when playhead leaves trim region.
      if (
        !snapshot.paused &&
        !storeState.isScrubbing &&
        storeState.trimEnd > storeState.trimStart + 0.01 &&
        snapshot.currentTime >= storeState.trimEnd
      ) {
        adapterRef.current?.pause();
      }
    };
  }, [
    handleDurationChange,
    setAudioSource,
    setAudioSourceError,
    setBufferedEnd,
    setStoreIsLoading,
    setStoreIsReady,
  ]);

  useEffect(() => {
    setHasUserTappedToLoad(false);
  }, [videoId]);

  useEffect(() => {
    handleErrorRef.current = (message: string) => {
      logTrimmerDebug('youtube-iframe.player-error', { message });
      const match = message.match(/code\\s+(-?\\d+)/i);
      const code = match ? Number(match[1]) : NaN;
      // Startup code 2/5 can be transient during iframe handshakes/re-cue.
      if (code === 2 || code === 5) {
        return;
      }
      setAudioSource(undefined);
      setStoreIsLoading(false);
      setStoreIsReady(false);
      setAudioSourceError(true, 'Could not load YouTube video, please check the link');
    };
  }, [setAudioSource, setAudioSourceError, setStoreIsLoading, setStoreIsReady]);

  useEffect(() => {
    const host = playerHostRef.current;
    if (!host) return;

    const adapter = new YouTubeIframeAdapter(host);
    adapterRef.current = adapter;

    const unsubscribeSnapshot = adapter.subscribe((snapshot) => {
      handleSnapshotRef.current(snapshot);
    });

    const unsubscribeError = adapter.onError((message) => {
      handleErrorRef.current(message);
    });

    return () => {
      unsubscribeSnapshot();
      unsubscribeError();
      adapter.destroy();
      adapterRef.current = null;
    };
  }, []);

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

  // Reset state when URL is cleared or invalid.
  useEffect(() => {
    if (!debouncedInput.trim() || !videoId) {
      setAudioSource(undefined);
      setHasUserTappedToLoad(false);
      setIsMuted(false);
      setPlayheadTime(0);
      setMediaDuration(0);
      setIsIframeVisible(false);
      setStoreIsReady(false);
      setStoreIsLoading(false);
      setBufferedEnd(0);
      lastMediaTimeRef.current = 0;
      lastReadyRef.current = false;
      lastLoadingRef.current = false;
      lastIsPlayingRef.current = false;
      lastMutedRef.current = false;
      latestSnapshotRef.current = null;
      adapterRef.current?.destroy();
      reset();
    } else {
      setStoreIsReady(false);
      setStoreIsLoading(shouldLoad);
    }
  }, [
    debouncedInput,
    reset,
    setAudioSource,
    setBufferedEnd,
    setStoreIsLoading,
    setStoreIsReady,
    shouldLoad,
    videoId,
  ]);

  // Load/cue video when valid and allowed to load.
  useEffect(() => {
    if (!videoId || !shouldLoad) {
      return;
    }

    const adapter = adapterRef.current;
    if (!adapter) return;

    setStoreIsLoading(true);
    setStoreIsReady(false);
    setIsIframeVisible(false);
    setAudioSource({ source: debouncedInputRef.current, type: 'YoutubeUrl' });
    setAudioSourceError(false, '');

    adapter.load(videoId).catch(() => {
      // Adapter-level errors are surfaced via `onError`.
    });
  }, [setAudioSource, setAudioSourceError, setStoreIsLoading, setStoreIsReady, shouldLoad, videoId]);

  useEffect(() => {
    if (!shouldLoad || !isReady) {
      setIsIframeVisible(false);
      return;
    }

    // Delay reveal slightly so transient embed startup UI does not flash.
    const timerId = window.setTimeout(() => {
      setIsIframeVisible(true);
    }, 120);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [isReady, shouldLoad]);

  // Surface invalid URL errors after a short delay.
  useEffect(() => {
    if (!debouncedInput.trim()) {
      setAudioSourceError(false, '');
      return;
    }

    if (videoId) {
      setAudioSourceError(false, '');
      return;
    }

    const timeoutId = setTimeout(() => {
      setAudioSourceError(true, 'Could not find YouTube video, please make sure the link is valid');
    }, 5000);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [debouncedInput, setAudioSourceError, videoId]);

  // Reset store when component unmounts.
  useEffect(() => {
    return () => {
      reset();
    };
  }, [reset]);

  const commitSeek = useCallback(
    (time: number, allowSeekAhead = true) => {
      const normalizedTime = normalizeSeekTarget(time);
      logTrimmerDebug('youtube-iframe.commit-seek', {
        targetTime: normalizedTime,
        allowSeekAhead,
        hasAdapter: !!adapterRef.current,
      });
      adapterRef.current?.seek(normalizedTime, { allowSeekAhead });
    },
    [normalizeSeekTarget]
  );

  const handlePreviewSeek = useCallback(
    (time: number) => {
      commitSeek(time, false);
    },
    [commitSeek]
  );

  const handleTrimDragEnd = useCallback(
    (time: number) => {
      commitSeek(time, true);
    },
    [commitSeek]
  );

  const handleSkipToStart = useCallback(() => {
    const trimStart = useTrimmerStore.getState().trimStart;
    useTrimmerStore.getState().setCurrentTime(trimStart, 'timeline');
    commitSeek(trimStart, true);
  }, [commitSeek]);

  const handleSkipToEnd = useCallback(() => {
    const { trimStart, trimEnd } = useTrimmerStore.getState();
    const targetTime = Math.max(trimStart, trimEnd - 3);
    useTrimmerStore.getState().setCurrentTime(targetTime, 'timeline');
    commitSeek(targetTime, true);
  }, [commitSeek]);

  const togglePlayPause = useCallback(() => {
    const adapter = adapterRef.current;
    if (!adapter) return;

    const snapshot = latestSnapshotRef.current;
    const state = useTrimmerStore.getState();
    const hasValidTrimBounds = state.trimEnd > state.trimStart + 0.01;

    if (!snapshot || snapshot.paused) {
      if (hasValidTrimBounds && (state.currentTime < state.trimStart || state.currentTime >= state.trimEnd)) {
        const target = normalizeSeekTarget(state.trimStart);
        state.setCurrentTime(target, 'timeline');
        adapter.seek(target, { allowSeekAhead: true });
      }
      adapter.play();
      logTrimmerDebug('youtube-iframe.play-command', {
        trimStart: state.trimStart,
        trimEnd: state.trimEnd,
        currentTime: state.currentTime,
      });
      return;
    }

    adapter.pause();
    logTrimmerDebug('youtube-iframe.pause-command');
  }, [normalizeSeekTarget]);

  const handleToggleMute = useCallback(() => {
    const nextMuted = !lastMutedRef.current;
    lastMutedRef.current = nextMuted;
    setIsMuted(nextMuted);
    adapterRef.current?.setMuted(nextMuted);
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    const shell = playerShellRef.current;
    if (!shell) return;

    if (document.fullscreenElement === shell) {
      document.exitFullscreen().catch(() => {
        // Non-blocking best effort.
      });
      return;
    }

    shell.requestFullscreen().catch(() => {
      // Non-blocking best effort.
    });
  }, []);

  const handlePlayerGesturePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      togglePlayPause();
    },
    [togglePlayPause]
  );

  const handleTextFieldChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setInputText(event.target.value);
  }, []);

  const handleTapToLoad = useCallback(() => {
    logTrimmerDebug('youtube-iframe.tap-to-load');
    if (videoId) {
      setStoreIsLoading(true);
      setHasUserTappedToLoad(true);
    }
  }, [setStoreIsLoading, videoId]);

  const showPlayer = Boolean(videoId);
  const showTapToLoadOverlay = showPlayer && isIOS() && !hasUserTappedToLoad;
  const pausedAttr = latestSnapshotRef.current?.paused ?? true;
  const bufferingAttr = latestSnapshotRef.current?.buffering ?? false;
  const showLoading = showPlayer && !showTapToLoadOverlay && (!isIframeVisible || isLoading);

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
      {!showError(audioSourceError) && !videoId && inputText.trim() && <CircularProgress />}

      <Box sx={{ position: 'relative', width: '100%', display: showPlayer ? 'block' : 'none' }}>
        <Box
          ref={playerShellRef}
          className={`${styles.player} media-player`}
          data-view-type="video"
          data-media-type="video"
          data-buffering={bufferingAttr ? '' : undefined}
          data-paused={pausedAttr ? '' : undefined}
          sx={{ position: 'relative' }}
        >
          <Box
            ref={playerHostRef}
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 1,
              opacity: isIframeVisible ? 1 : 0,
              transition: 'opacity 120ms linear',
              '& iframe': {
                width: '100%',
                height: '100%',
                border: 'none',
              },
            }}
          />

          <Box
            className={styles.gestureLayer}
            role="presentation"
            onPointerUp={handlePlayerGesturePointerUp}
          />

          <Box className={styles.controlsRoot}>
            <Box className={styles.controlsSliderGroup}>
              <TrimSlider onSeek={handlePreviewSeek} onTrimDragEnd={handleTrimDragEnd} height={14} />
            </Box>

            <Box className={styles.controlsBottomBar}>
              <YouTubeTrimmerControls
                isPaused={pausedAttr}
                isMuted={isMuted}
                currentTime={playheadTime}
                duration={mediaDuration}
                onSkipToStart={handleSkipToStart}
                onSkipToEnd={handleSkipToEnd}
                onPlayPause={togglePlayPause}
                onToggleMute={handleToggleMute}
                onToggleFullscreen={handleToggleFullscreen}
              />
            </Box>
          </Box>
        </Box>

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
              zIndex: 11,
            }}
          >
            <CircularProgress />
          </Box>
        )}

        {showTapToLoadOverlay && (
          <Box
            data-testid="tap-to-load-overlay"
            component="div"
            role="presentation"
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: 'rgba(0, 0, 0, 0.5)',
              zIndex: 12,
            }}
          >
            <Button
              variant="contained"
              color="primary"
              onClick={handleTapToLoad}
              role="button"
              aria-label="Tap to load video"
            >
              Tap to load video
            </Button>
          </Box>
        )}
      </Box>

      {showPlayer && (
        <Stack
          direction="row"
          spacing={2}
          alignItems="center"
          justifyContent="space-between"
          sx={{ mt: 2, width: '100%' }}
        >
          <EditableTimeInput type="start" label="Start" onCommitSeek={(time) => commitSeek(time, true)} />
          <EditableTimeInput type="end" label="End" onCommitSeek={(time) => commitSeek(time, true)} />
        </Stack>
      )}
    </Box>
  );
};

export default memo(YouTubeTrimmer);
