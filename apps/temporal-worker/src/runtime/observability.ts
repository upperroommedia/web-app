import * as Sentry from '@sentry/node';
import { DefaultLogger, Runtime } from '@temporalio/worker';

function mediaRecoveryLogger() {
  class MediaRecoveryLogger extends DefaultLogger {
    override log(
      level: Parameters<DefaultLogger['log']>[0],
      message: string,
      metadata?: Parameters<DefaultLogger['log']>[2]
    ) {
      if (!metadata) return super.log(level, message);
      const safeMetadata = { ...metadata };
      delete safeMetadata.taskToken;
      super.log(level, message, safeMetadata);
    }
  }
  return new MediaRecoveryLogger('INFO');
}
/** Never attach Activity inputs, provider errors, credentials or intent content. */
export function initializeWorkerObservability(
  projectId: string,
  buildId: string,
  queues: readonly string[] = [],
  onRuntimeInstalled?: (runtime: Runtime) => void
): Runtime {
  const runtime = Runtime.install({
    // The application drains dispatch before workers and owns every signal.
    shutdownSignals: [],
    ...(queues.includes('urm-media-kernel-recovery') ? { logger: mediaRecoveryLogger() } : {}),
    telemetryOptions: {
      metrics: {
        prometheus: {
          bindAddress: process.env.TEMPORAL_METRICS_ADDRESS || '0.0.0.0:9464',
          useSecondsForDurations: true,
        },
      },
    },
  });
  // Capture ownership even if subsequent Sentry initialization fails.
  onRuntimeInstalled?.(runtime);
  // Own the process client before loading shared adapters, even when reporting is disabled.
  Sentry.init({
    dsn: process.env.TEMPORAL_SENTRY_DSN,
    enabled: Boolean(process.env.TEMPORAL_SENTRY_DSN),
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
  return runtime;
}
export function reportWorkerFailure(code: string): void {
  if (process.env.TEMPORAL_SENTRY_DSN) Sentry.captureException(new Error(code));
}
export async function flushWorkerObservability(): Promise<void> {
  await Sentry.close(2000);
}
