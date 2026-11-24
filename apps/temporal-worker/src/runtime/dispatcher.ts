import { createHash, randomUUID } from 'node:crypto';
import { TEMPORAL_RELEASE_CONTROL_PATH } from '@upperroom/orchestration/release-admission';
import type { Firestore, DocumentReference } from 'firebase-admin/firestore';
import {
  encodeWorkflowIdConflictPolicy,
  encodeWorkflowIdReusePolicy,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
} from '@temporalio/common';
import { encodeToPayloadsWithContext } from '@temporalio/common/lib/internal-non-workflow';
import type { Client } from '@temporalio/client';
import { durableEntityKey } from '@upperroom/orchestration/job-store';
import { providerMutationFingerprint } from '../../../../functions/src/temporal/publishing/providerMutationGuard';
import { isDurableJobTerminal, type DurableWorkflowDispatch } from '@upperroom/contracts/temporal';

interface OutboxRecord {
  projectId?: string;
  jobId?: string;
  state: 'pending' | 'dispatching' | 'dispatched';
  dispatch?: DurableWorkflowDispatch;
  ref?: { projectId: string; jobId: string };
  workflowId?: string;
  action?: string;
  cancellationReason?: 'superseded';
  generation?: number;
  evidenceVersion?: number;
  signal?: { name: string; args: unknown[] | Record<string, unknown> };
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: number;
  nextAttemptAt?: number;
  attempt?: number;
}
interface Lease {
  ref: DocumentReference;
  value: OutboxRecord;
  token: string;
  expiresAt: number;
  authority?: { releaseId: string; revision: number };
}
export interface DispatcherOptions {
  db: Firestore;
  client: Pick<Client, 'workflow' | 'workflowService'>;
  projectId: string;
  owner?: string;
  now?: () => number;
  leaseMs?: number;
  batchSize?: number;
  /** Independent HTTP dispatch must obtain each lease under open release admission. */
  requireOpenAdmission?: boolean;
}
// Global admission controls the independent producer. Per-domain ownership remains
// enforced by native workflows/Activities; already-claimed work still needs release drain.
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function openAuthority(value: unknown): Lease['authority'] {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.releaseId !== 'string' ||
    !value.releaseId.trim() ||
    value.admission !== 'open' ||
    !record(value.domains)
  )
    return undefined;
  const domains = value.domains;
  const validDomains = ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].every((domain) => {
    const state = domains[domain];
    return (
      record(state) &&
      (state.owner === 'temporal' || state.owner === 'legacy') &&
      (state.admission === 'open' || state.admission === 'paused')
    );
  });
  if (validDomains) return { releaseId: value.releaseId, revision: Number(value.revision) };
}
const args = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const formerStartQueues: ReadonlyMap<string, string> = new Map([
  ['emailDeliveryWorkflow', 'urm-email'],
  ['SearchDocument', 'urm-search'],
  ['SearchBackfill', 'urm-search'],
  ['ImageIngest', 'urm-images'],
  ['ImageDelete', 'urm-images'],
  ['ImageReceiptReconciliation', 'urm-images'],
]);
/** Outbox ownership is a lease, never a process-local flag. A lost Temporal acknowledgement
 * is retried with the same Workflow ID; singleton signal handlers deduplicate job references. */
