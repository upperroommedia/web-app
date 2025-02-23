import React, { Dispatch, FunctionComponent, SetStateAction } from 'react';
import Cancel from '@mui/icons-material/Cancel';
import dynamic from 'next/dynamic';
import { isBrowser } from 'react-device-detect';

const DynamicAudioTrimmer = dynamic(() => import('./AudioTrimmer'), { ssr: false });
const DynamicMobileAudioTrimmer = dynamic(() => import('./MobileAudioTrimmerComponent'), { ssr: false });

type AudioTrimmerComponentProps = {
  url: string;
  trimStart: number;
  setTrimStart: (trimStartTime: number) => void;
  setTrimDuration: (duration: number) => void;
  clearAudioTrimmer: () => void;
  setHasTrimmed?: Dispatch<SetStateAction<boolean>>;
};

const AudioTrimmerComponent: FunctionComponent<AudioTrimmerComponentProps> = ({
  url,
  trimStart,
  setTrimStart,
  setTrimDuration,
  clearAudioTrimmer,
  setHasTrimmed,
}) => {
  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'right' }}>
        <Cancel sx={{ color: 'red' }} onClick={clearAudioTrimmer} />
      </div>
      {isBrowser ? (
        <DynamicAudioTrimmer
          url={url}
          trimStart={trimStart}
          setTrimStart={setTrimStart}
          setTrimDuration={setTrimDuration}
          setHasTrimmed={setHasTrimmed}
        />
      ) : (
        <DynamicMobileAudioTrimmer url={url} setDuration={setTrimDuration} />
      )}
    </div>
  );
};

export default AudioTrimmerComponent;
