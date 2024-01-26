import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import { useMediaPlayer } from '@vidstack/react';
import React, { useEffect } from 'react';
import { useStateRef } from './audioTrimmerComponents/utils';

interface TrackProgressComponentProps {
  playing: boolean;
  duration: number;
}

export default function TrackProgressComponent({ playing, duration }: TrackProgressComponentProps) {
  const [currentSecond, setCurrentSecond, currentSecondRef] = useStateRef(0);

  const player = useMediaPlayer();

  useEffect(() => {
    if (!player) return;
    if (!playing) return;
    return player.subscribe(({ currentTime }) => {
      if (Math.floor(currentTime) !== Math.floor(currentSecondRef.current)) {
        setCurrentSecond(currentTime);
      }
    });
  }, [currentSecondRef, player, setCurrentSecond, playing]);

  return (
    <>
      {currentSecond < Math.floor(duration) && (playing || currentSecond > 0) && (
        <Box sx={{ width: 1, maxWidth: { xs: 100, sm: 200 } }}>
          <LinearProgress
            variant="determinate"
            value={(currentSecond / duration) * 100}
            sx={{
              borderRadius: 5,
              color: (theme) => theme.palette.grey[theme.palette.mode === 'light' ? 200 : 800],
            }}
          />
        </Box>
      )}
    </>
  );
}
