import { memo } from 'react';
import Box from '@mui/material/Box';
import {
  useMediaState,
  MuteButton,
  FullscreenButton,
  Time,
} from '@vidstack/react';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import styles from '../styles/AudioTrimmer.module.css';

export interface YouTubeTrimmerControlsProps {
  onSkipToStart: () => void;
  onSkipToEnd: () => void;
  onPlayPause: () => void;
}

/**
 * Vidstack player controls for the YouTube trimmer.
 * Must be rendered inside MediaPlayer. Receives callbacks as props so the parent
 * does not need to re-render when only playhead/time changes.
 */
function YouTubeTrimmerControls({
  onSkipToStart,
  onSkipToEnd,
  onPlayPause,
}: YouTubeTrimmerControlsProps) {
  const isPaused = useMediaState('paused');
  const isMuted = useMediaState('muted');

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

      <MuteButton className={styles.controlButton}>
        {isMuted ? (
          <VolumeOffIcon sx={{ fontSize: 20 }} />
        ) : (
          <VolumeUpIcon sx={{ fontSize: 20 }} />
        )}
      </MuteButton>

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
        <Time type="current" />
        <span>/</span>
        <Time type="duration" />
      </Box>

      <Box sx={{ flex: 1 }} />

      <FullscreenButton className={styles.controlButton}>
        <FullscreenIcon sx={{ fontSize: 20 }} />
      </FullscreenButton>
    </>
  );
}

export default memo(YouTubeTrimmerControls);
