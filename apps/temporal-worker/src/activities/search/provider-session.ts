import { algoliasearch } from 'algoliasearch';
import { ApiError } from '@algolia/client-common';
import { createHttpRequester } from '@algolia/requester-node-http';
import { setTimeout as delay } from 'node:timers/promises';

export class SearchProviderError extends Error {
  constructor(readonly code: string, readonly nonRetryable = false) {
    super('Search provider operation could not be confirmed');
  }
}
export function classifyProviderError(error: unknown): SearchProviderError {
  // ApiError is the installed SDK's public class; DetailedApiError inherits from it.
  if (error instanceof ApiError) {
    if ([401, 403].includes(error.status)) return new SearchProviderError('SearchAuthorizationRejected', true);
    //400 can also mean bad credentials, so do NOT describe every400 as an invalid record.
    if ([400, 422].includes(error.status)) return new SearchProviderError('SearchProviderRequestRejected', true);
  }
  return error instanceof SearchProviderError ? error : new SearchProviderError('SearchProviderUnavailable');
}
/** One session per activity attempt, including all deletes/save and task confirmations. */
export function createSearchProviderSession(input: { appId: string; writeKey: string; cancellation: AbortSignal }) {
  const deadline = new AbortController();
  const deadlineAt = performance.now() + 150_000;
  const signal = AbortSignal.any([input.cancellation, deadline.signal]);
  const check = () => {
    signal.throwIfAborted();
    if (performance.now() >= deadlineAt) throw new SearchProviderError('SearchCompletionPending');
  };
  const transport = createHttpRequester({ requesterOptions: { signal } });
  const client = algoliasearch(input.appId, input.writeKey, {
    timeouts: { connect: 3000, read: 10000, write: 10000 },
    maxRateLimitRetries: 0, // Temporal owns429 backoff; no SDK Retry-After sleep outside our deadline.
    requester: {
      async send(request) {
        check();
        const remaining = Math.max(1, Math.floor(deadlineAt - performance.now()));
        const response = await transport.send({
          ...request,
          connectTimeout: Math.min(request.connectTimeout, remaining),
          responseTimeout: Math.min(request.responseTimeout, remaining),
        });
        check(); // Abort stops host fallback before it can start another request.
        return response;
      },
    },
  });
  const timer = setTimeout(
    () => deadline.abort(new SearchProviderError('SearchCompletionPending')),
    Math.max(1, deadlineAt - performance.now())
  );
  timer.unref();
  return {
    client,
    check,
    async waitPublished(indexName: string, taskID: number) {
      if (!Number.isSafeInteger(taskID) || taskID < 0) throw new SearchProviderError('SearchTaskReceiptInvalid', true);
      try {
        // SDK waitForTask has no abortable sleep. Its getTask API plus Node's abortable timer
        // is the small supported seam needed for prompt cancellation and an absolute budget.
        for (;;) {
          check();
          const result = await client.getTask({ indexName, taskID }, { cacheable: false });
          check();
          if (result.status === 'published') return;
          if (result.status !== 'notPublished') throw new SearchProviderError('SearchTaskResponseInvalid');
          await delay(Math.min(1000, Math.max(1, deadlineAt - performance.now())), undefined, { signal });
        }
      } catch (error) {
        if (input.cancellation.aborted) throw error; // Existing activity boundary maps actual cancellation.
        if (deadline.signal.aborted) throw classifyProviderError(deadline.signal.reason);
        throw classifyProviderError(error);
      }
    },
    close() {
      clearTimeout(timer);
      deadline.abort(new SearchProviderError('SearchSessionClosed'));
    },
  };
}
