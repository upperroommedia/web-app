import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import { Dispatch, FunctionComponent, SetStateAction, useState } from 'react';
import { UploadableFile } from './DropZone';
import Typography from '@mui/material/Typography';
import {
  MediaCanPlayDetail,
  MediaCanPlayEvent,
  MediaPlayer,
  MediaProvider,
  MediaProviderAdapter,
  MediaProviderChangeEvent,
  isYouTubeProvider,
} from '@vidstack/react';
import styles from '../styles/AudioTrimmer.module.css';
import { VideoLayout } from './vidstackComponents/VideoLayout';
import { CustomSlider } from './vidstackComponents/sliders';
import { formatTime } from '../utils/audioUtils';

interface YoutubeUrlToMp3Props {
  setFile?: Dispatch<SetStateAction<UploadableFile | undefined>>;
}

const YoutubeUrlToMp3: FunctionComponent<YoutubeUrlToMp3Props> = () => {
  const [inputText, setInputText] = useState('');
  const [error, setError] = useState('');
  const [showMediaPlayer, setShowMediaPlayer] = useState(false);
  const [isLoading, _setIsLoading] = useState(false);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);

  function onProviderChange(provider: MediaProviderAdapter | null, _nativeEvent: MediaProviderChangeEvent) {
    // We can configure provider's here.
    if (isYouTubeProvider(provider)) {
      // console.log('provider', provider);
      setShowMediaPlayer(true);
    }
  }

  // We can listen for the `can-play` event to be notified when the player is ready.
  function onCanPlay(_detail: MediaCanPlayDetail, _nativeEvent: MediaCanPlayEvent) {
    // console.log('can play detail', detail);
    setShowMediaPlayer(true);
  }

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
          value={inputText}
          disabled={isLoading}
          onChange={(e) => {
            setInputText(e.target.value);
            // setShowMediaPlayer(false)
            if (error) {
              setError('');
            }
          }}
        />
      </Box>
      {error && (
        <Typography variant="caption" color="red">
          {error}
        </Typography>
      )}
      {/* TODO: FIND A WAY TO KNOW WHEN A VALID VIDEO IS LOADED */}
      <MediaPlayer
        className={`${styles.player} media-player`}
        src={inputText}
        onProviderChange={onProviderChange}
        onCanPlay={onCanPlay}
        hideControlsOnMouseLeave={false}
        hidden={false}
        // onWaiting={() => console.log('waiting')}
        // onInvalid={() => console.log('invalid')}
        // onError={() => console.log('YOUSSEF error')}
        // onErrorCapture={() => console.log('error capture')}
        // onSourceChange={() => console.log('source change')}
        // onLoadedMetadata={() => console.log('loaded metadata')}
        crossorigin
        playsinline
        viewType="video"
        style={{ display: showMediaPlayer ? 'block' : 'none' }}
      >
        <MediaProvider></MediaProvider>
        <VideoLayout
          customSlider={
            <CustomSlider startTime={startTime} endTime={endTime} setStartTime={setStartTime} setEndTime={setEndTime} />
          }
        />
      </MediaPlayer>
      <Box display="flex" width={1} justifyContent="space-around" gap={1}>
        <p>Start Time: {formatTime(startTime)}</p>
        <p>End Time: {formatTime(endTime)}</p>
      </Box>
    </Box>
  );
};

export default YoutubeUrlToMp3;
