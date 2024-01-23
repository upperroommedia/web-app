import React from 'react';
import styles from '../../styles/AudioTrimmer.module.css';

interface OuterContainerProps {
  trimStartTime: string;
  trimEndTime: string;
  children: React.ReactNode;
}

function OuterContainer({ trimStartTime, trimEndTime, children }: OuterContainerProps) {
  return (
    <div className={styles.outer_container}>
      {children}
      <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
        <div>Trim Start: {trimStartTime}</div>
        <div>Trim Stop: {trimEndTime}</div>
      </div>
    </div>
  );
}

export default React.memo(OuterContainer);
