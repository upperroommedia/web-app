import styles from '../../styles/VideoLayout.module.css';

import { Captions, ChapterTitle, Controls, Gesture } from '@vidstack/react';

import * as Buttons from './buttons';
import * as Menus from './menus';
import * as Sliders from './sliders';
import { TimeGroup } from './time-group';
import { Dispatch, SetStateAction } from 'react';

export interface VideoLayoutProps {
  startTime: number;
  duration: number;
  setStartTime: Dispatch<SetStateAction<number>>;
  setDuration: (duration: number) => void;
  thumbnails?: string;
}

export function VideoLayout({ startTime, duration, setStartTime, setDuration }: VideoLayoutProps) {
  return (
    <>
      <Gestures />
      <Captions className={`${styles.captions} vds-captions`} />
      <Controls.Root className={`${styles.controls} vds-controls`}>
        <div className="vds-controls-spacer" />
        <div style={{ background: 'linear-gradient(0deg, black, transparent)' }}>
          <Controls.Group className={`${styles.controlsGroup} vds-controls-group`}>
            <Sliders.CustomSlider startTime={startTime} setDuration={setDuration} setStartTime={setStartTime} />
          </Controls.Group>
          <Controls.Group className={`${styles.controlsGroup} vds-controls-group`}>
            <Buttons.CustomSeek
              startTime={startTime}
              duration={duration}
              forward={false}
              tooltipPlacement="top"
            ></Buttons.CustomSeek>
            <Buttons.Play tooltipPlacement="top start" />
            <Buttons.CustomSeek
              startTime={startTime}
              duration={duration}
              forward
              tooltipPlacement="top"
            ></Buttons.CustomSeek>
            {/* <Buttons.Mute tooltipPlacement="top" />
          <Sliders.Volume /> */}
            <TimeGroup />
            <ChapterTitle className="vds-chapter-title" />
            <div className="vds-controls-spacer" />
            <Buttons.Caption tooltipPlacement="top" />
            <Menus.Settings placement="top end" tooltipPlacement="top" />
            <Buttons.PIP tooltipPlacement="top" />
            <Buttons.Fullscreen tooltipPlacement="top end" />
          </Controls.Group>
        </div>
      </Controls.Root>
    </>
  );
}

function Gestures() {
  return (
    <div style={{ backgroundColor: 'green' }}>
      <Gesture className={styles.gesture} event="pointerup" action="toggle:paused" />
      <Gesture className={styles.gesture} event="dblpointerup" action="toggle:fullscreen" />
      <Gesture className={styles.gesture} event="pointerup" action="toggle:controls" />
      <Gesture className={styles.gesture} event="dblpointerup" action="seek:-10" />
      <Gesture className={styles.gesture} event="dblpointerup" action="seek:10" />
    </div>
  );
}
