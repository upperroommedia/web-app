import { memo, useCallback } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import SkipPrevious from '@mui/icons-material/SkipPrevious';
import SkipNext from '@mui/icons-material/SkipNext';
import PlayCircle from '@mui/icons-material/PlayCircle';
import PauseCircle from '@mui/icons-material/PauseCircle';
import { useTrimmerStore } from '../../context/trimmerStore';

interface TrimmerControlsProps {
  /** Callback for play/pause toggle */
  onPlayPause?: () => void;
  /** Callback when seeking */
  onSeek?: (time: number) => void;
  /** Size of the icons */
  iconSize?: 'small' | 'medium' | 'large';
  /** Whether controls are disabled */
  disabled?: boolean;
}

/**
 * Playback controls for the trimmer: rewind to start, play/pause, forward to end.
 */
function TrimmerControls({
  onPlayPause,
  onSeek,
  iconSize = 'large',
  disabled = false,
}: TrimmerControlsProps) {
  const isPlaying = useTrimmerStore((state) => state.isPlaying);
  const trimStart = useTrimmerStore((state) => state.trimStart);
  const trimEnd = useTrimmerStore((state) => state.trimEnd);
  const setCurrentTime = useTrimmerStore((state) => state.setCurrentTime);

  const handleRewindToStart = useCallback(() => {
    setCurrentTime(trimStart, 'timeline');
    onSeek?.(trimStart);
  }, [trimStart, setCurrentTime, onSeek]);

  const handleForwardToEnd = useCallback(() => {
    // Go to 5 seconds before end, or start if trim region is shorter than 5 seconds
    const targetTime = Math.max(trimStart, trimEnd - 5);
    setCurrentTime(targetTime, 'timeline');
    onSeek?.(targetTime);
  }, [trimStart, trimEnd, setCurrentTime, onSeek]);

  const handlePlayPause = useCallback(() => {
    onPlayPause?.();
  }, [onPlayPause]);

  const iconSizeMap = {
    small: '1.5rem',
    medium: '2rem',
    large: '2.5rem',
  };

  const fontSize = iconSizeMap[iconSize];

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 1,
      }}
    >
      <IconButton
        onClick={handleRewindToStart}
        disabled={disabled}
        aria-label="Rewind to start"
        size={iconSize}
      >
        <SkipPrevious sx={{ fontSize }} />
      </IconButton>

      <IconButton
        onClick={handlePlayPause}
        disabled={disabled}
        aria-label={isPlaying ? 'Pause' : 'Play'}
        size={iconSize}
        color="primary"
      >
        {isPlaying ? (
          <PauseCircle sx={{ fontSize }} />
        ) : (
          <PlayCircle sx={{ fontSize }} />
        )}
      </IconButton>

      <IconButton
        onClick={handleForwardToEnd}
        disabled={disabled}
        aria-label="Forward to end"
        size={iconSize}
      >
        <SkipNext sx={{ fontSize }} />
      </IconButton>
    </Box>
  );
}

export default memo(TrimmerControls);
