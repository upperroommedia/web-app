import { createHash } from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { extractProviderResources, prepareProviderUsageChange } from './provider-usage';
export { withProviderIndexedTransaction } from './provider-transaction';
import {
  isDurableJobKind,
  isDurableJobTerminal,
  type DurableEntityRef,
  type DurableJob,
  type DurableJobKind,
  type DurableJobRef,
  type DurableJobState,
  type DurableJobStep,
  type DurableWorkflowDispatch,
} from '@upperroom/contracts/temporal';

export const DURABLE_COLLECTIONS = {
  jobs: 'durableJobs',
  intents: 'durableJobIntents',
  outbox: 'durableJobOutbox',
  entities: 'durableJobEntities',
  commands: 'durableJobCommands',
  critical: 'durableJobCriticalSections',
  executions: 'durableActivityExecutions',
  stepExecutions: 'durableJobStepExecutions',
  drains: 'durableActivityDrains',
} as const;

export interface DurableWorkerWitness {
  instanceId: string;
  buildId: string;
  podUid?: string;
  podName?: string;
  namespace?: string;
  clusterId?: string;
  nodeUid?: string;
  nodeName?: string;
  containerIds?: string[];
}
/** Trusted Temporal metadata, never caller payload or a local wall-clock epoch. */
export interface DurableActivityExecution {
  workflowId: string;
  runId: string;
  activityId: string;
  activityType: string;
  scheduledAt: number;
  attempt: number;
  /** Exact nanoseconds from Temporal DescribeWorkflowExecution, never a local clock. */
  runStartedAtNanos?: string;
  temporalNamespace?: string;
  worker?: DurableWorkerWitness;
}
interface DurableExecutionHead extends DurableActivityExecution {
  projectId: string;
  jobId: string;
  executionId: string;
  epoch: number;
  updatedAt: number;
  stepIds?: string[];
  countsAttempt?: boolean;
}
interface DurableStepExecutionHead extends DurableExecutionHead {
  stepId: string;
  uiAttemptBase: number;
}
export function durableActivityDrainKey(projectId: string, jobId: string, value: DurableActivityExecution): string {
  return createHash('sha256')
    .update(JSON.stringify([projectId, jobId, executionId(value), value.attempt, value.worker?.instanceId ?? null]))
    .digest('hex');
}
function executionId(value: DurableActivityExecution): string {
  return createHash('sha256')
    .update(JSON.stringify([value.workflowId, value.runId, value.activityId, value.scheduledAt]))
    .digest('hex');
}
function compareExecution(next: DurableActivityExecution, previous: DurableActivityExecution): number {
  if (executionId(next) === executionId(previous)) return 0;
  if (next.scheduledAt !== previous.scheduledAt) return next.scheduledAt > previous.scheduledAt ? 1 : -1;
  if (next.runId === previous.runId && /^\d+$/.test(next.activityId) && /^\d+$/.test(previous.activityId)) {
    return BigInt(next.activityId) > BigInt(previous.activityId) ? 1 : -1;
  }
  if (
    next.runStartedAtNanos !== undefined &&
    previous.runStartedAtNanos !== undefined &&
    next.runStartedAtNanos !== previous.runStartedAtNanos
  )
    return BigInt(next.runStartedAtNanos) > BigInt(previous.runStartedAtNanos) ? 1 : -1;
  throw new DurableJobStoreError(
    'STALE_EXECUTION',
    'Execution order is ambiguous; verify the Temporal workflow run before proceeding'
  );
}
function validateExecution(value: DurableActivityExecution): void {
  for (const key of ['workflowId', 'runId', 'activityId', 'activityType'] as const)
    boundedString(value[key], key, 1024);
  finite(value.scheduledAt, 'Temporal schedule timestamp');
  if (value.temporalNamespace !== undefined) boundedString(value.temporalNamespace, 'Temporal namespace');
  if (value.worker) {
    boundedString(value.worker.instanceId, 'worker instance id');
    boundedString(value.worker.buildId, 'worker build id');
    for (const key of ['podUid', 'podName', 'namespace', 'clusterId', 'nodeUid', 'nodeName'] as const)
      if (value.worker[key] !== undefined) boundedString(value.worker[key], key);
    if (
      value.worker.containerIds &&
      (value.worker.containerIds.length > 32 ||
        value.worker.containerIds.some((id) => typeof id !== 'string' || !id || id.length > 512))
    )
      invalid('Invalid worker container identities');
    if (
      Object.keys(value.worker).some(
        (key) =>
          ![
            'instanceId',
            'buildId',
            'podUid',
            'podName',
            'namespace',
            'clusterId',
            'nodeUid',
            'nodeName',
            'containerIds',
          ].includes(key)
      )
    )
      invalid('Unexpected worker witness detail');
  }
  if (value.runStartedAtNanos !== undefined && !/^[0-9]{1,30}$/.test(value.runStartedAtNanos))
    invalid('Invalid authoritative Temporal run start timestamp');
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 1) invalid('Invalid Temporal activity attempt');
}

/** Private enrollment in the fenced source catalogue producer protocol. Not a drain proof. */
export const PUBLISHING_SOURCE_PROTOCOL = 'publishing-source-catalog-v1' as const;
export function isPublishingSourceProtocolIntent(kind: DurableJobKind, payload: Record<string, unknown>): boolean {
  return (
    kind.startsWith('sermon.') ||
    kind.startsWith('list.') ||
    kind.startsWith('series.') ||
    kind === 'speaker.mutate' ||
    kind === 'provider.orphan_review' ||
    (kind === 'maintenance.run' && payload.operation !== 'media_artifacts_cleanup')
  );
}

export interface DurableJobIntent<T = Record<string, unknown>> extends DurableJobRef {
  schemaVersion: 1;
  kind: DurableJobKind;
  entity: DurableEntityRef;
  actorUid: string;
  payload: T;
  /** Present only for newly admitted publishing intents; old records require explicit bootstrap. */
  publishingSourceProtocol?: typeof PUBLISHING_SOURCE_PROTOCOL;
  generation: number;
  createdAt: number;
}
export interface DurableOutboxRecord extends DurableJobRef {
  schemaVersion: 1;
  dispatch: DurableWorkflowDispatch;
  state: 'pending' | 'dispatching' | 'dispatched' | 'failed';
  attempt: number;
  createdAt: number;
  updatedAt: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  nextAttemptAt?: number;
  dispatchedAt?: number;
  lastErrorCode?: string;
}
export interface DurableEntityState {
  schemaVersion: 1;
  projectId: string;
  entity: DurableEntityRef;
  scope: string;
  generation: number;
  activeJobId: string;
  updatedAt: number;
}
export interface CreateDurableJobInput {
  ref: DurableJobRef;
  kind: DurableJobKind;
  entity: DurableEntityRef;
  actorUid: string;
  payload: Record<string, unknown>;
  requestId: string;
  generation: number;
  dispatch: DurableWorkflowDispatch;
  initialState?: 'awaiting_source' | 'queued';
  createdAt: number;
}
export type DurableJobPatch = Partial<
  Pick<
    DurableJob,
    'state' | 'startedAt' | 'finishedAt' | 'steps' | 'actions' | 'destinations' | 'attention' | 'error' | 'result'
  >
