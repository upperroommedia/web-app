// An audio trimmer component that allows the user to trim audio files.
// Specifically, it allows the user to select a start and stop timestamp for the audio file.
// The start timestamp is the time is used in the backend to actually trim the file
import { FunctionComponent, Touch, SetStateAction, useEffect, useRef, useState, Dispatch, useCallback } from 'react';
import OuterContainer from './OuterContainer';
import { CLICK_TARGET } from './types';
import RenderTrimmer from './RenderTrimmer';
import RenderControls from './RenderControls';
import RenderTrimAreas from './RenderTrimAreas';
import RenderScrubber from './RenderScrubber';
import { calculateTime, useStateRef, useTrimTimes } from './utils';

interface AudioTrimmerProps {
  url: string;
  trimStart: number;
  setTrimStart: Dispatch<SetStateAction<number>>;
  setTrimDuration: (durationSeconds: number) => void;
  setHasTrimmed?: Dispatch<SetStateAction<boolean>>;
}

let clickTarget = CLICK_TARGET.SCRUBBER;

const AudioTrimmer: FunctionComponent<AudioTrimmerProps> = ({
  url,
  trimStart,
  setTrimStart,
  setTrimDuration,
  setHasTrimmed,
}) => {
  const [currentTime, setCurrentTime, currentTimeRef] = useStateRef<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const trimStartRef = useRef<number>(trimStart);
  const [stopTrim, setStopTrim, stopTrimRef] = useStateRef<number>(0);
  const previousPlayingStateRef = useRef<boolean>(false);
  const isScrubbingRef = useRef<boolean>(false);
  const clickOffsetRef = useRef<number>(0);
  const audioPlayer = useRef<HTMLAudioElement>(new Audio(url)); // reference for our audio component
  const scrubberContainer = useRef<HTMLDivElement>(null);
  const { trimStartTime, trimEndTime } = useTrimTimes(trimStart, stopTrim);

  useEffect(() => {
    if (trimStartRef.current !== trimStart) {
      trimStartRef.current = trimStart;
    }
    setTrimDuration(stopTrim - trimStart);
    if (setHasTrimmed && audioPlayer.current.duration) {
      const hasTrimmed = trimStart !== 0 || stopTrim !== audioPlayer.current.duration;
      setHasTrimmed(hasTrimmed);
    }
  }, [trimStart, stopTrim, setTrimDuration, setHasTrimmed]);

  const handleMetaDataLoaded = useCallback(() => {
    setStopTrim(audioPlayer.current.duration);
    setTrimDuration(audioPlayer.current.duration);
  }, [setStopTrim, setTrimDuration]);

  const handlePlay = () => {
    setIsPlaying(true);
  };

  const handlePause = () => {
    setIsPlaying(false);
  };

  const handleTimeUpdate = useCallback(() => {
    if (isScrubbingRef.current) return;
    const newCurrentTime = audioPlayer.current.currentTime;
    if (newCurrentTime >= stopTrimRef.current) {
      if (!audioPlayer.current.paused) {
        audioPlayer.current.currentTime = trimStartRef.current;
        audioPlayer.current.pause();
        setIsPlaying(false);
      }
    } else {
      if (Math.floor(newCurrentTime) !== Math.floor(currentTimeRef.current)) {
        setCurrentTime(newCurrentTime);
      }
    }
  }, [currentTimeRef, setCurrentTime, stopTrimRef]);

  const handleComplete = useCallback(() => {
    setIsPlaying(!audioPlayer.current.paused);
  }, [setIsPlaying]);

  const handleMouseUp = useCallback(() => {
    if (previousPlayingStateRef.current) {
      audioPlayer.current.play();
    }
    isScrubbingRef.current = false;
    audioPlayer.current.currentTime = currentTimeRef.current;
  }, [currentTimeRef]);

  const calculateTimeFromPosition = useCallback((mousePageX: number, container: HTMLDivElement) => {
    const rect = container.getBoundingClientRect();
    const duration = audioPlayer.current.duration;
    let time = ((mousePageX - rect.left) / container.offsetWidth) * duration;
    if (time < 0) time = 0;
    else if (time > duration) time = duration;
    return time;
  }, []);

  const handleMove = useCallback(
    (e: MouseEvent | TouchEvent) => {
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
          setTrimStart(time);
        } else if (clickTarget === CLICK_TARGET.END_TRIM) {
          time = time > trimStartRef.current ? time : trimStartRef.current;
          setStopTrim(time);
          time = time - 5;
          time = time > trimStartRef.current ? time : trimStartRef.current;
        }
        if (time > stopTrimRef.current) {
          setStopTrim(time);
        } else if (time < trimStartRef.current) {
          setTrimStart(time);
        }
        audioPlayer.current.currentTime = time;
        setCurrentTime(time);
        e.stopPropagation();
        e.preventDefault();
      }
    },
    [
      calculateTimeFromPosition,
      setTrimStart,
      setStopTrim,
      setCurrentTime,
      scrubberContainer,
      isScrubbingRef,
      clickOffsetRef,
      stopTrimRef,
      trimStartRef,
    ]
  );
  const handleError = useCallback(() => {
    // eslint-disable-next-line no-console
    console.error('Audio error:', audioPlayer.current.error);
  }, []);

  useEffect(() => {
    audioPlayer.current.addEventListener('loadedmetadata', handleMetaDataLoaded);
    audioPlayer.current.addEventListener('play', handlePlay);
    audioPlayer.current.addEventListener('pause', handlePause);
    audioPlayer.current.addEventListener('timeupdate', handleTimeUpdate);
    audioPlayer.current.addEventListener('ended', handleComplete);
    audioPlayer.current.addEventListener('error', handleError);
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
      audioPlayer.current.removeEventListener('error', handleError);
      removeEventListener('touchmove', handleMove);
      removeEventListener('mousemove', handleMove);
      removeEventListener('mouseup', handleMouseUp);
      removeEventListener('touchend', handleMouseUp);
      audioPlayer.current.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePlayPause = useCallback(() => {
    if (audioPlayer.current.paused) {
      // eslint-disable-next-line no-console
      audioPlayer.current.play().catch((error) => console.error('play error:', error));
    } else {
      audioPlayer.current.pause();
    }
  }, []);

  const rewindToStart = useCallback(() => {
    audioPlayer.current.currentTime = trimStart;
  }, [trimStart]);

  const forwardToEnd = useCallback(() => {
    audioPlayer.current.currentTime = stopTrim - 5 > 0 ? stopTrim - 5 : 0;
  }, [stopTrim]);

  const MouseDown = useCallback(
    (e: React.MouseEvent | React.TouchEvent, target: CLICK_TARGET) => {
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
      if (target === CLICK_TARGET.START_TRIM) {
        clickOffsetRef.current = event.clientX - e.currentTarget.getBoundingClientRect().right;
      } else if (target === CLICK_TARGET.END_TRIM) {
        clickOffsetRef.current = event.clientX - e.currentTarget.getBoundingClientRect().left;
      } else {
        clickOffsetRef.current = 0;
      }

      let time = calculateTimeFromPosition(event.pageX - clickOffsetRef.current, scrubberContainer!.current!);
      if (target === CLICK_TARGET.SCRUBBER) {
        time > stopTrim
          ? (target = CLICK_TARGET.END_TRIM)
          : time < trimStart
          ? (target = CLICK_TARGET.START_TRIM)
          : (target = CLICK_TARGET.SCRUBBER);
      }
      clickTarget = target;

      if (clickTarget === CLICK_TARGET.START_TRIM) {
        setTrimStart(time);
      } else if (clickTarget === CLICK_TARGET.END_TRIM) {
        setStopTrim(time);
        time = time - 5;
        time = time > trimStart ? time : trimStart;
      }
      setCurrentTime(time);

      e.stopPropagation();
      e.preventDefault();
    },
    [setStopTrim, setTrimStart, setCurrentTime, calculateTimeFromPosition, stopTrim, trimStart]
  );

  const calculateTimePercentage = useCallback((currentTime: number, right = false) => {
    const duration = audioPlayer.current.duration;
    if (right) return `${100 - (currentTime / duration) * 100}%`;
    return `${(currentTime / duration) * 100}%`;
  }, []);

  return (
    <OuterContainer trimStartTime={trimStartTime} trimEndTime={trimEndTime}>
      <RenderTrimmer MouseDown={MouseDown} scrubberContainer={scrubberContainer}>
        <RenderScrubber
          currentTime={currentTime}
          calculateTimePercentage={calculateTimePercentage}
          calculateTime={calculateTime}
        />
        <RenderTrimAreas
          trimStart={trimStart}
          stopTrim={stopTrim}
          calculateTimePercentage={calculateTimePercentage}
          MouseDown={MouseDown}
        />
      </RenderTrimmer>
      <RenderControls
        rewindToStart={rewindToStart}
        togglePlayPause={togglePlayPause}
        forwardToEnd={forwardToEnd}
        isPlaying={isPlaying}
      />
    </OuterContainer>
  );
};

export default AudioTrimmer;
