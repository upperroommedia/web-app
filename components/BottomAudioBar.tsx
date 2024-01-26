/**
 * BottomAudioBar is a component that displays the audio player similar to Spotify's bottom play bar
 */
// import Image from 'next/image';
import styles from '../styles/BottomAudioBar.module.css';
import { FunctionComponent } from 'react';
// import { formatTime } from '../utils/audioUtils';
// import Replay30Icon from '@mui/icons-material/Replay30';
// import Forward30Icon from '@mui/icons-material/Forward30';
// import PauseCircleIcon from '@mui/icons-material/PauseCircle';
// import PlayCircleIcon from '@mui/icons-material/PlayCircle';
// import { getDownloadURL, getStorage, ref } from 'firebase/storage';
// import firebase from '../firebase/firebase';
// import { sanitize } from 'dompurify';
import { MediaProvider } from '@vidstack/react';

import {
  ChapterTitle,
  VolumeSlider,
  TimeSlider,
  Time,
  MuteButton,
  Controls,
  PlayButton,
  SeekButton,
  Tooltip,
  useMediaState,
  type TooltipPlacement,
} from '@vidstack/react';

import {
  MuteIcon,
  PauseIcon,
  PlayIcon,
  SeekBackward10Icon,
  SeekForward10Icon,
  VolumeHighIcon,
  VolumeLowIcon,
} from '@vidstack/react/icons';
import Box from '@mui/material/Box';
// import MarqueeComponent from './MarqueeComponent';
// import BufferingIndicator from './BufferingIndicator';

interface MediaButtonProps {
  tooltipPlacement: TooltipPlacement;
}

interface SeekButtonProps extends MediaButtonProps {
  seconds: number;
}

//  interface SettingsProps {
//   placement: MenuPlacement;
//   tooltipPlacement: TooltipPlacement;
// }

interface TimeSliderProps {
  thumbnails?: string;
}

function Slider({ thumbnails }: TimeSliderProps) {
  return (
    <TimeSlider.Root className="vds-time-slider vds-slider">
      <TimeSlider.Chapters className="vds-slider-chapters">
        {(cues, forwardRef) =>
          cues.map((cue) => (
            <div className="vds-slider-chapter" key={cue.startTime} ref={forwardRef}>
              <TimeSlider.Track className="vds-slider-track" />
              <TimeSlider.TrackFill className="vds-slider-track-fill vds-slider-track" />
              <TimeSlider.Progress className="vds-slider-progress vds-slider-track" />
            </div>
          ))
        }
      </TimeSlider.Chapters>

      <TimeSlider.Thumb className="vds-slider-thumb" />

      <TimeSlider.Preview className="vds-slider-preview">
        {thumbnails ? (
          <TimeSlider.Thumbnail.Root src={thumbnails} className="vds-slider-thumbnail vds-thumbnail">
            <TimeSlider.Thumbnail.Img />
          </TimeSlider.Thumbnail.Root>
        ) : null}

        <TimeSlider.ChapterTitle className="vds-slider-chapter-title" />

        <TimeSlider.Value className="vds-slider-value" />
      </TimeSlider.Preview>
    </TimeSlider.Root>
  );
}

