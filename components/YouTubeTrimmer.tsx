import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import { Dispatch, FunctionComponent, SetStateAction, useEffect, useState } from 'react';
import {
  MediaPlayer,
  MediaProvider,
  MediaProviderAdapter,
  MediaProviderChangeEvent,
  isYouTubeProvider,
} from '@vidstack/react';
import styles from '../styles/AudioTrimmer.module.css';
import { VideoLayout } from './vidstackComponents/VideoLayout';
import { formatTime } from '../utils/audioUtils';
import { AudioSource } from '../pages/api/uploadFile';
import CircularProgress from '@mui/material/CircularProgress';
import { UploaderFieldError } from '../context/types';
import { getErrorMessage, showError } from './uploaderComponents/utils';

interface YouTubeTrimmerProps {
  setAudioSource: Dispatch<SetStateAction<AudioSource | undefined>>;
  trimStart: number;
  duration: number;
  setTrimStart: (trimStartTime: number) => void;
  setDuration: (duration: number) => void;
  audioSourceError?: UploaderFieldError;
  setAudioSourceError: (error: boolean, message: string) => void;
}

const YouTubeTrimmer: FunctionComponent<YouTubeTrimmerProps> = ({
  setAudioSource,
  trimStart,
  duration,
  setTrimStart,
  setDuration,
  audioSourceError,
  setAudioSourceError,
}) => {
  const [inputText, setInputText] = useState('');
  const [isLoading, _setIsLoading] = useState(false);
  const [isValidYouTubeUrl, setIsValidYouTubeUrl] = useState(false);

  function onProviderChange(provider: MediaProviderAdapter | null, _nativeEvent: MediaProviderChangeEvent) {
    // We can configure provider's here.
    if (isYouTubeProvider(provider)) {
      // console.log('provider', provider);
      setAudioSource({ source: inputText, type: 'YoutubeUrl' });
    }
  }

  // write a function that will set an error after 10 seconds which gets reset when the user types
  useEffect(() => {
    if (isValidYouTubeUrl || !inputText.trim()) return;
    const timeoutId = setTimeout(() => {
      if (!isValidYouTubeUrl) {
        setAudioSourceError(true, 'Could not find YouTube video, please make sure the link is valid');
      }
    }, 5000);

    return () => {
      setAudioSourceError(false, '');
      clearTimeout(timeoutId);
    };
  }, [inputText, isValidYouTubeUrl, setAudioSourceError]);

  useEffect(() => {
    if (trimStart + duration > 0) {
      setIsValidYouTubeUrl(true);
    } else {
      setIsValidYouTubeUrl(false);
    }
  }, [trimStart, duration]);

  return (
    <Box display="flex" width={1} flexDirection="column" justifyContent="center" alignItems="center" gap={1}>
      <Box display="flex" width={1} justifyContent="center" alignItems="center" gap={1}>
        <TextField
          sx={{
            display: 'block',
            width: 1,
          }}
          fullWidth
          id="youtube-url-input"
          label="Youtube Link"
          name="Youtube Link"
          variant="outlined"
          required
          error={showError(audioSourceError)}
          helperText={getErrorMessage(audioSourceError)}
          value={inputText}
          disabled={isLoading}
          onChange={(e) => {
            setInputText(e.target.value);
            setTrimStart(0);
            setAudioSourceError(false, '');
            // setShowMediaPlayer(false)
            // if (error) {
            //   setError(error);
            // }
          }}
        />
      </Box>
      {!showError(audioSourceError) && !isValidYouTubeUrl && inputText.trim() && <CircularProgress />}
      <MediaPlayer
        className={`${styles.player} media-player`}
        src={inputText}
        load="eager"
        onProviderChange={onProviderChange}
        hideControlsOnMouseLeave={false}
        controlsDelay={10000000000000}
        crossOrigin
        playsInline
        viewType="video"
        style={{ display: isValidYouTubeUrl ? 'block' : 'none' }}
      >
        <MediaProvider></MediaProvider>
        <VideoLayout startTime={trimStart} duration={duration} setStartTime={setTrimStart} setDuration={setDuration} />
      </MediaPlayer>
      <Box display="flex" width={1} justifyContent="space-around" gap={1}>
        <p>Start Time: {formatTime(trimStart)}</p>
        <p>End Time: {formatTime(trimStart + duration)}</p>
      </Box>
    </Box>
  );
};

export default YouTubeTrimmer;
