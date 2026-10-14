import type { AudioSource } from './uploadFile';

/** Preview URLs belong to the uploader, independently of React render/updater replay. */
export class AudioSourceOwnership {
  source: AudioSource | undefined;
  private disposed = false;
  private releaseTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>) {}

  activate(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
    this.disposed = false;
  }
  /** StrictMode replays cleanup/setup; defer disposal so the current source stays valid. */
  deactivate(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      this.disposed = true;
      this.replace(undefined);
    }, 0);
  }
  replace(next: AudioSource | undefined): AudioSource | undefined {
    if (this.disposed && next) return this.source;
    const previous = this.source;
    this.source = next;
    if (previous?.type === 'File' && (next?.type !== 'File' || next.source.preview !== previous.source.preview))
      this.urls.revokeObjectURL(previous.source.preview);
    return this.source;
  }
  select(file: File | undefined): AudioSource | undefined {
    if (!file) return this.replace(undefined);
    if (this.disposed) return this.source;
    const preview = this.urls.createObjectURL(file);
    // Register synchronously, even if React batches several selections into one render.
    return this.replace({ type: 'File', source: { file, preview, name: file.name.replace(/\.[^/.]+$/, '') } });
  }
}
