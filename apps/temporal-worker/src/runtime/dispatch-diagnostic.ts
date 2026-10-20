import { randomUUID } from 'node:crypto';
import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import type { Firestore, DocumentSnapshot } from 'firebase-admin/firestore';
import type { DispatchPassContext } from './serverless-dispatch';
import { workerReadinessDigest as digest } from './readiness-probe';
import type { DispatchWakeProbeInput } from '../workflows/verification/dispatch';

const fail = (): never => {
  throw new Error('DISPATCH_DIAGNOSTIC_UNCONFIRMED');
};
const domains = ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface DispatchDiagnosticManifest {
  schemaVersion: 2;
  commandsRecovery: 'scheduler';
  operationId: string;
  releaseId: string;
  bindingDigest: string;
  buildId: string;
  image: string;
  nonce: string;
  createdAt: number;
  expiresAt: number;
  controlVersion: string;
  stateVersion: string;
  activationDigest: string;
  eventSubject: string;
  schedulerSubject: string;
  serviceRevision: string;
}
export const diagnosticVersion = (snapshot: DocumentSnapshot): string => {
  const stamp = snapshot.updateTime;
  return stamp ? `${stamp.seconds}:${stamp.nanoseconds}` : fail();
};
function manifest(value: unknown): DispatchDiagnosticManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const m = value as DispatchDiagnosticManifest;
  if (
    Object.keys(m).sort().join(',') !==
      'activationDigest,bindingDigest,buildId,commandsRecovery,controlVersion,createdAt,eventSubject,expiresAt,image,nonce,operationId,releaseId,schedulerSubject,schemaVersion,serviceRevision,stateVersion' ||
    !Object.entries(m)
      .filter(([key]) => !['schemaVersion', 'createdAt', 'expiresAt'].includes(key))
      .every(([, value]) => typeof value === 'string') ||
    m.schemaVersion !== 2 ||
    m.commandsRecovery !== 'scheduler' ||
    !uuid.test(m.operationId) ||
    !uuid.test(m.releaseId) ||
    ![m.bindingDigest, m.activationDigest].every((v) => /^[a-f0-9]{64}$/.test(v)) ||
    !/^[a-f0-9]{40}$/.test(m.buildId) ||
    !/^[a-f0-9]{32}$/.test(m.nonce) ||
    !/^[^\s]+@sha256:[a-f0-9]{64}$/.test(m.image) ||
    ![m.controlVersion, m.stateVersion].every((v) => /^[0-9]+:[0-9]+$/.test(v)) ||
    ![m.eventSubject, m.schedulerSubject].every((v) => /^[0-9]{10,30}$/.test(v)) ||
    m.eventSubject === m.schedulerSubject ||
    !/^projects\/urm-app-staging\/locations\/us-central1\/services\/[a-z0-9-]+\/revisions\/[a-z0-9-]+$/.test(
      m.serviceRevision
    ) ||
    !Number.isSafeInteger(m.createdAt) ||
    !Number.isSafeInteger(m.expiresAt) ||
    m.createdAt <= 0 ||
    m.expiresAt - m.createdAt !== 300000
  )
    fail();
  return m;
}
export const diagnosticRecordPath = (operationId: string, surface: 'outbox' | 'commands') => {
  if (!uuid.test(operationId) || !['outbox', 'commands'].includes(surface)) fail();
  return `${surface === 'outbox' ? 'durableJobOutbox' : 'durableJobCommands'}/diagnostic-${operationId}-${surface}`;
};
function pulseBinding(
  m: DispatchDiagnosticManifest,
  surface: 'outbox' | 'commands',
  r: DocumentSnapshot,
  j: DocumentSnapshot,
  c: DocumentSnapshot
): string {
  if (
    !c.exists ||
    c.get('operationId') !== m.operationId ||
    c.get('releaseId') !== m.releaseId ||
    c.get('bindingDigest') !== m.bindingDigest ||
    c.get('identityState.stage') !== 'completed' ||
    c.get('identityState.plan.operationId') !== m.operationId ||
    c.get('identityState.plan.surface') !== `${surface}-trigger`
  )
    fail();
  const pulse = { operationId: m.operationId, nonce: m.nonce, creationReceiptDigest: digest(c.data()) };
  if (
    j.get('manifestDigest') !== digest(m) ||
    digest(j.get(`${surface}Pulse`)) !== digest(pulse) ||
    digest(r.get('diagnosticPulse')) !== digest(pulse)
  )
    fail();
  return digest(pulse);
}
/** Separate direct-read capability; never widens the business dispatch predicate.
 * Expired/uncertain attempts permit only GET of their original execution, never a new start.
 */
