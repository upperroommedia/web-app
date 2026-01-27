import { useRef, memo, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import { useTrimmerStore, formatTimeWithSubseconds } from '../../context/trimmerStore';
import { alpha, useTheme } from '@mui/material/styles';
import { colors } from '../../styles/theme';
import { useTrimmerDrag } from './useTrimmerDrag';

interface TrimmerTimelineProps {
  /** Optional callback when seeking (for syncing with media player) */
  onSeek?: (time: number) => void;
  /** Height of the timeline in pixels */
  height?: number;
  /** Whether to show time markers */
  showTimeMarkers?: boolean;
  /** Background element (e.g., waveform) */
  backgroundElement?: React.ReactNode;
}

/**
 * A visual timeline component with draggable trim handles and playhead.
 * Displays grayed-out regions outside the trim area.
 */
function TrimmerTimeline({ onSeek, height = 80, showTimeMarkers = true, backgroundElement }: TrimmerTimelineProps) {
  const theme = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [timelineWidth, setTimelineWidth] = useState(0);

  // Store state for rendering
  const trimStart = useTrimmerStore((state) => state.trimStart);
  const trimEnd = useTrimmerStore((state) => state.trimEnd);
  const currentTime = useTrimmerStore((state) => state.currentTime);
  const duration = useTrimmerStore((state) => state.duration);

  // Use shared drag hook
  const { startDrag, handleBackgroundMouseDown } = useTrimmerDrag(containerRef, { onSeek });

  // Calculate percentages
  const trimStartPercent = duration > 0 ? (trimStart / duration) * 100 : 0;
  const trimEndPercent = duration > 0 ? (trimEnd / duration) * 100 : 100;
  const playheadPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => {
      setTimelineWidth(container.clientWidth);
    };

    updateWidth();

    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  const timeMarkers = useMemo(() => {
    if (!showTimeMarkers || duration <= 0 || timelineWidth <= 0) return [];

    const labelSample = formatTimeDisplay(duration);
    const approxCharWidth = 7; // monospace approx at 0.7rem
    const labelWidth = Math.max(32, labelSample.length * approxCharWidth);
    const minSpacing = labelWidth + 12;
    const maxLabels = Math.max(2, Math.floor(timelineWidth / minSpacing));
    const rawInterval = duration / (maxLabels - 1);

    const niceIntervals = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const interval =
      niceIntervals.find((candidate) => candidate >= rawInterval) ||
      niceIntervals[niceIntervals.length - 1];

    const markers: { time: number; percent: number }[] = [];
    for (let t = 0; t <= duration; t += interval) {
      const percent = (t / duration) * 100;
      markers.push({ time: t, percent });
    }

    // Ensure end marker is included
    if (markers.length === 0 || markers[markers.length - 1].time < duration) {
      markers.push({ time: duration, percent: 100 });
    }

    // Enforce minimum spacing to avoid overlap
    const minPercentSpacing = (minSpacing / timelineWidth) * 100;
    const filtered: { time: number; percent: number }[] = [];

    markers.forEach((marker) => {
      if (filtered.length === 0) {
        filtered.push(marker);
        return;
      }

      const last = filtered[filtered.length - 1];
      if (marker.percent - last.percent >= minPercentSpacing) {
        filtered.push(marker);
      }
    });

    // Always keep the end marker; replace last if too close
    const endMarker = { time: duration, percent: 100 };
    const last = filtered[filtered.length - 1];
    if (!last || endMarker.percent - last.percent >= minPercentSpacing) {
      filtered.push(endMarker);
    } else if (last.time !== endMarker.time) {
      filtered[filtered.length - 1] = endMarker;
    }

    return filtered;
  }, [duration, showTimeMarkers, timelineWidth]);

  // Use theme accent colors (orange/flame)
  const handleColor = colors.accent.primary;
  const handleHoverColor = colors.accent.secondary;
  const handleActiveColor = colors.accent.dark;

  const handleWidth = 10; // pixels

  return (
    <Box
      sx={{
        width: '100%',
        userSelect: 'none',
        touchAction: 'none',
        pt: 4, // Space for playhead tooltip
        pb: 1,
      }}
    >
      {/* Timeline container */}
      <Box
        data-testid="audio-trim-timeline"
        ref={containerRef}
        onMouseDown={handleBackgroundMouseDown}
        onTouchStart={handleBackgroundMouseDown}
        sx={{
          position: 'relative',
          height: `${height}px`,
          bgcolor: theme.palette.mode === 'dark' ? colors.dark.background.default : colors.light.background.elevated,
          // borderRadius: 1.5,
          border: `1px solid ${theme.palette.mode === 'dark' ? colors.dark.border.default : colors.light.border.default}`,
          overflow: 'visible',
          cursor: 'pointer',
        }}
      >
        {/* Background wrapper with clipping for waveform and grayed regions */}
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            overflow: 'hidden',
            // borderRadius: 1,
            pointerEvents: 'none',
          }}
        >
          {/* Background element (waveform placeholder) */}
          {backgroundElement || (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                backgroundImage: 'url(/audio-wave.svg)',
                backgroundSize: 'auto 60%',
                backgroundPosition: 'center',
                backgroundRepeat: 'repeat-x',
                opacity: 0.4,
              }}
            />
          )}

          {/* Left grayed-out region (before trim start) */}
          <Box
            sx={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: `${trimStartPercent}%`,
              bgcolor: alpha(theme.palette.common.black, 0.55),
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
              bgcolor: alpha(theme.palette.common.black, 0.55),
            }}
          />

          {/* Trim area border - top/bottom lines */}
          <Box
            sx={{
              position: 'absolute',
              left: `${trimStartPercent}%`,
              right: `${100 - trimEndPercent}%`,
              top: 0,
              bottom: 0,
              borderTop: `2px solid ${handleColor}`,
              borderBottom: `2px solid ${handleColor}`,
            }}
          />
        </Box>

        {/* Start trim handle */}
        <Box
          data-testid="audio-trim-handle-start"
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
            borderRadius: '4px 0 0 4px',
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
            '&::after': {
              content: '""',
              width: '2px',
              height: '20px',
              bgcolor: alpha(theme.palette.common.white, 0.5),
              borderRadius: '1px',
            },
          }}
        />

        {/* End trim handle */}
        <Box
          data-testid="audio-trim-handle-end"
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
            borderRadius: '0 4px 4px 0',
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
            '&::after': {
              content: '""',
              width: '2px',
              height: '20px',
              bgcolor: alpha(theme.palette.common.white, 0.5),
              borderRadius: '1px',
            },
          }}
        />

        {/* Playhead */}
        <Box
          data-testid="audio-trim-playhead"
          data-playhead-percent={playheadPercent.toFixed(2)}
          onMouseDown={(e) => startDrag(e, 'playhead')}
          onTouchStart={(e) => startDrag(e, 'playhead')}
          sx={{
            position: 'absolute',
            left: `${playheadPercent}%`,
            top: 0,
            bottom: 0,
            width: '2px',
            bgcolor: theme.palette.common.white,
            transform: 'translateX(-50%)',
            cursor: 'ew-resize',
            zIndex: 10,
            boxShadow: '0 0 4px rgba(255,255,255,0.5)',
            '&::before': {
              content: '""',
              position: 'absolute',
              top: '-5px',
              left: '50%',
              transform: 'translateX(-50%)',
              width: 0,
              height: 0,
              borderLeft: '5px solid transparent',
              borderRight: '5px solid transparent',
              borderTop: `5px solid ${theme.palette.common.white}`,
            },
          }}
        />

        {/* Playhead time tooltip */}
        <Box
          sx={{
            position: 'absolute',
            left: `${playheadPercent}%`,
            top: '-28px',
            transform: 'translateX(-50%)',
            bgcolor: theme.palette.mode === 'dark' ? colors.dark.background.elevated : colors.light.background.paper,
            color: theme.palette.text.primary,
            border: `1px solid ${theme.palette.mode === 'dark' ? colors.dark.border.light : colors.light.border.default}`,
            px: 0.75,
            py: 0.25,
            borderRadius: 1,
            fontSize: '0.7rem',
            fontFamily: 'monospace',
            fontWeight: 500,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            boxShadow: theme.palette.mode === 'dark'
              ? '0 2px 8px rgba(0,0,0,0.4)'
              : '0 2px 8px rgba(0,0,0,0.1)',
          }}
        >
          {formatTimeWithSubseconds(currentTime)}
        </Box>
      </Box>

      {/* Time markers */}
      {showTimeMarkers && (
        <Box
          sx={{
            position: 'relative',
            height: '24px',
            mt: 1,
            px: 0.5,
          }}
        >
          {timeMarkers.map(({ time, percent }) => (
            <Box
              key={time}
              sx={{
                position: 'absolute',
                left: `${percent}%`,
                transform: 'translateX(-50%)',
                fontSize: '0.7rem',
                color: theme.palette.text.secondary,
                fontFamily: 'monospace',
                fontWeight: 500,
                opacity: 0.7,
              }}
            >
              {formatTimeDisplay(time)}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

// Helper to format time for markers (shorter format)
function formatTimeDisplay(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

export default memo(TrimmerTimeline);
