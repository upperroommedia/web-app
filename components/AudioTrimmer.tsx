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

interface AudioTrimmerProps {
  url: string;
  duration: number;
  setDuration: React.Dispatch<SetStateAction<number>>;
}
// TODO: Seperate into components
// TODO: Impelement loop which will make playhead stay between start and end trim
// TODO: THIS ENTIRE FILE NEEDS TO BE REFACTORED

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
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [startTrim, setStartTrim, startTrimRef] = useStateRef<number>(0);
  const [stopTrim, setStopTrim, stopTrimRef] = useStateRef<number>(duration);
  const isScrubbingRef = useRef<boolean>(false);
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
    // TODO(1): See why this doesn't update properly on phone
    const currentTime = audioPlayer.current.currentTime;
    if (!isScrubbingRef.current && currentTime >= stopTrimRef.current) {
      audioPlayer.current.currentTime = startTrimRef.current;
      audioPlayer.current.pause();
    }
    setCurrentTime(currentTime);
  };
  const handleComplete = () => {
    setIsPlaying(!audioPlayer.current.paused);
  };

  const handleMouseUp = () => {
    isScrubbingRef.current = false;
  };

  const handleMove = (e: MouseEvent | TouchEvent) => {
    if (scrubberContainer.current && isScrubbingRef.current) {
      let event: MouseEvent | Touch;
      if ('touches' in e) {
        event = e.touches[0];
      } else {
        event = e;
      }
      let time = calculateTimeFromPosition(event.pageX, scrubberContainer.current);
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
      audioPlayer.current.currentTime = time;
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
    addEventListener('touchmove', (event) => {
      handleMove(event);
    });
    addEventListener('mousemove', (event) => {
      handleMove(event);
    });
    addEventListener('mouseup', handleMouseUp);

    // TODO: Ensure that this cleanup is all that is required for audio
    return () => {
      audioPlayer.current.removeEventListener('loadedmetadata', handleMetaDataLoaded);
      audioPlayer.current.removeEventListener('play', handlePlay);
      audioPlayer.current.removeEventListener('pause', handlePause);
      audioPlayer.current.removeEventListener('timeupdate', handleTimeUpdate);
      audioPlayer.current.removeEventListener('ended', handleComplete);
      removeEventListener('touchmove', (event) => {
        handleMove(event);
      });
      removeEventListener('mousemove', (event) => {
        handleMove(event);
      });
      removeEventListener('mouseup', handleMouseUp);
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
    audioPlayer.current.currentTime = stopTrim;
  };

  const MouseDown = (e: React.MouseEvent | React.TouchEvent, target: CLICK_TARGET) => {
    isScrubbingRef.current = true;
    let event: React.MouseEvent | Touch;
    if ('touches' in e) {
      event = e.touches[0];
    } else {
      event = e;
    }

    let time = calculateTimeFromPosition(event.pageX, scrubberContainer!.current!);
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
    audioPlayer.current.currentTime = time;
    if (!audioPlayer.current.paused) {
      audioPlayer.current.pause();
    }

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
  return (
    <div className={styles.outer_container}>
      <div className={styles.scrubber_container}>
        <div
          onTouchStart={(e) => MouseDown(e, CLICK_TARGET.SCRUBBER)}
          onMouseDown={(e) => {
            MouseDown(e, CLICK_TARGET.SCRUBBER);
          }}
        >
          <div ref={scrubberContainer} className={styles.audio_container}>
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
            <div
              className={styles.trim_area}
              style={{
                left: calculateTimePercentage(startTrim),
                right: calculateTimePercentage(stopTrim, true),
              }}
            >
              <div
                className={`${styles.handle} ${styles.left_handle}`}
                onTouchStart={(e) => MouseDown(e, CLICK_TARGET.START_TRIM)}
                onMouseDown={(e) => {
                  MouseDown(e, CLICK_TARGET.START_TRIM);
                }}
              ></div>
              <div
                className={`${styles.handle} ${styles.right_handle}`}
                onTouchStart={(e) => MouseDown(e, CLICK_TARGET.END_TRIM)}
                onMouseDown={(e) => {
                  MouseDown(e, CLICK_TARGET.END_TRIM);
                }}
              ></div>
            </div>
          </div>
        </div>
      </div>
      {/* TODO: Style this better */}
      <div className={styles.button_container}>
        <button type="button" onClick={rewindToStart}>
          Rewind
        </button>
        <button type="button" onClick={togglePlayPause}>
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        <button type="button" onClick={forwardToEnd}>
          Forward
        </button>
      </div>
      <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
        {/* start time */}
        <div>Trim Start: {calculateTime(startTrim)}</div>
        {/* end time */}
        <div>Trim Stop: {calculateTime(stopTrim)}</div>
      </div>
    </div>
  );
};

export default AudioTrimmer;
