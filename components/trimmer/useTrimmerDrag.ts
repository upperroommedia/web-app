import { useCallback, useEffect, useState, useRef, RefObject } from 'react';
import { useTrimmerStore } from '../../context/trimmerStore';

export type DragTarget = 'start' | 'end' | 'playhead' | null;

interface UseTrimmerDragOptions {
  /** Callback when seeking (for syncing with media player) */
  onSeek?: (time: number) => void;
  /** Callback with target seek time when trim handle drag ends (for deferred seeking) */
  onTrimDragEnd?: (time: number) => void;
}

interface UseTrimmerDragReturn {
  /** Current drag target */
  dragTarget: DragTarget;
  /** Whether currently dragging */
  isDragging: boolean;
  /** Start dragging a specific target */
  startDrag: (e: React.MouseEvent | React.TouchEvent, target: DragTarget) => void;
  /** Handle click on timeline/slider background to scrub */
  handleBackgroundMouseDown: (e: React.MouseEvent | React.TouchEvent) => void;
  /** Convert pixel position to time value */
  positionToTime: (clientX: number) => number;
}

/**
 * Shared drag handling logic for trimmer components.
 * Handles mouse/touch events for dragging trim handles and playhead.
 *
 * IMPORTANT: Uses refs for store values during drag to prevent useEffect
 * from re-running and causing jitter (React best practice for event handlers).
 */
export function useTrimmerDrag(
  containerRef: RefObject<HTMLDivElement | null>,
  options: UseTrimmerDragOptions = {}
): UseTrimmerDragReturn {
  const { onSeek, onTrimDragEnd } = options;

  // Only subscribe to duration for positionToTime (used in render-time callbacks)
  // All other store values accessed via getState() in event handlers to avoid re-renders
  const duration = useTrimmerStore((state) => state.duration);

  // Local drag state
  const [dragTarget, setDragTarget] = useState<DragTarget>(null);

  // Use refs for values accessed in event handlers to avoid stale closures
  // and prevent useEffect from re-running during drag (React best practice)
  const trimTargetTimeRef = useRef<number | null>(null);
  const onSeekRef = useRef(onSeek);
  const onTrimDragEndRef = useRef(onTrimDragEnd);

  // Keep refs updated with latest values
  useEffect(() => {
    onSeekRef.current = onSeek;
  }, [onSeek]);
  useEffect(() => {
    onTrimDragEndRef.current = onTrimDragEnd;
  }, [onTrimDragEnd]);

  // Convert pixel position to time
  const positionToTime = useCallback(
    (clientX: number): number => {
      if (!containerRef.current || duration === 0) return 0;
      const rect = containerRef.current.getBoundingClientRect();
      const percent = (clientX - rect.left) / rect.width;
      return Math.max(0, Math.min(percent * duration, duration));
    },
    [containerRef, duration]
  );

  // Start dragging a specific target
  const startDrag = useCallback((e: React.MouseEvent | React.TouchEvent, target: DragTarget) => {
    e.preventDefault();
    e.stopPropagation();
    const state = useTrimmerStore.getState();
    setDragTarget(target);
    state.setIsScrubbing(true);
  }, []);

  // Handle click on background to scrub
  const handleBackgroundMouseDown = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const time = positionToTime(clientX);
      const state = useTrimmerStore.getState();

      // Move playhead to clicked position and start dragging
      const clampedTime = Math.max(state.trimStart, Math.min(time, state.trimEnd));
      state.setCurrentTime(clampedTime, 'timeline');
      onSeekRef.current?.(clampedTime);

      // Start dragging the playhead
      setDragTarget('playhead');
      state.setIsScrubbing(true);
    },
    [positionToTime]
  );

  // Handle mouse/touch move and up events
  // IMPORTANT: This effect only depends on dragTarget to avoid re-attaching listeners during drag.
  // All other values are read from refs or store.getState() to get latest values.
  useEffect(() => {
    if (!dragTarget) return;

    const handleMove = (e: MouseEvent | TouchEvent) => {
      if (!containerRef.current) return;

      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;

      // Get latest values from store (not stale closure values)
      const state = useTrimmerStore.getState();
      const { trimStart: currentTrimStart, trimEnd: currentTrimEnd, duration: currentDuration } = state;

      // Calculate time from position
      const rect = containerRef.current.getBoundingClientRect();
      const percent = (clientX - rect.left) / rect.width;
      const time = Math.max(0, Math.min(percent * currentDuration, currentDuration));

      if (dragTarget === 'start') {
        // Ensure start doesn't exceed end - 0.1s
        const maxStart = currentTrimEnd - 0.1;
        const newStart = Math.max(0, Math.min(time, maxStart));
        state.setTrimStart(newStart, 'timeline');
        state.setCurrentTime(newStart, 'timeline');
        trimTargetTimeRef.current = newStart;
        // Seek during drag (throttled by parent) - same as playhead
        onSeekRef.current?.(newStart);
      } else if (dragTarget === 'end') {
        // Ensure end doesn't go below start + 0.1s
        const minEnd = currentTrimStart + 0.1;
        const newEnd = Math.max(minEnd, Math.min(time, currentDuration));
        // Preview position near the end
        const previewTime = Math.max(currentTrimStart, newEnd - 3);
        state.setTrimEnd(newEnd, 'timeline');
        state.setCurrentTime(previewTime, 'timeline');
        trimTargetTimeRef.current = previewTime;
        // Seek during drag (throttled by parent) - same as playhead
        onSeekRef.current?.(previewTime);
      } else if (dragTarget === 'playhead') {
        // Constrain playhead within trim range
        const newTime = Math.max(currentTrimStart, Math.min(time, currentTrimEnd));
        state.setCurrentTime(newTime, 'timeline');
        onSeekRef.current?.(newTime);
      }
    };

    const handleUp = () => {
      // For trim handles, call onTrimDragEnd with the saved target time
      if ((dragTarget === 'start' || dragTarget === 'end') && trimTargetTimeRef.current !== null) {
        onTrimDragEndRef.current?.(trimTargetTimeRef.current);
        trimTargetTimeRef.current = null;
      }

      setDragTarget(null);
      useTrimmerStore.getState().setIsScrubbing(false);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    window.addEventListener('touchmove', handleMove);
    window.addEventListener('touchend', handleUp);

    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleUp);
    };
  }, [dragTarget, containerRef]); // Minimal dependencies - store values accessed via getState()

  return {
    dragTarget,
    isDragging: dragTarget !== null,
    startDrag,
    handleBackgroundMouseDown,
    positionToTime,
  };
}