export function Seek({ seconds, tooltipPlacement }: SeekButtonProps) {
  const isBackward = seconds < 0;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <SeekButton className="vds-button" seconds={seconds}>
          {isBackward ? <SeekBackward10Icon /> : <SeekForward10Icon />}
        </SeekButton>
      </Tooltip.Trigger>
      <Tooltip.Content className="vds-tooltip-content" placement={tooltipPlacement}>
        {isBackward ? 'Seek Backward' : 'Seek Forward'}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

function Mute({ tooltipPlacement }: MediaButtonProps) {
  const volume = useMediaState('volume');
  const isMuted = useMediaState('muted');
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <MuteButton className="vds-button">
          {isMuted || volume === 0 ? <MuteIcon /> : volume < 0.5 ? <VolumeLowIcon /> : <VolumeHighIcon />}
        </MuteButton>
      </Tooltip.Trigger>
      <Tooltip.Content className="vds-tooltip-content" placement={tooltipPlacement}>
        {isMuted ? 'Unmute' : 'Mute'}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

function Play({ tooltipPlacement }: MediaButtonProps) {
  const isPaused = useMediaState('paused');
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <PlayButton className="vds-button">{isPaused ? <PlayIcon /> : <PauseIcon />}</PlayButton>
      </Tooltip.Trigger>
      <Tooltip.Content className="vds-tooltip-content" placement={tooltipPlacement}>
        {isPaused ? 'Play' : 'Pause'}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

export function TimeGroup() {
  return (
    <div className="vds-time-group">
      <Time className="vds-time" type="current" />
      <div className="vds-time-divider">/</div>
      <Time className="vds-time" type="duration" />
    </div>
  );
}

function Volume() {
  return (
    <VolumeSlider.Root className="vds-volume-slider vds-slider">
      <VolumeSlider.Track className="vds-slider-track" />
      <VolumeSlider.TrackFill className="vds-slider-track-fill vds-slider-track" />
      <VolumeSlider.Preview className="vds-slider-preview" noClamp>
        <VolumeSlider.Value className="vds-slider-value" />
      </VolumeSlider.Preview>
      <VolumeSlider.Thumb className="vds-slider-thumb" />
    </VolumeSlider.Root>
  );
}

//  function Settings({ placement, tooltipPlacement }: SettingsProps) {
//   return (
//     <Menu.Root className="vds-menu">
//       <Tooltip.Root>
//         <Tooltip.Trigger asChild>
//           <Menu.Button className="vds-menu-button vds-button">
//             <SettingsIcon className="vds-rotate-icon" />
//           </Menu.Button>
//         </Tooltip.Trigger>
//         <Tooltip.Content className="vds-tooltip-content" placement={tooltipPlacement}>
//           Settings
//         </Tooltip.Content>
//       </Tooltip.Root>
//       <Menu.Content className="vds-menu-items" placement={placement}>
//         <CaptionSubmenu />
//       </Menu.Content>
//     </Menu.Root>
//   );
// }

const BottomAudioBar: FunctionComponent = () => {
  return (
    <MediaProvider>
      <Box className={`${styles.player} media-player`}>
        <Controls.Root className={`${styles.controls} vds-controls`}>
          <Controls.Group className={`${styles.controlsGroup} vds-controls-group`}>
            <Slider />
          </Controls.Group>
          <Controls.Group className={`${styles.controlsGroup} vds-controls-group`}>
            <Seek seconds={-10} tooltipPlacement="top start" />
            <Play tooltipPlacement="top" />
            {/* <BufferingIndicator/> */}
            <Seek seconds={10} tooltipPlacement="top" />
            <TimeGroup />
            {/* <MarqueeComponent> */}
            <ChapterTitle className="vds-chapter-title" />
            {/* </MarqueeComponent> */}
            <Mute tooltipPlacement="top" />
            <Volume />
            {/* <Settings placement="top end" tooltipPlacement="top end" /> */}
          </Controls.Group>
        </Controls.Root>
      </Box>
    </MediaProvider>
  );
};

export default BottomAudioBar;

// const storage = getStorage(firebase);
// // const path = useRouter().asPath;
// const BottomAudioBar: FunctionComponent<{ currentSermon: SermonWithMetadata }> = ({ currentSermon }) => {
//   const { playing, togglePlaying, currentSecond, updateCurrentSecond, setCurrentSermonUrl } = useAudioPlayer();
//   const audioPlayer = useRef<HTMLAudioElement>(new Audio());
//   const [seekTime, setSeekTime] = useState(-1);

//   // will fire when global play state changes
//   useEffect(() => {
//     if (currentSermon.url == null) {
//       getDownloadURL(ref(storage, `intro-outro-sermons/${currentSermon.id}`))
//         .then((url) => {
//           setCurrentSermonUrl(url);
//         })
//         .catch((error) => {
//           // eslint-disable-next-line no-console
//           console.log(error);
//         });
//     }
//     if (playing && currentSermon.url) {
//       audioPlayer.current.play();
//     } else if (!playing && audioPlayer.current) {
//       audioPlayer.current.pause();
//     }
//   }, [currentSecond, currentSermon.id, currentSermon.url, playing, setCurrentSermonUrl]);

//   const onPlaying = () => {
//     const newSecond = Math.floor(audioPlayer.current.currentTime);
//     if (audioPlayer.current.src === currentSermon.url && newSecond !== currentSecond) {
//       updateCurrentSecond(newSecond);
//     }
//   };

//   const rewind30Seconds = () => {
//     audioPlayer.current.currentTime = Math.max(audioPlayer.current.currentTime - 30, 0);
//   };

//   const forward30Seconds = () => {
//     audioPlayer.current.currentTime = Math.min(audioPlayer.current.currentTime + 30, currentSermon.durationSeconds);
//   };

//   function handleSliderScrub(event: ChangeEvent<HTMLInputElement>): void {
//     const value = parseFloat(event.target.value);
//     setSeekTime(value);
//   }
//   const handleMouseUp = (event: MouseEvent<HTMLInputElement>) => {
//     setSeekTime(-1);
//     const value = parseFloat(event.currentTarget.value);
//     updateCurrentSecond(value);
//     audioPlayer.current.currentTime = value;
//   };

//   return (
//     <div className={styles.container}>
//       <h1 className={styles.title}>{currentSermon.title}</h1>
//       <div className={styles['vertical-container']}>
//         <div className={styles['controls-container']}>
//           <Replay30Icon onClick={rewind30Seconds} />
//           {playing ? (
//             <PauseCircleIcon onClick={() => togglePlaying()} />
//           ) : (
//             <PlayCircleIcon onClick={() => togglePlaying()} />
//           )}
//           <Forward30Icon onClick={forward30Seconds} />
//         </div>
//         <div className={styles['progress-container']}>
//           {/* TODO: Scroll overflow text */}
//           <span className={styles['current-time']}>{formatTime(seekTime >= 0 ? seekTime : currentSecond)}</span>
//           <label htmlFor="audio-slider" className={styles['audio-slider-label']}>
//             <input
//               className={styles.slider}
//               type="range"
//               min="1"
//               step={1}
//               max={currentSermon.durationSeconds}
//               value={seekTime >= 0 ? seekTime : currentSecond}
//               id="myRange"
//               onInput={handleSliderScrub}
//               onMouseUp={handleMouseUp}
//             ></input>
//           </label>
//           <audio
//             ref={audioPlayer}
//             src={currentSermon.url ? sanitize(currentSermon.url) : undefined}
//             onTimeUpdate={onPlaying}
//             onEnded={() => togglePlaying(false)}
//           ></audio>
//           <span className={styles.duration}>{formatTime(currentSermon.durationSeconds)}</span>
//         </div>
//       </div>
//     </div>
//   );
// };
