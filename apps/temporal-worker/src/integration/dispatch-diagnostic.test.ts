import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import {
  collectDispatchDiagnosticExecution,
  DispatchDiagnostic,
  diagnosticVersion,
  diagnosticRecordPath,
} from '../runtime/dispatch-diagnostic';
import { workerReadinessDigest as digest } from '../runtime/readiness-probe';
import { createLocalTestEnvironment } from '../test-support/local-test-environment';
Runtime.install({ logger: new DefaultLogger('ERROR', () => undefined) });
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned diagnostic cleanup deadline')), 15000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('separate paused diagnostic starts only the fixed pinned original and reconciles an actual expired local lease', async () => {
  const harness = JSON.parse(readFileSync(resolve(__dirname, '../../../../firebase.test.json'), 'utf8'));
  if (process.env.FIRESTORE_EMULATOR_HOST !== `127.0.0.1:${harness.emulators.firestore.port}`)
    throw new Error('Dedicated emulator required');
  const app = initializeApp({ projectId: `demo-diagnostic-${randomUUID().slice(0, 8)}` }, randomUUID()),
    db = getFirestore(app);
  let environment: Awaited<ReturnType<typeof createLocalTestEnvironment>> | undefined;
  let worker: Worker | undefined, work: Promise<void> | undefined;
  let primary: unknown;
  try {
    environment = await createLocalTestEnvironment();
    const operationId = randomUUID(),
      releaseId = randomUUID(),
      buildId = 'a'.repeat(40),
      bindingDigest = 'b'.repeat(64);
    const control = db.doc('_control/temporalRelease'),
      state = db.doc('_control/temporalReleaseState'),
      parent = db.doc('_control/temporalReleaseOperation');
    await control.create({
      releaseId,
      admission: 'paused',
      domains: Object.fromEntries(
        ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((d) => [
          d,
          { admission: 'paused' },
        ])
      ),
    });
    await state.create({ releaseId, phase: 'provider-usage-ready' });
    const createdAt = Date.now(),
      serviceRevision = 'projects/urm-app-staging/locations/us-central1/services/dispatch/revisions/dispatch-r1';
    // Controlled arming observation. The operator's actual atomic producer is tested separately.
    const manifest = {
      schemaVersion: 1 as const,
      operationId,
      releaseId,
      bindingDigest,
      buildId,
      image: `registry/worker@sha256:${'d'.repeat(64)}`,
      nonce: 'c'.repeat(32),
      createdAt,
      expiresAt: createdAt + 300000,
      controlVersion: diagnosticVersion(await control.get()),
      stateVersion: diagnosticVersion(await state.get()),
      activationDigest: 'e'.repeat(64),
      eventSubject: '123456789012345678901',
      schedulerSubject: '123456789012345678902',
      serviceRevision,
    };
    const pulseState = (m: typeof manifest) => {
      const receipts = Object.fromEntries(
        (['outbox', 'commands'] as const).map((surface) => [
          surface,
          {
            operationId: m.operationId,
            releaseId: m.releaseId,
            bindingDigest: m.bindingDigest,
            identityState: { stage: 'completed', plan: { operationId: m.operationId, surface: `${surface}-trigger` } },
          },
        ])
      );
      const pulse = (surface: 'outbox' | 'commands') => ({
        operationId: m.operationId,
        nonce: m.nonce,
        creationReceiptDigest: digest(receipts[surface]),
      });
      return { receipts, pulse };
    };
    const seeded = pulseState(manifest);
    await db.runTransaction(async (tx) => {
      tx.create(parent, {
        operationId,
        releaseId,
        bindingDigest,
        action: 'prepare-cloud-run-dispatch-diagnostic',
        cloudDispatchDiagnostic: manifest,
      });
      tx.create(db.doc(`_control/temporalDispatchDiagnosticAuthorization-${operationId}`), manifest);
      tx.create(db.doc(`_control/temporalDispatchDiagnostic-${operationId}`), {
        manifestDigest: digest(manifest),
        outboxPulse: seeded.pulse('outbox'),
        commandsPulse: seeded.pulse('commands'),
      });
      for (const surface of ['outbox', 'commands'] as const) {
        tx.create(
          db.doc(`_control/temporalDispatchDiagnosticWakeCreation-${operationId}-${surface}`),
          seeded.receipts[surface]
        );
        tx.create(db.doc(diagnosticRecordPath(operationId, surface)), {
          state: 'diagnostic',
          surface,
          manifestDigest: digest(manifest),
          diagnosticPulse: seeded.pulse(surface),
        });
      }
    });
    worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.client.options.namespace,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('../workflows/verification/dispatch'),
      workerDeploymentOptions: {
        version: { deploymentName: 'urm-worker-staging', buildId },
        useWorkerVersioning: true,
        defaultVersioningBehavior: 'PINNED',
      },
      shutdownGraceTime: '2 seconds',
      shutdownForceTime: '5 seconds',
    });
    work = worker.run();
    void work.catch(() => undefined);
    const caller = (kind: 'event' | 'scheduler') => ({
      kind,
      subject: kind === 'event' ? manifest.eventSubject : manifest.schedulerSubject,
    });
    const context = (surface: 'outbox' | 'commands') => ({
      caller: caller('event'),
      delivery: {
        kind: 'event' as const,
        id: 'controlled-native-local',
        subject: `documents/${diagnosticRecordPath(operationId, surface)}`,
      },
    });
    const scheduled = {
      caller: caller('scheduler'),
      delivery: { kind: 'scheduler' as const, job: 'controlled-local' },
    };
    const diagnostic = new DispatchDiagnostic({
      db,
      client: environment.client,
      projectId: 'urm-app-staging',
      buildId,
      serviceRevision,
    });
    const signal = new AbortController().signal;
    expect(await diagnostic.tick(signal, scheduled)).toBe(false);
    expect((await db.doc(diagnosticRecordPath(operationId, 'outbox')).get()).get('lease')).toBeUndefined();
    const firstPass = await diagnostic.tick(signal, context('outbox'));
    expect(firstPass).toBe(true);
    const first = await db.doc(diagnosticRecordPath(operationId, 'outbox')).get();
    expect(first.get('dispatchAcknowledged')).toBe(true);
    const workflowId = `dispatch-diagnostic-${operationId}-outbox`;
    const handle = environment.client.workflow.getHandle(workflowId, first.get('runId'), { followRuns: false });
    expect(await handle.result()).toEqual({ nonce: manifest.nonce, runId: first.get('runId') });
    const completion = await collectDispatchDiagnosticExecution({
      db,
      client: environment.client,
      manifest,
      deadline: Date.now() + 10000,
    });
    expect(completion.runId).toBe(first.get('runId'));
    expect(completion.callerSubject).toBe(manifest.eventSubject);
    const outboxRef = db.doc(diagnosticRecordPath(operationId, 'outbox'));
    await outboxRef.update({ startPulseDigest: FieldValue.delete() });
    expect(await diagnostic.tick(signal, context('outbox'))).toBe(false);
    await expect(
      collectDispatchDiagnosticExecution({ db, client: environment.client, manifest, deadline: Date.now() + 10000 })
    ).rejects.toThrow();
    await outboxRef.update({ startPulseDigest: digest(seeded.pulse('outbox')) });
    const history = await handle.fetchHistory();
    expect(history.events?.filter((e) => e.workflowExecutionStartedEventAttributes)).toHaveLength(1);
    expect(
      history.events?.filter(
        (e) =>
          e.activityTaskScheduledEventAttributes ||
          e.startChildWorkflowExecutionInitiatedEventAttributes ||
          e.workflowExecutionContinuedAsNewEventAttributes
      )
    ).toHaveLength(0);
    let starts = 0;
    const native = environment.client.workflow;
    const workflow = new Proxy(native, {
      get(target, key) {
        if (key === 'start')
          return async (...args: Parameters<typeof target.start>) => {
            starts++;
            await target.start(...args);
            throw new Error('controlled post-acceptance ACK loss');
          };
        const v = Reflect.get(target, key);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const lost = new DispatchDiagnostic({
      db,
      client: Object.assign(Object.create(environment.client), { workflow }),
      projectId: 'urm-app-staging',
      buildId,
      serviceRevision,
    });
    expect(await lost.tick(signal, context('commands'))).toBe(false);
    const unknown = await db.doc(diagnosticRecordPath(operationId, 'commands')).get();
    expect(unknown.get('startAttemptedAt')).toEqual(expect.any(Number));
    expect(starts).toBe(1);
    expect(await diagnostic.tick(signal, scheduled)).toBe(false);
    // Actual elapsed local lease, not a Cloud Scheduler wake or native Cloud Run proof.
    const wait = Math.max(0, unknown.get('lease.expiresAt') - Date.now() + 100);
    await new Promise((resolve) => setTimeout(resolve, wait));
    expect(await diagnostic.tick(signal, scheduled)).toBe(true);
    const recovered = await db.doc(diagnosticRecordPath(operationId, 'commands')).get();
    expect(recovered.get('lease.attempt')).toBe(2);
    expect(recovered.get('dispatchAcknowledged')).toBe(true);
    expect(starts).toBe(1);
    const original = environment.client.workflow.getHandle(`dispatch-diagnostic-${operationId}-commands`);
    expect((await original.describe()).runId).toBe(recovered.get('runId'));
    expect(
      (await original.fetchHistory()).events?.filter((e) => e.workflowExecutionStartedEventAttributes)
    ).toHaveLength(1);
    // An exact native execution must not be adopted by a capability with no durable start intent.
    // Reset only this isolated fixture record to represent an orphan pre-existing execution.
    await db.doc(diagnosticRecordPath(operationId, 'commands')).update({
      lease: FieldValue.delete(),
      startAttemptedAt: FieldValue.delete(),
      dispatchAcknowledged: FieldValue.delete(),
      runId: FieldValue.delete(),
    });
    expect(await diagnostic.tick(signal, context('commands'))).toBe(false);
    expect(
      (await db.doc(diagnosticRecordPath(operationId, 'commands')).get()).get('dispatchAcknowledged')
    ).toBeUndefined();
    // A separate commands event has its own pulse, original run and completion proof.
    const commandsId = randomUUID(), commandsManifest = { ...manifest, operationId: commandsId, nonce: '1'.repeat(32) };
    const commandsSeed = pulseState(commandsManifest);
    await db.runTransaction(async tx => {
      tx.update(parent, { operationId: commandsId, cloudDispatchDiagnostic: commandsManifest });
      tx.create(db.doc(`_control/temporalDispatchDiagnosticAuthorization-${commandsId}`), commandsManifest);
      tx.create(db.doc(`_control/temporalDispatchDiagnostic-${commandsId}`), { manifestDigest: digest(commandsManifest), commandsPulse: commandsSeed.pulse('commands') });
      tx.create(db.doc(`_control/temporalDispatchDiagnosticWakeCreation-${commandsId}-commands`), commandsSeed.receipts.commands);
      tx.create(db.doc(diagnosticRecordPath(commandsId, 'commands')), { state: 'diagnostic', surface: 'commands', manifestDigest: digest(commandsManifest), diagnosticPulse: commandsSeed.pulse('commands') });
    });
    expect(await diagnostic.tick(signal, { caller: caller('event'), delivery: {kind: 'event', id: 'controlled-commands-event', subject: `documents/${diagnosticRecordPath(commandsId, 'commands')}`} })).toBe(true);
    const commandsRef = db.doc(diagnosticRecordPath(commandsId, 'commands')), commandsRecord = await commandsRef.get();
    await environment.client.workflow.getHandle(`dispatch-diagnostic-${commandsId}-commands`, commandsRecord.get('runId'), { followRuns: false }).result();
    const collectCommands = () => collectDispatchDiagnosticExecution({db, client: environment!.client, manifest: commandsManifest, surface: 'commands', deadline: Date.now()+10000});
    const commandsCompletion = await collectCommands();
    expect(commandsCompletion.surface).toBe('commands');
    expect(commandsCompletion.runId).toBe(commandsRecord.get('runId'));
    expect(commandsCompletion.creationReceiptDigest).toBe(digest(commandsSeed.receipts.commands));
    await commandsRef.update({runId: first.get('runId')});
    await expect(collectCommands()).rejects.toThrow();
    await commandsRef.update({runId: commandsRecord.get('runId'), diagnosticPulse: seeded.pulse('outbox')});
    await expect(collectCommands()).rejects.toThrow();
    await commandsRef.update({diagnosticPulse: commandsSeed.pulse('commands')});
    const commandsReceiptRef = db.doc(`_control/temporalDispatchDiagnosticWakeCreation-${commandsId}-commands`);
    await commandsReceiptRef.set(commandsSeed.receipts.outbox);
    await expect(collectCommands()).rejects.toThrow();
    await commandsReceiptRef.set(commandsSeed.receipts.commands);
    expect((await collectCommands()).runId).toBe(commandsRecord.get('runId'));
    // Protocol strings cannot be supplied as coercible singleton arrays.
    const malformedId = randomUUID(),
      malformedManifest = { ...manifest, operationId: malformedId, nonce: [manifest.nonce] };
    await db.runTransaction(async (tx) => {
      tx.update(parent, { operationId: malformedId, cloudDispatchDiagnostic: malformedManifest });
      tx.create(db.doc(`_control/temporalDispatchDiagnosticAuthorization-${malformedId}`), malformedManifest);
      tx.create(db.doc(`_control/temporalDispatchDiagnostic-${malformedId}`), {
        manifestDigest: digest(malformedManifest),
      });
      tx.create(db.doc(diagnosticRecordPath(malformedId, 'outbox')), {
        state: 'diagnostic',
        surface: 'outbox',
        manifestDigest: digest(malformedManifest),
      });
    });
    expect(
      await diagnostic.tick(signal, {
        caller: caller('event'),
        delivery: {
          kind: 'event',
          id: 'malformed-capability',
          subject: `documents/${diagnosticRecordPath(malformedId, 'outbox')}`,
        },
      })
    ).toBe(false);
    expect((await db.doc(diagnosticRecordPath(malformedId, 'outbox')).get()).get('lease')).toBeUndefined();
    // A delayed durable intent ACK cannot authorize a new RPC after its original lease.
    const delayedId = randomUUID();
    const delayedManifest = { ...manifest, operationId: delayedId, nonce: 'f'.repeat(32) };
    const delayedSeed = pulseState(delayedManifest);
    await db.runTransaction(async (tx) => {
      tx.update(parent, { operationId: delayedId, cloudDispatchDiagnostic: delayedManifest });
      tx.create(db.doc(`_control/temporalDispatchDiagnosticAuthorization-${delayedId}`), delayedManifest);
      tx.create(db.doc(`_control/temporalDispatchDiagnostic-${delayedId}`), {
        manifestDigest: digest(delayedManifest),
        outboxPulse: delayedSeed.pulse('outbox'),
        commandsPulse: delayedSeed.pulse('commands'),
      });
      for (const surface of ['outbox', 'commands'] as const) {
        tx.create(
          db.doc(`_control/temporalDispatchDiagnosticWakeCreation-${delayedId}-${surface}`),
          delayedSeed.receipts[surface]
        );
        tx.create(db.doc(diagnosticRecordPath(delayedId, surface)), {
          state: 'diagnostic',
          surface,
          manifestDigest: digest(delayedManifest),
          diagnosticPulse: delayedSeed.pulse(surface),
        });
      }
    });
    let delayAcknowledgement = true;
    const delayedDb = new Proxy(db, {
      get(target, key) {
        if (key === 'runTransaction')
          return async <T>(callback: (tx: FirebaseFirestore.Transaction) => Promise<T>) => {
            const result = await target.runTransaction(callback);
            if ((result === undefined || typeof result === 'number') && delayAcknowledgement) {
              delayAcknowledgement = false;
              const record = await target.doc(diagnosticRecordPath(delayedId, 'outbox')).get();
              await new Promise((resolve) =>
                setTimeout(resolve, Math.max(0, record.get('lease.expiresAt') - Date.now() + 100))
              );
            }
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    starts = 0;
    const delayed = new DispatchDiagnostic({
      db: delayedDb,
      client: Object.assign(Object.create(environment.client), { workflow }),
      projectId: 'urm-app-staging',
      buildId,
      serviceRevision,
    });
    expect(
      await delayed.tick(signal, {
        caller: caller('event'),
        delivery: {
          kind: 'event',
          id: 'delayed-intent',
          subject: `documents/${diagnosticRecordPath(delayedId, 'outbox')}`,
        },
      })
    ).toBe(false);
    expect(starts).toBe(0);
    expect((await db.doc(diagnosticRecordPath(delayedId, 'outbox')).get()).get('startAttemptedAt')).toEqual(
      expect.any(Number)
    );
    await control.update({ admission: 'open' });
    expect(
      await delayed.tick(signal, {
        caller: caller('event'),
        delivery: {
          kind: 'event',
          id: 'after-open',
          subject: `documents/${diagnosticRecordPath(delayedId, 'outbox')}`,
        },
      })
    ).toBe(false);
  } catch (error) {
    primary = error;
  } finally {
    const failures: unknown[] = primary ? [primary] : [];
    for (const cleanup of [
      async () => {
        worker?.shutdown();
        await work;
      },
      async () => environment?.teardown(),
      async () => db.terminate(),
      async () => deleteApp(app),
    ]) {
      try {
        await bounded(Promise.resolve().then(cleanup));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Diagnostic local fixture failed');
  }
});