> & { expectedRevision?: number };

export class DurableJobStoreError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'PROJECT_MISMATCH'
      | 'INVALID_ARGUMENT'
      | 'STALE_GENERATION'
      | 'STALE_REVISION'
      | 'TERMINAL_JOB'
      | 'STALE_STEP'
      | 'STALE_EXECUTION',
    message: string
  ) {
    super(message);
    this.name = 'DurableJobStoreError';
  }
}

/** Independent media processing and publishing generations must not supersede one another. */
export function getDurableJobScope(kind: DurableJobKind): string {
  if (kind === 'audio.process' || kind === 'youtube.authRecovery') return 'audio';
  if (kind === 'upload.create') return 'upload';
  if (kind.startsWith('sermon.')) return 'publishing';
  if (kind.startsWith('search.')) return 'search';
  if (kind.startsWith('image.')) return 'image';
  if (kind.startsWith('list.')) return 'list';
  if (kind === 'series.sync_metadata') return 'series-derived';
  if (kind.startsWith('series.')) return 'series';
  if (kind.startsWith('speaker.')) return 'speaker';
  if (kind === 'invite.claim' || kind === 'role.resolve' || kind === 'role.assign') return 'account-access';
  if (kind.startsWith('invite.')) return 'invite';
  if (kind === 'bundle.regenerate') return 'bundle';
  if (kind === 'email.deliver') return 'email';
  return 'maintenance';
}
export function durableEntityKey(projectId: string, entity: DurableEntityRef, kind: DurableJobKind): string {
  return createHash('sha256')
    .update(JSON.stringify([projectId, entity.type, entity.id, getDurableJobScope(kind)]))
    .digest('hex');
}
export const getDurableEntityKey = durableEntityKey;

const STATES = new Set<DurableJobState>([
  'awaiting_source',
  'queued',
  'running',
  'retrying',
  'waiting_for_auth',
  'cancel_requested',
  'reconciling',
  'needs_attention',
  'succeeded',
  'failed',
  'cancelled',
  'superseded',
]);
const STEP_STATES = new Set([
  'pending',
  'running',
  'retrying',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
]);
const SAFE_RESULT_KEYS = new Set([
  'sermonId',
  'listId',
  'seriesId',
  'speakerId',
  'imageId',
  'userId',
  'mailId',
  'storagePath',
  'processedPath',
  'finalPath',
  'generation',
  'revision',
  'requestVersion',
  'durationSeconds',
  'subsplashId',
  'soundcloudId',
  'remoteId',
  'count',
  'processedCount',
  'status',
  'deleted',
  'uploaded',
  'bundlePath',
  'sourceReady',
  'uploadSessionId',
  'sourceUpload',
  'mediaJobId',
  'mediaJobRef',
  'replacementJobId',
  'resolutionPurpose',
  'receiptId',
  'acknowledgementId',
  'blockingJobId',
  'remoteRetained',
  'sourceJobId',
  'sourceEntityId',
  'sourceEntityType',
  'mutationSessionId',
  'mode',
  'providerEffects',
  'contentPreserved',
]);
const UNSAFE_KEYS =
  /(?:password|secret|token|credential|cookie|authorization|signed.?url|smtp|private.?key|body|html|plaintext|buffer|bytes|stack|response)/i;
