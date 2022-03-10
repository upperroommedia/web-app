import {
  FunctionComponent,
  MouseEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import styles from '../styles/AudioTrimmer.module.css';

interface AudioTrimmerProps {
  url: string;
}
// TODO: Seperate into components
// TODO: Impelement loop which will make playhead stay between start and end trim
// TODO: Dropzone support for safari and check firefox and other browsers

const AudioTrimmer: FunctionComponent<AudioTrimmerProps> = ({ url }) => {
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [duration, setDuration] = useState<number>(0);
  const [startTrim, setStartTrim] = useState<number>(0);
  const [stopTrim, setStopTrim] = useState<number>(duration);
  const [isScrubbing, setIsScrubbing] = useState<boolean>(false);
  const [isMovingStartTrim, setIsMovingStartTrim] = useState<boolean>(false);
  const [isMovingStopTrim, setIsMovingStopTrim] = useState<boolean>(false);
  const [scrubbingTime, setScrubbingTime] = useState<number>(currentTime);
  const audioPlayer = useRef<HTMLAudioElement>(new Audio(url)); // reference for our audio component
  const scrubberContainer = useRef<HTMLDivElement>(null);

  function handleMetaDataLoaded() {
    setStopTrim(audioPlayer.current.duration);
    setDuration(audioPlayer.current.duration);
  }

  function handleTimeUpdate() {
    setCurrentTime(audioPlayer.current.currentTime);
  }
  const handleComplete = () => {
    setIsPlaying(!audioPlayer.current.paused);
  };
  useEffect(() => {
    audioPlayer.current.addEventListener(
      'loadedmetadata',
      handleMetaDataLoaded
    );

    audioPlayer.current.addEventListener('timeupdate', handleTimeUpdate);
    audioPlayer.current.addEventListener('ended', handleComplete);

    // TODO: Ensure that this cleanup is all that is required for audio
    return () => {
      audioPlayer.current.removeEventListener(
        'loadedmetadata',
        handleMetaDataLoaded
      );
      audioPlayer.current.removeEventListener('timeupdate', handleTimeUpdate);
      audioPlayer.current.removeEventListener('ended', handleComplete);
      audioPlayer.current.pause();
    };
  }, []);

  const calculateTime = (sec: number) => {
    const hours: number = Math.floor(sec / 3600); // get hours
    const minutes: number = Math.floor((sec - hours * 3600) / 60); // get minutes
    const seconds: number = Math.floor(sec - hours * 3600 - minutes * 60); //  get seconds
    return (
      (hours > 0 ? hours + ':' : '') +
      String(minutes).padStart(2, '0') +
      ':' +
      String(seconds).padStart(2, '0')
    ); // Return is HH : MM : SS
  };

  const togglePlayPause = () => {
    const prevValue = isPlaying;
    setIsPlaying(!prevValue);
    if (!prevValue) {
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
  const ScrubberContainerMouseDown = (e: MouseEvent) => {
    const time = calculateTimeFromPosition(
      e.pageX,
      scrubberContainer!.current!
    );
    audioPlayer.current.currentTime = time;
    setScrubbingTime(time);
    setIsScrubbing(true);
    if (audioPlayer.current.paused) {
      setIsPlaying(true);
      audioPlayer.current.play();
    }
    e.stopPropagation();
  };
  const StartTrimMouseDown = (e: MouseEvent) => {
    setIsMovingStartTrim(true);
    e.stopPropagation();
  };
  const StopTrimMouseDown = (e: MouseEvent) => {
    setIsMovingStopTrim(true);
    e.stopPropagation();
  };
  const MouseUp = () => {
    if (isScrubbing) setIsScrubbing(false);
    if (isMovingStartTrim) setIsMovingStartTrim(false);
    if (isMovingStopTrim) setIsMovingStopTrim(false);
  };
  const MouseMove = (e: MouseEvent) => {
    if (
      scrubberContainer.current &&
      (isScrubbing || isMovingStartTrim || isMovingStopTrim)
    ) {
      const time = calculateTimeFromPosition(
        e.pageX,
        scrubberContainer.current
      );
      if (isScrubbing) {
        setScrubbingTime(time);
        audioPlayer.current.currentTime = time;
      } else if (isMovingStartTrim) {
        setStartTrim(time < stopTrim ? time : stopTrim);
      } else if (isMovingStopTrim) {
        setStopTrim(time > startTrim ? time : startTrim);
      }
      e.stopPropagation();
    }
  };

  const calculateTimeFromPosition = (
    mousePageX: number,
    container: HTMLDivElement
  ) => {
    let time =
      ((mousePageX - container.offsetLeft + 1) / container.offsetWidth) *
      duration;
    if (time < 0) time = 0;
    else if (time > duration) time = duration;
    return time;
  };

  const calculateTimePercentage = (currentTime: number, right = false) => {
    if (right) return `${100 - (currentTime / duration) * 100}%`;
    return `${(currentTime / duration) * 100}%`;
  };
  return (
    <>
      <h1>Audio Trimmer</h1>
      <div
        style={{
          display: 'flex',
          alignItems: 'end',
          gap: '10px',
          justifyContent: 'center',
          // backgroundColor: 'blue',
        }}
        onMouseMove={(e) => MouseMove(e)}
        // TODO: Put the mouse up event on the body
        onMouseUp={MouseUp}
      >
        {/* current time */}
        <div className={styles.time_label}>{calculateTime(currentTime)}</div>
        <div
          onMouseDown={(e) => {
            ScrubberContainerMouseDown(e);
          }}
        >
          <div ref={scrubberContainer} className={styles.audio_container}>
            <div
              className={styles.audio_scrubber_container}
              style={{
                left: isScrubbing
                  ? calculateTimePercentage(scrubbingTime)
                  : calculateTimePercentage(currentTime),
              }}
            >
              <div className={styles.audio_scrubber}>
                <div className={styles.audio_scrubber_thumb}></div>
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
                className={styles.left_handle}
                onMouseDown={(e) => {
                  StartTrimMouseDown(e);
                }}
              ></div>
              <div
                className={styles.right_handle}
                onMouseDown={(e) => {
                  StopTrimMouseDown(e);
                }}
              ></div>
            </div>
          </div>
        </div>
        {/* duration */}
        <div className={styles.time_label}>{calculateTime(duration)}</div>
      </div>
      {/* <input
        type="range"
        className={styles.range}
        value={currentTime}
        step="1"
        min="0"
        max={duration}
        onChange={(e) => onScrub(e.target.value)}
        onMouseUp={onScrubEnd}
        onKeyUp={onScrubEnd}
        // style={{ background-image: url("https://audiotrimmer.com/waves/scrubbg.png")}}
        // style={{styles.range}}
      /> */}
      <div style={{ display: 'flex' }}>
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
      <div style={{ display: 'flex', gap: '10px' }}>
        {/* start time */}
        <div>Trim Start: {calculateTime(startTrim)}</div>
        {/* end time */}
        <div>Trim Stop: {calculateTime(stopTrim)}</div>
      </div>
    </>
  );
};

export default AudioTrimmer;
