import { useEffect, useRef, useCallback } from 'react';
import { useTrimmerStore } from '../../context/trimmerStore';
import { safePlayMediaElement } from './trimmerMedia';

interface UseTrimmerSyncOptions {
  /** Called when seeking is needed */
  onSeek?: (time: number) => void;
  /** Called when play/pause state changes */
  onPlayPause?: (play: boolean) => void;
  /** Whether to auto-pause at trim end */
  autoPauseAtEnd?: boolean;
  /** Whether to loop within trim region */
  loopWithinTrim?: boolean;
  /** Optional initial trim start for existing media. */
  initialTrimStart?: number;
  /** Optional initial trim end for existing media. */
  initialTrimEnd?: number;
}

/**
 * Hook to sync an HTML Audio element with the trimmer store.
 * Handles bidirectional sync and prevents feedback loops.
 */
export function useAudioTrimmerSync(
  audioRef: React.RefObject<HTMLAudioElement | null>,
  options: UseTrimmerSyncOptions = {}
) {
  const { autoPauseAtEnd = true, loopWithinTrim = false, initialTrimStart = 0, initialTrimEnd } = options;

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
      const mediaDuration = audioRef.current.duration;
      const clampedTrimStart = Math.max(0, Math.min(initialTrimStart, mediaDuration));
      const requestedTrimEnd = initialTrimEnd ?? mediaDuration;
      const clampedTrimEnd = Math.max(clampedTrimStart + 0.1, Math.min(requestedTrimEnd, mediaDuration));
      initialize({
        duration: mediaDuration,
        trimStart: clampedTrimStart,
        trimEnd: clampedTrimEnd,
      });
    }
  }, [audioRef, initialTrimEnd, initialTrimStart, initialize]);

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
        safePlayMediaElement(audioRef.current, () => {
          setIsPlaying(false);
        });
      }
    }
  }, [audioRef, isScrubbing, trimEnd, trimStart, autoPauseAtEnd, loopWithinTrim, setCurrentTime, setIsPlaying]);

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
      safePlayMediaElement(audio, () => {
        setIsPlaying(false);
      });
    }
  }, [audioRef, isScrubbing, setIsPlaying]);

  // Sync store time changes to audio element (when initiated by user input).
  // Use store.subscribe so we don't subscribe to currentTime/lastChangeSource in React
  // and the caller (AudioTrimmer) doesn't re-render on every timeupdate.
  useEffect(() => {
    return useTrimmerStore.subscribe(() => {
      const state = useTrimmerStore.getState();
      if (!audioRef.current || state.isScrubbing) return;
      if (state.lastChangeSource !== 'input' && state.lastChangeSource !== 'timeline') return;
      if (
        lastRequestedStoreTimeRef.current !== null &&
        Math.abs(state.currentTime - lastRequestedStoreTimeRef.current) < 0.001
      ) {
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
      safePlayMediaElement(audioRef.current, () => {
        setIsPlaying(false);
      });
    }
  }, [audioRef, trimStart, trimEnd, setIsPlaying]);

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
