import React, { Dispatch, FunctionComponent, SetStateAction } from 'react';
import CloseIcon from '@mui/icons-material/Close';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import dynamic from 'next/dynamic';

// Use the same AudioTrimmer for both mobile and desktop
// The new trimmer components are responsive and work on mobile
const DynamicAudioTrimmer = dynamic(() => import('./AudioTrimmer'), { ssr: false });

type AudioTrimmerComponentProps = {
  url: string;
  trimStart: number;
  trimDuration?: number;
  setTrimStart: (trimStartTime: number) => void;
  setTrimDuration: (duration: number) => void;
  clearAudioTrimmer: () => void;
  setHasTrimmed?: Dispatch<SetStateAction<boolean>>;
};

const AudioTrimmerComponent: FunctionComponent<AudioTrimmerComponentProps> = ({
  url,
  trimStart,
  trimDuration,
  setTrimStart,
  setTrimDuration,
  clearAudioTrimmer,
  setHasTrimmed,
}) => {
  return (
    <Box sx={{ width: '100%', position: 'relative' }}>
      {/* Close button - positioned in top right */}
      <Tooltip title="Remove audio" placement="left">
        <IconButton
          size="small"
          onClick={clearAudioTrimmer}
          sx={{
            position: 'absolute',
            top: 0,
            right: 0,
            zIndex: 10,
            color: 'text.secondary',
            '&:hover': {
              color: 'error.main',
              bgcolor: 'rgba(239, 68, 68, 0.1)',
            },
          }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <DynamicAudioTrimmer
        url={url}
        trimStart={trimStart}
        trimDuration={trimDuration}
        setTrimStart={setTrimStart}
        setTrimDuration={setTrimDuration}
        setHasTrimmed={setHasTrimmed}
      />
    </Box>
  );
};

export default AudioTrimmerComponent;