export class DispatchDiagnostic {
  constructor(
    private readonly options: {
      db: Firestore;
      client: Client;
      projectId: string;
      buildId: string;
      serviceRevision: string;
    }
  ) {}
  async tick(signal: AbortSignal, context: Readonly<DispatchPassContext>): Promise<boolean | undefined> {
    const { db, client } = this.options;
    const parentRef = db.doc('_control/temporalReleaseOperation');
    const parent = await parentRef.get();
    if (parent.get('action') !== 'prepare-cloud-run-dispatch-diagnostic') return undefined;
    try {
      const m = manifest(parent.get('cloudDispatchDiagnostic'));
      if (
        this.options.projectId !== 'urm-app-staging' ||
        this.options.buildId !== m.buildId ||
        this.options.serviceRevision !== m.serviceRevision ||
        signal.aborted
      )
        fail();
      if (context.caller.kind !== context.delivery.kind) fail();
      const md = digest(m),
        token = randomUUID();
      const authRef = db.doc(`_control/temporalDispatchDiagnosticAuthorization-${m.operationId}`);
      const journalRef = db.doc(`_control/temporalDispatchDiagnostic-${m.operationId}`);
      const controlRef = db.doc('_control/temporalRelease'),
        stateRef = db.doc('_control/temporalReleaseState');
      const surfaces =
        context.delivery.kind === 'event'
          ? (['outbox', 'commands'] as const).filter(
              (s) =>
                context.delivery.kind === 'event' &&
                context.delivery.subject === `documents/${diagnosticRecordPath(m.operationId, s)}`
            )
          : (['outbox', 'commands'] as const);
      if (
        !surfaces.length ||
        context.caller.subject !== (context.caller.kind === 'event' ? m.eventSubject : m.schedulerSubject)
      )
        fail();
      for (const surface of surfaces) {
        const recordRef = db.doc(diagnosticRecordPath(m.operationId, surface));
        const authority = async (tx: FirebaseFirestore.Transaction) => {
          const [p, c, s, a, j, r, creation, schedulerCreation] = await Promise.all(
            [
              parentRef,
              controlRef,
              stateRef,
              authRef,
              journalRef,
              recordRef,
              db.doc(`_control/temporalDispatchDiagnosticWakeCreation-${m.operationId}-${surface}`),
              db.doc(`_control/temporalDispatchDiagnosticWakeCreation-${m.operationId}-scheduler`),
            ].map((ref) => tx.get(ref))
          );
          if (
            p.get('operationId') !== m.operationId ||
            p.get('releaseId') !== m.releaseId ||
            p.get('bindingDigest') !== m.bindingDigest ||
            p.get('action') !== 'prepare-cloud-run-dispatch-diagnostic' ||
            digest(p.get('cloudDispatchDiagnostic')) !== md ||
            diagnosticVersion(c) !== m.controlVersion ||
            diagnosticVersion(s) !== m.stateVersion ||
            c.get('releaseId') !== m.releaseId ||
            s.get('releaseId') !== m.releaseId ||
            c.get('admission') !== 'paused' ||
            s.get('phase') !== 'provider-usage-ready' ||
            domains.some((d) => c.get(`domains.${d}.admission`) !== 'paused') ||
            !a.exists ||
            digest(a.data()) !== md ||
            j.get('manifestDigest') !== md ||
            r.get('state') !== 'diagnostic' ||
            r.get('manifestDigest') !== md ||
            r.get('surface') !== surface
          )
            fail();
          pulseBinding(m, surface, r, j, creation);
          if (context.caller.kind === 'scheduler' && (!schedulerCreation.exists ||
            schedulerCreation.get('operationId') !== m.operationId || schedulerCreation.get('releaseId') !== m.releaseId ||
            schedulerCreation.get('bindingDigest') !== m.bindingDigest || schedulerCreation.get('identityState.stage') !== 'completed' ||
            schedulerCreation.get('identityState.plan.surface') !== 'scheduler' || schedulerCreation.get('identityState.plan.operationId') !== m.operationId ||
            context.delivery.kind !== 'scheduler' || context.delivery.job !== schedulerCreation.get('identityState.plan.body.name'))) fail();
          return r;
        };
        const claim = await db.runTransaction(async (tx) => {
          const r = await authority(tx),
            now = r.readTime.toMillis();
          if (r.get('dispatchAcknowledged') === true) {
            if (r.get('startPulseDigest') !== digest(r.get('diagnosticPulse'))) fail();
            return { completed: true, attempt: 0 };
          }
          const previous = r.get('lease');
          if (
            previous &&
            (!Number.isSafeInteger(previous.attempt) ||
              previous.attempt < 1 ||
              typeof previous.token !== 'string' ||
              !Number.isSafeInteger(previous.expiresAt))
          )
            fail();
          if (previous && context.caller.kind === 'event' && surface === 'commands' && r.get('retryFaultAppliedAt') !== undefined &&
            digest(r.get('firstEventDelivery')) === digest(context.delivery)) {
            const j = await tx.get(journalRef), witness = { delivery: context.delivery, pulseDigest: digest(r.get('diagnosticPulse')), runId: r.get('runId'), leaseExpiresAt: previous.expiresAt };
            const prior = j.get('commandsRetry');
            if (prior !== undefined && digest(prior) !== digest(witness)) fail();
            if (prior === undefined) tx.update(journalRef, { commandsRetry: witness });
            return { retryObserved: true, attempt: 0 };
          }
          if (
            (!previous && (context.caller.kind !== 'event' || now >= m.expiresAt)) ||
            (previous && (context.caller.kind !== 'scheduler' || previous.expiresAt > now))
          )
            fail();
          const attempt = (previous?.attempt ?? 0) + 1;
          tx.update(recordRef, {
            lease: { token, attempt, expiresAt: now + 15000 },
            caller: { kind: context.caller.kind, subject: context.caller.subject },
            delivery: context.delivery,
            claimedAt: now,
            ...(!previous ? { firstEventDelivery: context.delivery } : {}),
          });
          return { completed: false, attempt };
        });
        if (claim.retryObserved) return false;
        if (claim.completed) continue;
        const workflowId = `dispatch-diagnostic-${m.operationId}-${surface}`;
        const input: DispatchWakeProbeInput = {
          projectId: 'urm-app-staging',
          buildId: m.buildId,
          nonce: m.nonce,
          operationId: m.operationId,
          surface,
        };
        let description;
        try {
          description = await client.connection.withDeadline(Date.now() + 10000, () =>
            client.workflow.getHandle(workflowId).describe()
          );
        } catch (error) {
          if (!(error instanceof WorkflowNotFoundError) || claim.attempt !== 1) throw error;
          // Persist the sole start attempt under unchanged authority before native execution.
          const leaseDeadline = await db.runTransaction(async (tx) => {
            const r = await authority(tx);
            if (
              r.get('lease.token') !== token ||
              r.get('startAttemptedAt') !== undefined ||
              r.get('lease.expiresAt') <= r.readTime.toMillis() ||
              r.readTime.toMillis() >= m.expiresAt
            )
              fail();
            tx.update(recordRef, {
              startAttemptedAt: r.readTime.toMillis(),
              startPulseDigest: digest(r.get('diagnosticPulse')),
              ...(surface === 'commands' ? { retryFaultIntent: {kind: 'withhold-accepted-start-ack', pulseDigest: digest(r.get('diagnosticPulse'))} } : {}),
            });
            return r.get('lease.expiresAt') as number;
          });
          const now = Date.now();
          if (signal.aborted || now >= m.expiresAt || now >= leaseDeadline) fail();
          await client.connection.withDeadline(Math.min(now + 10000, leaseDeadline, m.expiresAt), () =>
            client.workflow.start('DispatchWakeProbe', {
              workflowId,
              taskQueue: 'urm-orchestration',
              args: [input],
              workflowExecutionTimeout: '1 minute',
              workflowIdConflictPolicy: 'FAIL',
              workflowIdReusePolicy: 'REJECT_DUPLICATE',
              versioningOverride: { pinnedTo: { deploymentName: 'urm-worker-staging', buildId: m.buildId } },
            })
          );
          description = await client.connection.withDeadline(Date.now() + 10000, () =>
            client.workflow.getHandle(workflowId).describe()
          );
        }
        if (
          signal.aborted ||
          description.workflowId !== workflowId ||
          !uuid.test(description.runId) ||
          description.type !== 'DispatchWakeProbe' ||
          description.taskQueue !== 'urm-orchestration'
        )
          fail();
        await db.runTransaction(async (tx) => {
          const r = await authority(tx),
            attempted = r.get('startAttemptedAt');
          if (
            r.get('lease.token') !== token ||
            r.get('startPulseDigest') !== digest(r.get('diagnosticPulse')) ||
            !Number.isSafeInteger(attempted) ||
            attempted < m.createdAt ||
            attempted >= m.expiresAt ||
            description.startTime.getTime() < attempted - 5000 ||
            description.startTime.getTime() > m.expiresAt + 5000
          )
            fail();
        });
        const handle = client.workflow.getHandle(workflowId, description.runId, {
          firstExecutionRunId: description.runId,
          followRuns: false,
        });
        const history = await client.connection.withDeadline(Date.now() + 10000, () => handle.fetchHistory());
        const first = history.events?.[0]?.workflowExecutionStartedEventAttributes;
        if (
          !first ||
          first.firstExecutionRunId !== description.runId ||
          first.originalExecutionRunId !== description.runId ||
          first.continuedExecutionRunId ||
          first.workflowType?.name !== 'DispatchWakeProbe' ||
          first.taskQueue?.name !== 'urm-orchestration' ||
          first.input?.payloads?.length !== 1 ||
          digest(defaultPayloadConverter.fromPayload(first.input.payloads[0])) !== digest(input) ||
          first.versioningOverride?.pinned?.behavior !== 1 ||
          first.versioningOverride.pinned.version?.deploymentName !== 'urm-worker-staging' ||
          first.versioningOverride.pinned.version?.buildId !== m.buildId ||
          history.events?.some(
            (e) =>
              e.activityTaskScheduledEventAttributes ||
              e.startChildWorkflowExecutionInitiatedEventAttributes ||
              e.workflowExecutionContinuedAsNewEventAttributes
          )
        )
          fail();
        const acknowledged = await db.runTransaction(async (tx) => {
          const r = await authority(tx);
          if (
            r.get('lease.token') !== token ||
            r.get('lease.expiresAt') <= r.readTime.toMillis() ||
            r.get('startPulseDigest') !== digest(r.get('diagnosticPulse')) ||
            (r.get('runId') && r.get('runId') !== description.runId)
          )
            fail();
          if (surface === 'commands') {
            if (digest(r.get('retryFaultIntent')) !== digest({kind: 'withhold-accepted-start-ack', pulseDigest: digest(r.get('diagnosticPulse'))})) fail();
            if (claim.attempt === 1) {
              if (r.get('retryFaultAppliedAt') !== undefined) fail();
              tx.update(recordRef, {runId: description.runId, retryFaultAppliedAt: r.readTime.toMillis(), firstLeaseExpiresAt: r.get('lease.expiresAt'), startHistoryDigest: digest(JSON.parse(JSON.stringify(history)))});
              return false;
            }
            if (!Number.isSafeInteger(r.get('retryFaultAppliedAt')) || !Number.isSafeInteger(r.get('firstLeaseExpiresAt')) ||
              !Number.isSafeInteger(r.get('claimedAt')) || r.get('claimedAt') < r.get('firstLeaseExpiresAt')) fail();
          }
          tx.update(recordRef, {
            runId: description.runId,
            dispatchAcknowledged: true,
            startHistoryDigest: digest(JSON.parse(JSON.stringify(history))),
            observedAt: r.readTime.toMillis(),
          });
          return true;
        });
        if (!acknowledged) return false;
      }
      return true;
    } catch {
      return false;
    } // No SDK error, task token, payload or native identity is exported.
  }
}

