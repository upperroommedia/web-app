export interface TrimmerPlayerSnapshot {
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  paused: boolean;
  buffering: boolean;
  muted: boolean;
  ready: boolean;
  ended: boolean;
}

export interface SeekOptions {
  allowSeekAhead?: boolean;
}

export type TrimmerPlayerSnapshotListener = (snapshot: TrimmerPlayerSnapshot) => void;
export type TrimmerPlayerErrorListener = (message: string) => void;

export interface TrimmerPlayerAdapter {
  load(videoId: string, startTimeSeconds?: number): Promise<void>;
  play(): void;
  pause(): void;
  seek(time: number, options?: SeekOptions): void;
  setMuted(muted: boolean): void;
  subscribe(listener: TrimmerPlayerSnapshotListener): () => void;
  onError(listener: TrimmerPlayerErrorListener): () => void;
  destroy(): void;
}
