import { createServerlessDispatchHandler } from './serverless-dispatch';
import type { IncomingMessage, ServerResponse } from 'node:http';

function request(handler: ReturnType<typeof createServerlessDispatchHandler>, overrides: Record<string, unknown> = {}) {
  const req = {
    method: 'POST',
    url: '/dispatch',
    resume: jest.fn(),
    headers: {
      'ce-id': 'event-1',
      'ce-type': 'google.cloud.firestore.document.v1.written',
      'ce-source': '//firestore.googleapis.com/projects/urm-app-staging/databases/(default)',
      'ce-subject': 'documents/durableJobOutbox/job-1',
    },
    ...overrides,
  };
  let status = 0;
  let body = '';
  const res = {
    writeHead: jest.fn((code: number) => {
      status = code;
      return res;
    }),
    end: jest.fn((value = '') => {
      body = value;
    }),
  };
  return {
    done: handler(req as unknown as IncomingMessage, res as unknown as ServerResponse),
    result: () => ({ status, body }),
  };
}

test('a valid outbox event wakes bounded dispatch without starting a polling loop', async () => {
  const run = jest.fn().mockResolvedValue(true);
  const handler = createServerlessDispatchHandler({
    projectId: 'urm-app-staging',
    admission: 'enabled' as const,
    reconcileJob: 'projects/urm-app-staging/locations/us-central1/jobs/dispatch-reconcile',
    run,
  });
  const call = request(handler);
  await call.done;
  expect(run).toHaveBeenCalledTimes(1);
  expect(call.result().status).toBe(204);
});

const config = (run = jest.fn().mockResolvedValue(true)) => ({
  projectId: 'urm-app-staging',
    admission: 'enabled' as const,
  reconcileJob: 'projects/urm-app-staging/locations/us-central1/jobs/dispatch-reconcile',
  run,
});
test('rejects wrong-project events and events outside the two outboxes without dispatching', async () => {
  const options = config();
  const handler = createServerlessDispatchHandler(options);
  for (const headers of [
    {
      'ce-id': '1',
      'ce-type': 'google.cloud.firestore.document.v1.written',
      'ce-source': '//firestore.googleapis.com/projects/urm-app/databases/(default)',
      'ce-subject': 'documents/durableJobOutbox/1',
    },
    {
      'ce-id': '1',
      'ce-type': 'google.cloud.firestore.document.v1.written',
      'ce-source': '//firestore.googleapis.com/projects/urm-app-staging/databases/(default)',
      'ce-subject': 'documents/users/admin',
    },
  ]) {
    const call = request(handler, { headers });
    await call.done;
    expect(call.result().status).toBe(400);
  }
  expect(options.run).not.toHaveBeenCalled();
});
test('independent scheduled reconciliation recovers missed events without worker polling', async () => {
  const options = config();
  const handler = createServerlessDispatchHandler(options);
  const call = request(handler, { url: '/reconcile', headers: { 'x-cloudscheduler-jobname': options.reconcileJob } });
  await call.done;
  expect(call.result().status).toBe(204);
  expect(options.run).toHaveBeenCalledTimes(1);
});
test('dispatch failure requests platform retry without exposing private error data', async () => {
  const options = config(jest.fn().mockRejectedValue(new Error('private credential')));
  const call = request(createServerlessDispatchHandler(options));
  await call.done;
  expect(call.result()).toEqual({ status: 503, body: '' });
});
test('concurrent events share a pass and shutdown waits for the pass before refusing new work', async () => {
  let finish!: (value: boolean) => void;
  const run = jest.fn(
    () =>
      new Promise<boolean>((done) => {
        finish = done;
      })
  );
  const handler = createServerlessDispatchHandler(config(run));
  const first = request(handler);
  const second = request(handler);
  await Promise.resolve();
  expect(run).toHaveBeenCalledTimes(1);
  const draining = handler.drain();
  finish(true);
  await Promise.all([first.done, second.done, draining]);
  expect(first.result().status).toBe(503);
  expect(second.result().status).toBe(503);
  const late = request(handler);
  await late.done;
  expect(late.result().status).toBe(503);
});
test('incomplete pass requests redelivery and GET cannot run dispatch', async () => {
  const options = config(jest.fn().mockResolvedValue(false));
  const handler = createServerlessDispatchHandler(options);
  const retry = request(handler);
  await retry.done;
  expect(retry.result().status).toBe(503);
  const wrongMethod = request(handler, { method: 'GET' });
  await wrongMethod.done;
  expect(wrongMethod.result().status).toBe(405);
  expect(options.run).toHaveBeenCalledTimes(1);
});

test.each([
  '',
  'projects/urm-app/locations/us-central1/jobs/other',
  'projects/urm-app-staging/locations/us-central1/jobs/',
  'projects/urm-app-staging/locations/us-central1/jobs/a/extra',
])('rejects malformed reconciliation identity %s at startup', (reconcileJob) => {
  expect(() => createServerlessDispatchHandler({ ...config(), reconcileJob })).toThrow(
    'Invalid reconciliation job binding'
  );
});

test('a hung dispatch pass reaches its deadline and aborts rather than acknowledging success', async () => {
  jest.useFakeTimers();
  try {
    let active!: AbortSignal;
    const handler = createServerlessDispatchHandler({
      ...config(),
      passTimeoutMs: 1000,
      run: (signal: AbortSignal) => {
        active = signal;
        return new Promise<boolean>(() => undefined);
      },
    });
    const call = request(handler);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1000);
    await call.done;
    expect(active.aborted).toBe(true);
    expect(call.result().status).toBe(503);
    await handler.drain();
  } finally {
    jest.useRealTimers();
  }
});

test('a timed-out dependency retains the single-pass slot until it actually settles', async () => {
  jest.useFakeTimers();
  try {
    let finish!: (value: boolean) => void;
    const run = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    );
    const handler = createServerlessDispatchHandler({ ...config(), passTimeoutMs: 1000, run });
    const first = request(handler);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1000);
    await first.done;
    const second = request(handler);
    await second.done;
    expect(second.result().status).toBe(503);
    expect(run).toHaveBeenCalledTimes(1);
    finish(true);
    await jest.advanceTimersByTimeAsync(0);
    const third = request(handler);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    finish(true);
    await third.done;
    await handler.drain();
  } finally {
    jest.useRealTimers();
  }
});


test('prepared disabled service never acquires dispatch authority, including valid retries and reconciliation', async () => {
  const run = jest.fn().mockResolvedValue(true);
  const options = { ...config(run), admission: 'disabled' as const };
  const handler = createServerlessDispatchHandler(options);
  // Mutating the caller object cannot activate an already prepared process.
  Object.assign(options, { admission: 'enabled' });
  for (const overrides of [{}, { url: '/reconcile', headers: { 'x-cloudscheduler-jobname': options.reconcileJob } }, {}]) {
    const call = request(handler, overrides); await call.done; expect(call.result().status).toBe(503);
  }
  const health = request(handler, { method: 'GET', url: '/healthz' }); await health.done;
  expect(health.result().status).toBe(200); expect(run).not.toHaveBeenCalled();
  await handler.drain();
});
test.each([undefined, null, 'true', 'ENABLED'])('missing or invalid admission %s fails closed', admission => {
  expect(() => createServerlessDispatchHandler(Object.assign(config(), { admission }))).toThrow('Explicit dispatch admission required');
});
