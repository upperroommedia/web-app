import { memo } from 'react';
import Box from '@mui/material/Box';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import styles from '../styles/AudioTrimmer.module.css';

export interface YouTubeTrimmerControlsProps {
  isPaused: boolean;
  isMuted: boolean;
  currentTime: number;
  duration: number;
  onSkipToStart: () => void;
  onSkipToEnd: () => void;
  onPlayPause: () => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';

  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function YouTubeTrimmerControls({
  isPaused,
  isMuted,
  currentTime,
  duration,
  onSkipToStart,
  onSkipToEnd,
  onPlayPause,
  onToggleMute,
  onToggleFullscreen,
}: YouTubeTrimmerControlsProps) {
  return (
    <>
      <button
        className={styles.controlButton}
        onClick={onSkipToStart}
        title="Skip to trim start"
        type="button"
      >
        <SkipPreviousIcon sx={{ fontSize: 20 }} />
      </button>

      <button
        className={styles.controlButton}
        onClick={onPlayPause}
        title={isPaused ? 'Play' : 'Pause'}
        type="button"
      >
        {isPaused ? (
          <PlayArrowIcon sx={{ fontSize: 20 }} />
        ) : (
          <PauseIcon sx={{ fontSize: 20 }} />
        )}
      </button>

      <button
        className={styles.controlButton}
        onClick={onSkipToEnd}
        title="Skip to trim end"
        type="button"
      >
        <SkipNextIcon sx={{ fontSize: 20 }} />
      </button>

      <button
        className={styles.controlButton}
        onClick={onToggleMute}
        title={isMuted ? 'Unmute' : 'Mute'}
        type="button"
      >
        {isMuted ? (
          <VolumeOffIcon sx={{ fontSize: 20 }} />
        ) : (
          <VolumeUpIcon sx={{ fontSize: 20 }} />
        )}
      </button>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          color: 'white',
          fontSize: '0.8rem',
          fontFamily: 'monospace',
          ml: 1,
        }}
      >
        <span>{formatClock(currentTime)}</span>
        <span>/</span>
        <span>{formatClock(duration)}</span>
      </Box>

      <Box sx={{ flex: 1 }} />

      <button
        className={styles.controlButton}
        onClick={onToggleFullscreen}
        title="Toggle fullscreen"
        type="button"
      >
        <FullscreenIcon sx={{ fontSize: 20 }} />
      </button>
    </>
  );
}

export default memo(YouTubeTrimmerControls);
