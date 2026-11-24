import { createServerlessDispatchHandler } from './serverless-dispatch';
import type { IncomingMessage, ServerResponse, IncomingHttpHeaders } from 'node:http';
import type { DispatchRoute } from './dispatch-caller';

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
  interface TestResponse { writeHead(code: number): TestResponse; end(value?: string): void }
  const res: TestResponse = {
    writeHead: jest.fn((code: number): TestResponse => {
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
    authorization: { verify: jest.fn(async (_headers: IncomingHttpHeaders, kind: DispatchRoute) => ({ kind, subject: 'controlled' })), drain: async () => undefined },
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
  authorization: { verify: jest.fn(async (_headers: IncomingHttpHeaders, kind: DispatchRoute) => ({ kind, subject: 'controlled' })), drain: async () => undefined },
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
test('accepts the exact managed Eventarc push URL and rejects other query strings', async () => {
  const options = config();
  const handler = createServerlessDispatchHandler(options);
  const native = request(handler, { url: '/dispatch?__GCP_CloudEventsMode=CE_PUBSUB_BINDING' });
  await native.done;
  expect(native.result().status).toBe(204);
  for (const url of [
    '/dispatch?__GCP_CloudEventsMode=other',
    '/dispatch?__GCP_CloudEventsMode=CE_PUBSUB_BINDING&extra=1',
    '/reconcile?__GCP_CloudEventsMode=CE_PUBSUB_BINDING',
  ]) {
    const call = request(handler, { url });
    await call.done;
    expect(call.result().status).toBe(404);
  }
  expect(options.run).toHaveBeenCalledTimes(1);
});
test('independent scheduled reconciliation recovers missed events without worker polling', async () => {
  const options = config();
  const handler = createServerlessDispatchHandler(options);
  const call = request(handler, { url: '/reconcile', headers: { 'x-cloudscheduler-jobname': options.reconcileJob } });
  await call.done;
  expect(call.result().status).toBe(204);
  expect(options.run).toHaveBeenCalledTimes(1);
});
test('normalizes the native Scheduler job ID after authenticating its caller', async () => {
  const options = config();
  const handler = createServerlessDispatchHandler(options);
  const scheduledAt = '2026-11-24T16:28:00.962296Z';
  const headers = { 'x-cloudscheduler-jobname': 'dispatch-reconcile', 'x-cloudscheduler-scheduletime': scheduledAt };
  const accepted = request(handler, { url: '/reconcile', headers });
  await accepted.done;
  expect(accepted.result().status).toBe(204);
  expect(options.run).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ delivery: { kind: 'scheduler', job: options.reconcileJob, scheduledAt } })
  );
  for (const rejected of [
    { ...headers, 'x-cloudscheduler-jobname': 'other-dispatch-reconcile' },
    { ...headers, 'x-cloudscheduler-jobname': 'projects/other-project/locations/us-central1/jobs/dispatch-reconcile' },
    { ...headers, 'x-cloudscheduler-scheduletime': 'invalid' },
  ]) {
    const unrelated = request(handler, { url: '/reconcile', headers: rejected });
    await unrelated.done;
    expect(unrelated.result().status).toBe(400);
  }
  jest.mocked(options.authorization.verify).mockRejectedValueOnce(new Error('Unauthorized Scheduler'));
  const unauthorized = request(handler, { url: '/reconcile', headers });
  await unauthorized.done;
  expect(unauthorized.result().status).toBe(403);
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
  await new Promise<void>(yes => setImmediate(yes));
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
    let finish!: (value: boolean) => void;
    const handler = createServerlessDispatchHandler({
      ...config(),
      passTimeoutMs: 1000,
      run: (signal: AbortSignal) => {
        active = signal;
        return new Promise<boolean>(resolve => { finish = resolve; });
      },
    });
    const call = request(handler);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1000);
    await call.done;
    expect(active.aborted).toBe(true);
    expect(call.result().status).toBe(503);
    const closing = handler.drain();
    finish(false);
    await closing;
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
    await jest.advanceTimersByTimeAsync(0);
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

test.each(['resolve', 'reject'] as const)('shutdown retains ownership of an aborted SDK pass until it actually %ss', async settlement => {
  let settle!: (value: boolean) => void;
  let reject!: (error: Error) => void;
  const run = jest.fn(() => new Promise<boolean>((resolve, fail) => { settle = resolve; reject = fail; }));
  const handler = createServerlessDispatchHandler(config(run));
  const call = request(handler);
  await Promise.resolve();
  let drained = false;
  const closing = handler.drain().then(() => { drained = true; });
  await call.done;
  await Promise.resolve();
  expect(call.result().status).toBe(503);
  await new Promise<void>(resolve => setImmediate(resolve));
  const drainedBeforeSdkSettled = drained;
  const late = request(handler);
  await late.done;
  expect(late.result().status).toBe(503);
  expect(run).toHaveBeenCalledTimes(1);
  if (settlement === 'resolve') settle(true); else reject(new Error('private SDK failure'));
  await closing;
  expect(drainedBeforeSdkSettled).toBe(false);
  expect(drained).toBe(true);
});

test('every request must authorize before joining a pending pass',async()=>{
 let finish!:(v:boolean)=>void;
 const options=config(jest.fn(()=>new Promise<boolean>(yes=>{finish=yes;})));
 options.authorization.verify.mockResolvedValueOnce({kind:'event',subject:'controlled'}).mockRejectedValueOnce(new Error('private verifier failure'));
 const handler=createServerlessDispatchHandler(options),first=request(handler);
 await new Promise<void>(yes=>setImmediate(yes));
 const denied=request(handler);await denied.done;
 expect(denied.result()).toEqual({status:403,body:''});expect(options.run).toHaveBeenCalledTimes(1);
 finish(true);await first.done;await handler.drain();
});
test('duplicate authorization headers are rejected before credential verification or work',async()=>{
 const options=config(),handler=createServerlessDispatchHandler(options);
 const denied=request(handler,{rawHeaders:['Authorization','Bearer first','authorization','Bearer second']});
 await denied.done;expect(denied.result().status).toBe(403);expect(options.authorization.verify).not.toHaveBeenCalled();expect(options.run).not.toHaveBeenCalled();await handler.drain();
});
test('shutdown cancellation during authorization prevents late joining or work',async()=>{
 let finish!:()=>void;
 const work=new Promise<void>(yes=>{finish=yes;});const run=jest.fn().mockResolvedValue(true);
 const authorization={verify:async()=>{await work;return {kind:'event' as const,subject:'controlled'};},drain:()=>work};
 const handler=createServerlessDispatchHandler({...config(run),authorization});
 const pending=request(handler);await new Promise<void>(yes=>setImmediate(yes));
 let drained=false;const closing=handler.drain().then(()=>{drained=true;});await new Promise<void>(yes=>setImmediate(yes));expect(drained).toBe(false);
 finish();await Promise.all([pending.done,closing]);expect(pending.result().status).toBe(503);expect(run).not.toHaveBeenCalled();
});

test('the actual pass receives only the verified caller and immutable event projection', async () => {
  const run = jest.fn().mockResolvedValue(true);
  const options = config(run);
  const call = request(createServerlessDispatchHandler(options));
  await call.done;
  expect(run.mock.calls[0][1]).toEqual({
    caller: { kind: 'event', subject: 'controlled' },
    delivery: { kind: 'event', id: 'event-1', subject: 'documents/durableJobOutbox/job-1' },
  });
  expect(Object.isFrozen(run.mock.calls[0][1])).toBe(true);
  expect(Object.isFrozen(run.mock.calls[0][1].caller)).toBe(true);
  expect(Object.isFrozen(run.mock.calls[0][1].delivery)).toBe(true);
});

test.each(['scheduler', 'other-event', 'other-caller'] as const)(
  'concurrent %s cannot inherit another delivery acknowledgement or claim authority', async kind => {
    let finish!: (value: boolean) => void;
    const run = jest.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const options = config(run);
    const handler = createServerlessDispatchHandler(options);
    const first = request(handler);
    await new Promise<void>(resolve => setImmediate(resolve));
    if (kind === 'scheduler') options.authorization.verify.mockResolvedValueOnce({ kind: 'scheduler', subject: 'scheduler-owned' });
    if (kind === 'other-caller') options.authorization.verify.mockResolvedValueOnce({ kind: 'event', subject: 'other-owned' });
    const second = request(handler, kind === 'scheduler'
      ? { url: '/reconcile', headers: { 'x-cloudscheduler-jobname': options.reconcileJob } }
      : kind === 'other-event'
        ? { headers: { 'ce-id': 'event-2', 'ce-type': 'google.cloud.firestore.document.v1.written',
          'ce-source': '//firestore.googleapis.com/projects/urm-app-staging/databases/(default)',
          'ce-subject': 'documents/durableJobCommands/command-2' } }
        : {});
    await new Promise<void>(resolve => setImmediate(resolve));
    const beforeSettlement = second.result().status;
    finish(true);
    await Promise.all([first.done, second.done]);
    await handler.drain();
    expect(beforeSettlement).toBe(503);
    expect(second.result().status).toBe(503);
    expect(run).toHaveBeenCalledTimes(1);
  }
);

test('identical verified redelivery shares one successful pass', async () => {
  let finish!: (value: boolean) => void;
  const run = jest.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const handler = createServerlessDispatchHandler(config(run));
  const first = request(handler), duplicate = request(handler);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(run).toHaveBeenCalledTimes(1);
  finish(true);
  await Promise.all([first.done, duplicate.done]);
  expect(first.result().status).toBe(204);
  expect(duplicate.result().status).toBe(204);
  await handler.drain();
});

test('an event cannot inherit an active Scheduler pass', async () => {
  let finish!: (value: boolean) => void;
  const run = jest.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const options = config(run), handler = createServerlessDispatchHandler(options);
  const first = request(handler, { url: '/reconcile', headers: { 'x-cloudscheduler-jobname': options.reconcileJob } });
  await new Promise<void>(resolve => setImmediate(resolve));
  const event = request(handler);
  await event.done;
  expect(event.result().status).toBe(503);
  finish(true);
  await first.done;
  expect(first.result().status).toBe(204);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]).toHaveLength(2);
  await handler.drain();
});

test.each(['', 'a'.repeat(1025), 'event\nprivate', ['event-1']])('rejects unbounded or ambiguous event ID before authorization', async id => {
  const options = config(), handler = createServerlessDispatchHandler(options);
  const call = request(handler, { headers: {
    'ce-id': id, 'ce-type': 'google.cloud.firestore.document.v1.written',
    'ce-source': '//firestore.googleapis.com/projects/urm-app-staging/databases/(default)',
    'ce-subject': 'documents/durableJobOutbox/job-1',
  } });
  await call.done;
  expect(call.result().status).toBe(400);
  expect(options.authorization.verify).not.toHaveBeenCalled();
  expect(options.run).not.toHaveBeenCalled();
  await handler.drain();
});

test('a verifier result for the wrong route cannot acquire a pass', async () => {
  const options = config();
  options.authorization.verify.mockResolvedValueOnce({ kind: 'scheduler', subject: 'controlled' });
  const handler = createServerlessDispatchHandler(options), call = request(handler);
  await call.done;
  expect(call.result().status).toBe(403);
  expect(options.run).not.toHaveBeenCalled();
  await handler.drain();
});
