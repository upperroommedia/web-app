import Slider from '@mui/material/Slider';
import { TimeSlider, VolumeSlider, useMediaRemote, useMediaState } from '@vidstack/react';
import { Dispatch, SetStateAction, SyntheticEvent, useCallback, useEffect, useRef } from 'react';
import { useStateRef } from '../audioTrimmerComponents/utils';
import { formatTime } from '../../utils/audioUtils';

export function Volume() {
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

export interface TimeSliderProps {
  thumbnails?: string;
}

export function Time({ thumbnails }: TimeSliderProps) {
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

const minDistance = 5;
interface CustomSliderProps {
  startTime: number;
  endTime: number;
  setStartTime: Dispatch<SetStateAction<number>>;
  setEndTime: Dispatch<SetStateAction<number>>;
}

export function CustomSlider({ startTime, endTime, setStartTime, setEndTime }: CustomSliderProps) {
  const time = useMediaState('currentTime');
  const duration = useMediaState('duration');
  const seeking = useMediaState('seeking');
  const remote = useMediaRemote();
  const [value, setValue, valueRef] = useStateRef([startTime, time, endTime]);
  const activeIndexRef = useRef(0);

  // Keep slider value in-sync with playback.
  useEffect(() => {
    if (seeking) return;
    if (time > valueRef.current[2]) {
      remote.pause();
      return;
    }
    setValue((previousValue) => {
      previousValue[1] = time;
      return previousValue;
    });
  }, [time, seeking, setValue, valueRef, remote]);

  useEffect(() => {
    setValue((previousValue) => {
      previousValue[2] = duration;
      return previousValue;
    });
    setEndTime(duration);
  }, [duration, setEndTime, setValue]);

  const updateValue = useCallback(
    (newValue: number[]) => {
      setValue(newValue);
      setStartTime(newValue[0]);
      setEndTime(newValue[2]);
    },
    [setValue, setStartTime, setEndTime]
  );

  const handleOnChange = useCallback(
    (e: Event, newValue: number | number[], activeIndex: number) => {
      activeIndexRef.current = activeIndex;
      if (!Array.isArray(newValue)) return;
      if (activeIndex === 0) {
        updateValue([newValue[0], newValue[0] + minDistance, newValue[2]]);
      } else if (activeIndex === 1) {
        let startTime = newValue[0];
        let newTime = newValue[1];
        let endTime = newValue[2];
        if (endTime - newTime < minDistance) {
          const clamped = Math.min(newTime, duration - minDistance);
          endTime = clamped + minDistance;
          newTime = clamped;
        } else if (newTime - startTime < minDistance) {
          const clamped = Math.max(newTime, minDistance);
          startTime = clamped - minDistance;
          newTime = clamped;
        }
        remote.seeking(newTime);

        updateValue([startTime, newTime, endTime]);
      } else if (activeIndex === 2) {
        updateValue([newValue[0], newValue[2] - minDistance, newValue[2]]);
      }
    },
    [updateValue, remote, duration]
  );

  const handleOnChangeCommitted = useCallback(
    (e: Event | SyntheticEvent<Element, Event>, value: number | number[]) => {
      if (!Array.isArray(value)) return;
      let newTime = value[1];
      if (activeIndexRef.current === 0) {
        newTime = value[0];
        updateValue([value[0], newTime, value[2]]);
      } else if (activeIndexRef.current === 2) {
        newTime = value[2] - minDistance;
        updateValue([value[0], newTime, value[2]]);
      }
      remote.seek(newTime);
      remote.play();
    },
    [remote, updateValue]
  );

  return (
    <Slider
      min={0}
      max={duration}
      value={value}
      onChange={handleOnChange}
      onChangeCommitted={handleOnChangeCommitted}
      valueLabelFormat={formatTime}
      valueLabelDisplay="on"
      disableSwap
      sx={{
        color: 'rgb(254, 148, 26)',
        height: 4,
        '& .MuiSlider-thumb': {
          color: '#fff',
          width: 8,
          height: 8,
          transition: '0.3s cubic-bezier(.47,1.64,.41,.8)',
          '&::before': {
            boxShadow: '0 2px 12px 0 rgba(0,0,0,0.4)',
          },
          '&:hover, &.Mui-focusVisible': {
            boxShadow: `0px 0px 0px 8px ${
              'rgb(255 255 255 / 16%)'
              // : 'rgb(0 0 0 / 16%)'
            }`,
          },
          '&.Mui-active': {
            width: 20,
            height: 20,
          },
        },
        '& .MuiSlider-rail': {
          opacity: 0.28,
        },
      }}
    />
  );
}
