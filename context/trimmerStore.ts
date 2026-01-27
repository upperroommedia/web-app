import { create } from 'zustand';

export interface TrimmerState {
  // Core timing state
  trimStart: number; // seconds
  trimEnd: number; // seconds
  currentTime: number; // seconds
  duration: number; // total media duration in seconds
  bufferedEnd: number; // seconds (max buffered end)

  // Playback state
  isPlaying: boolean;
  isLoading: boolean;
  isReady: boolean;

  // Interaction state - prevents feedback loops
  isScrubbing: boolean;

  // Track which component initiated the last change
  lastChangeSource: 'timeline' | 'input' | 'media' | 'external' | null;
}

export interface TrimmerActions {
  setTrimStart: (time: number, source?: TrimmerState['lastChangeSource']) => void;
  setTrimEnd: (time: number, source?: TrimmerState['lastChangeSource']) => void;
  setCurrentTime: (time: number, source?: TrimmerState['lastChangeSource']) => void;
  setDuration: (duration: number) => void;
  setBufferedEnd: (bufferedEnd: number) => void;
  setIsPlaying: (isPlaying: boolean) => void;
  setIsScrubbing: (isScrubbing: boolean) => void;
  setIsLoading: (isLoading: boolean) => void;
  setIsReady: (isReady: boolean) => void;
  reset: () => void;

  // Batch update for initial setup
  initialize: (params: { duration: number; trimStart?: number; trimEnd?: number }) => void;
}

export interface TrimmerSelectors {
  // Computed values
  getTrimDuration: () => number;
  getTrimStartPercent: () => number;
  getTrimEndPercent: () => number;
  getCurrentTimePercent: () => number;
  getBufferedPercent: () => number;
  isValidTrimRange: () => boolean;
}

export type TrimmerStore = TrimmerState & TrimmerActions & TrimmerSelectors;

const initialState: TrimmerState = {
  trimStart: 0,
  trimEnd: 0,
  currentTime: 0,
  duration: 0,
  bufferedEnd: 0,
  isPlaying: false,
  isLoading: false,
  isReady: false,
  isScrubbing: false,
  lastChangeSource: null,
};

export const useTrimmerStore = create<TrimmerStore>((set, get) => ({
  // Initial state
  ...initialState,

  // Actions
  setTrimStart: (time, source = 'external') => {
    const { trimEnd, duration } = get();
    // Clamp to valid range: 0 <= trimStart < trimEnd
    const clampedTime = Math.max(0, Math.min(time, trimEnd - 0.1, duration));
    set({ trimStart: clampedTime, lastChangeSource: source });
  },

  setTrimEnd: (time, source = 'external') => {
    const { trimStart, duration } = get();
    // Clamp to valid range: trimStart < trimEnd <= duration
    const clampedTime = Math.max(trimStart + 0.1, Math.min(time, duration));
    set({ trimEnd: clampedTime, lastChangeSource: source });
  },

  setCurrentTime: (time, source = 'external') => {
    const { duration, isScrubbing } = get();
    // Don't update from media source while scrubbing
    if (source === 'media' && isScrubbing) return;

    const clampedTime = Math.max(0, Math.min(time, duration));
    set({ currentTime: clampedTime, lastChangeSource: source });
  },

  setDuration: (duration) => {
    set((state) => {
      const nextTrimEnd = state.trimEnd === 0 || state.trimEnd > duration ? duration : state.trimEnd;
      if (state.duration === duration && state.trimEnd === nextTrimEnd) {
        return state;
      }
      return {
        duration,
        // If trimEnd is not set or exceeds new duration, set it to duration
        trimEnd: nextTrimEnd,
      };
    });
  },

  setBufferedEnd: (bufferedEnd) => {
    set((state) => {
      const next = Math.max(0, Math.min(bufferedEnd, state.duration || bufferedEnd));
      if (Math.abs(next - state.bufferedEnd) < 0.05) {
        return state;
      }
      return { bufferedEnd: next };
    });
  },

  setIsPlaying: (isPlaying) => set({ isPlaying }),

  setIsScrubbing: (isScrubbing) => set({ isScrubbing }),

  setIsLoading: (isLoading) => set({ isLoading }),

  setIsReady: (isReady) => set({ isReady }),

  reset: () => set(initialState),

  initialize: ({ duration, trimStart = 0, trimEnd }) => {
    set({
      duration,
      trimStart,
      trimEnd: trimEnd ?? duration,
      currentTime: trimStart,
      isPlaying: false,
      isLoading: false,
      isReady: true,
      isScrubbing: false,
      lastChangeSource: null,
    });
  },

  // Selectors
  getTrimDuration: () => {
    const { trimStart, trimEnd } = get();
    return trimEnd - trimStart;
  },

  getTrimStartPercent: () => {
    const { trimStart, duration } = get();
    if (duration === 0) return 0;
    return (trimStart / duration) * 100;
  },

  getTrimEndPercent: () => {
    const { trimEnd, duration } = get();
    if (duration === 0) return 100;
    return (trimEnd / duration) * 100;
  },

  getCurrentTimePercent: () => {
    const { currentTime, duration } = get();
    if (duration === 0) return 0;
    return (currentTime / duration) * 100;
  },

  getBufferedPercent: () => {
    const { bufferedEnd, duration } = get();
    if (duration === 0) return 0;
    return (bufferedEnd / duration) * 100;
  },

  isValidTrimRange: () => {
    const { trimStart, trimEnd, duration } = get();
    return trimStart >= 0 && trimEnd > trimStart && trimEnd <= duration;
  },
}));

