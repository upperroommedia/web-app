import { Context } from '@temporalio/activity';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
/** SDK shutdown/time-out reasons carry retry semantics, but never provider details. */
export function safeCancellation(signal: AbortSignal): CancelledFailure {
  const reason = (signal.reason as { message?: unknown } | undefined)?.message;
  return new CancelledFailure(
    typeof reason === 'string' && ['WORKER_SHUTDOWN', 'TIMED_OUT', 'NOT_FOUND'].includes(reason)
      ? reason
      : 'Operation cancelled'
  );
}
export interface ActivityFailureProjection {
  name: string;
  args: unknown[];
  failure: ApplicationFailure;
  attempt: number;
  automaticRetry: boolean;
}
/** Errors from HTTP SDKs contain request headers, signed URLs and private content.
 * Every activity passes this boundary before its failure enters event history. */
export function safeActivities<T extends object>(
  activities: T,
  onFailure?: (value: ActivityFailureProjection) => Promise<void>,
  withExecution?: <R>(name: string, args: unknown[], operation: () => Promise<R>) => Promise<R>
): T {
  return Object.fromEntries(
    Object.entries(activities as Record<string, (...args: any[]) => any>).map(([name, run]) => [
      name,
      async (...args: unknown[]) => {
        const context = Context.current();
        const beat = () => {
          try {
            context.heartbeat({ activity: name });
          } catch {}
        };
        const timer = context.info?.heartbeatTimeoutMs
          ? setInterval(beat, Math.max(100, Math.min(5000, context.info.heartbeatTimeoutMs / 2)))
          : undefined;
        if (timer) {
          timer.unref();
          beat();
        }
        const invoke = async () => {
          try {
            const result = await run(...args);
            // Cancellation is confirmed only after provider/native work has actually
            // settled and its durable receipt writes have completed.
            if (context.cancellationSignal.aborted) throw safeCancellation(context.cancellationSignal);
            return result;
          } catch (error) {
            if (context.cancellationSignal.aborted || error instanceof CancelledFailure)
              throw safeCancellation(context.cancellationSignal);
            const code = (error as { code?: unknown })?.code;
            const failure =
              error instanceof ApplicationFailure
                ? ApplicationFailure.create({
                    message: 'Operation could not be confirmed',
                    type: /^[A-Za-z0-9_]{1,100}$/.test(error.type ?? '') ? error.type! : 'DOMAIN_FAILURE',
                    nonRetryable: error.nonRetryable ?? false,
                  })
                : [
                    'STALE_GENERATION',
                    'PROJECT_MISMATCH',
                    'PERMISSION_CHANGED',
                    'STALE_EXECUTION',
                    'PROVIDER_ACCOUNT_ISOLATION_REQUIRED',
                    'PROVIDER_MUTATION_UNRESOLVED',
                    'PUBLISHING_CANCEL_MUTATION_REVIEW_REQUIRED',
                    'PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED',
                    'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT',
                    'PUBLISHING_CANONICAL_DELETION_EFFECT_FORBIDDEN',
                    'PUBLISHING_SOURCE_CLAIMS_FROZEN',
                    'PUBLISHING_ALLOCATION_SOURCE_CHANGED',
                    'PUBLISHING_METADATA_DESTINATIONS_CHANGED',
                  ].includes(String(code))
                ? ApplicationFailure.nonRetryable('Operation is no longer eligible', String(code))
                : ApplicationFailure.retryable('Operation is temporarily unavailable', 'ACTIVITY_UNAVAILABLE');
            const policy = context.info?.retryPolicy;
            const automaticRetry = Boolean(
              policy &&
                !failure.nonRetryable &&
                !(policy.nonRetryableErrorTypes ?? []).includes(failure.type!) &&
                (!policy.maximumAttempts || context.info.attempt < policy.maximumAttempts)
            );
            // Failure projection is best effort: a Firestore outage must not replace or
            // conceal the original safe Activity failure and its real retry policy.
            try {
              await onFailure?.({ name, args, failure, attempt: context.info?.attempt ?? 1, automaticRetry });
            } catch {}
            throw failure;
          }
        };
        try {
          return await (withExecution ? withExecution(name, args, invoke) : invoke());
        } finally {
          if (timer) clearInterval(timer);
        }
      },
    ])
  ) as T;
}
