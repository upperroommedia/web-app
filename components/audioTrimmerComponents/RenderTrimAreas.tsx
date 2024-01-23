import styles from '../../styles/AudioTrimmer.module.css';
import classNames from 'classnames';
import React from 'react';
import { CLICK_TARGET } from './types';

interface RenderTrimAreasProps {
  trimStart: number;
  stopTrim: number;
  calculateTimePercentage: (time: number, invert?: boolean) => string;
  MouseDown: (
    e: React.MouseEvent<HTMLDivElement, MouseEvent> | React.TouchEvent<HTMLDivElement>,
    target: CLICK_TARGET
  ) => void;
}

function RenderTrimAreas({ trimStart, stopTrim, calculateTimePercentage, MouseDown }: RenderTrimAreasProps) {
  return (
    <>
      <div
        className={classNames(styles.outside_trim_area, styles.left_container)}
        style={{ left: 0, right: calculateTimePercentage(trimStart, true) }}
      ></div>
      <div
        className={classNames(styles.outside_trim_area, styles.right_container)}
        style={{ left: calculateTimePercentage(stopTrim), right: 0 }}
      ></div>
      <div
        className={styles.trim_area}
        style={{
          left: calculateTimePercentage(trimStart),
          right: calculateTimePercentage(stopTrim, true),
        }}
      >
        <div
          className={classNames(styles.handle, styles.left_handle)}
          onTouchStart={(e) => MouseDown(e, CLICK_TARGET.START_TRIM)}
          onMouseDown={(e) => {
            MouseDown(e, CLICK_TARGET.START_TRIM);
          }}
        ></div>
        <div
          className={classNames(styles.handle, styles.right_handle)}
          onTouchStart={(e) => MouseDown(e, CLICK_TARGET.END_TRIM)}
          onMouseDown={(e) => {
            MouseDown(e, CLICK_TARGET.END_TRIM);
          }}
        ></div>
      </div>
    </>
  );
}

export default React.memo(RenderTrimAreas);
