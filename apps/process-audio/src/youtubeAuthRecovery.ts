import { isFreshSuccessfulYouTubeMediaByteCanary, type YouTubeMediaByteCanaryReport } from './youtubeReadiness';

/** Use download evidence, rather than the browser login state, to release waiting jobs. */
export async function recoverDeferredYouTubeAfterCanary(
  report: YouTubeMediaByteCanaryReport,
  resume: (generation: string) => Promise<unknown>,
  maxAgeMs: number,
  now = Date.now()
): Promise<boolean> {
  if (report.scope !== 'authenticated' || !isFreshSuccessfulYouTubeMediaByteCanary(report, now, maxAgeMs)) return false;
  await resume(report.checkedAt);
  return true;
}

/** Coalesce manual and automatic recovery requests without queueing overlapping probes. */
export function createYouTubeAuthRecovery(options: {
  hasPending: () => Promise<boolean>;
  verifyAndResume: () => Promise<unknown>;
  now?: () => number;
  minimumIntervalMs?: number;
}) {
  const now = options.now ?? Date.now;
  const minimumIntervalMs = options.minimumIntervalMs ?? 60_000;
  let running: Promise<boolean> | null = null;
  let nextCheckAtMs = 0;
  return {
    isRunning: () => running !== null,
    run(force = false): Promise<boolean> {
      if (running) return running;
      if (now() < nextCheckAtMs) return Promise.resolve(false);
      running = Promise.resolve()
        .then(async () => {
          if (!force && !(await options.hasPending())) return false;
          nextCheckAtMs = now() + minimumIntervalMs;
          await options.verifyAndResume();
          return true;
        })
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
}
