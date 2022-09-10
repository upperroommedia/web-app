/**
 * BottomAudioBar is a component that displays the audio player similar to Spotify's bottom play bar
 */
// import Image from 'next/image';
import {
  ChangeEvent,
  FunctionComponent,
  MouseEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import { formatTime } from '../utils/audioUtils';
import styles from '../styles/BottomAudioBar.module.css';
import {
  SkipNext,
  SkipPrevious,
  PlayCircle,
  PauseCircle,
  Replay30,
  Forward30,
} from '@mui/icons-material';
import { getDownloadURL, ref } from 'firebase/storage';
import { storage } from '../firebase/firebase';

const BottomAudioBar: FunctionComponent = () => {
  const {
    currentSermon,
    playing,
    togglePlaying,
    currentSecond,
    updateCurrentSecond,
    setCurrentSermonUrl,
    previousSermon,
    nextSermon,
    sermonEnded,
  } = useAudioPlayer();
  const audioPlayer = useRef<HTMLAudioElement>(new Audio());
  const [seekTime, setSeekTime] = useState(-1);

  // will fire when global play state changes
  useEffect(() => {
    if (currentSermon.url == null) {
      getDownloadURL(ref(storage, `sermons/${currentSermon.key}`))
        .then((url) => {
          setCurrentSermonUrl(url);
        })
        .catch((error) => {
          console.log(error);
        });
    }
    if (playing && currentSermon.url) {
      audioPlayer.current.currentTime = currentSecond;
      audioPlayer.current.play();
    } else if (!playing && audioPlayer.current) {
      audioPlayer.current.pause();
    }
  }, [currentSermon.url, playing]);

  const onPlaying = () => {
    const newSecond = Math.floor(audioPlayer.current.currentTime);
    if (
      audioPlayer.current.src === currentSermon.url &&
      newSecond !== currentSecond
    ) {
      updateCurrentSecond(newSecond);
    }
  };

  const rewind30Seconds = () => {
    audioPlayer.current.currentTime = Math.max(
      audioPlayer.current.currentTime - 30,
      0
    );
  };

  const forward30Seconds = () => {
    audioPlayer.current.currentTime = Math.min(
      audioPlayer.current.currentTime + 30,
      currentSermon.durationSeconds
    );
  };

  function handleSliderScrub(event: ChangeEvent<HTMLInputElement>): void {
    const value = parseFloat(event.target.value);
    setSeekTime(value);
  }
  const handleMouseUp = (event: MouseEvent<HTMLInputElement>) => {
    setSeekTime(-1);
    const value = parseFloat(event.currentTarget.value);
    updateCurrentSecond(value);
    audioPlayer.current.currentTime = value;
  };

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>{currentSermon.title}</h1>
      <div className={styles['vertical-container']}>
        <div className={styles['controls-container']}>
          <Replay30 onClick={rewind30Seconds} />
          <SkipPrevious onClick={previousSermon} />
          {playing ? (
            <PauseCircle onClick={() => togglePlaying()} />
          ) : (
            <PlayCircle onClick={() => togglePlaying()} />
          )}
          <SkipNext onClick={nextSermon} />
          <Forward30 onClick={forward30Seconds} />
        </div>
        <div className={styles['progress-container']}>
          {/* TODO: Scroll overflow text */}
          <h4 className={styles['current-time']}>
            {formatTime(seekTime >= 0 ? seekTime : currentSecond)}
          </h4>
          <input
            className={styles.slider}
            type="range"
            min="1"
            step={1}
            max={currentSermon.durationSeconds}
            value={seekTime >= 0 ? seekTime : currentSecond}
            id="myRange"
            onInput={handleSliderScrub}
            onMouseUp={handleMouseUp}
          ></input>
          <audio
            ref={audioPlayer}
            src={currentSermon.url}
            onTimeUpdate={onPlaying}
            onEnded={sermonEnded}
          ></audio>
          <h4 className={styles.duration}>
            {formatTime(currentSermon.durationSeconds)}
          </h4>
        </div>
      </div>
    </div>
  );
};

export default BottomAudioBar;
