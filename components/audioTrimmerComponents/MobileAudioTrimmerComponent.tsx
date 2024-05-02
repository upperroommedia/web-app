import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useRef } from 'react';

type MobileAudioTrimmerComponentProps = {
  url: string;
  setDuration: (duration: number) => void;
};
export default function MobileAudioTrimmerComponent({ url, setDuration }: MobileAudioTrimmerComponentProps) {
  const audioPlayer = useRef<HTMLAudioElement>(null); // reference for our audio component

  const handleMetaDataLoaded = useCallback(() => {
    setDuration(audioPlayer.current?.duration || 0);
  }, [setDuration]);

  useEffect(() => {
    if (audioPlayer && audioPlayer.current) {
      const currentAudioPlayer = audioPlayer.current;
      currentAudioPlayer.addEventListener('loadedmetadata', handleMetaDataLoaded);
      return function cleanup() {
        currentAudioPlayer.removeEventListener('loadedmetadata', handleMetaDataLoaded);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioPlayer]);
  return (
    <Box display="flex" flexDirection="column" justifyContent="center" alignItems="center">
      <audio style={{ width: '100%' }} controls src={url} ref={audioPlayer} />
      <Typography variant="caption">
        Trimming is not currently supported on mobile: please trim your audio on a seperate application first
      </Typography>
    </Box>
  );
}
