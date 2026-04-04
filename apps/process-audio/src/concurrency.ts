type ReleaseFn = () => void;

interface Waiter {
  resolve: (release: ReleaseFn) => void;
}

export interface SemaphoreSnapshot {
  limit: number;
  active: number;
  waiting: number;
}

export class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly name: string, readonly limit: number) {
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`Semaphore ${name} requires a positive finite limit`);
    }
  }

  snapshot(): SemaphoreSnapshot {
    return {
      limit: this.limit,
      active: this.active,
      waiting: this.waiters.length,
    };
  }

  async acquire(): Promise<ReleaseFn> {
    if (this.active < this.limit) {
      this.active += 1;
      return this.createRelease();
    }

    return new Promise<ReleaseFn>((resolve) => {
      this.waiters.push({ resolve });
    });
  }

  private createRelease(): ReleaseFn {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      const next = this.waiters.shift();
      if (next) {
        next.resolve(this.createRelease());
        return;
      }

      this.active = Math.max(0, this.active - 1);
    };
  }
}

function parseConcurrencyLimit(envVarName: string, fallback: number): number {
  const raw = Number.parseInt(process.env[envVarName] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const ytDlpDownloadSemaphore = new AsyncSemaphore(
  'yt-dlp-download',
  parseConcurrencyLimit('PROCESS_AUDIO_YTDLP_DOWNLOAD_CONCURRENCY', 2)
);

export const ffmpegSemaphore = new AsyncSemaphore(
  'ffmpeg',
  parseConcurrencyLimit('PROCESS_AUDIO_FFMPEG_CONCURRENCY', 2)
);

export function getProcessAudioConcurrencyConfig(): {
  ytDlpDownload: SemaphoreSnapshot;
  ffmpeg: SemaphoreSnapshot;
} {
  return {
    ytDlpDownload: ytDlpDownloadSemaphore.snapshot(),
    ffmpeg: ffmpegSemaphore.snapshot(),
  };
}
