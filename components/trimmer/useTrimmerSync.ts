import { useEffect, useRef, useCallback } from 'react';
import { useTrimmerStore } from '../../context/trimmerStore';
import { useMediaRemote, type MediaPlayerInstance } from '@vidstack/react';
import { logTrimmerDebug } from '@/utils/trimmerDebug';

interface UseTrimmerSyncOptions {
  /** Called when seeking is needed */
  onSeek?: (time: number) => void;
  /** Called when play/pause state changes */
  onPlayPause?: (play: boolean) => void;
  /** Whether to auto-pause at trim end */
  autoPauseAtEnd?: boolean;
  /** Whether to loop within trim region */
  loopWithinTrim?: boolean;
}

/**
 * Hook to sync an HTML Audio element with the trimmer store.
 * Handles bidirectional sync and prevents feedback loops.
 */
export function useAudioTrimmerSync(
  audioRef: React.RefObject<HTMLAudioElement | null>,
  options: UseTrimmerSyncOptions = {}
) {
  const { autoPauseAtEnd = true, loopWithinTrim = false } = options;

  // Only subscribe to state the caller needs for rendering. currentTime/lastChangeSource
  // are used for store→audio sync via subscribe() below so the hook (and parent) don't
  // re-render on every timeupdate.
  const trimStart = useTrimmerStore((state) => state.trimStart);
  const trimEnd = useTrimmerStore((state) => state.trimEnd);
  const isScrubbing = useTrimmerStore((state) => state.isScrubbing);
  const setCurrentTime = useTrimmerStore((state) => state.setCurrentTime);
  const setIsPlaying = useTrimmerStore((state) => state.setIsPlaying);
  const initialize = useTrimmerStore((state) => state.initialize);

  // Track if we initiated the seek to prevent feedback loop
  const seekingRef = useRef(false);
  const lastSyncedTimeRef = useRef(0);
  const lastRequestedStoreTimeRef = useRef<number | null>(null);
  const wasPlayingBeforeScrubRef = useRef(false);
  const initializedRef = useRef(false);

  // Handle metadata loaded - initialize store (only once)
  const handleLoadedMetadata = useCallback(() => {
    if (audioRef.current && !initializedRef.current) {
      initializedRef.current = true;
      initialize({
        duration: audioRef.current.duration,
        trimStart: 0,
        trimEnd: audioRef.current.duration,
      });
    }
  }, [audioRef, initialize]);

  // Handle time updates from audio element
  const handleTimeUpdate = useCallback(() => {
    if (!audioRef.current) return;
    if (isScrubbing || seekingRef.current) return;

    const audioTime = audioRef.current.currentTime;
    // Only update if significantly different (avoid micro-updates)
    if (Math.abs(audioTime - lastSyncedTimeRef.current) > 0.05) {
      lastSyncedTimeRef.current = audioTime;
      setCurrentTime(audioTime, 'media');
    }

    // Check if we've reached the end of trim region
    if (autoPauseAtEnd && audioTime >= trimEnd) {
      audioRef.current.pause();
      if (loopWithinTrim) {
        audioRef.current.currentTime = trimStart;
        audioRef.current.play();
      }
    }
  }, [audioRef, isScrubbing, trimEnd, trimStart, autoPauseAtEnd, loopWithinTrim, setCurrentTime]);

  // Handle play/pause events
  const handlePlay = useCallback(() => {
    setIsPlaying(true);
  }, [setIsPlaying]);

  const handlePause = useCallback(() => {
    setIsPlaying(false);
  }, [setIsPlaying]);

  // Pause playback during scrubbing to avoid drift/jumps.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isScrubbing) {
      if (!audio.paused) {
        wasPlayingBeforeScrubRef.current = true;
        audio.pause();
      }
    } else if (wasPlayingBeforeScrubRef.current) {
      wasPlayingBeforeScrubRef.current = false;
      audio.play().catch(() => {});
    }
  }, [audioRef, isScrubbing]);

  // Sync store time changes to audio element (when initiated by user input).
  // Use store.subscribe so we don't subscribe to currentTime/lastChangeSource in React
  // and the caller (AudioTrimmer) doesn't re-render on every timeupdate.
  useEffect(() => {
    return useTrimmerStore.subscribe(() => {
      const state = useTrimmerStore.getState();
      if (!audioRef.current || state.isScrubbing) return;
      if (state.lastChangeSource !== 'input' && state.lastChangeSource !== 'timeline') return;
      if (lastRequestedStoreTimeRef.current !== null && Math.abs(state.currentTime - lastRequestedStoreTimeRef.current) < 0.001) {
        return;
      }
      lastRequestedStoreTimeRef.current = state.currentTime;
      const audio = audioRef.current;
      if (Math.abs(audio.currentTime - state.currentTime) > 0.1) {
        seekingRef.current = true;
        audio.currentTime = state.currentTime;
        lastSyncedTimeRef.current = state.currentTime;
        setTimeout(() => {
          seekingRef.current = false;
        }, 100);
      }
    });
  }, [audioRef]);

  // Track current audio element to detect when it changes
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  // Setup and cleanup event listeners
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // Reset initialization flag if audio element changed
    if (currentAudioRef.current !== audio) {
      initializedRef.current = false;
      currentAudioRef.current = audio;
    }

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);

    // If already loaded, initialize
    if (audio.duration) {
      handleLoadedMetadata();
    }

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
    };
  }, [audioRef, handleLoadedMetadata, handleTimeUpdate, handlePlay, handlePause]);

  // Seek function for external use
  const seek = useCallback(
    (time: number) => {
      if (audioRef.current) {
        seekingRef.current = true;
        audioRef.current.currentTime = time;
        lastSyncedTimeRef.current = time;
        setTimeout(() => {
          seekingRef.current = false;
        }, 100);
      }
    },
    [audioRef]
  );

  // Play/pause controls
  const play = useCallback(() => {
    if (audioRef.current) {
      // If current time is outside trim range, seek to start
      if (audioRef.current.currentTime < trimStart || audioRef.current.currentTime >= trimEnd) {
        audioRef.current.currentTime = trimStart;
      }
      audioRef.current.play();
    }
  }, [audioRef, trimStart, trimEnd]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, [audioRef]);

  const togglePlayPause = () => {
    if (audioRef.current?.paused) {
      play();
    } else {
      pause();
    }
  };

  return {
    seek,
    play,
    pause,
    togglePlayPause,
  };
}

