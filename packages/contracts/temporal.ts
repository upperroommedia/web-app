/** Public job projection. Only the server may author these records. */
export const DURABLE_JOB_KINDS = [
  'upload.create',
  'audio.process',
  'sermon.publish',
  'sermon.unpublish',
  'sermon.update',
  'sermon.delete',
  'image.ingest',
  'image.delete',
  'search.sync',
  'search.backfill',
  'email.deliver',
  'invite.create',
  'invite.resend',
  'invite.claim',
  'role.resolve',
  'role.assign',
  'speaker.resolve',
  'speaker.mutate',
  'list.create',
  'list.update',
  'list.delete',
  'list.publish',
  'list.membership',
  'list.reorder',
  'list.reconcile',
  'series.create',
  'series.update',
  'series.delete',
  'series.membership',
  'series.reorder',
  'series.publish',
  'series.sync_metadata',
  'bundle.regenerate',
  'maintenance.run',
  'youtube.authRecovery',
  'provider.orphan_review',
] as const;

export type DurableJobKind = (typeof DURABLE_JOB_KINDS)[number];
export type DurableJobState =
  | 'awaiting_source'
  | 'queued'
  | 'running'
  | 'retrying'
  | 'waiting_for_auth'
  | 'cancel_requested'
  | 'reconciling'
  | 'needs_attention'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'superseded';
export type DurableStepState =
  | 'pending'
  | 'running'
  | 'retrying'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface DurableJobRef {
  jobId: string;
  projectId: string;
}
export interface DurableEntityRef {
  type: 'sermon' | 'list' | 'series' | 'speaker' | 'image' | 'user' | 'mail' | 'bundle' | 'maintenance';
  id: string;
  label?: string;
}
export type DurableAction = 'cancel' | 'retry' | 'resume' | 'resolve' | 'resume_upload';

export interface DurableSafeError {
  code: string;
  message: string;
  retryable: boolean;
  provider?: 'subsplash' | 'soundcloud' | 'youtube' | 'algolia' | 'smtp' | 'storage';
}
export interface DurableJobAttention {
  kind: 'reconnect_provider' | 'external_result_unknown' | 'remote_drift' | 'source_unavailable' | 'permission_changed';
  message: string;
  stepId?: string;
  receiptId?: string;
  /** Opaque reference to a separately reviewed original provider acknowledgement. */
  acknowledgementId?: string;
  /** Server-verified cleanup review for a confirmed resource, never inferred from an uncertain create. */
  resolutionKind?: 'retain_existing_resource' | 'critical_repair';
  resolutionDecisions?: Array<'retain_existing_resource' | 'confirm_existing_resource_absent'>;
  certificateId?: string;
  repairPurpose?: 'repair_confirmed_changes' | 'complete_fixed_cleanup';
  /** Source-certified retention of an initial, unverified legacy reference; never an unknown mutable request. */
  requiresRetentionAcknowledgement?: boolean;
  /** Fixed provider ID for the confirmed cleanup review. */
  remoteId?: string;
  provider?: DurableSafeError['provider'];
}
export interface DurableJobStep {
  id: string;
  label: string;
  state: DurableStepState;
  attempt: number;
  /** Only present when progress can be measured, never a guessed completion percentage. */
  progress?: { completed: number; total: number; unit: 'bytes' | 'seconds' | 'items' };
  nextRetryAt?: number;
  startedAt?: number;
  finishedAt?: number;
  error?: DurableSafeError;
}
export interface DurableDestinationResult {
  destination: 'subsplash' | 'soundcloud' | 'storage' | 'algolia' | 'email';
  state: 'pending' | 'running' | 'confirmed' | 'absent' | 'unknown' | 'failed';
  remoteId?: string;
  message?: string;
}
/** Server-authored simulation provenance, never a client authorization capability. */
export type ProviderSimulationScenario =
  | 'success'
  | 'delayed-processing'
  | 'transient-failure'
  | 'permanent-failure'
  | 'commit-then-lost-response';
export interface ProviderExecution {
  mode: 'sandbox';
  profileId: string;
  version: 1;
  scenario: ProviderSimulationScenario;
}

export interface DurableJob extends DurableJobRef {
  providerExecution?: ProviderExecution;
  schemaVersion: 1;
  kind: DurableJobKind;
  entity: DurableEntityRef;
  workflowId: string;
  generation: number;
  /** Monotonically increasing projection revision; reject older cached snapshots. */
  revision: number;
  requestedBy: string;
  requestId: string;
  state: DurableJobState;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  steps: DurableJobStep[];
  actions: DurableAction[];
  destinations?: DurableDestinationResult[];
  attention?: DurableJobAttention;
  error?: DurableSafeError;
  supersedesJobId?: string;
  /** Safe, bounded UI result. Tokens, credentials, file bytes and raw provider errors are forbidden. */
  result?: Record<string, unknown>;
}

export interface DurableAdmissionRequest {
  requestId: string;
  kind: DurableJobKind;
  entity: DurableEntityRef;
  expectedGeneration?: number;
  payload: Record<string, unknown>;
}
export interface DurableAdmissionReceipt extends DurableJobRef {
  requestId: string;
  admissionState: 'awaiting_source' | 'queued' | 'accepted';
  revision: number;
  generation: number;
  /** Private response available only to the original authenticated requester; never stored on the public job. */
  clientResult?: Record<string, unknown>;
  sourceUpload?: {
    storagePath: string;
    expectedFile: {
      name: string;
      size: number;
      lastModified: number;
      fingerprint?: { algorithm: string; chunkBytes: number; value: string };
    };
    jobRevision: number;
  };
}
/** Private source wake-up references; this signal never authorizes a desired mutation. */
export interface PublishingEvidenceRef extends DurableJobRef {
  sessionId: string;
  factId: string;
  generation: number;
}
export interface DurableJobCommand {
  jobId: string;
  requestId: string;
  expectedRevision: number;
  action: DurableAction;
  /** Resolution includes references/IDs, never secrets; server validates each domain action. */
  resolution?: Record<string, unknown>;
}
export interface DurableCommandReceipt extends DurableJobRef {
  requestId: string;
  acceptedRevision: number;
  state: 'accepted' | 'already_accepted';
  replacementJobRef?: DurableJobRef;
}

/** Workflow history carries references only; activities load the private immutable intent. */
export interface DurableWorkflowDispatch {
  workflowType: string;
  workflowId: string;
  taskQueue: string;
  ref: DurableJobRef;
  startArgs?: Record<string, unknown>;
  signal?: { name: string; args: Record<string, unknown> };
}

export const DURABLE_TERMINAL_STATES: readonly DurableJobState[] = ['succeeded', 'failed', 'cancelled', 'superseded'];
export function isDurableJobTerminal(state: DurableJobState): boolean {
  return DURABLE_TERMINAL_STATES.includes(state);
}
export function isDurableJobKind(value: unknown): value is DurableJobKind {
  return typeof value === 'string' && (DURABLE_JOB_KINDS as readonly string[]).includes(value);
}