// Utility functions for time formatting
export function formatTimeWithSubseconds(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '00:00:00.0';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds % 1) * 10);

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}

export function parseTimeInput(input: string): number | null {
  // Remove all non-digit characters except decimal point
  const digitsOnly = input.replace(/[^\d.]/g, '');

  // Handle decimal input (subseconds)
  const parts = digitsOnly.split('.');
  const mainDigits = parts[0] || '';
  const subseconds = parts[1] ? parseInt(parts[1].charAt(0) || '0', 10) / 10 : 0;

  if (mainDigits.length === 0) return subseconds;

  // Parse based on number of digits
  // 1-2 digits: SS
  // 3-4 digits: MMSS
  // 5-6 digits: HHMMSS
  // 7+ digits: HHHMMSS (extended hours)
  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  const padded = mainDigits.padStart(6, '0');
  const len = mainDigits.length;

  if (len <= 2) {
    seconds = parseInt(mainDigits, 10);
  } else if (len <= 4) {
    minutes = parseInt(mainDigits.slice(0, -2), 10);
    seconds = parseInt(mainDigits.slice(-2), 10);
  } else {
    const hoursStr = padded.slice(0, padded.length - 4);
    hours = parseInt(hoursStr, 10);
    minutes = parseInt(padded.slice(-4, -2), 10);
    seconds = parseInt(padded.slice(-2), 10);
  }

  // Validate ranges (allow overflow for minutes/seconds for flexibility)
  if (minutes >= 60) {
    hours += Math.floor(minutes / 60);
    minutes = minutes % 60;
  }
  if (seconds >= 60) {
    minutes += Math.floor(seconds / 60);
    seconds = seconds % 60;
    if (minutes >= 60) {
      hours += Math.floor(minutes / 60);
      minutes = minutes % 60;
    }
  }

  return hours * 3600 + minutes * 60 + seconds + subseconds;
}

// Format for display while typing (adds colons automatically)
export function formatTimeInputDisplay(input: string): string {
  const digitsOnly = input.replace(/[^\d.]/g, '');
  const parts = digitsOnly.split('.');
  const mainDigits = parts[0] || '';
  const decimal = parts.length > 1 ? '.' + (parts[1]?.charAt(0) || '') : '';

  if (mainDigits.length === 0) return decimal || '';
  if (mainDigits.length <= 2) return mainDigits + decimal;
  if (mainDigits.length <= 4) {
    return `${mainDigits.slice(0, -2)}:${mainDigits.slice(-2)}${decimal}`;
  }
  // 5+ digits
  const hoursEnd = mainDigits.length - 4;
  return `${mainDigits.slice(0, hoursEnd)}:${mainDigits.slice(hoursEnd, hoursEnd + 2)}:${mainDigits.slice(-2)}${decimal}`;
}
