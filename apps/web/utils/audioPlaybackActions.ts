export interface AudioPlaybackStore {
  readonly target: unknown;
  readonly state: { readonly paused: boolean; readonly duration: number };
  play: () => Promise<void>;
  pause: () => void;
  seek: (seconds: number) => Promise<number>;
}

// Video.js actions are asynchronous and are not queued before attachment. Fence
// responses by both media identity and selected source, including same-element URL changes.
export function createAudioPlaybackActions(
  player: AudioPlaybackStore,
  getSource: () => string,
  setError: (message: string | undefined) => void
) {
  const shouldIgnore = (error: unknown, target: unknown, source: string) =>
    player.target !== target || getSource() !== source || (error instanceof Error && error.name === 'AbortError');
  const play = async () => {
    setError(undefined);
    const target = player.target;
    const source = getSource();
    try {
      await player.play();
    } catch (error) {
      if (!shouldIgnore(error, target, source)) setError('Audio could not start. Select Play to try again.');
    }
  };
  const pause = () => {
    if (player.target != null) player.pause();
  };
  const togglePaused = () => {
    if (player.state.paused) void play();
    else pause();
  };
  const seek = async (seconds: number) => {
    if (player.target == null || !Number.isFinite(seconds) || !(player.state.duration > 0)) return;
    const target = player.target;
    const source = getSource();
    try {
      await player.seek(Math.max(0, Math.min(seconds, player.state.duration)));
    } catch (error) {
      if (!shouldIgnore(error, target, source)) setError('Audio could not seek. Please try again.');
    }
  };
  return { play, pause, togglePaused, seek };
}
