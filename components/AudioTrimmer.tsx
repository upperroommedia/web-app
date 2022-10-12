// An audio trimmer component that allows the user to trim audio files.
// Specifically, it allows the user to select a start and stop timestamp for the audio file.
// The start timestamp is the time is used in the backend to actually trim the file
import {
  FunctionComponent,
  Touch,
  SetStateAction,
  useEffect,
  useRef,
  useState,
  Dispatch,
  MutableRefObject,
} from 'react';
import styles from '../styles/AudioTrimmer.module.css';
import classNames from 'classnames';
import SkipNext from '@mui/icons-material/SkipNext';
import SkipPrevious from '@mui/icons-material/SkipPrevious';
import PlayCircle from '@mui/icons-material/PlayCircle';
import PauseCircle from '@mui/icons-material/PauseCircle';

interface AudioTrimmerProps {
  url: string;
  duration: number;
  setDuration: React.Dispatch<SetStateAction<number>>;
}

enum CLICK_TARGET {
  'SCRUBBER',
  'START_TRIM',
  'END_TRIM',
}

let clickTarget = CLICK_TARGET.SCRUBBER;

function useStateRef<T>(initialValue: T): [T, Dispatch<SetStateAction<T>>, MutableRefObject<T>] {
  const [value, setValue] = useState(initialValue);
  const ref = useRef(value);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return [value, setValue, ref];
}
const AudioTrimmer: FunctionComponent<AudioTrimmerProps> = ({ url, duration, setDuration }) => {
  const [currentTime, setCurrentTime, currentTimeRef] = useStateRef<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [startTrim, setStartTrim, startTrimRef] = useStateRef<number>(0);
  const [stopTrim, setStopTrim, stopTrimRef] = useStateRef<number>(duration);
  const previousPlayingStateRef = useRef<boolean>(false);
  const isScrubbingRef = useRef<boolean>(false);
  const clickOffsetRef = useRef<number>(0);
  const audioPlayer = useRef<HTMLAudioElement>(new Audio(url)); // reference for our audio component
  const scrubberContainer = useRef<HTMLDivElement>(null);

  const handleMetaDataLoaded = () => {
    setStopTrim(audioPlayer.current.duration);
    setDuration(audioPlayer.current.duration);
  };

  const handlePlay = () => {
    setIsPlaying(true);
  };

  const handlePause = () => {
    setIsPlaying(false);
  };

  const handleTimeUpdate = () => {
    if (isScrubbingRef.current) return;
    const currentTime = audioPlayer.current.currentTime;
    if (currentTime >= stopTrimRef.current) {
      audioPlayer.current.currentTime = startTrimRef.current;
      audioPlayer.current.pause();
    }
    setCurrentTime(currentTime);
  };

  const handleComplete = () => {
    setIsPlaying(!audioPlayer.current.paused);
  };

  const handleMouseUp = () => {
    if (previousPlayingStateRef.current) {
      audioPlayer.current.play();
    }
    isScrubbingRef.current = false;
    audioPlayer.current.currentTime = currentTimeRef.current;
  };

  const handleMove = (e: MouseEvent | TouchEvent) => {
    if (scrubberContainer.current && isScrubbingRef.current) {
      let event: MouseEvent | Touch;
      if ('touches' in e) {
        event = e.touches[0];
      } else {
        event = e;
      }
      let time = calculateTimeFromPosition(event.pageX - clickOffsetRef.current, scrubberContainer.current);
      if (clickTarget === CLICK_TARGET.START_TRIM) {
        time = time < stopTrimRef.current ? time : stopTrimRef.current;
        setStartTrim(time);
      } else if (clickTarget === CLICK_TARGET.END_TRIM) {
        time = time > startTrimRef.current ? time : startTrimRef.current;
        setStopTrim(time);
        time = time - 5;
        time = time > startTrimRef.current ? time : startTrimRef.current;
      }
      if (time > stopTrimRef.current) {
        setStopTrim(time);
      } else if (time < startTrimRef.current) {
        setStartTrim(time);
      }
      // audioPlayer.current.currentTime = time;
      setCurrentTime(time);
      e.stopPropagation();
      e.preventDefault();
    }
  };

  useEffect(() => {
    audioPlayer.current.addEventListener('loadedmetadata', handleMetaDataLoaded);
    audioPlayer.current.addEventListener('play', handlePlay);
    audioPlayer.current.addEventListener('pause', handlePause);
    audioPlayer.current.addEventListener('timeupdate', handleTimeUpdate);
    audioPlayer.current.addEventListener('ended', handleComplete);
    addEventListener('touchmove', handleMove);
    addEventListener('mousemove', handleMove);
    addEventListener('mouseup', handleMouseUp);
    addEventListener('touchend', handleMouseUp);

    return () => {
      audioPlayer.current.removeEventListener('loadedmetadata', handleMetaDataLoaded);
      audioPlayer.current.removeEventListener('play', handlePlay);
      audioPlayer.current.removeEventListener('pause', handlePause);
      audioPlayer.current.removeEventListener('timeupdate', handleTimeUpdate);
      audioPlayer.current.removeEventListener('ended', handleComplete);
      removeEventListener('touchmove', handleMove);
      removeEventListener('mousemove', handleMove);
      removeEventListener('mouseup', handleMouseUp);
      removeEventListener('touchend', handleMouseUp);
      audioPlayer.current.pause();
    };
  }, []);

  const calculateTime = (sec: number) => {
    const hours: number = Math.floor(sec / 3600); // get hours
    const minutes: number = Math.floor((sec - hours * 3600) / 60); // get minutes
    const seconds: number = Math.floor(sec - hours * 3600 - minutes * 60); //  get seconds
    return (hours > 0 ? hours + ':' : '') + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0'); // Return is HH : MM : SS
  };

  const togglePlayPause = () => {
    if (audioPlayer.current.paused) {
      audioPlayer.current.play();
    } else {
      audioPlayer.current.pause();
    }
  };

  const rewindToStart = () => {
    audioPlayer.current.currentTime = startTrim;
  };

  const forwardToEnd = () => {
    audioPlayer.current.currentTime = stopTrim - 5 > 0 ? stopTrim - 5 : 0;
  };

  const MouseDown = (e: React.MouseEvent | React.TouchEvent, target: CLICK_TARGET) => {
    previousPlayingStateRef.current = !audioPlayer.current.paused;
    if (!audioPlayer.current.paused) {
      audioPlayer.current.pause();
    }
    isScrubbingRef.current = true;
    let event: React.MouseEvent | Touch;
    if ('touches' in e) {
      event = e.touches[0];
    } else {
      event = e;
    }
    if (target === CLICK_TARGET.START_TRIM || target === CLICK_TARGET.END_TRIM) {
      clickOffsetRef.current = event.clientX - e.currentTarget.getBoundingClientRect().left;
    } else {
      clickOffsetRef.current = 0;
    }
    let time = calculateTimeFromPosition(event.pageX - clickOffsetRef.current, scrubberContainer!.current!);
    if (target === CLICK_TARGET.SCRUBBER) {
      time > stopTrim
        ? (target = CLICK_TARGET.END_TRIM)
        : time < startTrim
        ? (target = CLICK_TARGET.START_TRIM)
        : (target = CLICK_TARGET.SCRUBBER);
    }
    clickTarget = target;

    if (clickTarget === CLICK_TARGET.START_TRIM) {
      setStartTrim(time);
    } else if (clickTarget === CLICK_TARGET.END_TRIM) {
      setStopTrim(time);
      time = time - 5;
      time = time > startTrim ? time : startTrim;
    }
    setCurrentTime(time);

    e.stopPropagation();
    e.preventDefault();
  };

  const calculateTimeFromPosition = (mousePageX: number, container: HTMLDivElement) => {
    const duration = audioPlayer.current.duration;
    let time = ((mousePageX - container.offsetLeft + 1) / container.offsetWidth) * duration;
    if (time < 0) time = 0;
    else if (time > duration) time = duration;
    return time;
  };

  const calculateTimePercentage = (currentTime: number, right = false) => {
    if (right) return `${100 - (currentTime / duration) * 100}%`;
    return `${(currentTime / duration) * 100}%`;
  };

  const RenderScrubber = () => {
    return (
      <div
        className={styles.audio_scrubber_container}
        style={{
          left: calculateTimePercentage(currentTime),
        }}
      >
        <div className={styles.audio_scrubber}>
          <div className={styles.audio_scrubber_thumb}>
            <span className={styles.audio_scrubber_text}>{calculateTime(currentTime)}</span>
          </div>
        </div>
      </div>
    );
  };

  const RenderTrimAreas = () => {
    return (
      <>
        <div
          className={classNames(styles.outside_trim_area, styles.left_container)}
          style={{ left: 0, right: calculateTimePercentage(startTrim, true) }}
        ></div>
        <div
          className={classNames(styles.outside_trim_area, styles.right_container)}
          style={{ left: calculateTimePercentage(stopTrim), right: 0 }}
        ></div>
        <div
          className={styles.trim_area}
          style={{
            left: calculateTimePercentage(startTrim),
            right: calculateTimePercentage(stopTrim, true),
          }}
        >
          <div
            className={classNames(styles.handle, styles.left_handle)}
            onTouchStart={(e) => MouseDown(e, CLICK_TARGET.START_TRIM)}
            onMouseDown={(e) => {
              MouseDown(e, CLICK_TARGET.START_TRIM);
            }}
          ></div>
          <div
            className={classNames(styles.handle, styles.right_handle)}
            onTouchStart={(e) => MouseDown(e, CLICK_TARGET.END_TRIM)}
            onMouseDown={(e) => {
              MouseDown(e, CLICK_TARGET.END_TRIM);
            }}
          ></div>
        </div>
      </>
    );
  };

  const RenderControls = () => {
    return (
      <div className={styles.button_container}>
        <SkipPrevious onClick={rewindToStart} />
        {isPlaying ? <PauseCircle onClick={togglePlayPause} /> : <PlayCircle onClick={togglePlayPause} />}
        <SkipNext onClick={forwardToEnd} />
      </div>
    );
  };

  const RenderTrimmer = ({ children }: React.ComponentProps<React.FC>) => {
    return (
      <div className={styles.scrubber_container}>
        <div
          onTouchStart={(e) => MouseDown(e, CLICK_TARGET.SCRUBBER)}
          onMouseDown={(e) => {
            MouseDown(e, CLICK_TARGET.SCRUBBER);
          }}
        >
          <div ref={scrubberContainer} className={styles.audio_container}>
            {children}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.outer_container}>
      <RenderTrimmer>
        <RenderScrubber />
        <RenderTrimAreas />
      </RenderTrimmer>
      <RenderControls />
      <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
        <div>Trim Start: {calculateTime(startTrim)}</div>
        <div>Trim Stop: {calculateTime(stopTrim)}</div>
      </div>
    </div>
  );
};

export default AudioTrimmer;
