import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DispatchAuthorization, DispatchCaller } from './dispatch-caller';

export interface DispatchPassContext {
  readonly caller: Readonly<DispatchCaller>;
  /** Delivery metadata is only a selector; it never authorizes a record or proves native delivery. */
  readonly delivery: Readonly<
    { kind: 'event'; id: string; subject: string } | { kind: 'scheduler'; job: string; scheduledAt?: string }
  >;
}

export interface ServerlessDispatchOptions {
  projectId: string;
  admission: 'disabled' | 'enabled';
  reconcileJob: string;
  authorization: DispatchAuthorization;
  /** One bounded pass through the durable outbox. False requests delivery retry. */
  run(signal: AbortSignal, context: Readonly<DispatchPassContext>): Promise<boolean>;
  passTimeoutMs?: number;
}

/** Deployed behind Cloud Run IAM, with Eventarc and Scheduler as its only invokers.
 * Event bodies contain private job data and are deliberately discarded, not logged.
 * The fixed-project dispatcher reads authoritative records rather than trusting an event snapshot.
 */
export function createServerlessDispatchHandler(options: ServerlessDispatchOptions) {
  if (!['disabled', 'enabled'].includes(options.admission)) throw new Error('Explicit dispatch admission required');
  if (typeof options.authorization?.verify !== 'function' || typeof options.authorization?.drain !== 'function')
    throw new Error('Native caller authorization required');
  const authorizing = new Set<AbortController>();
  const admission = options.admission; // Immutable process configuration; callers cannot flip a prepared instance.
  if (!['urm-app-staging', 'urm-app'].includes(options.projectId)) throw new Error('Invalid dispatch project');
  const reconcileJob = options.reconcileJob;
  const schedulerJobId = new RegExp(`^projects/${options.projectId}/locations/us-central1/jobs/([A-Za-z0-9_-]{1,500})$`).exec(
    reconcileJob
  )?.[1];
  if (!schedulerJobId) throw new Error('Invalid reconciliation job binding');
  const timeoutMs = options.passTimeoutMs ?? 20000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid dispatch deadline');
  let active: AbortController | undefined;
  let draining = false;
  let inflight: Promise<boolean> | undefined;
  let actualWork: Promise<boolean> | undefined;
  let activeContextKey: string | undefined;
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
    if (draining || admission !== 'enabled') {
      end(503);
      return;
    }
    const headers = request.headers;
    const raw = request.rawHeaders ?? [];
    const headerCount = (name: string) => raw.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
    let delivery: DispatchPassContext['delivery'];
    if (request.url === '/dispatch' || request.url === '/dispatch?__GCP_CloudEventsMode=CE_PUBSUB_BINDING') {
      if (
        typeof headers['ce-id'] !== 'string' ||
        !/^[\x21-\x7e]{1,1024}$/.test(headers['ce-id']) ||
        headers['ce-type'] !== 'google.cloud.firestore.document.v1.written' ||
        headers['ce-source'] !== `//firestore.googleapis.com/projects/${options.projectId}/databases/(default)` ||
        typeof headers['ce-subject'] !== 'string' ||
        !/^documents\/(durableJobOutbox|durableJobCommands)\/[A-Za-z0-9_.:-]{1,256}$/.test(headers['ce-subject'])
      ) {
        end(400);
        return;
      }
      delivery = Object.freeze({ kind: 'event', id: headers['ce-id'], subject: headers['ce-subject'] });
    } else if (request.url === '/reconcile') {
      // Native Scheduler sends the short ID. Use the validated full resource
      // internally, and keep the authenticated Scheduler caller check below.
      const jobHeader = headers['x-cloudscheduler-jobname'];
      const scheduledAt = headers['x-cloudscheduler-scheduletime'];
      if (
        (jobHeader !== schedulerJobId && jobHeader !== reconcileJob) ||
        headerCount('x-cloudscheduler-jobname') > 1 ||
        headerCount('x-cloudscheduler-scheduletime') > 1 ||
        (scheduledAt !== undefined &&
          (typeof scheduledAt !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(scheduledAt) ||
            !Number.isFinite(Date.parse(scheduledAt))))
      ) {
        end(400);
        return;
      }
      delivery = Object.freeze({ kind: 'scheduler', job: reconcileJob, ...(scheduledAt && { scheduledAt }) });
    } else {
      end(404);
      return;
    }
    if (headerCount('authorization') > 1 || headerCount('x-serverless-authorization') > 1) {
      end(403); return;
    }
    const authentication = new AbortController();
    authorizing.add(authentication);
    let context: Readonly<DispatchPassContext>;
    try {
      const caller = await options.authorization.verify(headers, delivery.kind, authentication.signal);
      if (draining || authentication.signal.aborted) { end(503); return; }
      if (caller.kind !== delivery.kind || typeof caller.subject !== 'string' || !caller.subject) {
        end(403); return;
      }
      context = Object.freeze({ caller: Object.freeze({ kind: caller.kind, subject: caller.subject }), delivery });
    } catch { end(draining ? 503 : 403); return; }
    finally { authorizing.delete(authentication); }
    // Only the identical authenticated delivery may share this pass. A Scheduler
    // wake or another event must retry rather than inherit its acknowledgement or authority.
    const contextKey = JSON.stringify(context);
    if (inflight && activeContextKey !== contextKey) { end(503); return; }
    if (!inflight) {
      const controller = new AbortController();
      active = controller;
      activeContextKey = contextKey;
      const aborted = new Promise<boolean>((resolve) =>
        controller.signal.addEventListener('abort', () => resolve(false), { once: true })
      );
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // A deadline ends the HTTP response, not ownership of a still-running SDK call.
      // Retain the slot until that call settles so hung dependencies cannot spawn more passes.
      const work = Promise.resolve()
        .then(() => options.run(controller.signal, context))
        .finally(() => {
          if (active === controller) {
            active = undefined;
            inflight = undefined;
            actualWork = undefined;
            activeContextKey = undefined;
          }
        });
      actualWork = work;
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
      for (const controller of authorizing) controller.abort();
      // HTTP timeout/cancellation is not SDK settlement. Keep dependencies alive
      // until the actual pass settles; interrupted leases remain for reconciliation.
      await Promise.all([actualWork?.catch(() => undefined), options.authorization.drain()]);
    },
  });
}
