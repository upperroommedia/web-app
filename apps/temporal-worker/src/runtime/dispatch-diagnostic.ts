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
  schemaVersion: 1;
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
      'activationDigest,bindingDigest,buildId,controlVersion,createdAt,eventSubject,expiresAt,image,nonce,operationId,releaseId,schedulerSubject,schemaVersion,serviceRevision,stateVersion' ||
    !Object.entries(m)
      .filter(([key]) => !['schemaVersion', 'createdAt', 'expiresAt'].includes(key))
      .every(([, value]) => typeof value === 'string') ||
    m.schemaVersion !== 1 ||
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
          const [p, c, s, a, j, r] = await Promise.all(
            [parentRef, controlRef, stateRef, authRef, journalRef, recordRef].map((ref) => tx.get(ref))
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
          return r;
        };
        const claim = await db.runTransaction(async (tx) => {
          const r = await authority(tx),
            now = r.readTime.toMillis();
          if (r.get('dispatchAcknowledged') === true) return { completed: true, attempt: 0 };
          const previous = r.get('lease');
          if (
            previous &&
            (!Number.isSafeInteger(previous.attempt) ||
              previous.attempt < 1 ||
              typeof previous.token !== 'string' ||
              !Number.isSafeInteger(previous.expiresAt))
          )
            fail();
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
          });
          return { completed: false, attempt };
        });
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
            tx.update(recordRef, { startAttemptedAt: r.readTime.toMillis() });
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
        await db.runTransaction(async (tx) => {
          const r = await authority(tx);
          if (
            r.get('lease.token') !== token ||
            r.get('lease.expiresAt') <= r.readTime.toMillis() ||
            (r.get('runId') && r.get('runId') !== description.runId)
          )
            fail();
          tx.update(recordRef, {
            runId: description.runId,
            dispatchAcknowledged: true,
            startHistoryDigest: digest(JSON.parse(JSON.stringify(history))),
            observedAt: r.readTime.toMillis(),
          });
        });
      }
      return true;
    } catch {
      return false;
    } // No SDK error, task token, payload or native identity is exported.
  }
}