function invalid(message: string): never {
  throw new DurableJobStoreError('INVALID_ARGUMENT', message);
}
function boundedString(value: unknown, label: string, max = 256): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f]/.test(value))
    invalid(`Invalid ${label}`);
}
function safeText(value: unknown, label: string, max = 512): asserts value is string {
  boundedString(value, label, max);
  // Raw URLs/provider diagnostics may contain authorization even when their object keys are safe.
  if (
    /(?:https?:\/\/|bearer\s|-----BEGIN|\beyJ[A-Za-z0-9_-]{12,}\.|[?&](?:token|key|signature)=)/i.test(value as string)
  )
    invalid(`Unsafe ${label}`);
}
function finite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(`Invalid ${label}`);
}
function copyDefined<T>(value: T): T {
  if (value === undefined) return value;
  if (Array.isArray(value)) return value.map(copyDefined) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, copyDefined(v)])
    ) as T;
  }
  return value;
}
function validateError(error: DurableJob['error']): void {
  if (!error) return;
  safeText(error.code, 'error code', 128);
  safeText(error.message, 'error message');
  if (typeof error.retryable !== 'boolean') invalid('Invalid retryable flag');
  if (error.provider && !['subsplash', 'soundcloud', 'youtube', 'algolia', 'smtp', 'storage'].includes(error.provider))
    invalid('Invalid error provider');
  if (Object.keys(error).some((k) => !['code', 'message', 'retryable', 'provider'].includes(k)))
    invalid('Unexpected error detail');
}
function validateStep(step: DurableJobStep): void {
  boundedString(step.id, 'step id', 128);
  safeText(step.label, 'step label', 128);
  if (!STEP_STATES.has(step.state) || !Number.isInteger(step.attempt) || step.attempt < 0) invalid('Invalid step');
  if (
    Object.keys(step).some(
      (k) =>
        !['id', 'label', 'state', 'attempt', 'progress', 'nextRetryAt', 'startedAt', 'finishedAt', 'error'].includes(k)
    )
  )
    invalid('Unexpected step detail');
  if (step.progress) {
    finite(step.progress.completed, 'completed progress');
    finite(step.progress.total, 'total progress');
    if (step.progress.completed > step.progress.total || !['bytes', 'seconds', 'items'].includes(step.progress.unit))
      invalid('Invalid progress');
    if (Object.keys(step.progress).some((k) => !['completed', 'total', 'unit'].includes(k)))
      invalid('Unexpected progress detail');
  }
  for (const key of ['nextRetryAt', 'startedAt', 'finishedAt'] as const)
    if (step[key] !== undefined) finite(step[key], key);
  validateError(step.error);
}
function validatePatch(patch: DurableJobPatch): void {
  if (
    Object.keys(patch).some(
      (k) =>
        ![
          'state',
          'startedAt',
          'finishedAt',
          'steps',
          'actions',
          'destinations',
          'attention',
          'error',
          'result',
          'expectedRevision',
        ].includes(k)
    )
  )
    invalid('Immutable or unknown projection field');
  if (patch.state && !STATES.has(patch.state)) invalid('Invalid state');
  for (const key of ['startedAt', 'finishedAt', 'expectedRevision'] as const)
    if (patch[key] !== undefined) finite(patch[key], key);
  if (patch.steps) {
    if (!Array.isArray(patch.steps) || patch.steps.length > 64) invalid('Too many steps');
    patch.steps.forEach(validateStep);
    if (new Set(patch.steps.map((s) => s.id)).size !== patch.steps.length) invalid('Duplicate steps');
  }
  if (
    patch.actions &&
    (patch.actions.length > 5 ||
      patch.actions.some((a) => !['cancel', 'retry', 'resume', 'resolve', 'resume_upload'].includes(a)))
  )
    invalid('Invalid actions');
  validateError(patch.error);
  if (patch.attention) {
    const attention = patch.attention;
    if (
      ![
        'reconnect_provider',
        'external_result_unknown',
        'remote_drift',
        'source_unavailable',
        'permission_changed',
      ].includes(attention.kind)
    )
      invalid('Invalid attention');
    safeText(attention.message, 'attention message');
    if (attention.stepId) boundedString(attention.stepId, 'attention step id', 128);
    if (attention.receiptId) boundedString(attention.receiptId, 'receipt id');
    if (
      'acknowledgementId' in attention &&
      attention.acknowledgementId !== undefined &&
      (typeof attention.acknowledgementId !== 'string' || !/^[a-f0-9]{64}$/.test(attention.acknowledgementId))
    )
      invalid('Invalid provider acknowledgement id');
    if (
      'resolutionKind' in attention &&
      attention.resolutionKind !== undefined &&
      !['retain_existing_resource', 'critical_repair'].includes(String(attention.resolutionKind))
    )
      invalid('Invalid provider resolution kind');
    if (
      'resolutionDecisions' in attention &&
      attention.resolutionDecisions !== undefined &&
      (!Array.isArray(attention.resolutionDecisions) ||
        attention.resolutionDecisions.length > 2 ||
        new Set(attention.resolutionDecisions).size !== attention.resolutionDecisions.length ||
        attention.resolutionDecisions.some(
          (value) => !['retain_existing_resource', 'confirm_existing_resource_absent'].includes(String(value))
        ))
    )
      invalid('Invalid provider resolution decisions');
    if (
      'requiresRetentionAcknowledgement' in attention &&
      attention.requiresRetentionAcknowledgement !== undefined &&
      (typeof attention.requiresRetentionAcknowledgement !== 'boolean' ||
        attention.resolutionKind !== 'critical_repair')
    )
      invalid('Invalid certified retention capability');
    if (
      'certificateId' in attention &&
      attention.certificateId !== undefined &&
      (typeof attention.certificateId !== 'string' || !/^[a-f0-9]{64}$/.test(attention.certificateId))
    )
      invalid('Invalid repair certificate');
    if (
      'repairPurpose' in attention &&
      attention.repairPurpose !== undefined &&
      !['repair_confirmed_changes', 'complete_fixed_cleanup'].includes(String(attention.repairPurpose))
    )
      invalid('Invalid repair purpose');
    if (attention.resolutionKind === 'critical_repair' && (!attention.certificateId || !attention.repairPurpose))
      invalid('Critical repair requires a certified purpose');
    if (
      'remoteId' in attention &&
      attention.remoteId !== undefined &&
      (typeof attention.remoteId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(attention.remoteId))
    )
      invalid('Invalid attention resource id');
    if (attention.provider)
      validateError({
        code: 'ATTENTION',
        message: 'Attention required',
        retryable: false,
        provider: attention.provider,
      });
    if (
      Object.keys(attention).some(
        (k) =>
          ![
            'kind',
            'message',
            'stepId',
            'provider',
            'receiptId',
            'acknowledgementId',
            'resolutionKind',
            'resolutionDecisions',
            'remoteId',
            'certificateId',
            'repairPurpose',
            'requiresRetentionAcknowledgement',
          ].includes(k)
      )
    )
      invalid('Unexpected attention detail');
  }
  if (patch.destinations) {
    if (patch.destinations.length > 32) invalid('Too many destinations');
    for (const destination of patch.destinations) {
      if (
        !['subsplash', 'soundcloud', 'storage', 'algolia', 'email'].includes(destination.destination) ||
        !['pending', 'running', 'confirmed', 'absent', 'unknown', 'failed'].includes(destination.state)
      )
        invalid('Invalid destination');
      if (destination.remoteId) safeText(destination.remoteId, 'remote id');
      if (destination.message) safeText(destination.message, 'destination message');
      if (Object.keys(destination).some((k) => !['destination', 'state', 'remoteId', 'message'].includes(k)))
        invalid('Unexpected destination detail');
    }
  }
  if (patch.result) {
    if (
      ['mode', 'providerEffects', 'contentPreserved'].some((key) =>
        Object.prototype.hasOwnProperty.call(patch.result, key)
      ) &&
      (patch.result.mode !== 'partial_stop' ||
        !['not_started', 'partial'].includes(String(patch.result.providerEffects)) ||
        patch.result.contentPreserved !== true)
    )
      invalid('Invalid stopped result descriptor');
    for (const [key, value] of Object.entries(patch.result)) {
      if (!SAFE_RESULT_KEYS.has(key) || UNSAFE_KEYS.test(key)) invalid(`Unsafe result field ${key}`);
      if (key === 'sourceJobId' && (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)))
        invalid('Invalid source job id');
      if (
        key === 'sourceEntityType' &&
        !['sermon', 'list', 'series', 'speaker', 'image', 'user', 'mail', 'bundle', 'maintenance'].includes(
          String(value)
        )
      )
        invalid('Invalid source entity type');
      if (key === 'remoteRetained' && typeof value !== 'boolean') invalid('Invalid remote retention flag');
      if (key === 'blockingJobId' && (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)))
        invalid('Invalid blocking job id');
      if (key === 'mutationSessionId' && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))
        invalid('Invalid provider mutation session id');
      if (key === 'acknowledgementId' && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))
        invalid('Invalid provider acknowledgement id');
      if (key === 'resolutionPurpose') {
        if (value !== 'cleanup') invalid('Invalid resolution purpose');
      } else if (key === 'sourceUpload') validateSourceUpload(value);
      else if (key === 'mediaJobRef') validateReference(value);
      else if (typeof value === 'string') safeText(value, 'result value', 1024);
      else if (typeof value === 'number') finite(value, 'result value');
      else if (typeof value !== 'boolean' && value !== null) invalid('Results must contain bounded scalar values');
    }
  }
  if (Buffer.byteLength(JSON.stringify(patch), 'utf8') > 32_768) invalid('Projection exceeds size limit');
}

