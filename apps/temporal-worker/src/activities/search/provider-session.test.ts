// Exercise the real Algolia client and its transport policy. Only the official
// HTTP requester boundary is replaced: no provider traffic leaves this suite.
const mockSend = jest.fn();
let mockTransportSignal: AbortSignal;

jest.mock('@algolia/requester-node-http', () => ({
  createHttpRequester: (options?: { requesterOptions?: { signal?: AbortSignal } }) => {
    // SDK constructs its default requester too, then uses the explicit override.
    if (options?.requesterOptions?.signal) mockTransportSignal = options.requesterOptions.signal;
    return { send: (...args: unknown[]) => mockSend(...args) };
  },
}));

import { ApiError } from '@algolia/client-common';
import { classifyProviderError, createSearchProviderSession } from './provider-session';

type WireRequest = { method: string; url: string };
const wireResponse = (body: unknown, status = 200) => ({
  content: JSON.stringify(body),
  status,
  isTimedOut: false,
});
const createSession = (controller = new AbortController()) => ({
  controller,
  session: createSearchProviderSession({
    appId: 'test-app',
    writeKey: 'TEST-PRIVATE-WRITE-KEY-CANARY',
    cancellation: controller.signal,
  }),
});

beforeEach(() => {
  jest.useFakeTimers();
  mockSend.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

test('confirms publication after three pending task checks without submitting another batch', async () => {
  // node:timers/promises is deliberately real: exercise the production abortable delay.
  jest.useRealTimers();
  let thirdRead!: () => void;
  const reachedThirdRead = new Promise<void>((resolve) => {
    thirdRead = resolve;
  });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    watchdog = setTimeout(() => reject(new Error('Publication polling did not finish within the test budget')), 10_000);
  });
  let taskReads = 0;
  mockSend.mockImplementation(async (request: WireRequest) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST') {
      expect(path).toBe('/1/indexes/exact-index/batch');
      return wireResponse({ taskID: 713, objectIDs: ['one'] });
    }
    expect(request.method).toBe('GET');
    expect(path).toBe('/1/indexes/exact-index/task/713');
    taskReads += 1;
    if (taskReads === 3) thirdRead();
    return wireResponse({ status: taskReads <= 3 ? 'notPublished' : 'published' });
  });
  const { session } = createSession();
  let publication: Promise<void> | undefined;
  try {
    const receipts = await session.client.saveObjects({
      indexName: 'exact-index',
      objects: [{ objectID: 'one', value: 1 }],
      waitForTasks: false,
    });
    expect(receipts).toHaveLength(1);
    let completed = false;
    publication = session.waitPublished('exact-index', receipts[0].taskID).then(() => {
      completed = true;
    });
    // Keep an assertion failure from leaving a later abort rejection unobserved.
    void publication.catch(() => {});
    await Promise.race([
      reachedThirdRead,
      publication.then(() => {
        throw new Error('Publication completed before the three pending checks');
      }),
      timedOut,
    ]);
    expect(taskReads).toBe(3);
    expect(completed).toBe(false);
    await Promise.race([publication, timedOut]);
    expect(taskReads).toBe(4);
    expect(mockSend.mock.calls.filter(([request]) => request.method === 'POST')).toHaveLength(1);
  } finally {
    clearTimeout(watchdog);
    session.close();
    await publication?.catch(() => {});
  }
}, 15_000);

test('cancellation drains a held wire request before rejecting and never retries another host', async () => {
  let activeRequests = 0;
  let releaseWire = () => {};
  let abortObserved = false;
  mockSend.mockImplementation(() => {
    activeRequests += 1;
    return new Promise((resolve) => {
      let released = false;
      mockTransportSignal.addEventListener(
        'abort',
        () => {
          abortObserved = true;
        },
        { once: true }
      );
      releaseWire = () => {
        if (released) return;
        released = true;
        activeRequests -= 1;
        resolve(wireResponse({ message: 'request aborted' }, 0));
      };
    });
  });
  const { controller, session } = createSession();
  let publication: Promise<string> | undefined;
  try {
    let settled = false;
    // Attach both branches before aborting, so the rejection is always observed.
    publication = session.waitPublished('exact-index', 713).then(
      () => {
        settled = true;
        return 'published';
      },
      () => {
        settled = true;
        return 'rejected';
      }
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(activeRequests).toBe(1);
    controller.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(abortObserved).toBe(true);
    expect(settled).toBe(false);
    expect(activeRequests).toBe(1);
    releaseWire();
    expect(await publication).toBe('rejected');
    expect(activeRequests).toBe(0);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockSend).toHaveBeenCalledTimes(1);
  } finally {
    session.close();
    releaseWire();
    await publication;
  }
});

