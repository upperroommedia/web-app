import { createContext, useCallback, useContext, useMemo, useState, useRef } from 'react';
import { usePlayer } from '@videojs/react/audio';
import { createAudioPlaybackActions } from '../../utils/audioPlaybackActions';

// Readiness/errors change rarely. Playback time stays in Video.js's selector store
// instead of invalidating the application-wide sermon context on every tick.
const PlaybackFeedback = createContext<{
  ready: boolean;
  error: string | undefined;
  setReady: (ready: boolean) => void;
  setError: (error: string | undefined) => void;
  getSource: () => string;
} | null>(null);

export function PlaybackFeedbackProvider({ children, sourceKey }: { children: React.ReactNode; sourceKey: string }) {
  const source = useRef(sourceKey);
  source.current = sourceKey;
  const getSource = useCallback(() => source.current, []);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const value = useMemo(() => ({ ready, error, setReady, setError, getSource }), [ready, error, getSource]);
  return <PlaybackFeedback.Provider value={value}>{children}</PlaybackFeedback.Provider>;
}

export function usePlaybackFeedback() {
  const feedback = useContext(PlaybackFeedback);
  if (!feedback) throw new Error('PlaybackFeedbackProvider is required');
  return feedback;
}

export function usePlaybackActions() {
  const player = usePlayer();
  const { setError, getSource } = usePlaybackFeedback();
  return useMemo(() => createAudioPlaybackActions(player, getSource, setError), [player, getSource, setError]);
}

export function usePlaybackPlaying() {
  return usePlayer((state) => !state.paused && !state.ended);
}
