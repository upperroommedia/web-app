import type { ChildProcess } from 'node:child_process';

export class CancelToken {
  private shouldCancel = false;
  private readonly abortController = new AbortController();
  private readonly processes = new Map<ChildProcess, Promise<void>>();
  private readonly listeners = new Set<() => void>();

  cancel = () => {
    if (this.shouldCancel) return;
    this.shouldCancel = true;
    this.abortController.abort(new Error('Media operation cancelled'));
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A failed signal never becomes a CLOSE receipt; continue cancelling
        // the other owned children and retain waitForProcesses() fencing.
      }
    }
  };

  /** Native cancellation remains active even when a provider produces no output. */
  trackProcess(process: ChildProcess): void {
    if (this.processes.has(process)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      try {
        process.kill('SIGTERM');
      } catch {
        /* Still attempt escalation; only CLOSE settles ownership. */
      }
      timer = setTimeout(() => {
        try {
          process.kill('SIGKILL');
        } catch {
          /* Wait for original CLOSE; never infer death. */
        }
      }, 5000);
      timer.unref();
    };
    this.listeners.add(abort);
    const closed = new Promise<void>((resolve) => {
      process.once('close', () => {
        if (timer) clearTimeout(timer);
        this.listeners.delete(abort);
        this.processes.delete(process);
        resolve();
      });
    });
    this.processes.set(process, closed);
    if (this.shouldCancel) abort();
  }

  async waitForProcesses(): Promise<void> {
    await Promise.all([...this.processes.values()]);
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get isCancellationRequested() {
    return this.shouldCancel;
  }
}
