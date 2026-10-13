import { randomUUID } from 'node:crypto';
import type { Firestore, DocumentReference } from 'firebase-admin/firestore';
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from '@temporalio/common';
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
  leaseToken?: string;
  leaseExpiresAt?: number;
  nextAttemptAt?: number;
  attempt?: number;
}
interface Lease {
  ref: DocumentReference;
  value: OutboxRecord;
  token: string;
}
export interface DispatcherOptions {
  db: Firestore;
  client: Pick<Client, 'workflow'>;
  projectId: string;
  owner?: string;
  now?: () => number;
  leaseMs?: number;
  batchSize?: number;
}
const args = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
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
  private async claim(ref: DocumentReference): Promise<Lease | undefined> {
    return this.options.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const value = snapshot.data() as OutboxRecord | undefined;
      const now = this.now();
      if (
        !value ||
        value.state === 'dispatched' ||
        (value.nextAttemptAt ?? 0) > now ||
        (value.leaseExpiresAt ?? 0) > now
      )
        return undefined;
      const project = value.dispatch?.ref.projectId ?? value.ref?.projectId ?? value.projectId;
      if (project !== this.options.projectId) throw new Error('OUTBOX_PROJECT_MISMATCH');
      const token = randomUUID();
      tx.update(ref, {
        state: 'dispatching',
        leaseOwner: this.owner,
        leaseToken: token,
        leaseExpiresAt: now + (this.options.leaseMs ?? 60_000),
        attempt: (value.attempt ?? 0) + 1,
      });
      return { ref, value, token };
    });
  }
  private async settle(lease: Lease, error?: unknown): Promise<void> {
    await this.options.db.runTransaction(async (tx) => {
      const current = (await tx.get(lease.ref)).data() as OutboxRecord | undefined;
      if (current?.leaseToken !== lease.token) return;
      tx.update(
        lease.ref,
        error
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
    });
  }
  private async send(value: OutboxRecord): Promise<void> {
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
      const options = {
        workflowId: dispatch.workflowId,
        taskQueue: dispatch.taskQueue,
        args: args(dispatch.startArgs ?? dispatch.ref),
        workflowIdReusePolicy: dispatch.signal
          ? WorkflowIdReusePolicy.ALLOW_DUPLICATE
          : WorkflowIdReusePolicy.REJECT_DUPLICATE,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      };
      if (dispatch.signal) {
        await this.options.client.workflow.signalWithStart(dispatch.workflowType, {
          ...options,
          signal: dispatch.signal.name,
          signalArgs: args(dispatch.signal.args),
        });
      } else {
        try {
          await this.options.client.workflow.start(dispatch.workflowType, options);
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
    const handle = this.options.client.workflow.getHandle(value.workflowId);
    if (value.signal) await handle.signal(value.signal.name, ...args(value.signal.args));
    else if (value.action === 'cancel') await handle.cancel();
    else throw new Error('COMMAND_SIGNAL_REQUIRED');
  }
  async tick(): Promise<void> {
    let successful = true;
    for (const collection of ['durableJobOutbox', 'durableJobCommands']) {
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
        if (this.stopped) return;
        const lease = await this.claim(snapshot.ref);
        if (!lease) continue;
        try {
          await this.send(lease.value);
          await this.settle(lease);
        } catch (error) {
          await this.settle(lease, error);
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
