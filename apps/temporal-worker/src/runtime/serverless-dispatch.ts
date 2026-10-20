import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ServerlessDispatchOptions {
  projectId: string;
  reconcileJob: string;
  /** One bounded pass through the durable outbox. False requests delivery retry. */
  run(signal: AbortSignal): Promise<boolean>;
  passTimeoutMs?: number;
}

/** Deployed behind Cloud Run IAM, with Eventarc and Scheduler as its only invokers.
 * Event bodies contain private job data and are deliberately discarded, not logged.
 * The fixed-project dispatcher reads authoritative records rather than trusting an event snapshot.
 */
export function createServerlessDispatchHandler(options: ServerlessDispatchOptions) {
  if (!['urm-app-staging', 'urm-app'].includes(options.projectId)) throw new Error('Invalid dispatch project');
  if (
    !new RegExp(`^projects/${options.projectId}/locations/us-central1/jobs/[A-Za-z0-9_-]{1,500}$`).test(
      options.reconcileJob
    )
  )
    throw new Error('Invalid reconciliation job binding');
  const timeoutMs = options.passTimeoutMs ?? 20000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid dispatch deadline');
  let active: AbortController | undefined;
  let draining = false;
  let inflight: Promise<boolean> | undefined;
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    request.resume();
    const end = (status: number) => response.writeHead(status, { 'cache-control': 'no-store' }).end();
    if (request.method === 'GET' && request.url === '/healthz') {
      end(draining ? 503 : 200);
      return;
    }
    if (request.method !== 'POST') {
      end(405);
      return;
    }
    if (draining) {
      end(503);
      return;
    }
    const headers = request.headers;
    if (request.url === '/dispatch') {
      if (
        typeof headers['ce-id'] !== 'string' ||
        !headers['ce-id'] ||
        headers['ce-type'] !== 'google.cloud.firestore.document.v1.written' ||
        headers['ce-source'] !== `//firestore.googleapis.com/projects/${options.projectId}/databases/(default)` ||
        typeof headers['ce-subject'] !== 'string' ||
        !/^documents\/(durableJobOutbox|durableJobCommands)\/[A-Za-z0-9_.:-]{1,256}$/.test(headers['ce-subject'])
      ) {
        end(400);
        return;
      }
    } else if (request.url === '/reconcile') {
      if (headers['x-cloudscheduler-jobname'] !== options.reconcileJob) {
        end(400);
        return;
      }
    } else {
      end(404);
      return;
    }
    // Eventarc may deliver concurrently; do not run overlapping scans in one process.
    // Other instances are fenced by the existing transactional document leases.
    if (!inflight) {
      const controller = new AbortController();
      active = controller;
      const aborted = new Promise<boolean>((resolve) =>
        controller.signal.addEventListener('abort', () => resolve(false), { once: true })
      );
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // A deadline ends the HTTP response, not ownership of a still-running SDK call.
      // Retain the slot until that call settles so hung dependencies cannot spawn more passes.
      const work = Promise.resolve()
        .then(() => options.run(controller.signal))
        .finally(() => {
          if (active === controller) {
            active = undefined;
            inflight = undefined;
          }
        });
      inflight = Promise.race([work, aborted]).finally(() => clearTimeout(timer));
    }
    try {
      end((await inflight) ? 204 : 503);
    } catch {
      end(503);
    }
  };
  return Object.assign(handler, {
    async drain(): Promise<void> {
      draining = true;
      active?.abort();
      await inflight?.catch(() => undefined);
    },
  });
}
