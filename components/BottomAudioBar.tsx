/**
 * BottomAudioBar is a component that displays the audio player similar to Spotify's bottom play bar
 */
// import Image from 'next/image';
import { ChangeEvent, FunctionComponent, MouseEvent, useEffect, useRef, useState } from 'react';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import { formatTime } from '../utils/audioUtils';
import styles from '../styles/BottomAudioBar.module.css';
import Replay30Icon from '@mui/icons-material/Replay30';
import Forward30Icon from '@mui/icons-material/Forward30';
import PauseCircleIcon from '@mui/icons-material/PauseCircle';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious';
import { getDownloadURL, getStorage, ref } from 'firebase/storage';
import firebase from '../firebase/firebase';

const storage = getStorage(firebase);

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
  } = useAudioPlayer();
  const audioPlayer = useRef<HTMLAudioElement>(new Audio());
  const [seekTime, setSeekTime] = useState(-1);

  // will fire when global play state changes
  useEffect(() => {
    if (currentSermon.url == null) {
      getDownloadURL(ref(storage, `intro-outro-sermons/${currentSermon.key}`))
        .then((url) => {
          setCurrentSermonUrl(url);
        })
        .catch((error) => {
          // eslint-disable-next-line no-console
          console.log(error);
        });
    }
    if (playing && currentSermon.url) {
      audioPlayer.current.currentTime = currentSecond;
      audioPlayer.current.play();
    } else if (!playing && audioPlayer.current) {
      audioPlayer.current.pause();
    }
  }, [currentSermon?.url, playing]);

  const onPlaying = () => {
    const newSecond = Math.floor(audioPlayer.current.currentTime);
    if (audioPlayer.current.src === currentSermon.url && newSecond !== currentSecond) {
      updateCurrentSecond(newSecond);
    }
  };

  const rewind30Seconds = () => {
    audioPlayer.current.currentTime = Math.max(audioPlayer.current.currentTime - 30, 0);
  };

  const forward30Seconds = () => {
    audioPlayer.current.currentTime = Math.min(audioPlayer.current.currentTime + 30, currentSermon.durationSeconds);
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
          <Replay30Icon onClick={rewind30Seconds} />
          <SkipPreviousIcon onClick={previousSermon} />
          {playing ? (
            <PauseCircleIcon onClick={() => togglePlaying()} />
          ) : (
            <PlayCircleIcon onClick={() => togglePlaying()} />
          )}
          <SkipNextIcon onClick={nextSermon} />
          <Forward30Icon onClick={forward30Seconds} />
        </div>
        <div className={styles['progress-container']}>
          {/* TODO: Scroll overflow text */}
          <span className={styles['current-time']}>{formatTime(seekTime >= 0 ? seekTime : currentSecond)}</span>
          <label htmlFor="audio-slider" className={styles['audio-slider-label']}>
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
          </label>
          <audio ref={audioPlayer} src={currentSermon.url} onTimeUpdate={onPlaying}></audio>
          <span className={styles.duration}>{formatTime(currentSermon.durationSeconds)}</span>
        </div>
      </div>
    </div>
  );
};

const BottomAudioBarWrapper = () => {
  const { currentSermon } = useAudioPlayer();
  return <>{currentSermon && <BottomAudioBar />}</>;
};

export default BottomAudioBarWrapper;
