import { logTrimmerDebug } from '@/utils/trimmerDebug';
import {
  SeekOptions,
  TrimmerPlayerAdapter,
  TrimmerPlayerErrorListener,
  TrimmerPlayerSnapshot,
  TrimmerPlayerSnapshotListener,
} from './playerAdapter';

const YOUTUBE_IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';
const YOUTUBE_IFRAME_API_SCRIPT_ID = 'youtube-iframe-api-script';
const YOUTUBE_IFRAME_API_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 200;
const PRIMING_PAUSE_DELAY_MS = 400;

interface YouTubePlayerConstructorOptions {
  videoId?: string;
  host?: string;
  playerVars?: {
    autoplay?: 0 | 1;
    controls?: 0 | 1;
    disablekb?: 0 | 1;
    enablejsapi?: 0 | 1;
    fs?: 0 | 1;
    iv_load_policy?: 1 | 3;
    origin?: string;
    playsinline?: 0 | 1;
    rel?: 0 | 1;
  };
  events?: {
    onReady?: (event: YouTubePlayerEvent) => void;
    onStateChange?: (event: YouTubePlayerEvent) => void;
    onError?: (event: YouTubePlayerEvent) => void;
  };
}

interface YouTubePlayerEvent {
  data: number;
  target: YouTubePlayerInstance;
}

interface CueVideoByIdOptions {
  videoId: string;
  startSeconds?: number;
  endSeconds?: number;
}

interface YouTubePlayerInstance {
  cueVideoById(videoId: string | CueVideoByIdOptions): void;
  destroy(): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoLoadedFraction(): number;
  isMuted(): boolean;
  mute(): void;
  pauseVideo(): void;
  playVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  unMute(): void;
}

interface YouTubeIframeApi {
  Player: new (element: HTMLElement, options: YouTubePlayerConstructorOptions) => YouTubePlayerInstance;
  PlayerState: {
    UNSTARTED: -1;
    ENDED: 0;
    PLAYING: 1;
    PAUSED: 2;
    BUFFERING: 3;
    CUED: 5;
  };
}

declare global {
  interface Window {
    YT?: YouTubeIframeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youtubeApiPromise: Promise<YouTubeIframeApi> | null = null;

function loadYouTubeIframeApi(): Promise<YouTubeIframeApi> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('YouTube iframe API is only available in the browser'));
  }

  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  if (youtubeApiPromise) {
    return youtubeApiPromise;
  }

  youtubeApiPromise = new Promise<YouTubeIframeApi>((resolve, reject) => {
    const existingScript = document.getElementById(YOUTUBE_IFRAME_API_SCRIPT_ID) as HTMLScriptElement | null;
    let timeoutId = -1;
    let readyPollId = -1;
    let settled = false;
    let scriptForCleanup: HTMLScriptElement | null = null;

    const cleanup = () => {
      if (timeoutId !== -1) {
        window.clearTimeout(timeoutId);
      }
      if (readyPollId !== -1) {
        window.clearInterval(readyPollId);
      }
      if (scriptForCleanup) {
        scriptForCleanup.removeEventListener('error', onScriptError);
      }
    };

    const resolveWhenReady = () => {
      if (settled || !window.YT?.Player) {
        return;
      }
      settled = true;
      cleanup();
      resolve(window.YT);
    };

    const rejectWith = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      youtubeApiPromise = null;
      reject(error);
    };

    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      resolveWhenReady();
    };

    const onScriptError = () => {
      rejectWith(new Error('Failed to load YouTube iframe API script'));
    };

    if (window.YT?.Player) {
      resolveWhenReady();
      return;
    }

    if (!existingScript) {
      const script = document.createElement('script');
      script.id = YOUTUBE_IFRAME_API_SCRIPT_ID;
      script.src = YOUTUBE_IFRAME_API_SRC;
      script.async = true;
      script.addEventListener('error', onScriptError, { once: true });
      scriptForCleanup = script;
      document.head.appendChild(script);
    } else {
      existingScript.addEventListener('error', onScriptError, { once: true });
      scriptForCleanup = existingScript;
    }

    readyPollId = window.setInterval(() => {
      resolveWhenReady();
    }, 100);

    timeoutId = window.setTimeout(() => {
      rejectWith(new Error('Timed out while waiting for YouTube iframe API'));
    }, YOUTUBE_IFRAME_API_TIMEOUT_MS);
  });

  return youtubeApiPromise;
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function hasMeaningfulSnapshotDiff(prev: TrimmerPlayerSnapshot | null, next: TrimmerPlayerSnapshot): boolean {
  if (!prev) return true;

  return (
    Math.abs(prev.currentTime - next.currentTime) > 0.05 ||
    Math.abs(prev.duration - next.duration) > 0.05 ||
    Math.abs(prev.bufferedEnd - next.bufferedEnd) > 0.1 ||
    prev.paused !== next.paused ||
    prev.buffering !== next.buffering ||
    prev.muted !== next.muted ||
    prev.ready !== next.ready ||
    prev.ended !== next.ended
  );
}