test('a huge provider rate-limit delay cannot start an SDK sleep or host fallback', async () => {
  mockSend.mockResolvedValue({
    ...wireResponse({ message: 'rate limited', status: 429, retryAfter: 86_400 }, 429),
    headers: { 'retry-after': '86400' },
  });
  const { session } = createSession();
  try {
    let outcome: unknown;
    const publication = session.waitPublished('exact-index', 713).then(
      () => {
        outcome = 'unexpected publication';
      },
      (error: unknown) => {
        outcome = classifyProviderError(error);
      }
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(outcome).toEqual(expect.objectContaining({ nonRetryable: false }));
    await publication;
    expect(mockSend).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(149_000);
    expect(mockSend).toHaveBeenCalledTimes(1);
  } finally {
    session.close();
  }
});

test('the absolute session deadline also bounds an in-flight task request', async () => {
  let activeRequests = 0;
  let releaseWire = () => {};
  mockSend.mockImplementation(() => {
    activeRequests += 1;
    return new Promise((resolve) => {
      let released = false;
      releaseWire = () => {
        if (released) return;
        released = true;
        activeRequests -= 1;
        resolve(wireResponse({ message: 'request aborted' }, 0));
      };
      mockTransportSignal.addEventListener('abort', releaseWire, { once: true });
    });
  });
  const { session } = createSession();
  let publication: Promise<void> | undefined;
  try {
    // Time consumed before the request is part of the same session budget.
    await jest.advanceTimersByTimeAsync(149_000);
    let outcome = 'pending';
    let failure: unknown;
    publication = session.waitPublished('exact-index', 713).then(
      () => {
        outcome = 'published';
      },
      (error: unknown) => {
        outcome = 'rejected';
        failure = error;
      }
    );
    await jest.advanceTimersByTimeAsync(999);
    expect(outcome).toBe('pending');
    expect(activeRequests).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    await publication;
    expect(outcome).toBe('rejected');
    expect(failure).toEqual(expect.objectContaining({ code: 'SearchCompletionPending' }));
    expect(activeRequests).toBe(0);
    expect(() => session.check()).toThrow();
    expect(mockSend).toHaveBeenCalledTimes(1);
  } finally {
    session.close();
    releaseWire();
    await publication;
  }
});

test('an already cancelled session cannot start provider work', async () => {
  const controller = new AbortController();
  const reason = new Error('activity cancelled');
  controller.abort(reason);
  const { session } = createSession(controller);
  try {
    await expect(session.waitPublished('exact-index', 713)).rejects.toBe(reason);
    expect(() => session.check()).toThrow();
    expect(mockSend).not.toHaveBeenCalled();
  } finally {
    session.close();
  }
});

test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  'invalid task receipt %s cannot start a provider request',
  async (taskID) => {
    const { session } = createSession();
    try {
      await expect(session.waitPublished('exact-index', taskID)).rejects.toMatchObject({
        code: 'SearchTaskReceiptInvalid',
        nonRetryable: true,
      });
      expect(mockSend).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
  }
);

test('a zero task ID returned by the provider is confirmed through the real SDK', async () => {
  mockSend.mockImplementation(async (request: WireRequest) =>
    wireResponse(request.method === 'POST' ? { taskID: 0, objectIDs: ['one'] } : { status: 'published' })
  );
  const { session } = createSession();
  try {
    // The documented integer task ID has no positive-only minimum; the SDK accepts zero.
    const receipts = await session.client.saveObjects({
      indexName: 'exact-index',
      objects: [{ objectID: 'one' }],
      waitForTasks: false,
    });
    expect(receipts[0].taskID).toBe(0);
    await session.waitPublished('exact-index', receipts[0].taskID);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(new URL(mockSend.mock.calls[1][0].url).pathname).toBe('/1/indexes/exact-index/task/0');
  } finally {
    session.close();
  }
});

test('an unknown task status fails safely instead of reporting publication', async () => {
  mockSend.mockResolvedValue(wireResponse({ status: 'PRIVATE-UNEXPECTED-STATUS-CANARY' }));
  const { session } = createSession();
  try {
    const failure = await session.waitPublished('exact-index', 713).then(
      () => undefined,
      (error: unknown) => classifyProviderError(error)
    );
    expect(failure).toEqual(expect.objectContaining({ code: 'SearchTaskResponseInvalid', nonRetryable: false }));
    expect(failure?.message + JSON.stringify(failure)).not.toContain('PRIVATE-UNEXPECTED-STATUS-CANARY');
    expect(mockSend).toHaveBeenCalledTimes(1);
  } finally {
    session.close();
  }
});

test('closing the session prevents subsequent provider requests', async () => {
  const { session } = createSession();
  session.close();
  await expect(session.waitPublished('exact-index', 713)).rejects.toMatchObject({ code: 'SearchSessionClosed' });
  expect(() => session.check()).toThrow();
  expect(mockSend).not.toHaveBeenCalled();
});

test.each([401, 403, 400, 422])('SDK ApiError status %s becomes a static nonretryable error', (status) => {
  const classified = classifyProviderError(new ApiError('PRIVATE-PROVIDER-RESPONSE-CANARY', status, []));
  expect(classified.nonRetryable).toBe(true);
  expect(classified.code).toBe(
    status === 401 || status === 403 ? 'SearchAuthorizationRejected' : 'SearchProviderRequestRejected'
  );
  expect(classified.message + JSON.stringify(classified)).not.toContain('PRIVATE-PROVIDER-RESPONSE-CANARY');
  expect(classified.message + JSON.stringify(classified)).not.toContain('TEST-PRIVATE-WRITE-KEY-CANARY');
});

test.each([404, 429, 500, 503])('SDK ApiError status %s remains retryable and redacted', (status) => {
  const classified = classifyProviderError(new ApiError('PRIVATE-PROVIDER-RESPONSE-CANARY', status, []));
  expect(classified.nonRetryable).toBe(false);
  expect(classified.message + JSON.stringify(classified)).not.toContain('PRIVATE-PROVIDER-RESPONSE-CANARY');
});
