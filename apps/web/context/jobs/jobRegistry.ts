import { isDurableJobTerminal, type DurableJob, type DurableEntityRef } from '@upperroom/contracts/temporal';

export interface JobSnapshot {
  jobs: readonly DurableJob[];
  loading: boolean;
  stale: boolean;
  error: string | null;
}
export type JobObserver = (jobs: DurableJob[], fromCache: boolean) => void;
export type JobSource = (next: JobObserver, fail: (error: string) => void) => () => void;
const INITIAL: JobSnapshot = { jobs: [], loading: true, stale: true, error: null };

/** One bounded transport subscription per scope, irrespective of mounted consumers. */
export class JobRegistry {
  private entries = new Map<
    string,
    {
      snapshot: JobSnapshot;
      listeners: Set<() => void>;
      stop?: () => void;
      release?: ReturnType<typeof setTimeout>;
      selections: Map<string, JobSnapshot>;
    }
  >();

  snapshot(key: string): JobSnapshot {
    return this.entries.get(key)?.snapshot ?? INITIAL;
  }

  entitySnapshot(key: string, entity: DurableEntityRef): JobSnapshot {
    const entry = this.entries.get(key);
    if (!entry) return INITIAL;
    const selectionKey = `${entity.type}:${entity.id}`;
    const matches = entry.snapshot.jobs.filter((job) => job.entity.type === entity.type && job.entity.id === entity.id);
    const job = matches.find((candidate) => !isDurableJobTerminal(candidate.state)) ?? matches[0];
    const previous = entry.selections.get(selectionKey);
    if (
      previous &&
      previous.jobs[0] === job &&
      previous.loading === entry.snapshot.loading &&
      previous.stale === entry.snapshot.stale &&
      previous.error === entry.snapshot.error
    )
      return previous;
    const next = { ...entry.snapshot, jobs: job ? [job] : [] };
    if (entry.selections.size >= 1_000) entry.selections.delete(entry.selections.keys().next().value!);
    entry.selections.set(selectionKey, next);
    return next;
  }

  subscribe(key: string, source: JobSource, listener: () => void): () => void {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { snapshot: INITIAL, listeners: new Set(), selections: new Map() };
      this.entries.set(key, entry);
    }
    if (entry.release) clearTimeout(entry.release);
    entry.listeners.add(listener);
    if (!entry.stop) {
      const current = entry;
      current.stop = source(
        (incoming, fromCache) => {
          const previous = new Map(current.snapshot.jobs.map((job) => [job.jobId, job]));
          const jobs = incoming.map((job) => {
            const prior = previous.get(job.jobId);
            return prior && prior.revision >= job.revision ? prior : job;
          });
          // A cached empty window must not erase known server state on reconnect.
          current.snapshot = {
            jobs: fromCache && incoming.length === 0 && previous.size ? current.snapshot.jobs : jobs,
            loading: false,
            stale: fromCache,
            error: null,
          };
          current.listeners.forEach((notify) => notify());
        },
        (error) => {
          current.snapshot = { ...current.snapshot, loading: false, stale: true, error };
          current.listeners.forEach((notify) => notify());
        }
      );
    }
    return () => {
      entry!.listeners.delete(listener);
      if (entry!.listeners.size === 0) {
        // Survive React strict-mode remount; idle stores do not retain identity data.
        entry!.release = setTimeout(() => {
          if (entry!.listeners.size === 0) {
            entry!.stop?.();
            this.entries.delete(key);
          }
        }, 0);
      }
    };
  }

  clear(): void {
    this.entries.forEach((entry) => {
      if (entry.release) clearTimeout(entry.release);
      entry.stop?.();
      entry.snapshot = INITIAL;
      entry.selections.clear();
      entry.listeners.forEach((notify) => notify());
    });
    this.entries.clear();
  }
}
export const jobRegistry = new JobRegistry();
