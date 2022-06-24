/**
 * BottomAudioBar is a component that displays the audio player similar to Spotify's bottom play bar
 */
// import Image from 'next/image';
import {
  ChangeEvent,
  FunctionComponent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { formatTime } from '../utils/audioUtils';
import styles from '../styles/BottomAudioBar.module.css';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import PauseCircleIcon from '@mui/icons-material/PauseCircle';
import { Sermon } from '../types/Sermon';
import { IconButton } from '@mui/material';

interface Props {
  sermon: Sermon;
  playRef: { index: number; isPlaying: boolean };
  url: string | undefined;
  playSermonClick: (index: number) => void;
}

const BottomAudioBar: FunctionComponent<Props> = ({
  sermon,
  playRef,
  url,
  playSermonClick,
}) => {
  const audioPlayer = useRef<HTMLAudioElement>(new Audio());
  const [currentTime, setCurrentTime] = useState(0);

  // TODO: Handle ended event
  useEffect(() => {
    audioPlayer.current.play();
  }, [url]);

  // will fire when global play state changes
  useEffect(() => {
    if (playRef.isPlaying) {
      audioPlayer.current.play();
    } else if (audioPlayer.current) {
      audioPlayer.current.pause();
    }
  }, [playRef.isPlaying]);

  const onPlaying = () => {
    setCurrentTime(audioPlayer.current.currentTime);
  };
  // TODO: Pause audio on scrub
  function handleSliderChange(event: ChangeEvent<HTMLInputElement>): void {
    const value = parseFloat(event.target.value);
    setCurrentTime(value);
    audioPlayer.current.currentTime = value;
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>{sermon.title}</h1>
      <div className={styles['vertical-container']}>
        <IconButton
          onClick={(e) => {
            e.preventDefault();
            playSermonClick(playRef.index);
          }}
        >
          {playRef.isPlaying ? <PauseCircleIcon /> : <PlayCircleIcon />}
        </IconButton>
        <div className={styles['controls-container']}>
          {/* TODO: Scroll overflow text */}
          <h4 className={styles['current-time']}>{formatTime(currentTime)}</h4>
          <input
            className={styles.slider}
            type="range"
            min="1"
            step={0.001}
            max={
              audioPlayer.current.duration ? audioPlayer.current.duration : 0
            }
            value={currentTime}
            id="myRange"
            onTimeUpdate={onPlaying}
            onChange={handleSliderChange}
          ></input>
          <audio ref={audioPlayer} src={url} onTimeUpdate={onPlaying}></audio>
          <h4 className={styles.duration}>
            {audioPlayer.current.duration
              ? formatTime(audioPlayer.current.duration)
              : formatTime(0)}
          </h4>
        </div>
      </div>
    </div>
  );
};

export default BottomAudioBar;
