type PlayableMediaElement = {
  play: () => Promise<void> | void;
};

export type MediaPlayFailureHandler = (error: unknown) => void;

interface WaveformAudioDataInput {
  url: string;
  blob?: Blob;
  signal?: AbortSignal;
}

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

export async function readWaveformAudioData({ url, blob, signal }: WaveformAudioDataInput): Promise<ArrayBuffer> {
  if (blob) {
    return blob.arrayBuffer();
  }

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error('Failed to fetch audio');
  }
  return response.arrayBuffer();
}

export function logWaveformPreviewFailure(error: unknown): void {
  if (process.env.NODE_ENV !== 'production') {
    console.warn('Unable to render audio waveform preview:', error);
  }
}
