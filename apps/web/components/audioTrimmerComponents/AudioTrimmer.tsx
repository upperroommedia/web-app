// An audio trimmer component that allows the user to trim audio files.
// Uses the shared trimmer components for consistent UI and state management.
import { FunctionComponent, SetStateAction, useEffect, useMemo, useRef, Dispatch, useCallback } from 'react';
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
  trimDuration?: number;
  setTrimStart: (trimStartTime: number) => void;
  setTrimDuration: (durationSeconds: number) => void;
  setHasTrimmed?: Dispatch<SetStateAction<boolean>>;
}

const AudioTrimmer: FunctionComponent<AudioTrimmerProps> = ({
  url,
  trimStart,
  trimDuration,
  setTrimStart,
  setTrimDuration,
  setHasTrimmed,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const savedTrimStartRef = useRef(trimStart);
  const savedTrimEndRef = useRef(trimDuration && trimDuration > 0 ? trimStart + trimDuration : undefined);
  const savedTrimStart = savedTrimStartRef.current;
  const savedTrimEnd = savedTrimEndRef.current;

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
  const isReady = useTrimmerStore((state) => state.isReady);
  const reset = useTrimmerStore((state) => state.reset);

  // Use the sync hook
  const { seek, togglePlayPause } = useAudioTrimmerSync(audioRef, {
    autoPauseAtEnd: true,
    initialTrimStart: savedTrimStart,
    initialTrimEnd: savedTrimEnd,
  });

  // Sync store changes to parent props
  useEffect(() => {
    if (!isReady) return;
    setTrimStart(storeTrimStart);
  }, [isReady, storeTrimStart, setTrimStart]);

  useEffect(() => {
    if (!isReady) return;
    const trimDuration = storeTrimEnd - storeTrimStart;
    if (trimDuration > 0) {
      setTrimDuration(trimDuration);
    }
  }, [isReady, storeTrimStart, storeTrimEnd, setTrimDuration]);

  // Track if user has trimmed
  useEffect(() => {
    if (setHasTrimmed && isReady && duration > 0) {
      const effectiveInitialTrimEnd = savedTrimEnd ?? duration;
      const hasTrimmed =
        Math.abs(storeTrimStart - savedTrimStart) > 0.05 || Math.abs(storeTrimEnd - effectiveInitialTrimEnd) > 0.05;
      setHasTrimmed(hasTrimmed);
    }
  }, [duration, isReady, savedTrimEnd, savedTrimStart, setHasTrimmed, storeTrimEnd, storeTrimStart]);

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

  const waveformElement = useMemo(
    () => <AudioWaveform url={url} height={80} />,
    [url]
  );

  return (
    <Stack spacing={2} sx={{ width: '100%', py: 2 }}>
      {/* Timeline with waveform */}
      <TrimmerTimeline
        onSeek={handleSeek}
        height={80}
        backgroundElement={waveformElement}
      />

      {/* Controls and Time Inputs */}
      <Stack spacing={2} sx={{ display: { xs: 'flex', sm: 'none' } }}>
        <Stack
          direction="row"
          spacing={2}
          alignItems="stretch"
          justifyContent="space-between"
        >
          <EditableTimeInput type="start" label="Trim Start" resetValue={savedTrimStart} />
          <EditableTimeInput type="end" label="Trim End" resetValue={savedTrimEnd} />
        </Stack>
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="center"
        >
          <TrimmerControls onPlayPause={togglePlayPause} onSeek={handleSeek} />
        </Stack>
      </Stack>
      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        justifyContent="space-between"
        sx={{ display: { xs: 'none', sm: 'flex' } }}
      >
        <EditableTimeInput type="start" label="Trim Start" resetValue={savedTrimStart} />
        <TrimmerControls onPlayPause={togglePlayPause} onSeek={handleSeek} />
        <EditableTimeInput type="end" label="Trim End" resetValue={savedTrimEnd} />
      </Stack>
    </Stack>
  );
};

export default AudioTrimmer;
