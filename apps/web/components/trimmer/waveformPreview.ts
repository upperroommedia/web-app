import { WAVEFORM_BUDGET, type WaveformPreview } from './waveformPcm';

export interface PreviewWorker {
  onmessage: Worker['onmessage'];
  onerror: Worker['onerror'];
  postMessage(value: { blob: Blob; duration: number }): void;
  terminate(): void;
}
type Observer = (result: WaveformPreview) => void;
/** One bounded worker, no source buffers in the cache, and source identity never depends on canvas width. */
export class WaveformPreviewService {
  private identities = new WeakMap<Blob, number>();
  private identity = 0;
  private cache = new Map<string, WaveformPreview>();
  private active?: {
    key: string;
    worker: PreviewWorker;
    observers: Set<Observer>;
    timer: ReturnType<typeof setTimeout>;
  };

  observe(blob: Blob, duration: number, createWorker: () => PreviewWorker, observer: Observer): () => void {
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > WAVEFORM_BUDGET.durationSeconds ||
      blob.size > WAVEFORM_BUDGET.inputBytes
    ) {
      observer({ status: 'unavailable', reason: 'budget' });
      return () => undefined;
    }
    let identity = this.identities.get(blob);
    if (!identity) {
      identity = ++this.identity;
      this.identities.set(blob, identity);
    }
    const key = `${identity}:${duration}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      observer(cached);
      return () => undefined;
    }
    if (this.active && this.active.key !== key) this.finish({ status: 'unavailable', reason: 'cancelled' }, false);
    if (!this.active) {
      let worker: PreviewWorker;
      try {
        worker = createWorker();
      } catch {
        observer({ status: 'unavailable', reason: 'format' });
        return () => undefined;
      }
      const current = {
        key,
        worker,
        observers: new Set<Observer>(),
        timer: setTimeout(() => {
          if (this.active === current) this.finish({ status: 'unavailable', reason: 'budget' });
        }, WAVEFORM_BUDGET.elapsedMs + 1000),
      };
      this.active = current;
      worker.onmessage = ({ data }: MessageEvent<WaveformPreview>) => {
        if (this.active !== current) return;
        if (
          data?.status === 'ready' &&
          data.peaks instanceof Float32Array &&
          data.peaks.length === WAVEFORM_BUDGET.peaks &&
          data.peaks.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
        )
          this.finish(data);
        else this.finish({ status: 'unavailable', reason: 'format' });
      };
      worker.onerror = () => {
        if (this.active === current) this.finish({ status: 'unavailable', reason: 'format' });
      };
      current.observers.add(observer);
      try {
        worker.postMessage({ blob, duration });
      } catch {
        this.finish({ status: 'unavailable', reason: 'format' });
      }
    } else this.active.observers.add(observer);
    const current = this.active;
    return () => {
      current?.observers.delete(observer);
      if (current && this.active === current && current.observers.size === 0)
        this.finish({ status: 'unavailable', reason: 'cancelled' }, false);
    };
  }

  private finish(result: WaveformPreview, retain = true): void {
    const current = this.active;
    if (!current) return;
    this.active = undefined;
    clearTimeout(current.timer);
    current.worker.onmessage = null;
    current.worker.onerror = null;
    current.worker.terminate();
    if (retain) {
      this.cache.set(current.key, result);
      if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
    }
    current.observers.forEach((notify) => notify(result));
    current.observers.clear();
  }
}
export const waveformPreviewService = new WaveformPreviewService();