export class YouTubeIframeAdapter implements TrimmerPlayerAdapter {
  private readonly container: HTMLElement;
  private readonly snapshotListeners = new Set<TrimmerPlayerSnapshotListener>();
  private readonly errorListeners = new Set<TrimmerPlayerErrorListener>();

  private api: YouTubeIframeApi | null = null;
  private player: YouTubePlayerInstance | null = null;
  private pollId: number | null = null;
  private primePauseTimer: number | null = null;
  private restoreMuteAfterPrime = false;
  private lastSnapshot: TrimmerPlayerSnapshot | null = null;
  private isIframeReady = false;
  private isVideoReady = false;
  private pendingVideoId: string | null = null;
  private pendingStartSeconds = 0;
  private destroyed = false;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  subscribe(listener: TrimmerPlayerSnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    if (this.lastSnapshot) {
      listener(this.lastSnapshot);
    }

    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  onError(listener: TrimmerPlayerErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  async load(videoId: string, startTimeSeconds = 0): Promise<void> {
    this.destroyed = false;
    this.pendingVideoId = videoId;
    this.pendingStartSeconds = Math.max(0, startTimeSeconds);
    this.isVideoReady = false;

    try {
      await this.ensurePlayer();
      if (this.destroyed || !this.player) return;

      if (this.isIframeReady) {
        this.cueVideo(videoId);
      } else {
        this.emitSnapshot(true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitError(message);
    }
  }

  play(): void {
    try {
      this.cancelPrimePlayback(false);
      this.player?.playVideo();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitError(message);
    }
  }

  pause(): void {
    try {
      this.player?.pauseVideo();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitError(message);
    }
  }

  seek(time: number, options: SeekOptions = {}): void {
    try {
      if (!this.player) return;
      const normalized = time <= 0 ? 0.01 : time;
      this.player.seekTo(normalized, options.allowSeekAhead ?? true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitError(message);
    }
  }

  setMuted(muted: boolean): void {
    try {
      if (!this.player) return;
      if (muted) this.player.mute();
      else this.player.unMute();
      this.emitSnapshot(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitError(message);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.pendingVideoId = null;
    this.stopPolling();
    this.cancelPrimePlayback(true);

    if (this.player) {
      try {
        this.player.destroy();
      } catch {
        // Best effort cleanup.
      }
    }

    this.player = null;
    this.api = null;
    this.isIframeReady = false;
    this.isVideoReady = false;
    this.lastSnapshot = null;
    this.container.replaceChildren();

    const resetSnapshot: TrimmerPlayerSnapshot = {
      currentTime: 0,
      duration: 0,
      bufferedEnd: 0,
      paused: true,
      buffering: false,
      muted: false,
      ready: false,
      ended: false,
    };

    this.emitSnapshotToListeners(resetSnapshot);
  }

  private async ensurePlayer(): Promise<void> {
    if (this.player) return;

    const api = await loadYouTubeIframeApi();
    if (this.destroyed) return;

    this.api = api;
    this.isIframeReady = false;
    this.isVideoReady = false;

    const mountNode = document.createElement('div');
    this.container.replaceChildren(mountNode);

    this.player = new api.Player(mountNode, {
      host: 'https://www.youtube-nocookie.com',
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        enablejsapi: 1,
        fs: 1,
        iv_load_policy: 3,
        origin: window.location.origin,
        playsinline: 1,
        rel: 0,
      },
      events: {
        onReady: () => {
          this.isIframeReady = true;
          const pending = this.pendingVideoId;
          if (pending) {
            this.cueVideo(pending, this.pendingStartSeconds);
          }
          this.emitSnapshot(true);
          this.startPolling();
        },
        onStateChange: (event) => {
          const unstartedState = this.api?.PlayerState.UNSTARTED ?? -1;
          if (event.data !== unstartedState && this.pendingVideoId) {
            this.isVideoReady = true;
          }
          logTrimmerDebug('youtube-iframe.state-change', {
            state: event.data,
          });
          this.emitSnapshot(true);
        },
        onError: (event) => {
          this.emitError(`YouTube player error code ${event.data}`);
        },
      },
    });

    this.startPolling();
  }

  private cueVideo(videoId: string, startSeconds = 0): void {
    if (!this.player) return;

    try {
      this.isVideoReady = false;
      this.player.cueVideoById({
        videoId,
        startSeconds: Math.max(0, startSeconds),
      });
      // Avoid synthetic startup play/pause cycles; they can briefly surface
      // transient YouTube embed error UI before the player is actually used.
      this.emitSnapshot(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitError(message);
    }
  }

  private beginPrimingPlayback(): void {
    if (!this.player) return;

    this.cancelPrimePlayback(true);

    try {
      const wasMuted = this.player.isMuted();
      this.restoreMuteAfterPrime = !wasMuted;
      if (!wasMuted) {
        this.player.mute();
      }
      this.player.playVideo();
      this.primePauseTimer = window.setTimeout(() => {
        try {
          this.player?.pauseVideo();
        } catch {
          // Best effort.
        }
        if (this.restoreMuteAfterPrime) {
          try {
            this.player?.unMute();
          } catch {
            // Best effort.
          }
        }
        this.restoreMuteAfterPrime = false;
        this.primePauseTimer = null;
      }, PRIMING_PAUSE_DELAY_MS);
    } catch {
      // Priming is best effort only.
    }
  }

  private cancelPrimePlayback(restoreMute: boolean): void {
    if (this.primePauseTimer !== null) {
      window.clearTimeout(this.primePauseTimer);
      this.primePauseTimer = null;
    }
    if (restoreMute && this.restoreMuteAfterPrime) {
      try {
        this.player?.unMute();
      } catch {
        // Best effort.
      }
    }
    this.restoreMuteAfterPrime = false;
  }

  private startPolling(): void {
    if (this.pollId !== null) return;

    this.pollId = window.setInterval(() => {
      this.emitSnapshot();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollId === null) return;
    window.clearInterval(this.pollId);
    this.pollId = null;
  }

  private emitError(message: string): void {
    logTrimmerDebug('youtube-iframe.error', { message });
    this.errorListeners.forEach((listener) => {
      listener(message);
    });
  }

  private emitSnapshot(force = false): void {
    if (!this.player) return;

    const api = this.api;
    const playingState: number = api?.PlayerState.PLAYING ?? 1;
    const endedState: number = api?.PlayerState.ENDED ?? 0;
    const bufferingState: number = api?.PlayerState.BUFFERING ?? 3;
    const cuedState: number = api?.PlayerState.CUED ?? 5;
    const unstartedState: number = api?.PlayerState.UNSTARTED ?? -1;

    let currentTime = 0;
    let duration = 0;
    let loadedFraction = 0;
    let playerState: number = api?.PlayerState.UNSTARTED ?? -1;
    let muted = false;

    try {
      currentTime = safeNumber(this.player.getCurrentTime());
      duration = safeNumber(this.player.getDuration());
      loadedFraction = clamp(safeNumber(this.player.getVideoLoadedFraction()), 0, 1);
      playerState = safeNumber(this.player.getPlayerState());
      muted = this.player.isMuted();
    } catch {
      return;
    }

    const hasLoadedVideoState =
      this.pendingVideoId !== null &&
      (this.isVideoReady || duration > 0 || playerState === cuedState || playerState > unstartedState);

    const snapshot: TrimmerPlayerSnapshot = {
      currentTime,
      duration,
      bufferedEnd: duration > 0 ? duration * loadedFraction : 0,
      paused: playerState !== playingState,
      buffering: playerState === bufferingState,
      muted,
      ready: this.isIframeReady && hasLoadedVideoState,
      ended: playerState === endedState,
    };

    if (!force && !hasMeaningfulSnapshotDiff(this.lastSnapshot, snapshot)) {
      return;
    }

    this.emitSnapshotToListeners(snapshot);
  }

  private emitSnapshotToListeners(snapshot: TrimmerPlayerSnapshot): void {
    this.lastSnapshot = snapshot;

    this.snapshotListeners.forEach((listener) => {
      listener(snapshot);
    });
  }
}
