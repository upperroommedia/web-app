import * as Sentry from '@sentry/node';
import { Runtime } from '@temporalio/worker';
/** Never attach Activity inputs, provider errors, credentials or intent content. */
export function initializeWorkerObservability(
  projectId: string,
  buildId: string,
  queues: readonly string[] = []
): void {
  Runtime.install({
    telemetryOptions: {
      metrics: {
        prometheus: {
          bindAddress: process.env.TEMPORAL_METRICS_ADDRESS || '0.0.0.0:9464',
          useSecondsForDurations: true,
        },
      },
    },
  });
  if (process.env.TEMPORAL_SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.TEMPORAL_SENTRY_DSN,
      environment: projectId,
      release: buildId,
      initialScope: {
        tags: {
          service: 'temporal-worker',
          ...(queues.length
            ? {
                role: [
                  ...new Set(
                    queues.filter((queue) =>
                      [
                        'urm-orchestration',
                        'urm-controls',
                        'urm-media',
                        'urm-email',
                        'urm-images',
                        'urm-search',
                      ].includes(queue)
                    )
                  ),
                ]
                  .sort()
                  .map((queue) => queue.slice(4))
                  .join(','),
              }
            : {}),
        },
      },
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: { request: false, response: false },
        httpBodies: [],
        urlQueryParams: false,
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        graphQL: { document: false, variables: false },
        stackFrameVariables: false,
      },
      beforeSendLog: () => null,
      maxBreadcrumbs: 20,
      beforeSend(event) {
        delete event.request;
        delete event.breadcrumbs;
        delete event.extra;
        return event;
      },
    });
  }
}
export function reportWorkerFailure(code: string): void {
  if (process.env.TEMPORAL_SENTRY_DSN) Sentry.captureException(new Error(code));
}
export async function flushWorkerObservability(): Promise<void> {
  await Sentry.close(2000);
}
