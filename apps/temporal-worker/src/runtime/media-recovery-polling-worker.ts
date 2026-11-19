import { Worker, type WorkerOptions } from '@temporalio/worker';

/** SDK 1.24 disposes an initialized Worker only through run(). Keep diagnostic
 * cleanup from making an initial native poll if authorization never opened. */
export class MediaRecoveryPollingWorker extends Worker {
  private allowed?: () => boolean;

  static async create(options: WorkerOptions): Promise<MediaRecoveryPollingWorker> {
    const worker = await super.create(options);
    if (!(worker instanceof MediaRecoveryPollingWorker)) throw new Error('MEDIA_RECOVERY_POLL_GATE_UNCONFIRMED');
    return worker;
  }

  allowPolling(allowed: () => boolean): void {
    this.allowed = allowed;
  }

  protected override pollLoop$<T>(poll: () => Promise<T>) {
    return super.pollLoop$(async () => {
      if (!this.allowed?.() && this.getState() === 'RUNNING') this.shutdown();
      // Core must consume its shutdown notifications to finish releasing the
      // worker. Native polling enters Core only after shutdown was initiated.
      return poll();
    });
  }
}
