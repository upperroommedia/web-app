// An audio trimmer component that allows the user to trim audio files.
// Uses the shared trimmer components for consistent UI and state management.
import { FunctionComponent, SetStateAction, useEffect, useRef, Dispatch, useCallback } from 'react';
import Stack from '@mui/material/Stack';
import {
  EditableTimeInput,
  TrimmerTimeline,
  TrimmerControls,
  AudioWaveform,
  useTrimmerStore,
  useAudioTrimmerSync,
} from '../trimmer';

interface AudioTrimmerProps {
  url: string;
  trimStart: number;
  setTrimStart: (trimStartTime: number) => void;
  setTrimDuration: (durationSeconds: number) => void;
  setHasTrimmed?: Dispatch<SetStateAction<boolean>>;
}

const AudioTrimmer: FunctionComponent<AudioTrimmerProps> = ({
  url,
  trimStart: propTrimStart,
  setTrimStart,
  setTrimDuration,
  setHasTrimmed,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Initialize audio element
  useEffect(() => {
    audioRef.current = new Audio(url);
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [url]);

  // Store state
  const storeTrimStart = useTrimmerStore((state) => state.trimStart);
  const storeTrimEnd = useTrimmerStore((state) => state.trimEnd);
  const duration = useTrimmerStore((state) => state.duration);
  const reset = useTrimmerStore((state) => state.reset);

  // Use the sync hook
  const { seek, togglePlayPause } = useAudioTrimmerSync(audioRef, {
    autoPauseAtEnd: true,
  });

  // Sync store changes to parent props
  useEffect(() => {
    setTrimStart(storeTrimStart);
  }, [storeTrimStart, setTrimStart]);

  useEffect(() => {
    const trimDuration = storeTrimEnd - storeTrimStart;
    if (trimDuration > 0) {
      setTrimDuration(trimDuration);
    }
  }, [storeTrimStart, storeTrimEnd, setTrimDuration]);

  // Track if user has trimmed
  useEffect(() => {
    if (setHasTrimmed && duration > 0) {
      const hasTrimmed = storeTrimStart !== 0 || storeTrimEnd !== duration;
      setHasTrimmed(hasTrimmed);
    }
  }, [storeTrimStart, storeTrimEnd, duration, setHasTrimmed]);

  // Reset store when component unmounts
  useEffect(() => {
    return () => {
      reset();
    };
  }, [reset]);

  // Handle seek from timeline
  const handleSeek = useCallback(
    (time: number) => {
      seek(time);
    },
    [seek]
  );

  return (
    <Stack spacing={2} sx={{ width: '100%', py: 2 }}>
      {/* Timeline with waveform */}
      <TrimmerTimeline
        onSeek={handleSeek}
        height={80}
        backgroundElement={<AudioWaveform url={url} height={80} />}
      />

      {/* Controls and Time Inputs */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems="center"
        justifyContent="space-between"
      >
        <EditableTimeInput type="start" label="Trim Start" />
        <TrimmerControls onPlayPause={togglePlayPause} onSeek={handleSeek} />
        <EditableTimeInput type="end" label="Trim End" />
      </Stack>
    </Stack>
  );
};

export default AudioTrimmer;
