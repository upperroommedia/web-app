import styles from '../../styles/VideoLayout.module.css';

import { Captions, ChapterTitle, Controls, Gesture } from '@vidstack/react';

import * as Buttons from './buttons';
import * as Menus from './menus';
import { TimeGroup } from './time-group';

export interface VideoLayoutProps {
  thumbnails?: string;
}

/**
 * Video layout for the Vidstack player.
 * Note: Trimming UI is now handled by the TrimmerTimeline component outside the player.
 */
export function VideoLayout({ thumbnails }: VideoLayoutProps) {
  return (
    <>
      <Gestures />
      <Captions className={`${styles.captions} vds-captions`} />
      <Controls.Root className={`${styles.controls} vds-controls`}>
        <div className="vds-controls-spacer" />
        <div style={{ background: 'linear-gradient(0deg, black, transparent)' }}>
          <Controls.Group className={`${styles.controlsGroup} vds-controls-group`}>
            <Buttons.Play tooltipPlacement="top start" />
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
