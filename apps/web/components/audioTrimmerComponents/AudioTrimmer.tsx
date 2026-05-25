// An audio trimmer component that allows the user to trim audio files.
// Uses the shared trimmer components for consistent UI and state management.
import { FunctionComponent, SetStateAction, useEffect, useMemo, useRef, Dispatch, useCallback, useState } from 'react';
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
  audioBlob?: Blob;
  trimStart: number;
  trimDuration?: number;
  setTrimStart: (trimStartTime: number) => void;
  setTrimDuration: (durationSeconds: number) => void;
  setHasTrimmed?: Dispatch<SetStateAction<boolean>>;
}

const AudioTrimmer: FunctionComponent<AudioTrimmerProps> = ({
  url,
  audioBlob,
  trimStart,
  trimDuration,
  setTrimStart,
  setTrimDuration,
  setHasTrimmed,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [mediaStatus, setMediaStatus] = useState<{ url: string; status: 'ready' | 'error' } | null>(null);
  const [savedTrimStart] = useState(() => trimStart);
  const [savedTrimEnd] = useState(() => (trimDuration && trimDuration > 0 ? trimStart + trimDuration : undefined));
  const isMediaPlayable = mediaStatus?.url === url && mediaStatus.status === 'ready';

  // Initialize audio element
  useEffect(() => {
    const audio = new Audio(url);
    audio.preload = 'metadata';
    audioRef.current = audio;

    const handleMediaReady = () => {
      setMediaStatus({ url, status: audio.error ? 'error' : 'ready' });
    };
    const handleMediaError = () => {
      setMediaStatus({ url, status: 'error' });
    };

    audio.addEventListener('loadedmetadata', handleMediaReady);
    audio.addEventListener('canplay', handleMediaReady);
    audio.addEventListener('error', handleMediaError);

    return () => {
      audio.removeEventListener('loadedmetadata', handleMediaReady);
      audio.removeEventListener('canplay', handleMediaReady);
      audio.removeEventListener('error', handleMediaError);
      audio.pause();
      if (audioRef.current === audio) {
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
    () => <AudioWaveform url={url} audioBlob={audioBlob} height={80} />,
    [url, audioBlob]
  );

  return (
    <Stack spacing={2} sx={{ width: '100%', py: 2 }}>
      {/* Timeline with waveform */}
      <TrimmerTimeline onSeek={handleSeek} height={80} backgroundElement={waveformElement} />

      {/* Controls and Time Inputs */}
      <Stack spacing={2} sx={{ display: { xs: 'flex', sm: 'none' } }}>
        <Stack direction="row" spacing={2} alignItems="stretch" justifyContent="space-between">
          <EditableTimeInput type="start" label="Trim Start" resetValue={savedTrimStart} />
          <EditableTimeInput type="end" label="Trim End" resetValue={savedTrimEnd} />
        </Stack>
        <Stack direction="row" alignItems="center" justifyContent="center">
          <TrimmerControls onPlayPause={togglePlayPause} onSeek={handleSeek} disabled={!isMediaPlayable} />
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
        <TrimmerControls onPlayPause={togglePlayPause} onSeek={handleSeek} disabled={!isMediaPlayable} />
        <EditableTimeInput type="end" label="Trim End" resetValue={savedTrimEnd} />
      </Stack>
    </Stack>
  );
};

export default AudioTrimmer;