function validateReference(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid job reference');
  const ref = value as Record<string, unknown>;
  if (Object.keys(ref).some((k) => !['projectId', 'jobId'].includes(k))) invalid('Unexpected reference field');
  boundedString(ref.jobId, 'job id');
  boundedString(ref.projectId, 'project id');
}
function validateSourceUpload(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid source upload descriptor');
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((k) => !['storagePath', 'expectedFile', 'jobRevision'].includes(k)))
    invalid('Unexpected upload descriptor field');
  safeText(source.storagePath, 'upload storage path', 1024);
  finite(source.jobRevision, 'upload job revision');
  const file = source.expectedFile as Record<string, unknown> | undefined;
  if (!file || typeof file !== 'object' || Array.isArray(file)) invalid('Invalid expected upload file');
  if (Object.keys(file).some((k) => !['name', 'size', 'lastModified', 'fingerprint'].includes(k)))
    invalid('Unexpected file descriptor field');
  safeText(file.name, 'file name');
  finite(file.size, 'file size');
  finite(file.lastModified, 'file modification time');
  if (file.fingerprint) {
    const fingerprint = file.fingerprint as Record<string, unknown>;
    if (Object.keys(fingerprint).some((k) => !['algorithm', 'chunkBytes', 'value'].includes(k)))
      invalid('Unexpected fingerprint field');
    if (
      fingerprint.algorithm !== 'sha256-chunks-v1' ||
      fingerprint.chunkBytes !== 4194304 ||
      typeof fingerprint.value !== 'string' ||
      !/^[a-f0-9]{64}$/.test(fingerprint.value)
    )
      invalid('Invalid source fingerprint');
  }
}
const HISTORY_KEYS = new Set([
  'jobId',
  'projectId',
  'sermonId',
  'revision',
  'requestVersion',
  'generation',
  'initial',
  'ref',
  'mediaTaskQueue',
  'cursor',
  'batchSize',
]);
/** Reject accidental business payloads/secrets before they can enter durable workflow history. */
export function validateDispatch(dispatch: DurableWorkflowDispatch): void {
  function visit(value: unknown, depth = 0): void {
    if (depth > 4) invalid('Workflow references are too deeply nested');
    if (!value || typeof value !== 'object' || Array.isArray(value))
      invalid('Workflow arguments must contain references');
    for (const [key, item] of Object.entries(value)) {
      if (!HISTORY_KEYS.has(key)) invalid(`Workflow history field ${key} is not a reference`);
      if (item && typeof item === 'object') visit(item, depth + 1);
      else if (typeof item === 'string') safeText(item, 'workflow reference', 1024);
      else if (typeof item === 'number') finite(item, 'workflow reference');
      else if (item !== null) invalid('Invalid workflow reference');
    }
  }
  if (
    Object.keys(dispatch).some(
      (key) => !['workflowType', 'workflowId', 'taskQueue', 'ref', 'startArgs', 'signal'].includes(key)
    )
  )
    invalid('Unexpected dispatch detail');
  validateReference({ jobId: dispatch.ref.jobId, projectId: dispatch.ref.projectId });
  visit(dispatch.ref);
  if (dispatch.startArgs) visit(dispatch.startArgs);
  if (dispatch.signal) {
    boundedString(dispatch.signal.name, 'signal name');
    visit(dispatch.signal.args);
  }
  if (Buffer.byteLength(JSON.stringify(dispatch)) > 8192) invalid('Workflow dispatch exceeds size limit');
}

function guardStep(previous: DurableJobStep | undefined, next: DurableJobStep): void {
  if (!previous) return;
  if (
    next.attempt < previous.attempt ||
    (next.attempt === previous.attempt &&
      ['succeeded', 'cancelled', 'skipped'].includes(previous.state) &&
      next.state !== previous.state)
  ) {
    throw new DurableJobStoreError('STALE_STEP', 'An older activity attempt cannot overwrite the current step');
  }
  if (
    next.attempt === previous.attempt &&
    previous.progress &&
    next.progress &&
    next.progress.unit === previous.progress.unit &&
    next.progress.total === previous.progress.total &&
    next.progress.completed < previous.progress.completed
  ) {
    throw new DurableJobStoreError('STALE_STEP', 'Step progress cannot move backwards within an attempt');
  }
}

