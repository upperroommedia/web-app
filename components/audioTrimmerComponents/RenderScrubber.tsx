import React from 'react';
import styles from '../../styles/AudioTrimmer.module.css';

interface RenderScrubberProps {
  currentTime: number;
  calculateTimePercentage: (time: number) => string;
  calculateTime: (time: number) => string;
}

function RenderScrubber({ currentTime, calculateTimePercentage, calculateTime }: RenderScrubberProps) {
  return (
    <div
      className={styles.audio_scrubber_container}
      style={{
        left: calculateTimePercentage(currentTime),
      }}
    >
      <div className={styles.audio_scrubber}>
        <div className={styles.audio_scrubber_thumb}>
          <span className={styles.audio_scrubber_text}>{calculateTime(currentTime)}</span>
        </div>
      </div>
    </div>
  );
}

export default React.memo(RenderScrubber);