/**
 * Hook to sync a Vidstack MediaPlayer with the trimmer store.
 * Similar to useAudioTrimmerSync but for Vidstack's API.
 */
export function useVidstackTrimmerSync(
  playerRef: React.RefObject<MediaPlayerInstance | null>,
  options: UseTrimmerSyncOptions = {}
) {
  const { autoPauseAtEnd = true } = options;
  const remote = useMediaRemote(playerRef);

  // Only subscribe to state the caller needs. currentTime/lastChangeSource are used
  // for store→player sync via subscribe() below so the hook (and YouTubeTrimmer)
  // don't re-render on every timeupdate.
  const trimStart = useTrimmerStore((state) => state.trimStart);
  const trimEnd = useTrimmerStore((state) => state.trimEnd);
  const isScrubbing = useTrimmerStore((state) => state.isScrubbing);
  const setCurrentTime = useTrimmerStore((state) => state.setCurrentTime);
  const setIsPlaying = useTrimmerStore((state) => state.setIsPlaying);
  const setDuration = useTrimmerStore((state) => state.setDuration);
  const initialize = useTrimmerStore((state) => state.initialize);

  const seekingRef = useRef(false);
  const lastSyncedTimeRef = useRef(0);
  const lastRequestedStoreTimeRef = useRef<number | null>(null);
  const ignoreMediaUntilRef = useRef(0);

  // Sync store time changes to player (when initiated by user input).
  // Use store.subscribe so we don't subscribe to currentTime/lastChangeSource in React
  // and the caller (YouTubeTrimmer) doesn't re-render on every timeupdate.
  useEffect(() => {
    return useTrimmerStore.subscribe(() => {
      const state = useTrimmerStore.getState();
      const player = playerRef.current;
      if (!player || state.isScrubbing) return;
      // For Vidstack, timeline seeks are driven explicitly by remote.seeking/remote.seek
      // from the trimmer UI interaction handlers. Keep this subscription input-only to
      // avoid duplicate seek request paths and request ordering races.
      if (state.lastChangeSource !== 'input') return;
      if (lastRequestedStoreTimeRef.current !== null && Math.abs(state.currentTime - lastRequestedStoreTimeRef.current) < 0.001) {
        return;
      }
      lastRequestedStoreTimeRef.current = state.currentTime;
      if (Math.abs(player.currentTime - state.currentTime) > 0.1) {
        // Ignore media echo updates for a short window after programmatic seeks.
        ignoreMediaUntilRef.current = Date.now() + 1500;
        logTrimmerDebug('vidstack.store-seek', {
          fromTime: player.currentTime,
          toTime: state.currentTime,
          source: state.lastChangeSource,
          isScrubbing: state.isScrubbing,
        });
        seekingRef.current = true;
        remote.seek(state.currentTime);
        lastSyncedTimeRef.current = state.currentTime;
        setTimeout(() => {
          seekingRef.current = false;
        }, 100);
      }
    });
  }, [playerRef, remote]);

  // Create subscription for time updates
  const subscribeToPlayer = useCallback(
    (player: MediaPlayerInstance) => {
      const unsubscribeTime = player.subscribe(({ currentTime: playerTime }) => {
        if (isScrubbing || seekingRef.current) return;
        if (Date.now() < ignoreMediaUntilRef.current) return;

        if (Math.abs(playerTime - lastSyncedTimeRef.current) > 0.05) {
          lastSyncedTimeRef.current = playerTime;
          setCurrentTime(playerTime, 'media');
        }

        // Check if we've reached the end of trim region
        if (autoPauseAtEnd && playerTime >= trimEnd) {
          logTrimmerDebug('vidstack.auto-pause-at-end', {
            playerTime,
            trimEnd,
          });
          player.pause();
        }
      });

      const unsubscribeDuration = player.subscribe(({ duration }) => {
        if (duration > 0) {
          setDuration(duration);
        }
      });

      const unsubscribePaused = player.subscribe(({ paused }) => {
        setIsPlaying(!paused);
      });

      return () => {
        unsubscribeTime();
        unsubscribeDuration();
        unsubscribePaused();
      };
    },
    [isScrubbing, trimEnd, autoPauseAtEnd, setCurrentTime, setDuration, setIsPlaying]
  );

  // Seek function
  const seek = useCallback(
    (time: number) => {
      const player = playerRef.current;
      if (player) {
        logTrimmerDebug('vidstack.seek-command', {
          targetTime: time,
          currentTime: player.currentTime,
        });
        seekingRef.current = true;
        remote.seek(time);
        lastSyncedTimeRef.current = time;
        setTimeout(() => {
          seekingRef.current = false;
        }, 100);
      }
    },
    [playerRef, remote]
  );

  // Play controls
  const play = useCallback(() => {
    const player = playerRef.current;
    if (player) {
      logTrimmerDebug('vidstack.play-command', {
        playerTime: player.currentTime,
        trimStart,
        trimEnd,
      });
      if (player.currentTime < trimStart || player.currentTime >= trimEnd) {
        remote.seek(trimStart);
      }
      remote.play();
    }
  }, [playerRef, remote, trimStart, trimEnd]);

  const pause = useCallback(() => {
    if (playerRef.current) {
      logTrimmerDebug('vidstack.pause-command');
      remote.pause();
    }
  }, [playerRef, remote]);

  const togglePlayPause = () => {
    const player = playerRef.current;
    if (player?.paused) {
      play();
    } else {
      pause();
    }
  };

  // Initialize with duration when available
  const handleDurationChange = useCallback(
    (duration: number) => {
      if (duration <= 0) return;

      const state = useTrimmerStore.getState();
      // Only run full initialization once per source/reset.
      // Subsequent duration updates should not reset user trim selections.
      if (state.duration === 0 || state.trimEnd === 0) {
        initialize({
          duration,
          trimStart: 0,
          trimEnd: duration,
        });
        return;
      }

      setDuration(duration);
    },
    [initialize, setDuration]
  );

  return {
    seek,
    play,
    pause,
    togglePlayPause,
    subscribeToPlayer,
    handleDurationChange,
  };
}
