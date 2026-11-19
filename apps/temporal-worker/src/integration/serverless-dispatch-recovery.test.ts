import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { OutboxDispatcher } from '../runtime/dispatcher';
import { createServerlessDispatchHandler, type DispatchPassContext } from '../runtime/serverless-dispatch';
import { createLocalTestEnvironment } from '../test-support/local-test-environment';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('Local dispatch fixture deadline')), 10000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

async function cleanupOwned(steps: Array<() => Promise<unknown>>, primary?: { error: unknown }) {
  const failures: unknown[] = primary ? [primary.error] : [];
  for (const step of steps) {
    try { await step(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Owned dispatch fixture failed or did not clean up', { cause: failures[0] });
}

test('cleanup attempts every owned resource and preserves primary plus cleanup failures', async () => {
  const primary = new Error('controlled primary'), cleanup = new Error('controlled cleanup');
  const seen: number[] = [];
  let caught: unknown;
  try { await cleanupOwned([
    async () => { seen.push(1); throw cleanup; },
    async () => { seen.push(2); },
    async () => { seen.push(3); },
  ], { error: primary }); } catch (error) { caught = error; }
  expect(seen).toEqual([1, 2, 3]);
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([primary, cleanup]);
  expect((caught as AggregateError).cause).toBe(primary);
});

test.each(['start', 'signal-with-start'] as const)(
  'native accepted %s survives interrupted HTTP shutdown and expired-lease reconciliation without another delivery',
  runDispatchRecovery
);

async function runDispatchRecovery(operation: 'start' | 'signal-with-start') {
  const harness = JSON.parse(readFileSync(resolve(__dirname, '../../../../firebase.test.json'), 'utf8'));
  if (process.env.FIRESTORE_EMULATOR_HOST !== `127.0.0.1:${harness.emulators.firestore.port}`)
    throw new Error('Dedicated emulator required');
  // An isolated emulator project keeps this dispatcher scan away from other suites.
  // This test does not attest candidate Firebase project/identity configuration.
  const app = initializeApp({ projectId: `demo-dispatch-${randomUUID().slice(0, 8)}` }, randomUUID());
  const db = getFirestore(app);
  const environment = await createLocalTestEnvironment().catch(async error => {
    await cleanupOwned([() => bounded(db.terminate()), () => bounded(deleteApp(app))], { error });
    throw error;
  });
  const projectId = 'urm-app-staging', jobId = `dispatch-recovery-${randomUUID()}`;
  const workflowId = `dispatch:${projectId}:${jobId}`;
  const outbox = db.collection('durableJobOutbox').doc(jobId), job = db.collection('durableJobs').doc(jobId);
  const nextJobId = `${jobId}-next`;
  const nextOutbox = db.collection('durableJobOutbox').doc(nextJobId);
  const accepted = deferred(), releaseAck = deferred();
  let starts = 0, clock = Date.now();
  async function loseAcknowledgement(send: () => Promise<unknown>) {
    starts++;
    await send();
    accepted.resolve();
    await releaseAck.promise;
    throw new Error('controlled lost acknowledgement');
  }
  const workflow = new Proxy(environment.client.workflow, {
    get(target, property) {
      if (property === 'start' && operation === 'start')
        return (...args: Parameters<typeof target.start>) => loseAcknowledgement(() => target.start(...args));
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const workflowService = new Proxy(environment.client.workflowService, {
    get(target, property) {
      if (property === 'signalWithStartWorkflowExecution' && operation === 'signal-with-start')
        return (...args: Parameters<typeof target.signalWithStartWorkflowExecution>) =>
          loseAcknowledgement(() => target.signalWithStartWorkflowExecution(...args));
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const first = new OutboxDispatcher({ db, client: { workflow, workflowService }, projectId, requireOpenAdmission: true, now: () => clock, leaseMs: 1000 });
  const passContexts: Readonly<DispatchPassContext>[] = [];
  const handler = createServerlessDispatchHandler({ projectId, authorization: { verify: async (_headers, kind) => ({ kind, subject: `controlled-local-${kind}` }), drain: async () => undefined }, admission: 'enabled',
    reconcileJob: `projects/${projectId}/locations/us-central1/jobs/local-reconcile`,
    run: async (signal, context) => { passContexts.push(context); await first.tick(signal); return first.healthy; } });
  const server = createServer((req, res) => { void handler(req, res); });
  let closing: Promise<void> | undefined;
  let primary: { error: unknown } | undefined;
  try {
    const control = db.doc('_control/temporalRelease');
    await control.create({ schemaVersion: 1, revision: 1, releaseId: jobId, admission: 'paused',
      domains: Object.fromEntries(['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search']
        .map(domain => [domain, { owner: 'temporal', admission: 'open' }])) });
    await job.create({ projectId, state: 'running' });
    await outbox.create({ state: 'pending', nextAttemptAt: 0,
      dispatch: { ref: { projectId, jobId }, workflowId, workflowType: 'inertLocalDispatchFixture', taskQueue: jobId,
        ...(operation === 'signal-with-start' ? { signal: { name: 'media.request', args: { projectId, jobId } } } : {}),
      } });
    await new Promise<void>(yes => { server.listen(0, '127.0.0.1', yes); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local fixture address required');
    const request = () => fetch(`http://127.0.0.1:${address.port}/dispatch`, { method: 'POST', headers: {
      'ce-id': jobId, 'ce-type': 'google.cloud.firestore.document.v1.written',
      'ce-source': `//firestore.googleapis.com/projects/${projectId}/databases/(default)`,
      'ce-subject': `documents/durableJobOutbox/${jobId}`,
    } });
    await control.update({ 'domains.media.owner': ['temporal'], admission: 'open' });
    const malformed = await bounded(request());
    expect(malformed.status).toBe(503);
    await malformed.arrayBuffer();
    expect(starts).toBe(0);
    expect((await outbox.get()).get('leaseToken')).toBeUndefined();
    await control.update({ 'domains.media.owner': 'temporal', admission: 'paused' });
    const denied = await bounded(request());
    expect(denied.status).toBe(503);
    await denied.arrayBuffer();
    expect(starts).toBe(0);
    expect((await outbox.get()).get('state')).toBe('pending');
    expect((await outbox.get()).get('leaseToken')).toBeUndefined();
    await control.update({ admission: 'open', revision: 2 });
    const response = request();
    await bounded(accepted.promise);
    const original = await environment.client.workflow.getHandle(workflowId).describe();
    const leased = await outbox.get();
    expect(leased.get('state')).toBe('dispatching');
    expect(leased.get('attempt')).toBe(1);
    // These are controlled local callers, not native Google-authenticated deliveries.
    const otherCaller = await bounded(fetch(`http://127.0.0.1:${address.port}/reconcile`, {
      method: 'POST', headers: { 'x-cloudscheduler-jobname': `projects/${projectId}/locations/us-central1/jobs/local-reconcile` },
    }));
    expect(otherCaller.status).toBe(503);
    await otherCaller.arrayBuffer();
    expect(starts).toBe(1);
    expect(passContexts).toHaveLength(3); // malformed, paused, then the accepted event pass
    expect(passContexts[2]).toEqual({
      caller: { kind: 'event', subject: 'controlled-local-event' },
      delivery: { kind: 'event', id: jobId, subject: `documents/durableJobOutbox/${jobId}` },
    });
    expect(Object.isFrozen(passContexts[2])).toBe(true);
    expect((await outbox.get()).get('leaseToken')).toBe(leased.get('leaseToken'));
    let drained = false;
    closing = handler.drain().then(() => { drained = true; });
    const aborted = await bounded(response);
    expect(aborted.status).toBe(503);
    await aborted.arrayBuffer();
    await new Promise<void>(yes => setImmediate(yes));
    expect(drained).toBe(false);
    releaseAck.resolve();
    await bounded(closing);
    expect((await outbox.get()).get('leaseToken')).toBe(leased.get('leaseToken'));
    expect((await outbox.get()).get('state')).toBe('dispatching');
    expect(starts).toBe(1);
    const replacement = new OutboxDispatcher({ db, client: environment.client, projectId, requireOpenAdmission: true, now: () => clock });
    try {
      await replacement.tick(); // An unexpired native lease cannot be stolen.
      expect((await outbox.get()).get('attempt')).toBe(1);
      clock += 1001; // Controlled lease clock; not a native timer-wake proof.
      await control.update({ admission: 'paused', revision: 3 });
      await replacement.tick();
      expect((await outbox.get()).get('leaseToken')).toBe(leased.get('leaseToken'));
      expect((await outbox.get()).get('attempt')).toBe(1);
      expect(replacement.healthy).toBe(false);
      await control.update({ admission: 'open', revision: 4 });
      await replacement.tick();
      expect((await outbox.get()).get('state')).toBe('dispatched');
      expect((await outbox.get()).get('attempt')).toBe(2);
      const recovered = environment.client.workflow.getHandle(workflowId);
      expect((await recovered.describe()).runId).toBe(original.runId);
      const history = await recovered.fetchHistory();
      expect(history.events?.filter(event => event.workflowExecutionStartedEventAttributes)).toHaveLength(1);
      expect(history.events?.filter(event => event.workflowExecutionSignaledEventAttributes))
        .toHaveLength(operation === 'signal-with-start' ? 1 : 0);
      if (operation === 'signal-with-start') {
        const nextRef = { projectId, jobId: nextJobId };
        await nextOutbox.create({ state: 'pending', nextAttemptAt: 0,
          dispatch: { ref: nextRef, workflowId, workflowType: 'inertLocalDispatchFixture', taskQueue: jobId,
            signal: { name: 'media.request', args: nextRef } } });
        await replacement.tick();
        expect((await nextOutbox.get()).get('state')).toBe('dispatched');
        expect((await recovered.describe()).runId).toBe(original.runId);
        expect((await recovered.fetchHistory()).events?.filter(event => event.workflowExecutionSignaledEventAttributes))
          .toHaveLength(2);
      }
    } finally { await replacement.stop(); }
  } catch (error) { primary = { error }; }
  finally {
    releaseAck.resolve();
    await cleanupOwned([
      () => bounded(Promise.all([handler.drain(), first.stop(), closing])),
      () => bounded(new Promise<void>((yes, no) => server.listening ? server.close(error => error ? no(error) : yes()) : yes())),
      () => bounded(Promise.all([outbox.delete(), job.delete(), ...(operation === 'signal-with-start' ? [nextOutbox.delete()] : [])])),
      () => bounded(db.terminate()),
      () => bounded(deleteApp(app)),
      () => environment.teardown(),
    ], primary);
  }
}
