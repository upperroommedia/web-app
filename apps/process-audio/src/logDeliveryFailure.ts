import { write } from 'node:fs';

// A log sink must never turn a recoverable task into a process crash. This
// fallback deliberately excludes the original error, request context and stack.
export const LOG_DELIVERY_FAILURE_NOTICE =
  '{"severity":"WARNING","code":"LOG_DELIVERY_FAILED","message":"Log delivery failed; application processing is continuing.","service":"process-audio"}\n';
const NOTICE_INTERVAL_MS = 60_000;

export function createLogDeliveryFailureReporter({
  now = Date.now,
  writeNotice = (message, done) => {
    // Use the fd API rather than the stderr stream: even a closed stderr pipe
    // reports its error to this callback without an unhandled stream event.
    write(2, message, () => done());
  },
}: {
  now?: () => number;
  writeNotice?: (message: string, done: () => void) => void;
} = {}): () => void {
  let lastNoticeAt = Number.NEGATIVE_INFINITY;
  let pending = false;
  return () => {
    const timestamp = now();
    if (pending || timestamp - lastNoticeAt < NOTICE_INTERVAL_MS) return;
    lastNoticeAt = timestamp;
    pending = true;
    try {
      writeNotice(LOG_DELIVERY_FAILURE_NOTICE, () => {
        pending = false;
      });
    } catch {
      // Logging the fallback failure would recurse. The original task continues.
      pending = false;
    }
  };
}
