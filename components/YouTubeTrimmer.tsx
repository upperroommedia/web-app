import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import { Dispatch, FunctionComponent, memo, SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import {
  MediaPlayer,
  MediaProvider,
  MediaProviderAdapter,
  MediaProviderChangeEvent,
  isYouTubeProvider,
  MediaPlayerInstance,
} from '@vidstack/react';
import styles from '../styles/AudioTrimmer.module.css';
import { VideoLayout } from './vidstackComponents/VideoLayout';
import { formatTime } from '../utils/audioUtils';
import { AudioSource } from '../pages/api/uploadFile';
import CircularProgress from '@mui/material/CircularProgress';
import { UploaderFieldError } from '../context/types';
import { getErrorMessage, showError } from './uploaderComponents/utils';
import useDebounce from '@/hooks/useDebounce';

/**
 * Normalize a YouTube URL or ID into a standard embed URL.
 * Handles live, short, and other YouTube link variants.
 */
export function normalizeYouTubeUrl(input: string): string | null {
  if (!input) return null;

  // Trim whitespace
  const value = input.trim();

  // If it's already just an ID (11 characters typical)
  if (/^[\w-]{11}$/.test(value)) {
    return `https://www.youtube.com/embed/${value}`;
  }

  try {
    const url = new URL(value);

    // Match based on hostname patterns
    const host = url.hostname.replace(/^www\./, '');

    let videoId: string | null = null;

    switch (host) {
      case 'youtube.com':
      case 'youtube-nocookie.com':
        if (url.pathname === '/watch') {
          videoId = url.searchParams.get('v');
        } else if (url.pathname.startsWith('/embed/')) {
          videoId = url.pathname.split('/embed/')[1];
        } else if (url.pathname.startsWith('/live/')) {
          videoId = url.pathname.split('/live/')[1];
        } else if (url.pathname.startsWith('/shorts/')) {
          videoId = url.pathname.split('/shorts/')[1];
        }
        break;

      case 'youtu.be':
        videoId = url.pathname.split('/')[1];
        break;

      default:
        return null;
    }

    if (!videoId) return null;

    // Clean up videoId (remove query params or fragments)
    videoId = videoId.split('?')[0].split('&')[0].split('#')[0];

    // Validate it looks like a proper YouTube video ID
    if (!/^[\w-]{11}$/.test(videoId)) return null;

    return `https://www.youtube.com/embed/${videoId}`;
  } catch {
    // If it's not a URL, maybe it's just a malformed ID string
    const maybeId = value.match(/[\w-]{11}/)?.[0];
    return maybeId ? `https://www.youtube.com/embed/${maybeId}` : null;
  }
}

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
  const [isValidYouTubeUrl, setIsValidYouTubeUrl] = useState(false);
  const mediaPlayerRef = useRef<MediaPlayerInstance>(null);
  const debouncedInput = useDebounce(inputText, 500); // wait 500ms after user stops typing

  useEffect(() => {
    if (!mediaPlayerRef.current) return;
    mediaPlayerRef.current.startLoading();
    mediaPlayerRef.current.startLoadingPoster();
  }, [debouncedInput]);

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

  const handleTextFieldChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setInputText(event.target.value);
    },
    [setInputText]
  );

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
          onChange={handleTextFieldChange}
        />
      </Box>
      {!showError(audioSourceError) && !isValidYouTubeUrl && inputText.trim() && <CircularProgress />}
      <MediaPlayer
        ref={mediaPlayerRef}
        className={`${styles.player} media-player`}
        src={normalizeYouTubeUrl(debouncedInput) || undefined}
        load="custom"
        posterLoad="custom"
        onProviderChange={onProviderChange}
        hideControlsOnMouseLeave={false}
        controlsDelay={10000000000000}
        crossOrigin
        playsInline
        viewType="video"
        onError={() => {
          setIsValidYouTubeUrl(false);
          setAudioSourceError(true, 'Could not load YouTube video, please check the link');
        }}
        style={{ display: isValidYouTubeUrl ? 'block' : 'none' }}
      >
        <MediaProvider iframeProps={{ style: { height: '100%', width: '100%' } }}></MediaProvider>
        <VideoLayout startTime={trimStart} duration={duration} setStartTime={setTrimStart} setDuration={setDuration} />
      </MediaPlayer>
      <Box display="flex" width={1} justifyContent="space-around" gap={1}>
        <p>Start Time: {formatTime(trimStart)}</p>
        <p>End Time: {formatTime(trimStart + duration)}</p>
      </Box>
    </Box>
  );
};

export default memo(YouTubeTrimmer);
