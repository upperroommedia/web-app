import { useEffect, useRef, useCallback } from 'react';
import { useTrimmerStore } from '../../context/trimmerStore';
import type { MediaPlayerInstance } from '@vidstack/react';

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

  const trimStart = useTrimmerStore((state) => state.trimStart);
  const trimEnd = useTrimmerStore((state) => state.trimEnd);
  const currentTime = useTrimmerStore((state) => state.currentTime);
  const isScrubbing = useTrimmerStore((state) => state.isScrubbing);
  const lastChangeSource = useTrimmerStore((state) => state.lastChangeSource);
  const setCurrentTime = useTrimmerStore((state) => state.setCurrentTime);
  const setIsPlaying = useTrimmerStore((state) => state.setIsPlaying);
  const setDuration = useTrimmerStore((state) => state.setDuration);
  const initialize = useTrimmerStore((state) => state.initialize);

  // Track if we initiated the seek to prevent feedback loop
  const seekingRef = useRef(false);
  const lastSyncedTimeRef = useRef(0);
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
    if (!audioRef.current || isScrubbing || seekingRef.current) return;

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

  // Sync store time changes to audio element (when initiated by user input)
  useEffect(() => {
    if (!audioRef.current || isScrubbing) return;

    // Only sync if the change came from user input (not from media playback)
    if (lastChangeSource === 'input' || lastChangeSource === 'timeline') {
      const audio = audioRef.current;
      if (Math.abs(audio.currentTime - currentTime) > 0.1) {
        seekingRef.current = true;
        audio.currentTime = currentTime;
        lastSyncedTimeRef.current = currentTime;
        // Reset seeking flag after a short delay
        setTimeout(() => {
          seekingRef.current = false;
        }, 100);
      }
    }
  }, [audioRef, currentTime, lastChangeSource, isScrubbing]);

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

  const togglePlayPause = useCallback(() => {
    if (audioRef.current?.paused) {
      play();
    } else {
      pause();
    }
  }, [play, pause]);

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

  const trimStart = useTrimmerStore((state) => state.trimStart);
  const trimEnd = useTrimmerStore((state) => state.trimEnd);
  const currentTime = useTrimmerStore((state) => state.currentTime);
  const isScrubbing = useTrimmerStore((state) => state.isScrubbing);
  const lastChangeSource = useTrimmerStore((state) => state.lastChangeSource);
  const setCurrentTime = useTrimmerStore((state) => state.setCurrentTime);
  const setIsPlaying = useTrimmerStore((state) => state.setIsPlaying);
  const setDuration = useTrimmerStore((state) => state.setDuration);
  const initialize = useTrimmerStore((state) => state.initialize);

  const seekingRef = useRef(false);
  const lastSyncedTimeRef = useRef(0);

  // Sync store time changes to player (when initiated by user input)
  useEffect(() => {
    const player = playerRef.current;
    if (!player || isScrubbing) return;

    if (lastChangeSource === 'input' || lastChangeSource === 'timeline') {
      if (Math.abs(player.currentTime - currentTime) > 0.1) {
        seekingRef.current = true;
        player.currentTime = currentTime;
        lastSyncedTimeRef.current = currentTime;
        setTimeout(() => {
          seekingRef.current = false;
        }, 100);
      }
    }
  }, [playerRef, currentTime, lastChangeSource, isScrubbing]);

  // Create subscription for time updates
  const subscribeToPlayer = useCallback(
    (player: MediaPlayerInstance) => {
      const unsubscribeTime = player.subscribe(({ currentTime: playerTime }) => {
        if (isScrubbing || seekingRef.current) return;

        if (Math.abs(playerTime - lastSyncedTimeRef.current) > 0.05) {
          lastSyncedTimeRef.current = playerTime;
          setCurrentTime(playerTime, 'media');
        }

        // Check if we've reached the end of trim region
        if (autoPauseAtEnd && playerTime >= trimEnd) {
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
        seekingRef.current = true;
        player.currentTime = time;
        lastSyncedTimeRef.current = time;
        setTimeout(() => {
          seekingRef.current = false;
        }, 100);
      }
    },
    [playerRef]
  );

  // Play controls
  const play = useCallback(() => {
    const player = playerRef.current;
    if (player) {
      if (player.currentTime < trimStart || player.currentTime >= trimEnd) {
        player.currentTime = trimStart;
      }
      player.play();
    }
  }, [playerRef, trimStart, trimEnd]);

  const pause = useCallback(() => {
    playerRef.current?.pause();
  }, [playerRef]);

  const togglePlayPause = useCallback(() => {
    const player = playerRef.current;
    if (player?.paused) {
      play();
    } else {
      pause();
    }
  }, [play, pause]);

  // Initialize with duration when available
  const handleDurationChange = useCallback(
    (duration: number) => {
      if (duration > 0) {
        initialize({
          duration,
          trimStart: 0,
          trimEnd: duration,
        });
      }
    },
    [initialize]
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
