import { Context } from '@temporalio/activity';
import type { Database } from 'firebase-admin/database';
import type { Firestore } from 'firebase-admin/firestore';
import { CancelToken } from '../CancelToken';
import { createContext } from '../context';
import type { MediaJobRef } from './types';

/** Coalesce canaries in one worker; persist safe evidence so restart does not manufacture recovery. */
export function createMediaAuthenticationProbe(dependencies: {
  firestore: Firestore;
  database: Database;
  ytdlpPath: string;
}) {
  let running: Promise<{ ready: boolean; generation: string | null }> | undefined;
  let cached: { ready: boolean; generation: string | null; checkedAt: number } | undefined;
  return async (ref: MediaJobRef): Promise<{ ready: boolean; generation: string | null }> => {
    if (cached && Date.now() - cached.checkedAt < 60_000) return { ready: cached.ready, generation: cached.generation };
    if (running) return running;
    const { runAuthenticatedYouTubeMediaByteCanary, withYouTubeCancellation } = await import('../processYouTubeUrl');
    if (running) return running;
    const context = Context.current();
    const token = new CancelToken();
    const abort = () => token.cancel();
    context.cancellationSignal.addEventListener('abort', abort, { once: true });
    if (context.cancellationSignal.aborted) abort();
    const timer = setInterval(() => context.heartbeat({ scope: 'authenticated' }), 10_000);
    timer.unref();
    running = withYouTubeCancellation(token, async () => {
      const report = await runAuthenticatedYouTubeMediaByteCanary(
        dependencies.ytdlpPath,
        dependencies.database,
        createContext(ref.sermonId, 'temporal-authentication-canary')
      );
      context.cancellationSignal.throwIfAborted();
      const ready = report.succeeded && report.bytesDownloaded > 0 && report.scope === 'authenticated';
      const generation = ready ? report.checkedAt : null;
      await dependencies.firestore
        .collection('temporalMediaRecovery')
        .doc('authenticated')
        .set({
          ready,
          generation,
          checkedAt: report.checkedAt,
          bytesDownloaded: report.bytesDownloaded,
          failureClass: report.failureClass ?? null,
        });
      cached = { ready, generation, checkedAt: Date.now() };
      return { ready, generation };
    });
    try {
      return await running;
    } finally {
      clearInterval(timer);
      context.cancellationSignal.removeEventListener('abort', abort);
      if (context.cancellationSignal.aborted) token.cancel();
      await token.waitForProcesses();
      running = undefined;
    }
  };
}
