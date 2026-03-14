import { useCallback, useEffect, useState, useRef, RefObject } from 'react';
import { useTrimmerStore } from '../../context/trimmerStore';
import { logTrimmerDebug } from '@/utils/trimmerDebug';

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
  const dragStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const hasDraggedRef = useRef(false);

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
    const point =
      'touches' in e
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
        : { x: e.clientX, y: e.clientY };
    dragStartPointRef.current = point;
    hasDraggedRef.current = false;
    logTrimmerDebug('timeline.start-drag', {
      target,
      x: point.x,
      y: point.y,
      trimStart: state.trimStart,
      trimEnd: state.trimEnd,
      currentTime: state.currentTime,
    });
    setDragTarget(target);
    state.setIsScrubbing(true);
  }, []);

  // Handle click on background to scrub
  const handleBackgroundMouseDown = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const point =
        'touches' in e
          ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
          : { x: e.clientX, y: e.clientY };
      dragStartPointRef.current = point;
      hasDraggedRef.current = false;

      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const time = positionToTime(clientX);
      const state = useTrimmerStore.getState();

      // Move playhead to clicked position and start dragging
      const clampedTime = Math.max(state.trimStart, Math.min(time, state.trimEnd));
      logTrimmerDebug('timeline.background-seek', {
        time,
        clampedTime,
        x: point.x,
        y: point.y,
        trimStart: state.trimStart,
        trimEnd: state.trimEnd,
      });
      // Enter scrubbing mode first so timeline-origin store updates don't
      // immediately dispatch a hard seek (this can race with remote.seeking).
      state.setIsScrubbing(true);
      state.setCurrentTime(clampedTime, 'timeline');
      trimTargetTimeRef.current = clampedTime;

      // Start dragging the playhead
      setDragTarget('playhead');
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

      const point = 'touches' in e ? e.touches[0] : e;
      const clientX = point.clientX;

      if (dragStartPointRef.current && !hasDraggedRef.current) {
        const dx = Math.abs(point.clientX - dragStartPointRef.current.x);
        const dy = Math.abs(point.clientY - dragStartPointRef.current.y);
        if (dx > 3 || dy > 3) {
          hasDraggedRef.current = true;
        }
      }

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
      } else if (dragTarget === 'end') {
        // Ensure end doesn't go below start + 0.1s
        const minEnd = currentTrimStart + 0.1;
        const newEnd = Math.max(minEnd, Math.min(time, currentDuration));
        // Preview position near the end
        const previewTime = Math.max(currentTrimStart, newEnd - 3);
        state.setTrimEnd(newEnd, 'timeline');
        state.setCurrentTime(previewTime, 'timeline');
        trimTargetTimeRef.current = previewTime;
      } else if (dragTarget === 'playhead') {
        // For click-to-seek interactions, avoid preview seek requests:
        // background mousedown already set the target time and mouseup will commit once.
        if (!hasDraggedRef.current) {
          return;
        }
        // Constrain playhead within trim range
        const newTime = Math.max(currentTrimStart, Math.min(time, currentTrimEnd));
        state.setCurrentTime(newTime, 'timeline');
        trimTargetTimeRef.current = newTime;
        onSeekRef.current?.(newTime);
      }
    };

    const handleUp = (event?: Event) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
        if ('stopImmediatePropagation' in event) {
          event.stopImmediatePropagation();
        }
      }

      if (hasDraggedRef.current) {
        // Prevent accidental control activation from the synthetic click
        // fired at the pointerup target after a drag operation.
        const suppressNextClick = (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          window.removeEventListener('click', suppressNextClick, true);
        };
        window.addEventListener('click', suppressNextClick, true);
        setTimeout(() => {
          window.removeEventListener('click', suppressNextClick, true);
        }, 0);
      }

      // Commit the final target time when any draggable target is released.
      if (dragTarget !== null && trimTargetTimeRef.current !== null) {
        logTrimmerDebug('timeline.end-drag', {
          dragTarget,
          finalTime: trimTargetTimeRef.current,
          hasDragged: hasDraggedRef.current,
        });
        onTrimDragEndRef.current?.(trimTargetTimeRef.current);
        trimTargetTimeRef.current = null;
      }

      dragStartPointRef.current = null;
      hasDraggedRef.current = false;
      setDragTarget(null);
      useTrimmerStore.getState().setIsScrubbing(false);
    };

    const handleMouseUp = (e: MouseEvent) => handleUp(e);
    const handleTouchEnd = (e: TouchEvent) => handleUp(e);
    const handlePointerUp = (e: PointerEvent) => handleUp(e);

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('touchmove', handleMove);
    // Capture release events before control buttons can handle them.
    window.addEventListener('mouseup', handleMouseUp, true);
    window.addEventListener('touchend', handleTouchEnd, true);
    window.addEventListener('pointerup', handlePointerUp, true);

    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('mouseup', handleMouseUp, true);
      window.removeEventListener('touchend', handleTouchEnd, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
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
