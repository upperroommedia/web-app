export interface LifecycleWorker {
  run: () => Promise<void>;
  shutdown: () => void;
  getStatus: () => { runState: string };
}
export interface LifecycleResource {
  name: string;
  close: () => Promise<unknown> | unknown;
}
export class WorkerLifecycleFailure extends Error {
  constructor(readonly stage: string, cause: unknown) {
    super(`Worker lifecycle failed at ${stage}`, { cause });
    this.name = 'WorkerLifecycleFailure';
  }
}

/** One owner for signals, rotation, run failure and finally. SDK signals must be disabled. */
export class WorkerLifecycle {
  readonly workers: LifecycleWorker[] = [];
  draining = false;
  private readonly failures: WorkerLifecycleFailure[] = [];
  private runs: Promise<void>[] | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private shutdownFailure: AggregateError | undefined;
  private markStartupComplete!: () => void;
  private readonly startupComplete = new Promise<void>((resolve) => {
    this.markStartupComplete = resolve;
  });

  constructor(
    private readonly options: {
      onDraining: () => void;
      stopDispatcher: () => Promise<void>;
      resources: LifecycleResource[];
    }
  ) {}

  isShutdownFailure(error: unknown): boolean {
    return error === this.shutdownFailure && error !== undefined;
  }

  completeStartup(): void {
    this.markStartupComplete();
  }
  fail(stage: string, error: unknown): void {
    this.failures.push(new WorkerLifecycleFailure(stage, error));
  }

  private startWorkers(): Promise<void>[] {
    if (this.runs) return this.runs;
    this.runs = this.workers.map((worker) => {
      let run: Promise<void>;
      try {
        run = worker.run();
      } catch (error) {
        run = Promise.reject(error);
      }
      return run.then(
        () => {
          this.requestShutdown();
        },
        (error) => {
          this.fail('worker.run', error);
          this.requestShutdown();
        }
      );
    });
    return this.runs;
  }

  private requestShutdown(): void {
    // This rejection is also awaited by run()/main's finally. Attach a handler
    // immediately so signal/fatal callbacks cannot produce an unhandled rejection.
    void this.shutdown().catch(() => undefined);
  }

  async run(): Promise<void> {
    if (!this.draining) await Promise.all(this.startWorkers());
    await this.shutdown();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.draining = true;
    try {
      this.options.onDraining();
    } catch (error) {
      this.fail('stop.probes', error);
    }
    this.shutdownPromise = (async () => {
      // A signal during connect/create must not close resources still being
      // initialized. Startup always releases this gate from main's finally.
      await this.startupComplete;
      try {
        await this.options.stopDispatcher();
      } catch (error) {
        this.fail('dispatcher.stop', error);
      }
      // A partially initialized SDK Worker has no dispose() API. SDK1.24 run()
      // synchronously enters RUNNING; start then immediately drain it as well.
      const runs = this.startWorkers();
      for (const worker of this.workers) {
        try {
          if (worker.getStatus().runState === 'RUNNING') worker.shutdown();
        } catch (error) {
          this.fail('worker.shutdown', error);
        }
      }
      await Promise.all(runs); // All errors have been retained by startWorkers.
      // Services remain available through actual activity/run settlement.
      for (const resource of this.options.resources) {
        try {
          await resource.close();
        } catch (error) {
          this.fail(resource.name, error);
        }
      }
      if (this.failures.length) {
        this.shutdownFailure = new AggregateError(this.failures, 'Temporal worker lifecycle failed');
        throw this.shutdownFailure;
      }
    })();
    return this.shutdownPromise;
  }
}
