import React from 'react';
import styles from '../../styles/AudioTrimmer.module.css';
import SkipPrevious from '@mui/icons-material/SkipPrevious';
import PauseCircle from '@mui/icons-material/PauseCircle';
import SkipNext from '@mui/icons-material/SkipNext';
import PlayCircle from '@mui/icons-material/PlayCircle';

interface RenderControlsProps {
  rewindToStart: () => void;
  togglePlayPause: () => void;
  forwardToEnd: () => void;
  isPlaying: boolean;
}

function RenderControls({ rewindToStart, togglePlayPause, forwardToEnd, isPlaying }: RenderControlsProps) {
  return (
    <div className={styles.button_container}>
      <SkipPrevious onClick={rewindToStart} />
      {isPlaying ? <PauseCircle onClick={togglePlayPause} /> : <PlayCircle onClick={togglePlayPause} />}
      <SkipNext onClick={forwardToEnd} />
    </div>
  );
}

export default React.memo(RenderControls);