export class OutboxDispatcher {
  private readonly owner: string;
  private readonly now: () => number;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private inflight?: Promise<void>;
  healthy = false;
  constructor(private readonly options: DispatcherOptions) {
    this.owner = options.owner ?? randomUUID();
    this.now = options.now ?? Date.now;
  }
  private async claim(ref: DocumentReference, signal?: AbortSignal): Promise<Lease | undefined | null> {
    return this.options.db.runTransaction(async (tx) => {
      const authority = this.options.requireOpenAdmission
        ? openAuthority((await tx.get(this.options.db.doc(TEMPORAL_RELEASE_CONTROL_PATH))).data())
        : undefined;
      if (this.options.requireOpenAdmission && !authority) return null;
      const snapshot = await tx.get(ref);
      const value = snapshot.data() as OutboxRecord | undefined;
      const now = this.now();
      if (
        this.stopped ||
        signal?.aborted ||
        !value ||
        !['pending', 'dispatching'].includes(value.state) ||
        (value.nextAttemptAt ?? 0) > now ||
        (value.leaseExpiresAt ?? 0) > now
      )
        return undefined;
      const project = value.dispatch?.ref.projectId ?? value.ref?.projectId ?? value.projectId;
      if (project !== this.options.projectId) throw new Error('OUTBOX_PROJECT_MISMATCH');
      const token = randomUUID();
      const expiresAt = now + (this.options.leaseMs ?? 60_000);
      tx.update(ref, {
        state: 'dispatching',
        leaseOwner: this.owner,
        leaseToken: token,
        leaseExpiresAt: expiresAt,
        attempt: (value.attempt ?? 0) + 1,
      });
      return { ref, value, token, expiresAt, authority };
    });
  }
  private ownsLease(lease: Lease, current: OutboxRecord | undefined): boolean {
    return (
      current?.state === 'dispatching' &&
      current.leaseOwner === this.owner &&
      current.leaseToken === lease.token &&
      current.leaseExpiresAt === lease.expiresAt &&
      this.now() < lease.expiresAt
    );
  }
  private async assertSendAuthority(lease: Lease, signal?: AbortSignal): Promise<void> {
    await this.options.db.runTransaction(
      async (tx) => {
        const current = (await tx.get(lease.ref)).data() as OutboxRecord | undefined;
        if (!this.ownsLease(lease, current)) throw new Error('OUTBOX_LEASE_EXPIRED');
        if (lease.authority) {
          const authority = openAuthority((await tx.get(this.options.db.doc(TEMPORAL_RELEASE_CONTROL_PATH))).data());
          if (authority?.releaseId !== lease.authority.releaseId || authority.revision !== lease.authority.revision)
            throw new Error('OUTBOX_ADMISSION_CHANGED');
        }
      },
      { readOnly: true }
    );
    if (this.stopped || signal?.aborted || this.now() >= lease.expiresAt) throw new Error('DISPATCH_INTERRUPTED');
  }
  private async settle(lease: Lease, outcome: 'acknowledged' | 'retry'): Promise<boolean> {
    return this.options.db.runTransaction(async (tx) => {
      const current = (await tx.get(lease.ref)).data() as OutboxRecord | undefined;
      if (!current || !this.ownsLease(lease, current)) return false;
      tx.update(
        lease.ref,
        outcome === 'retry'
          ? {
              state: 'pending',
              leaseExpiresAt: 0,
              nextAttemptAt: this.now() + Math.min(300_000, 1000 * 2 ** Math.min(current.attempt ?? 1, 8)),
              lastErrorCode: 'TEMPORAL_DISPATCH_UNAVAILABLE',
            }
          : current.action === 'evidence_available' &&
            (current.evidenceVersion ?? 0) > (lease.value.evidenceVersion ?? 0)
          ? {
              state: 'pending',
              leaseExpiresAt: 0,
              nextAttemptAt: 0,
              acknowledgedEvidenceVersion: lease.value.evidenceVersion ?? 0,
            }
          : { state: 'dispatched', leaseExpiresAt: 0, acknowledgedAt: this.now() }
      );
      return true;
    });
  }
  private async send(lease: Lease, signal?: AbortSignal): Promise<void> {
    const { value } = lease;
    const dispatch = value.dispatch;
    if (dispatch) {
      if (
        dispatch.ref.projectId !== this.options.projectId ||
        !dispatch.workflowId.split(':').includes(this.options.projectId)
      )
        throw new Error('INVALID_WORKFLOW_SCOPE');
      const job = (await this.options.db.collection('durableJobs').doc(dispatch.ref.jobId).get()).data();
      if (job && job.projectId !== this.options.projectId) throw new Error('INVALID_JOB_SCOPE');
      if (job && isDurableJobTerminal(job.state)) return;
      // Pending legacy outbox records retain their job and workflow IDs. A
      // previously accepted run keeps its original queue under USE_EXISTING.
      if (typeof dispatch.taskQueue !== 'string' || !dispatch.taskQueue.trim())
        throw new Error('INVALID_WORKFLOW_QUEUE');
      const taskQueue =
        formerStartQueues.get(dispatch.workflowType) === dispatch.taskQueue ? 'urm-orchestration' : dispatch.taskQueue;
      const startArgs = args(dispatch.startArgs ?? dispatch.ref);
      if (dispatch.signal) {
        // The SDK's high-level SignalWithStart chooses a new ID per invocation.
        // Native retries of one outbox record must reuse its original request ID.
        const { workflow, workflowService } = this.options.client;
        const { namespace, identity, loadedDataConverter } = workflow.options;
        const context = { type: 'workflow' as const, namespace, workflowId: dispatch.workflowId };
        const [input, signalInput] = await Promise.all([
          encodeToPayloadsWithContext(loadedDataConverter, context, startArgs),
          encodeToPayloadsWithContext(loadedDataConverter, context, args(dispatch.signal.args)),
        ]);
        const requestId = createHash('sha256')
          .update(JSON.stringify([namespace, this.options.projectId, lease.ref.path]))
          .digest('hex');
        await this.assertSendAuthority(lease, signal);
        await workflowService.signalWithStartWorkflowExecution({
          namespace,
          identity,
          requestId,
          workflowId: dispatch.workflowId,
          workflowType: { name: dispatch.workflowType },
          taskQueue: { name: taskQueue },
          workflowIdReusePolicy: encodeWorkflowIdReusePolicy(WorkflowIdReusePolicy.ALLOW_DUPLICATE),
          workflowIdConflictPolicy: encodeWorkflowIdConflictPolicy(WorkflowIdConflictPolicy.USE_EXISTING),
          input: { payloads: input },
          signalName: dispatch.signal.name,
          signalInput: { payloads: signalInput },
        });
      } else {
        await this.assertSendAuthority(lease, signal);
        try {
          await this.options.client.workflow.start(dispatch.workflowType, {
            workflowId: dispatch.workflowId,
            taskQueue,
            args: startArgs,
            workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
          });
        } catch (error) {
          if ((error as { name?: string }).name !== 'WorkflowExecutionAlreadyStartedError') throw error;
        }
      }
      return;
    }
    const commandRef =
      value.ref ?? (value.jobId && value.projectId ? { jobId: value.jobId, projectId: value.projectId } : undefined);
    if (
      !commandRef ||
      commandRef.projectId !== this.options.projectId ||
      !value.workflowId?.split(':').includes(this.options.projectId)
    )
      throw new Error('INVALID_COMMAND_SCOPE');
    const job = (await this.options.db.collection('durableJobs').doc(commandRef.jobId).get()).data();
    if (job && job.projectId !== this.options.projectId) throw new Error('INVALID_JOB_SCOPE');
    if (
      job &&
      isDurableJobTerminal(job.state) &&
      !(job.state === 'superseded' && value.action === 'cancel' && value.cancellationReason === 'superseded')
    )
      return;
    if (value.action === 'evidence_available') {
      const payloads = args(value.signal?.args),
        payload = payloads[0] as Record<string, unknown> | undefined;
      if (
        !job ||
        value.signal?.name !== 'publishingEvidenceAvailable' ||
        payloads.length !== 1 ||
        !payload ||
        Object.keys(payload).sort().join(',') !== 'factId,generation,jobId,projectId,sessionId' ||
        payload.projectId !== commandRef.projectId ||
        payload.jobId !== commandRef.jobId ||
        payload.generation !== job.generation ||
        value.generation !== job.generation ||
        job.workflowId !== value.workflowId ||
        typeof payload.sessionId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(payload.sessionId) ||
        typeof payload.factId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(payload.factId)
      )
        return;
      const [session, fact, intent] = await Promise.all([
        this.options.db.collection('temporalProviderMutationSessions').doc(payload.sessionId).get(),
        this.options.db.collection('temporalProviderMutationFacts').doc(payload.factId).get(),
        this.options.db.collection('durableJobIntents').doc(commandRef.jobId).get(),
      ]);
      const scope = session.get('scope');
      if (
        !scope ||
        scope.projectId !== commandRef.projectId ||
        scope.jobId !== commandRef.jobId ||
        providerMutationFingerprint(scope) !== payload.sessionId ||
        fact.get('sessionId') !== payload.sessionId ||
        typeof fact.get('step') !== 'string' ||
        typeof fact.get('claim') !== 'string' ||
        providerMutationFingerprint([payload.sessionId, fact.get('step'), fact.get('claim')]) !== payload.factId ||
        intent.get('projectId') !== commandRef.projectId ||
        intent.get('generation') !== job.generation ||
        !['acknowledged', 'rejected_no_effect'].includes(fact.get('completion'))
      )
        return;
      const [request, entity] = await Promise.all([
        this.options.db
          .collection('temporalProviderMutationSessions')
          .doc(payload.sessionId)
          .collection('requests')
          .doc(providerMutationFingerprint(fact.get('step')))
          .get(),
        this.options.db
          .collection('durableJobEntities')
          .doc(durableEntityKey(commandRef.projectId, intent.get('entity'), intent.get('kind')))
          .get(),
      ]);
      if (
        request.get('claim') !== fact.get('claim') ||
        request.get('executionId') !== fact.get('executionId') ||
        request.get('fingerprint') !== fact.get('fingerprint') ||
        !['acknowledged', 'rejected_no_effect', 'acknowledged_unprojectable'].includes(request.get('state')) ||
        entity.get('generation') !== job.generation ||
        entity.get('activeJobId') !== commandRef.jobId
      )
        return;
    }
    await this.assertSendAuthority(lease, signal);
    const handle = this.options.client.workflow.getHandle(value.workflowId);
    if (value.signal) await handle.signal(value.signal.name, ...args(value.signal.args));
    else if (value.action === 'cancel') await handle.cancel();
    else throw new Error('COMMAND_SIGNAL_REQUIRED');
  }
  async tick(signal?: AbortSignal): Promise<void> {
    this.healthy = false;
    if (
      this.options.requireOpenAdmission &&
      !openAuthority((await this.options.db.doc(TEMPORAL_RELEASE_CONTROL_PATH).get()).data())
    )
      return;
    let successful = true;
    for (const collection of ['durableJobOutbox', 'durableJobCommands']) {
      if (this.stopped || signal?.aborted) return;
      // Both pending and expired dispatching leases are scanned. No query depends on
      // an acknowledgement having been written by the previous process.
      const [pending, expired] = await Promise.all([
        this.options.db
          .collection(collection)
          .where('state', '==', 'pending')
          .where('nextAttemptAt', '<=', this.now())
          .orderBy('nextAttemptAt')
          .limit(this.options.batchSize ?? 100)
          .get(),
        this.options.db
          .collection(collection)
          .where('state', '==', 'dispatching')
          .where('leaseExpiresAt', '<=', this.now())
          .orderBy('leaseExpiresAt')
          .limit(this.options.batchSize ?? 100)
          .get(),
      ]);
      for (const snapshot of [...pending.docs, ...expired.docs]) {
        if (this.stopped || signal?.aborted) return;
        const lease = await this.claim(snapshot.ref, signal);
        if (lease === null) return;
        if (!lease) continue;
        try {
          await this.send(lease, signal);
          if (this.stopped || signal?.aborted) return;
          if (!(await this.settle(lease, 'acknowledged'))) successful = false;
        } catch {
          if (this.stopped || signal?.aborted) return;
          await this.settle(lease, 'retry');
          successful = false;
        }
      }
    }
    this.healthy = successful;
  }
  start(): void {
    const loop = () => {
      if (this.stopped) return;
      this.inflight = this.tick()
        .catch(() => {
          this.healthy = false;
        })
        .finally(() => {
          if (!this.stopped) {
            this.timer = setTimeout(loop, 1000);
            this.timer.unref();
          }
        });
    };
    loop();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.healthy = false;
    if (this.timer) clearTimeout(this.timer);
    await this.inflight;
  }
}