export function createDurableJobStore(options: {
  firestore: Firestore;
  projectId: string;
  authorizeActor?: (intent: DurableJobIntent<unknown>) => Promise<void>;
  now?: () => number;
  getExecution?: () => DurableActivityExecution | undefined;
  /** Read-only certificate planning; commit is called only after every projection read. */
  prepareCriticalAttention?: (
    tx: Transaction,
    job: DurableJob,
    patch: DurableJobPatch
  ) => Promise<{ attention: NonNullable<DurableJobPatch['attention']>; commit(): void } | undefined>;
}) {
  const { firestore, projectId } = options;
  const now = options.now ?? Date.now;
  const checkRef = (ref: DurableJobRef) => {
    if (ref.projectId !== projectId)
      throw new DurableJobStoreError('PROJECT_MISMATCH', 'Job belongs to another environment');
    boundedString(ref.jobId, 'job id');
    if (ref.jobId.includes('/')) invalid('Job id must be a document id');
  };
  const intentDoc = (ref: DurableJobRef) => {
    checkRef(ref);
    return firestore.collection(DURABLE_COLLECTIONS.intents).doc(ref.jobId);
  };
  const jobDoc = (ref: DurableJobRef) => {
    checkRef(ref);
    return firestore.collection(DURABLE_COLLECTIONS.jobs).doc(ref.jobId);
  };
  const entityDoc = (intent: Pick<DurableJobIntent, 'entity' | 'kind'>) =>
    firestore.collection(DURABLE_COLLECTIONS.entities).doc(durableEntityKey(projectId, intent.entity, intent.kind));
  const executionDoc = (ref: DurableJobRef, type: string) =>
    firestore.collection(DURABLE_COLLECTIONS.executions).doc(
      createHash('sha256')
        .update(JSON.stringify([projectId, ref.jobId, type]))
        .digest('hex')
    );
  const stepExecutionDoc = (ref: DurableJobRef, stepId: string) =>
    firestore.collection(DURABLE_COLLECTIONS.stepExecutions).doc(
      createHash('sha256')
        .update(JSON.stringify([projectId, ref.jobId, stepId]))
        .digest('hex')
    );
  function currentExecution(): DurableActivityExecution | undefined {
    const value = options.getExecution?.();
    if (value) validateExecution(value);
    return value;
  }
  function checkExecution(execution: DurableActivityExecution, head: DurableExecutionHead | undefined): void {
    if (
      !head ||
      head.projectId !== projectId ||
      head.executionId !== executionId(execution) ||
      head.attempt !== execution.attempt ||
      head.worker?.instanceId !== execution.worker?.instanceId
    )
      throw new DurableJobStoreError(
        'STALE_EXECUTION',
        'This activity execution has been replaced or was not registered'
      );
  }
  async function assertExecutionInTransaction(
    tx: Transaction,
    ref: DurableJobRef,
    execution = currentExecution()
  ): Promise<DurableExecutionHead | undefined> {
    if (!execution) return undefined;
    const head = (await tx.get(executionDoc(ref, execution.activityType))).data() as DurableExecutionHead | undefined;
    checkExecution(execution, head);
    const boundSteps = await Promise.all((head!.stepIds ?? []).map((stepId) => tx.get(stepExecutionDoc(ref, stepId))));
    for (const snapshot of boundSteps) {
      const step = snapshot.data() as DurableStepExecutionHead | undefined;
      if (!step || step.executionId !== head!.executionId || step.attempt !== execution.attempt)
        throw new DurableJobStoreError('STALE_EXECUTION', 'A newer execution owns this activity step');
    }
    return head;
  }
  function nextStepHead(
    ref: DurableJobRef,
    stepId: string,
    execution: DurableActivityExecution,
    previous: DurableStepExecutionHead | undefined,
    priorAttempt: number,
    countsAttempt = true
  ): DurableStepExecutionHead {
    const order = previous ? compareExecution(execution, previous) : 1;
    if (order < 0 || (order === 0 && previous && execution.attempt < previous.attempt))
      throw new DurableJobStoreError('STALE_EXECUTION', 'A previous execution cannot claim this step');
    const base =
      previous && order === 0
        ? previous.uiAttemptBase
        : Math.max(
            priorAttempt,
            previous ? previous.uiAttemptBase + (previous.countsAttempt === false ? 0 : previous.attempt) : 0
          );
    return {
      ...execution,
      projectId,
      jobId: ref.jobId,
      executionId: executionId(execution),
      epoch: previous ? previous.epoch + (order > 0 ? 1 : 0) : 1,
      stepId,
      uiAttemptBase: base,
      countsAttempt: previous && order === 0 ? previous.countsAttempt !== false : countsAttempt,
      updatedAt: now(),
    };
  }
  /** Registers before any effect. Arrival order never authorizes an older scheduled execution. */
  async function registerActivityExecution(
    ref: DurableJobRef,
    execution: DurableActivityExecution,
    registration: { stepIds?: readonly string[]; countsAttempt?: boolean } = {}
  ): Promise<{ executionId: string; epoch: number }> {
    validateExecution(execution);
    const requested = [...new Set(registration.stepIds ?? [execution.activityType])];
    if (requested.length > 64) invalid('Too many activity step bindings');
    requested.forEach((step) => boundedString(step, 'activity step binding', 128));
    return firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(jobDoc(ref));
      if (!snapshot.exists) throw new DurableJobStoreError('NOT_FOUND', 'Job was not found');
      const job = snapshot.data() as DurableJob;
      if (job.workflowId !== execution.workflowId)
        throw new DurableJobStoreError('STALE_EXECUTION', 'This activity belongs to a different workflow');
      if (job.projectId !== projectId || job.jobId !== ref.jobId)
        throw new DurableJobStoreError('PROJECT_MISMATCH', 'Invalid job identity');
      const target = executionDoc(ref, execution.activityType);
      const previous = (await tx.get(target)).data() as DurableExecutionHead | undefined;
      const order = previous ? compareExecution(execution, previous) : 1;
      if (order < 0 || (order === 0 && previous && execution.attempt < previous.attempt))
        throw new DurableJobStoreError('STALE_EXECUTION', 'An older activity cannot reclaim this execution');
      const stepIds = [...new Set([...requested, ...(order === 0 ? previous?.stepIds ?? [] : [])])];
      if (stepIds.length > 128) invalid('Too many cumulative activity step bindings');
      const steps = await Promise.all(
        stepIds.map(async (stepId) => {
          const target = stepExecutionDoc(ref, stepId);
          const oldStep = (await tx.get(target)).data() as DurableStepExecutionHead | undefined;
          return {
            target,
            value: nextStepHead(
              ref,
              stepId,
              execution,
              oldStep,
              job.steps.find((step) => step.id === stepId)?.attempt ?? 0,
              registration.countsAttempt !== false
            ),
          };
        })
      );
      const head: DurableExecutionHead = {
        ...execution,
        projectId,
        jobId: ref.jobId,
        executionId: executionId(execution),
        epoch: previous ? previous.epoch + (order > 0 ? 1 : 0) : 1,
        stepIds,
        countsAttempt: registration.countsAttempt !== false,
        updatedAt: now(),
      };
      tx.set(target, copyDefined(head));
      steps.forEach((step) => tx.set(step.target, copyDefined(step.value)));
      return { executionId: head.executionId, epoch: head.epoch };
    });
  }
  function getExecutionIdentity(): DurableActivityExecution | undefined {
    const execution = currentExecution();
    return execution ? { ...execution } : undefined;
  }
  /** Trusted worker completion witness. Never call until all spawned provider/native work settles. */
  async function recordActivityExecutionDrained(
    ref: DurableJobRef,
    execution: DurableActivityExecution
  ): Promise<void> {
    validateExecution(execution);
    const target = firestore
      .collection(DURABLE_COLLECTIONS.drains)
      .doc(durableActivityDrainKey(projectId, ref.jobId, execution));
    await firestore.runTransaction(async (tx) => {
      const job = await tx.get(jobDoc(ref));
      const previous = await tx.get(target);
      if (!job.exists) throw new DurableJobStoreError('NOT_FOUND', 'Job was not found');
      if (job.data()?.workflowId !== execution.workflowId || job.data()?.projectId !== projectId)
        throw new DurableJobStoreError('STALE_EXECUTION', 'Invalid completion witness identity');
      if (previous.exists) return;
      // Old executions still need their own witness after newer heads replace them.
      tx.create(
        target,
        copyDefined({
          schemaVersion: 1,
          ...ref,
          executionId: executionId(execution),
          execution,
          state: 'drained',
          drainedAt: now(),
          source: 'worker_settled',
        })
      );
    });
  }
  function checkCurrent(intent: DurableJobIntent<unknown>, entity: DurableEntityState | undefined): void {
    if (
      !entity ||
      entity.projectId !== projectId ||
      entity.generation !== intent.generation ||
      entity.activeJobId !== intent.jobId
    )
      throw new DurableJobStoreError('STALE_GENERATION', 'This job has been replaced by a newer request');
  }
  async function loadIntent<T = Record<string, unknown>>(ref: DurableJobRef): Promise<DurableJobIntent<T>> {
    const snapshot = await intentDoc(ref).get();
    if (!snapshot.exists) throw new DurableJobStoreError('NOT_FOUND', 'Job intent was not found');
    const intent = snapshot.data() as DurableJobIntent<T>;
    if (intent.projectId !== projectId || intent.jobId !== ref.jobId)
      throw new DurableJobStoreError('PROJECT_MISMATCH', 'Invalid intent identity');
    return intent;
  }
  async function loadJob(ref: DurableJobRef): Promise<DurableJob> {
    const snapshot = await jobDoc(ref).get();
    if (!snapshot.exists) throw new DurableJobStoreError('NOT_FOUND', 'Job was not found');
    const job = snapshot.data() as DurableJob;
    if (job.projectId !== projectId || job.jobId !== ref.jobId)
      throw new DurableJobStoreError('PROJECT_MISMATCH', 'Invalid job identity');
    return job;
  }
  async function assertCurrentInTransaction(tx: Transaction, ref: DurableJobRef): Promise<DurableJobIntent<unknown>> {
    const snapshot = await tx.get(intentDoc(ref));
    if (!snapshot.exists) throw new DurableJobStoreError('NOT_FOUND', 'Job intent was not found');
    const intent = snapshot.data() as DurableJobIntent<unknown>;
    if (intent.projectId !== projectId || intent.jobId !== ref.jobId)
      throw new DurableJobStoreError('PROJECT_MISMATCH', 'Invalid intent identity');
    checkCurrent(intent, (await tx.get(entityDoc(intent))).data() as DurableEntityState | undefined);
    await assertExecutionInTransaction(tx, ref);
    return intent;
  }
  async function assertCurrent(ref: DurableJobRef): Promise<DurableJobIntent<unknown>> {
    const intent = await loadIntent<unknown>(ref);
    checkCurrent(intent, (await entityDoc(intent).get()).data() as DurableEntityState | undefined);
    if (options.authorizeActor) await options.authorizeActor(intent);
    const execution = currentExecution();
    if (execution)
      await firestore.runTransaction(async (tx) => {
        await assertExecutionInTransaction(tx, ref, execution);
      });
    return intent;
  }
  async function commitCurrent<T>(
    ref: DurableJobRef,
    mutate: (tx: Transaction, intent: DurableJobIntent<unknown>) => Promise<T>
  ): Promise<T> {
    await assertCurrent(ref);
    return firestore.runTransaction(async (tx) => {
      const intent = await assertCurrentInTransaction(tx, ref);
      return mutate(tx, intent);
    });
  }
  /** Read every critical-boundary fence before returning a write-only commit. */
  async function prepareCritical(
    tx: Transaction,
    ref: DurableJobRef,
    input: { reasonCode: string }
  ): Promise<{ job: DurableJob; commit(): void }> {
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(input.reasonCode)) invalid('Invalid critical section reason');
    const intent = await assertCurrentInTransaction(tx, ref);
    const criticalRef = firestore.collection(DURABLE_COLLECTIONS.critical).doc(ref.jobId);
    const [snapshot, cancellation, critical] = await Promise.all([
      tx.get(jobDoc(ref)),
      tx.get(firestore.collection('durableJobCancellationIntents').doc(ref.jobId)),
      tx.get(criticalRef),
    ]);
    if (!snapshot.exists) throw new DurableJobStoreError('NOT_FOUND', 'Job was not found');
    const job = snapshot.data() as DurableJob;
    if (job.projectId !== projectId || job.jobId !== ref.jobId)
      throw new DurableJobStoreError('PROJECT_MISMATCH', 'Invalid job identity');
    if (isDurableJobTerminal(job.state))
      throw new DurableJobStoreError('TERMINAL_JOB', 'A completed job cannot enter a critical mutation');
    if (job.state === 'cancel_requested' || cancellation.exists || job.result?.resolutionPurpose === 'cleanup')
      throw new DurableJobStoreError('STALE_REVISION', 'Cancellation won before the irreversible mutation');
    if (options.authorizeActor) await options.authorizeActor(intent);
    if (critical.exists) {
      const previous = critical.data();
      if (
        previous?.projectId !== projectId ||
        previous.jobId !== ref.jobId ||
        previous.generation !== job.generation ||
        previous.workflowId !== job.workflowId
      )
        throw new DurableJobStoreError('PROJECT_MISMATCH', 'Critical mutation identity changed');
      return { job, commit: () => {} };
    }
    const next = {
      ...job,
      actions: job.actions.filter((action) => action !== 'cancel'),
      revision: job.revision + 1,
      updatedAt: now(),
    };
    const marker = copyDefined({
      schemaVersion: 1,
      ...ref,
      generation: job.generation,
      workflowId: job.workflowId,
      reasonCode: input.reasonCode,
      enteredAt: now(),
      revision: next.revision,
      execution: currentExecution(),
    });
    return {
      job: next,
      commit: () => {
        tx.create(criticalRef, marker);
        tx.set(jobDoc(ref), next);
      },
    };
  }
  /** Enter the irreversible phase and any prepared provider reservations atomically.
   * The optional trusted preparation only reads and returns a write-only closure. */
  async function markCritical(
    ref: DurableJobRef,
    input: { reasonCode: string; prepare?: (tx: Transaction) => Promise<() => void> }
  ): Promise<DurableJob> {
    await assertCurrent(ref);
    return firestore.runTransaction(async (tx) => {
      const critical = await prepareCritical(tx, ref, input);
      const writePrepared = await input.prepare?.(tx);
      // Preparation can include slow authoritative reads. Recheck the actor before committing.
      if (options.authorizeActor) await options.authorizeActor(await assertCurrentInTransaction(tx, ref));
      writePrepared?.();
      critical.commit();
      return critical.job;
    });
  }
  async function mutate(
    ref: DurableJobRef,
    makePatch: (job: DurableJob) => DurableJobPatch,
    stepAttemptMode: 'effect' | 'projection' = 'projection'
  ): Promise<DurableJob> {
    return firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(jobDoc(ref));
      if (!snapshot.exists) throw new DurableJobStoreError('NOT_FOUND', 'Job was not found');
      const job = snapshot.data() as DurableJob;
      if (job.projectId !== projectId || job.jobId !== ref.jobId)
        throw new DurableJobStoreError('PROJECT_MISMATCH', 'Invalid job identity');
      const entity = (await tx.get(entityDoc(job))).data() as DurableEntityState | undefined;
      const critical = (await tx.get(firestore.collection(DURABLE_COLLECTIONS.critical).doc(ref.jobId))).data();
      const execution = currentExecution();
      const activityHead = await assertExecutionInTransaction(tx, ref, execution);
      const patch = { ...makePatch(job) };
      const executionWrites: Array<{ target: ReturnType<typeof stepExecutionDoc>; head: DurableStepExecutionHead }> =
        [];
      if (execution && patch.steps) {
        const updated: DurableJobStep[] = [];
        for (const step of patch.steps) {
          const priorStep = job.steps.find((value) => value.id === step.id);
          if (
            JSON.stringify(priorStep) === JSON.stringify(step) &&
            stepAttemptMode !== 'effect' &&
            !activityHead?.stepIds?.includes(step.id)
          ) {
            updated.push(step);
            continue;
          }
          const target = stepExecutionDoc(ref, step.id);
          const previous = (await tx.get(target)).data() as DurableStepExecutionHead | undefined;
          const head = nextStepHead(
            ref,
            step.id,
            execution,
            previous,
            priorStep?.attempt ?? 0,
            activityHead?.countsAttempt !== false &&
              (stepAttemptMode === 'effect' || Boolean(activityHead?.stepIds?.includes(step.id)))
          );
          const projected = {
            ...step,
            attempt: head.uiAttemptBase + (head.countsAttempt === false ? 0 : execution.attempt),
          };
          if (projected.state === 'succeeded') {
            delete projected.error;
            delete projected.nextRetryAt;
            if (!projected.progress && priorStep?.progress) projected.progress = priorStep.progress;
          }
          updated.push(projected);
          executionWrites.push({ target, head });
        }
        patch.steps = updated;
      }
      if (patch.state && ['running', 'succeeded', 'cancelled', 'superseded'].includes(patch.state)) {
        if (!Object.prototype.hasOwnProperty.call(patch, 'error')) patch.error = undefined;
        if (!Object.prototype.hasOwnProperty.call(patch, 'attention')) patch.attention = undefined;
      }
      if (patch.error?.code === 'PUBLISHING_CANCEL_EXTERNAL_REFERENCE_REVIEW_REQUIRED' && patch.attention?.receiptId) {
        const confirmed = await tx.get(firestore.collection('temporalProviderReceipts').doc(patch.attention.receiptId));
        const result = confirmed.get('result');
        const remoteId =
          typeof result === 'string'
            ? result
            : result && typeof result === 'object'
            ? result.id ?? result.listId ?? result.tagId ?? result.trackIdentifier
            : undefined;
        if (
          confirmed.get('projectId') === projectId &&
          confirmed.get('jobId') === ref.jobId &&
          confirmed.get('state') === 'confirmed' &&
          typeof confirmed.get('operationKey') === 'string' &&
          confirmed.get('operationKey').startsWith(`durable:${projectId}:${ref.jobId}:`) &&
          typeof remoteId === 'string' &&
          /^[A-Za-z0-9_.:-]{1,200}$/.test(remoteId)
        )
          patch.attention = { ...patch.attention, resolutionKind: 'retain_existing_resource', remoteId };
      }
      if (job.kind === 'provider.orphan_review')
        patch.actions = (patch.actions ?? job.actions).filter((action) => action === 'resolve');
      let criticalAttentionCommit: (() => void) | undefined;
      if (critical) {
        if (
          critical.projectId !== projectId ||
          critical.jobId !== ref.jobId ||
          critical.generation !== job.generation ||
          critical.workflowId !== job.workflowId
        )
          throw new DurableJobStoreError('PROJECT_MISMATCH', 'Critical mutation identity changed');
        const targetState = patch.state ?? job.state;
        const needsReview =
          ['needs_attention', 'waiting_for_auth', 'cancel_requested', 'reconciling'].includes(targetState) &&
          Boolean(patch.attention ?? job.attention);
        const cleanupAuthority = await tx.get(firestore.collection('durableJobCancellationIntents').doc(ref.jobId));
        const cleanupReview =
          needsReview &&
          cleanupAuthority.get('purpose') === 'critical_repair_cleanup' &&
          cleanupAuthority.get('projectId') === projectId &&
          cleanupAuthority.get('jobId') === ref.jobId &&
          cleanupAuthority.get('generation') === job.generation &&
          cleanupAuthority.get('workflowId') === job.workflowId &&
          typeof cleanupAuthority.get('certificateId') === 'string' &&
          /^[a-f0-9]{64}$/.test(cleanupAuthority.get('certificateId')) &&
          /^PUBLISHING_CANCEL_/.test(patch.error?.code ?? job.error?.code ?? '') &&
          Boolean(patch.attention?.receiptId || patch.attention?.acknowledgementId);
        const prepared =
          needsReview && !cleanupReview && options.prepareCriticalAttention
            ? await options.prepareCriticalAttention(tx, job, patch)
            : undefined;
        if (prepared) {
          patch.attention = prepared.attention;
          criticalAttentionCommit = prepared.commit;
        }
        if (
          !prepared &&
          patch.attention?.resolutionKind === 'critical_repair' &&
          (job.attention?.resolutionKind !== 'critical_repair' ||
            patch.attention.certificateId !== job.attention.certificateId ||
            patch.attention.repairPurpose !== job.attention.repairPurpose ||
            patch.attention.requiresRetentionAcknowledgement !== job.attention.requiresRetentionAcknowledgement)
        )
          invalid('Critical repair descriptor must be prepared by the trusted source planner');
        if (!prepared && !cleanupReview && needsReview && job.attention?.resolutionKind === 'critical_repair')
          patch.attention = job.attention;
        const certified = Boolean(prepared) || job.attention?.resolutionKind === 'critical_repair';
        patch.actions = needsReview && (certified || cleanupReview) ? ['resolve'] : [];
      }
      validatePatch(patch);
      if (patch.expectedRevision !== undefined && patch.expectedRevision !== job.revision)
        throw new DurableJobStoreError('STALE_REVISION', 'The job changed; refresh before issuing a command');
      if (patch.state !== 'superseded')
        checkCurrent({ ...job, actorUid: job.requestedBy, payload: {} } as DurableJobIntent<unknown>, entity);
      if (
        isDurableJobTerminal(job.state) &&
        Object.keys(patch).some(
          (key) =>
            key !== 'expectedRevision' &&
            JSON.stringify(patch[key as keyof DurableJobPatch]) !== JSON.stringify(job[key as keyof DurableJob])
        )
      )
        throw new DurableJobStoreError('TERMINAL_JOB', 'A completed job cannot restart; submit a new request');
      if (
        job.state === 'cancel_requested' &&
        patch.state &&
        ![
          'cancel_requested',
          'reconciling',
          'needs_attention',
          'cancelled',
          'succeeded',
          'failed',
          'superseded',
        ].includes(patch.state)
      )
        throw new DurableJobStoreError('STALE_REVISION', 'Cancellation has already been requested');
      if (patch.state === 'queued' && job.state !== 'awaiting_source' && job.state !== 'queued')
        throw new DurableJobStoreError('STALE_REVISION', 'An admitted job cannot regress to queued');
      if (patch.state === 'awaiting_source' && job.state !== 'awaiting_source')
        throw new DurableJobStoreError('STALE_REVISION', 'An admitted source cannot become unconfirmed');
      if (patch.steps) {
        patch.steps.forEach((step) =>
          guardStep(
            job.steps.find((s) => s.id === step.id),
            step
          )
        );
        const supplied = new Set(patch.steps.map((step) => step.id));
        patch.steps = [...job.steps.filter((step) => !supplied.has(step.id)), ...patch.steps];
        if (patch.steps.length > 64) invalid('Too many cumulative job steps');
      }
      if (isDurableJobTerminal(job.state)) return job;
      const { expectedRevision: _revision, ...values } = patch;
      const next = copyDefined({ ...job, ...values, revision: job.revision + 1, updatedAt: now() });
      if (isDurableJobTerminal(next.state)) {
        next.actions = [];
        next.finishedAt ??= next.updatedAt;
      }
      let releaseIntentUsage: (() => void) | undefined;
      if (isDurableJobTerminal(next.state)) {
        const intent = (await tx.get(intentDoc(ref))).data();
        if (extractProviderResources(projectId, intentDoc(ref).path, intent).length)
          releaseIntentUsage = await prepareProviderUsageChange(tx, firestore, {
            projectId,
            canonicalPath: intentDoc(ref).path,
            before: intent,
            after: undefined,
          });
      }
      criticalAttentionCommit?.();
      releaseIntentUsage?.();
      if (activityHead && execution && executionWrites.length)
        tx.set(executionDoc(ref, execution.activityType), {
          ...activityHead,
          stepIds: [
            ...new Set([...(activityHead.stepIds ?? []), ...executionWrites.map((value) => value.head.stepId)]),
          ],
        });
      executionWrites.forEach(({ target, head }) => tx.set(target, copyDefined(head)));
      tx.set(jobDoc(ref), next);
      return next;
    });
  }
  async function project(ref: DurableJobRef, patch: DurableJobPatch): Promise<DurableJob> {
    return mutate(ref, () => patch);
  }
  async function recordStep(ref: DurableJobRef, step: DurableJobStep): Promise<DurableJob> {
    validateStep(step);
    return mutate(ref, () => ({ steps: [step] }), 'effect');
  }
  const preparedAdmissions = new WeakMap<Transaction, Map<string, string>>();
  /** READ ONLY preparation for provider IDs frozen in an immutable admitted intent.
   * Invoke returned write-only closure after all admission reads, before createInTransaction. */
  async function prepareCreateInTransaction(tx: Transaction, input: CreateDurableJobInput): Promise<() => void> {
    checkRef(input.ref);
    const path = `${DURABLE_COLLECTIONS.intents}/${input.ref.jobId}`;
    const intent = { projectId, jobId: input.ref.jobId, payload: input.payload };
    const payloadHash = createHash('sha256').update(JSON.stringify(input.payload)).digest('hex');
    const apply = extractProviderResources(projectId, path, intent).length
      ? await prepareProviderUsageChange(tx, firestore, {
          projectId,
          canonicalPath: path,
          before: undefined,
          after: intent,
        })
      : () => {};
    return () => {
      apply();
      const ids = preparedAdmissions.get(tx) ?? new Map<string, string>();
      ids.set(input.ref.jobId, payloadHash);
      preparedAdmissions.set(tx, ids);
    };
  }
  /** WRITE ONLY: admission must finish duplicate, authorization and generation reads first. */
  function createInTransaction(tx: Transaction, input: CreateDurableJobInput): DurableJob {
    checkRef(input.ref);
    if (!isDurableJobKind(input.kind)) invalid('Invalid job kind');
    if (
      Object.prototype.hasOwnProperty.call(input, 'publishingSourceProtocol') ||
      Object.prototype.hasOwnProperty.call(input.payload, 'publishingSourceProtocol')
    )
      invalid('Publishing source protocol is server-authored admission metadata');
    boundedString(input.actorUid, 'actor uid');
    boundedString(input.requestId, 'request id');
    boundedString(input.entity.id, 'entity id', 1024);
    if (input.entity.label !== undefined) safeText(input.entity.label, 'entity label', 200);
    if (Object.keys(input.entity).some((key) => !['type', 'id', 'label'].includes(key)))
      invalid('Unexpected entity detail');
    if (
      !['sermon', 'list', 'series', 'speaker', 'image', 'user', 'mail', 'bundle', 'maintenance'].includes(
        input.entity.type
      )
    )
      invalid('Invalid entity');
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) invalid('Invalid generation');
    finite(input.createdAt, 'creation time');
    const dispatch = input.dispatch;
    if (dispatch.ref.projectId !== projectId || dispatch.ref.jobId !== input.ref.jobId)
      invalid('Dispatch reference differs from intent');
    validateDispatch(dispatch);
    boundedString(dispatch.workflowId, 'workflow id', 1024);
    boundedString(dispatch.workflowType, 'workflow type');
    boundedString(dispatch.taskQueue, 'task queue');
    if (input.initialState && !['queued', 'awaiting_source'].includes(input.initialState))
      invalid('Invalid admission state');
    const job: DurableJob = {
      schemaVersion: 1,
      jobId: input.ref.jobId,
      projectId: input.ref.projectId,
      kind: input.kind,
      entity: input.entity,
      workflowId: dispatch.workflowId,
      generation: input.generation,
      revision: 1,
      requestedBy: input.actorUid,
      requestId: input.requestId,
      state: input.initialState ?? 'queued',
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      steps: [],
      actions: input.initialState === 'awaiting_source' ? ['resume_upload', 'cancel'] : ['cancel'],
    };
    const intent: DurableJobIntent = {
      schemaVersion: 1,
      jobId: input.ref.jobId,
      projectId: input.ref.projectId,
      kind: input.kind,
      entity: input.entity,
      actorUid: input.actorUid,
      payload: input.payload,
      ...(isPublishingSourceProtocolIntent(input.kind, input.payload)
        ? { publishingSourceProtocol: PUBLISHING_SOURCE_PROTOCOL }
        : {}),
      generation: input.generation,
      createdAt: input.createdAt,
    };
    const outbox: DurableOutboxRecord = {
      schemaVersion: 1,
      jobId: input.ref.jobId,
      projectId: input.ref.projectId,
      dispatch,
      state: 'pending',
      attempt: 0,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      leaseExpiresAt: 0,
      nextAttemptAt: 0,
    };
    const entity: DurableEntityState = {
      schemaVersion: 1,
      projectId,
      entity: input.entity,
      scope: getDurableJobScope(input.kind),
      generation: input.generation,
      activeJobId: input.ref.jobId,
      updatedAt: input.createdAt,
    };
    if (
      extractProviderResources(projectId, intentDoc(input.ref).path, intent).length &&
      preparedAdmissions.get(tx)?.get(input.ref.jobId) !==
        createHash('sha256').update(JSON.stringify(input.payload)).digest('hex')
    )
      throw new DurableJobStoreError(
        'INVALID_ARGUMENT',
        'Provider-bearing intents require read-only usage preparation before admission'
      );
    tx.create(jobDoc(input.ref), copyDefined(job));
    tx.create(intentDoc(input.ref), copyDefined(intent));
    if (input.initialState !== 'awaiting_source')
      tx.create(firestore.collection(DURABLE_COLLECTIONS.outbox).doc(input.ref.jobId), copyDefined(outbox));
    tx.set(entityDoc(intent), entity);
    // The trusted admission caller must have read/created the canonical sermon in this transaction.
    if (input.entity.type === 'sermon')
      tx.set(
        firestore.collection('sermons').doc(input.entity.id),
        { activeDurableJobs: { [entity.scope]: { jobId: input.ref.jobId, projectId, generation: input.generation } } },
        { merge: true }
      );
    return job;
  }
  return {
    loadIntent,
    loadJob,
    getExecutionIdentity,
    recordActivityExecutionDrained,
    registerActivityExecution,
    assertExecutionInTransaction,
    assertCurrent,
    assertCurrentInTransaction,
    commitCurrent,
    prepareCritical,
    markCritical,
    project,
    recordStep,
    prepareCreateInTransaction,
    createInTransaction,
  };
}
export type DurableJobStore = ReturnType<typeof createDurableJobStore>;
