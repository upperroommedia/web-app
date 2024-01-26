import Typography from '@mui/material/Typography';
import React, { useEffect } from 'react';
import { convertToHMS, formatRemainingTime } from '../utils/audioUtils';
import { useMediaPlayer } from '@vidstack/react';
import { useStateRef } from './audioTrimmerComponents/utils';

interface RemainingTimeComponentProps {
  playing: boolean;
  duration: number;
}

export default function RemainingTimeComponent({ playing, duration }: RemainingTimeComponentProps) {
  const [currentSecond, setCurrentSecond, currentSecondRef] = useStateRef(0);

  const player = useMediaPlayer();

  useEffect(() => {
    if (!player) return;
    if (!playing) return;
    return player.subscribe(({ currentTime }) => {
      const currentTimeSeconds = Math.floor(currentTime);
      const currentRemainingTime = Math.floor(duration) - currentTimeSeconds;
      const {
        hours: _,
        minutes: currentRemainingMinutes,
        seconds: currentRemainingSeconds,
      } = convertToHMS(currentRemainingTime);
      const remainingTime = Math.floor(duration) - currentSecondRef.current;
      if (currentRemainingMinutes > 0) {
        // displaying minutes
        const previousRemainingMinutes = Math.floor(remainingTime / 60);
        if (
          (previousRemainingMinutes !== currentRemainingMinutes &&
            !(previousRemainingMinutes - currentRemainingMinutes === 1 && currentRemainingSeconds > 0)) ||
          (previousRemainingMinutes === currentRemainingMinutes && currentTimeSeconds < currentSecondRef.current) ||
          (previousRemainingMinutes === currentRemainingMinutes &&
            currentRemainingSeconds === 0 &&
            currentTimeSeconds !== currentSecondRef.current)
        ) {
          // update every minute when over 60 seconds
          setCurrentSecond(currentTimeSeconds);
        }
      } else if (currentTimeSeconds !== currentSecondRef.current) {
        setCurrentSecond(currentTimeSeconds);
      }
    });
  }, [currentSecondRef, duration, player, playing, setCurrentSecond]);

  return (
    <>
      {currentSecond < Math.floor(duration) ? (
        <>
          <Typography sx={{ whiteSpace: 'nowrap', fontSize: { xs: '0.8rem', sm: '0.9rem', md: '1rem' } }}>
            {formatRemainingTime(duration - currentSecond) + (playing || currentSecond ? ' left' : '')}
          </Typography>
        </>
      ) : (
        <>
          <Typography sx={{ fontSize: { xs: '0.8rem', sm: '0.9rem', md: '1rem' } }}>Played</Typography>
          <Typography sx={{ color: 'lightgreen', fontSize: { xs: '0.8rem', sm: '0.9rem', md: '1rem' } }}>
            {' '}
            &#10003;
          </Typography>
        </>
      )}
    </>
  );
}
