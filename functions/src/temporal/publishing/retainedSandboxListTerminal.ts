import type { DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';
import { acknowledgedProjectionDigest as digest } from './acknowledgedProjectionDigest';

export const SANDBOX_LIST_PARTIAL_STOP_TERMINALS = 'temporalSandboxListPartialStopTerminals';

/** Written create-only by the trusted reader of the native workflow's close history. */
export interface SandboxListPartialStopTerminal {
  schemaVersion: 1;
  source: 'temporal_workflow_history';
  projectId: string;
  jobId: string;
  sessionId: string;
  generation: number;
  workflowId: string;
  runId: string;
  closeEventId: number;
  closeEventType: 'WorkflowExecutionCanceled';
  stopDigest: string;
  commandId: string;
}

const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const immutable = (doc: DocumentSnapshot) => doc.exists && doc.createTime?.isEqual(doc.updateTime!) === true;

/** Authorizes reuse of this physical lock only. The original request remains unknown. */
export async function isTerminalSandboxListPartialStop(
  tx: Transaction,
  db: Firestore,
  projectId: string,
  owner: DocumentSnapshot,
  lock: DocumentSnapshot
): Promise<boolean> {
  if (
    projectId !== 'urm-app-staging' ||
    !('projectId' in db) ||
    db.projectId !== projectId ||
    db.databaseId !== '(default)' ||
    owner.get('state') !== 'sandbox_partial_stop'
  )
    return false;
  const jobId = owner.get('scope.jobId');
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(jobId)) return false;
  const scope = { projectId, jobId, operation: `publishing:${jobId}:lists:publish:all` };
  const keys = owner.get('resourceKeys');
  const resources = owner.get('resources');
  if (
    owner.get('schemaVersion') !== 1 ||
    digest(scope) !== owner.id ||
    digest(owner.get('scope')) !== owner.id ||
    !Array.isArray(keys) ||
    keys.length < 2 ||
    keys.length > 16 ||
    !keys.every(sha) ||
    new Set(keys).size !== keys.length ||
    !keys.includes(lock.id) ||
    !Array.isArray(resources) ||
    resources.length !== keys.length ||
    !resources.every(
      (resource, index) =>
        resource?.provider === 'subsplash' &&
        resource.account === 'app:9XTSHD' &&
        resource.resourceType === 'list' &&
        typeof resource.resourceId === 'string' &&
        /^[A-Za-z0-9_-]{1,200}$/.test(resource.resourceId) &&
        keys[index] === digest([projectId, resource.provider, resource.account, resource.resourceId])
    ) ||
    lock.get('schemaVersion') !== 1 ||
    lock.get('state') !== 'held' ||
    lock.get('projectId') !== projectId ||
    lock.get('jobId') !== jobId ||
    lock.get('sessionId') !== owner.id
  )
    return false;

  const [stop, terminal, job] = await tx.getAll(
    db.doc(`temporalSandboxListPartialStops/${owner.id}`),
    db.doc(`${SANDBOX_LIST_PARTIAL_STOP_TERMINALS}/${owner.id}`),
    db.doc(`durableJobs/${jobId}`)
  );
  if (!immutable(stop) || !immutable(terminal) || !job.exists) return false;
  const witness = terminal.data() as SandboxListPartialStopTerminal;
  const stopDigest = digest(stop.data());
  return (
    owner.updateTime?.isEqual(stop.createTime!) === true &&
    (terminal.createTime!.seconds > stop.createTime!.seconds ||
      (terminal.createTime!.seconds === stop.createTime!.seconds &&
        terminal.createTime!.nanoseconds > stop.createTime!.nanoseconds)) &&
    stop.get('schemaVersion') === 1 &&
    stop.get('projectId') === projectId &&
    stop.get('jobId') === jobId &&
    stop.get('sessionId') === owner.id &&
    owner.get('sandboxPartialStopDigest') === stopDigest &&
    digest(stop.get('resourceKeys')) === digest([...keys].sort()) &&
    ['sourceDigest', 'claimDigest', 'journalDigest', 'projectionDigest', 'approvalDigest', 'commandId'].every((field) =>
      sha(stop.get(field))
    ) &&
    digest(stop.get('result')) ===
      digest({ state: 'completed', mode: 'partial_stop', providerEffects: 'partial', contentPreserved: true }) &&
    witness.schemaVersion === 1 &&
    witness.source === 'temporal_workflow_history' &&
    witness.projectId === projectId &&
    witness.jobId === jobId &&
    witness.sessionId === owner.id &&
    witness.stopDigest === stopDigest &&
    witness.commandId === stop.get('commandId') &&
    Number.isSafeInteger(witness.generation) &&
    witness.generation > 0 &&
    witness.generation === stop.get('generation') &&
    typeof witness.workflowId === 'string' &&
    witness.workflowId.length > 0 &&
    witness.workflowId === stop.get('workflowId') &&
    typeof witness.runId === 'string' &&
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(witness.runId) &&
    Number.isSafeInteger(witness.closeEventId) &&
    witness.closeEventId > 0 &&
    witness.closeEventType === 'WorkflowExecutionCanceled' &&
    job.get('jobId') === jobId &&
    job.get('projectId') === projectId &&
    job.get('kind') === 'sermon.publish' &&
    job.get('state') === 'cancelled' &&
    job.get('generation') === witness.generation &&
    job.get('workflowId') === witness.workflowId
  );
}
