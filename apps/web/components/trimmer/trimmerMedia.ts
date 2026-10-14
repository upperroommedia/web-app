type PlayableMediaElement = {
  play: () => Promise<void> | void;
};

export type MediaPlayFailureHandler = (error: unknown) => void;

export function safePlayMediaElement(
  media: PlayableMediaElement | null | undefined,
  onFailure?: MediaPlayFailureHandler
): void {
  if (!media) return;

  try {
    const playResult = media.play();
    if (playResult && typeof playResult.catch === 'function') {
      void playResult.catch((error: unknown) => {
        onFailure?.(error);
      });
    }
  } catch (error) {
    onFailure?.(error);
  }
}

export function logWaveformPreviewFailure(error: unknown): void {
  if (process.env.NODE_ENV !== 'production') {
    console.warn('Unable to render audio waveform preview:', error);
  }
}
