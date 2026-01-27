import { useRef, memo, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import { useTrimmerStore, formatTimeWithSubseconds } from '../../context/trimmerStore';
import { alpha, useTheme } from '@mui/material/styles';
import { colors } from '../../styles/theme';
import { useTrimmerDrag } from './useTrimmerDrag';

interface TrimSliderProps {
  /** Optional callback when seeking (for syncing with media player) */
  onSeek?: (time: number) => void;
  /** Optional callback when trim handle drag ends (for deferred seeking) */
  onTrimDragEnd?: (time: number) => void;
  /** Height of the slider in pixels */
  height?: number;
}

/**
 * A minimal 1D slider for trimming, designed to overlay on video players.
 * Contains: start handle, end handle, and playhead indicator.
 */
function TrimSlider({ onSeek, onTrimDragEnd, height = 14 }: TrimSliderProps) {
  const theme = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);

  // Store state for rendering
  const trimStart = useTrimmerStore((state) => state.trimStart);
  const trimEnd = useTrimmerStore((state) => state.trimEnd);
  const currentTime = useTrimmerStore((state) => state.currentTime);
  const duration = useTrimmerStore((state) => state.duration);
  const bufferedEnd = useTrimmerStore((state) => state.bufferedEnd);

  // Hover state for time preview
  const [hoverState, setHoverState] = useState<{ percent: number; time: number } | null>(null);

  // Use shared drag hook
  const { isDragging, startDrag, handleBackgroundMouseDown } = useTrimmerDrag(containerRef, {
    onSeek,
    onTrimDragEnd,
  });

  // Handle mouse move for hover preview
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!containerRef.current || duration === 0 || isDragging) return;
      const rect = containerRef.current.getBoundingClientRect();
      const percent = ((e.clientX - rect.left) / rect.width) * 100;
      const time = (percent / 100) * duration;
      setHoverState({ percent: Math.max(0, Math.min(100, percent)), time: Math.max(0, Math.min(duration, time)) });
    },
    [duration, isDragging]
  );

  const handleMouseLeave = useCallback(() => {
    setHoverState(null);
  }, []);

  // Calculate percentages
  const trimStartPercent = duration > 0 ? (trimStart / duration) * 100 : 0;
  const trimEndPercent = duration > 0 ? (trimEnd / duration) * 100 : 100;
  const playheadPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? Math.min(100, (bufferedEnd / duration) * 100) : 0;

  // Use theme accent colors (orange/flame)
  const handleColor = colors.accent.primary;
  const handleHoverColor = colors.accent.secondary;
  const handleActiveColor = colors.accent.dark;
  const handleWidth = 8; // pixels

  return (
    <Box
      ref={containerRef}
      data-testid="trim-slider"
      onMouseDown={handleBackgroundMouseDown}
      onTouchStart={handleBackgroundMouseDown}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      sx={{
        position: 'relative',
        height: `${height}px`,
        bgcolor: alpha(theme.palette.common.black, 0.7),
        cursor: 'pointer',
        userSelect: 'none',
        touchAction: 'none',
        borderRadius: '4px',
        overflow: 'visible', // Allow handles to extend
      }}
    >
      {/* Track background - full width */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          bgcolor: alpha(theme.palette.common.white, 0.15),
        }}
      />

      {/* Buffered region */}
      <Box
        data-testid="trim-buffered"
        data-buffered-percent={bufferedPercent.toFixed(2)}
        sx={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: `${bufferedPercent}%`,
          bgcolor: alpha(theme.palette.common.white, 0.35),
        }}
      />

      {/* Left grayed-out region (before trim start) */}
      <Box
        sx={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: `${trimStartPercent}%`,
          bgcolor: alpha(theme.palette.common.black, 0.6),
        }}
      />

      {/* Right grayed-out region (after trim end) */}
      <Box
        sx={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: `${100 - trimEndPercent}%`,
          bgcolor: alpha(theme.palette.common.black, 0.6),
        }}
      />

      {/* Active trim region highlight */}
      <Box
        sx={{
          position: 'absolute',
          left: `${trimStartPercent}%`,
          right: `${100 - trimEndPercent}%`,
          top: 0,
          bottom: 0,
          bgcolor: alpha(handleColor, 0.25),
          borderTop: `2px solid ${handleColor}`,
          borderBottom: `2px solid ${handleColor}`,
        }}
      />

      {/* Start trim handle */}
      <Box
        data-testid="trim-handle-start"
        data-trim-start-percent={trimStartPercent.toFixed(2)}
        onMouseDown={(e) => startDrag(e, 'start')}
        onTouchStart={(e) => startDrag(e, 'start')}
        sx={{
          position: 'absolute',
          left: `${trimStartPercent}%`,
          top: 0,
          bottom: 0,
          width: `${handleWidth}px`,
          transform: 'translateX(-100%)',
          bgcolor: handleColor,
          borderRadius: '3px 0 0 3px',
          cursor: 'ew-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'background-color 0.15s ease',
          zIndex: 5,
          '&:hover': {
            bgcolor: handleHoverColor,
          },
          '&:active': {
            bgcolor: handleActiveColor,
          },
          // Handle grip lines
          '&::after': {
            content: '""',
            width: '2px',
            height: '8px',
            bgcolor: alpha(theme.palette.common.white, 0.6),
            borderRadius: '1px',
          },
        }}
      />

      {/* End trim handle */}
      <Box
        data-testid="trim-handle-end"
        data-trim-end-percent={trimEndPercent.toFixed(2)}
        onMouseDown={(e) => startDrag(e, 'end')}
        onTouchStart={(e) => startDrag(e, 'end')}
        sx={{
          position: 'absolute',
          left: `${trimEndPercent}%`,
          top: 0,
          bottom: 0,
          width: `${handleWidth}px`,
          bgcolor: handleColor,
          borderRadius: '0 3px 3px 0',
          cursor: 'ew-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'background-color 0.15s ease',
          zIndex: 5,
          '&:hover': {
            bgcolor: handleHoverColor,
          },
          '&:active': {
            bgcolor: handleActiveColor,
          },
          // Handle grip lines
          '&::after': {
            content: '""',
            width: '2px',
            height: '8px',
            bgcolor: alpha(theme.palette.common.white, 0.6),
            borderRadius: '1px',
          },
        }}
      />

      {/* Playhead */}
      <Box
        data-testid="trim-playhead"
        data-playhead-percent={playheadPercent.toFixed(2)}
        onMouseDown={(e) => startDrag(e, 'playhead')}
        onTouchStart={(e) => startDrag(e, 'playhead')}
        sx={{
          position: 'absolute',
          left: `${playheadPercent}%`,
          top: '-4px',
          bottom: '-4px',
          width: '3px',
          bgcolor: theme.palette.common.white,
          transform: 'translateX(-50%)',
          cursor: 'ew-resize',
          zIndex: 10,
          boxShadow: '0 0 4px rgba(0,0,0,0.5)',
          borderRadius: '1px',
          // Triangle indicator at top
          '&::before': {
            content: '""',
            position: 'absolute',
            top: '-4px',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 0,
            height: 0,
            borderLeft: '4px solid transparent',
            borderRight: '4px solid transparent',
            borderTop: `4px solid ${theme.palette.common.white}`,
          },
        }}
      />

      {/* Hover indicator line */}
      {hoverState && !isDragging && (
        <Box
          sx={{
            position: 'absolute',
            left: `${hoverState.percent}%`,
            top: 0,
            bottom: 0,
            width: '1px',
            bgcolor: alpha(theme.palette.common.white, 0.5),
            transform: 'translateX(-50%)',
            pointerEvents: 'none',
            zIndex: 3,
          }}
        />
      )}

      {/* Hover time tooltip */}
      {hoverState && !isDragging && (
        <Box
          sx={{
            position: 'absolute',
            left: `${hoverState.percent}%`,
            bottom: `${height + 8}px`,
            transform: 'translateX(-50%)',
            bgcolor: alpha(theme.palette.common.black, 0.9),
            color: theme.palette.common.white,
            px: 1,
            py: 0.25,
            borderRadius: 1,
            fontSize: '0.7rem',
            fontFamily: 'monospace',
            fontWeight: 500,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 15,
          }}
        >
          {formatTimeWithSubseconds(hoverState.time)}
        </Box>
      )}

      {/* Dragging time tooltip */}
      {isDragging && (
        <Box
          sx={{
            position: 'absolute',
            left: `${playheadPercent}%`,
            bottom: `${height + 8}px`,
            transform: 'translateX(-50%)',
            bgcolor: alpha(theme.palette.common.black, 0.9),
            color: theme.palette.common.white,
            px: 1,
            py: 0.25,
            borderRadius: 1,
            fontSize: '0.7rem',
            fontFamily: 'monospace',
            fontWeight: 500,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 15,
          }}
        >
          {formatTimeWithSubseconds(currentTime)}
        </Box>
      )}
    </Box>
  );
}

export default memo(TrimSlider);
