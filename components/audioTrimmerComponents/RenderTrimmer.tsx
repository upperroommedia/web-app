import React, { RefObject } from 'react';
import styles from '../../styles/AudioTrimmer.module.css';
import { CLICK_TARGET } from './types';

interface RenderTrimmerProps {
  MouseDown: (e: React.MouseEvent | React.TouchEvent, target: CLICK_TARGET) => void;
  scrubberContainer: RefObject<HTMLDivElement>;
  children: React.ReactNode;
}

function RenderTrimmer({ MouseDown, scrubberContainer, children }: RenderTrimmerProps) {
  return (
    <div className={styles.scrubber_container}>
      <div
        onTouchStart={(e) => MouseDown(e, CLICK_TARGET.SCRUBBER)}
        onMouseDown={(e) => {
          MouseDown(e, CLICK_TARGET.SCRUBBER);
        }}
      >
        <div ref={scrubberContainer} className={styles.audio_container}>
          {children}
        </div>
      </div>
    </div>
  );
}

export default React.memo(RenderTrimmer);