/** Native GET-only completion join. Stored dispatch acknowledgement alone is not completion. */
export async function collectDispatchDiagnosticExecution(options: {
  db: Firestore;
  client: Client;
  manifest: DispatchDiagnosticManifest;
  deadline: number;
  surface?: 'outbox' | 'commands';
  recovery?: 'retry' | 'scheduler';
}) {
  const m = manifest(options.manifest),
    { db, client, deadline } = options,
    surface = options.surface ?? 'outbox';
  if (!['outbox', 'commands'].includes(surface)) fail();
  if (!Number.isFinite(deadline) || Date.now() >= deadline) fail();
  if (options.recovery !== undefined && (surface !== 'commands' || !['retry', 'scheduler'].includes(options.recovery))) fail();
  const [r, j, c, scheduler] = await db.getAll(
    db.doc(diagnosticRecordPath(m.operationId, surface)),
    db.doc(`_control/temporalDispatchDiagnostic-${m.operationId}`),
    db.doc(`_control/temporalDispatchDiagnosticWakeCreation-${m.operationId}-${surface}`),
    db.doc(`_control/temporalDispatchDiagnosticWakeCreation-${m.operationId}-scheduler`)
  );
  const pulseDigest = pulseBinding(m, surface, r, j, c);
  if (r.get('startPulseDigest') !== pulseDigest) fail();
  const workflowId = `dispatch-diagnostic-${m.operationId}-${surface}`,
    runId = r.get('runId');
  if (
    r.get('state') !== 'diagnostic' ||
    r.get('manifestDigest') !== digest(m) ||
    (options.recovery === 'retry' ? r.get('dispatchAcknowledged') !== undefined : r.get('dispatchAcknowledged') !== true) ||
    !uuid.test(runId ?? '') ||
    (options.recovery === 'scheduler'
      ? r.get('caller.kind') !== 'scheduler' || r.get('caller.subject') !== m.schedulerSubject || r.get('delivery.kind') !== 'scheduler' ||
        !scheduler.exists || scheduler.get('operationId') !== m.operationId || scheduler.get('releaseId') !== m.releaseId || scheduler.get('bindingDigest') !== m.bindingDigest ||
        scheduler.get('identityState.stage') !== 'completed' || scheduler.get('identityState.plan.surface') !== 'scheduler' ||
        scheduler.get('identityState.plan.operationId') !== m.operationId || r.get('delivery.job') !== scheduler.get('identityState.plan.body.name') ||
        r.get('lease.attempt') < 2 || r.get('claimedAt') < r.get('firstLeaseExpiresAt')
      : r.get('caller.kind') !== 'event' || r.get('caller.subject') !== m.eventSubject || r.get('delivery.kind') !== 'event' ||
        r.get('delivery.subject') !== `documents/${diagnosticRecordPath(m.operationId, surface)}` || typeof r.get('delivery.id') !== 'string' || !r.get('delivery.id')) ||
    !Number.isSafeInteger(r.get('startAttemptedAt')) ||
    r.get('startAttemptedAt') < m.createdAt ||
    r.get('startAttemptedAt') >= m.expiresAt
  )
    fail();
  if (surface === 'commands') {
    const retry = j.get('commandsRetry');
    if (!options.recovery || !Number.isSafeInteger(r.get('retryFaultAppliedAt')) || !Number.isSafeInteger(r.get('firstLeaseExpiresAt')) ||
      r.get('retryFaultAppliedAt') < r.get('startAttemptedAt') || r.get('retryFaultAppliedAt') >= r.get('firstLeaseExpiresAt') ||
      digest(r.get('retryFaultIntent')) !== digest({kind: 'withhold-accepted-start-ack', pulseDigest}) ||
      retry?.runId !== runId || retry?.pulseDigest !== pulseDigest || retry?.leaseExpiresAt !== r.get('firstLeaseExpiresAt') ||
      digest(retry?.delivery) !== digest(r.get('firstEventDelivery'))) fail();
  }
  const handle = client.workflow.getHandle(workflowId, runId, { firstExecutionRunId: runId, followRuns: false });
  const history = await client.connection.withDeadline(Math.min(deadline, Date.now() + 10000), () =>
    handle.fetchHistory()
  );
  const first = history.events?.[0]?.workflowExecutionStartedEventAttributes;
  const input: DispatchWakeProbeInput = {
    projectId: 'urm-app-staging',
    buildId: m.buildId,
    nonce: m.nonce,
    operationId: m.operationId,
    surface,
  };
  const completed = history.events?.filter((e) => e.workflowExecutionCompletedEventAttributes) ?? [];
  if (
    !first ||
    first.firstExecutionRunId !== runId ||
    first.originalExecutionRunId !== runId ||
    first.continuedExecutionRunId ||
    first.workflowType?.name !== 'DispatchWakeProbe' ||
    first.taskQueue?.name !== 'urm-orchestration' ||
    first.input?.payloads?.length !== 1 ||
    digest(defaultPayloadConverter.fromPayload(first.input.payloads[0])) !== digest(input) ||
    first.versioningOverride?.pinned?.behavior !== 1 ||
    first.versioningOverride.pinned.version?.deploymentName !== 'urm-worker-staging' ||
    first.versioningOverride.pinned.version?.buildId !== m.buildId ||
    completed.length !== 1 ||
    completed[0].workflowExecutionCompletedEventAttributes?.result?.payloads?.length !== 1 ||
    digest(
      defaultPayloadConverter.fromPayload(completed[0].workflowExecutionCompletedEventAttributes.result.payloads[0])
    ) !== digest({ nonce: m.nonce, runId }) ||
    history.events?.some(
      (e) =>
        e.activityTaskScheduledEventAttributes ||
        e.startChildWorkflowExecutionInitiatedEventAttributes ||
        e.workflowExecutionContinuedAsNewEventAttributes
    )
  )
    fail();
  return {
    schemaVersion: 1,
    operationId: m.operationId,
    manifestDigest: digest(m),
    workflowId,
    runId,
    historyDigest: digest(JSON.parse(JSON.stringify(history))),
    surface,
    creationReceiptDigest: digest(c.data()),
    pulseDigest,
    callerKind: options.recovery === 'scheduler' ? 'scheduler' : 'event',
    callerSubject: options.recovery === 'scheduler' ? m.schedulerSubject : m.eventSubject,
    ...(options.recovery === 'scheduler' ? { schedulerReceiptDigest: digest(scheduler.data()), job: r.get('delivery.job') } : {deliveryId: r.get('delivery.id')}),
    ...(surface === 'commands' ? {recovery: options.recovery, retryWitnessDigest: digest(j.get('commandsRetry'))} : {}),
    serviceRevision: m.serviceRevision,
    scope:
      'native original timer completion joined to stored verified-caller dispatch; not exclusive transport causality, inherited isolation or readiness',
  };
}
