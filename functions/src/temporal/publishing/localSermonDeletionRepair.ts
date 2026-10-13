import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import {
  SERMON_DELETION_MIRROR_PLANS,
  sermonDeletionMirrorPlanId,
  removeSermonDeletionMirrors,
  type SermonDeletionMirrorPlan,
} from '../../helpers/sermonDeletionMirrors';
import { runCriticalPublishingRepair } from './durableOperationContext';
import { acknowledgedProjectionDigest } from './criticalAcknowledgedRepair';
import { PROVIDER_MUTATION_SESSIONS } from './providerMutationGuard';
import { desiredProviderDeletionDocumentFingerprint } from '../../../../packages/orchestration/src/provider-usage';

export type LocalSermonDeletionRepairOperation = Readonly<{ kind: 'local_sermon_delete'; planId: string }>;
export interface LocalSermonDeletionRepairSource {
  operation: LocalSermonDeletionRepairOperation;
  sourceEvidence: { path: string; digest: string };
  sourceEvidenceDigest: string;
  headerProjection: Readonly<Record<string, unknown>>;
  plan: Readonly<SermonDeletionMirrorPlan>;
  commit(): void;
}
export interface LocalSermonDeletionRepairDependencies {
  firestore: Firestore;
  /** Fresh administrator, exact certificate/operation grant and SDK execution fence. */
  authorizeInTransaction(
    tx: Transaction,
    ref: DurableJobRef,
    operation: LocalSermonDeletionRepairOperation
  ): Promise<void>;
  /** The standard generation-fenced, provider-indexed canonical transaction runner. */
  commitCurrent(ref: DurableJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void>;
}
type Data = Record<string, unknown>;
const object = (value: unknown): Data =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
const id = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 256 && !/[\s/?#]/.test(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (): never => {
  throw Object.assign(new Error('LOCAL_SERMON_DELETION_REPAIR_PROOF_REQUIRED'), {
    code: 'LOCAL_SERMON_DELETION_REPAIR_PROOF_REQUIRED',
  });
};
const absent = (value: unknown) => value === undefined || value === null || value === '';
/** Progress/checkpoint changes cannot rewrite the captured deletion authority. */
export function localSermonDeletionHeaderProjection(header: Data): Record<string, unknown> {
  return Object.fromEntries(
    [
      'schemaVersion',
      'projectId',
      'jobId',
      'sermonId',
      'planId',
      'generation',
      'workflowId',
      'operation',
      'sourceStepIds',
      'sourceParentRef',
      'intentFingerprint',
      'originalRoot',
      'originalRootDigest',
      'pointerClearRootDigest',
      'requests',
      'verifications',
    ]
      .filter((key) => header[key] !== undefined)
      .map((key) => [key, header[key]])
  );
}
async function readSource(
  tx: Transaction,
  db: Firestore,
  input: { ref: DurableJobRef; expectedRevision?: number; planId?: string; reviewedCleanup?: boolean }
): Promise<LocalSermonDeletionRepairSource> {
  const { ref } = input;
  if (!id(ref.projectId) || !id(ref.jobId)) return fail();
  const [jobSnapshot, intentSnapshot] = await Promise.all([
    tx.get(db.doc(`durableJobs/${ref.jobId}`)),
    tx.get(db.doc(`durableJobIntents/${ref.jobId}`)),
  ]);
  const job = object(jobSnapshot.data()),
    intent = object(intentSnapshot.data()),
    entity = object(intent.entity),
    domain = object(intent.payload);
  const sermonId = entity.id;
  if (
    !jobSnapshot.exists ||
    !intentSnapshot.exists ||
    intent.schemaVersion !== 1 ||
    intent.projectId !== ref.projectId ||
    intent.jobId !== ref.jobId ||
    job.projectId !== ref.projectId ||
    job.jobId !== ref.jobId ||
    intent.kind !== 'sermon.delete' ||
    job.kind !== intent.kind ||
    entity.type !== 'sermon' ||
    object(job.entity).type !== entity.type ||
    object(job.entity).id !== sermonId ||
    !id(sermonId) ||
    domain.sermonId !== sermonId ||
    domain.action !== 'delete' ||
    domain.generation !== intent.generation ||
    job.generation !== intent.generation ||
    !Number.isSafeInteger(intent.generation) ||
    Number(intent.generation) < 1 ||
    !id(job.workflowId) ||
    (!['running', 'retrying', 'reconciling', 'needs_attention'].includes(String(job.state)) &&
      !(input.reviewedCleanup && job.state === 'cancel_requested')) ||
    (input.expectedRevision !== undefined && job.revision !== input.expectedRevision)
  )
    return fail();
  const planId = sermonDeletionMirrorPlanId(ref, sermonId);
  if (input.planId !== undefined && input.planId !== planId) return fail();
  const headerPath = `${SERMON_DELETION_MIRROR_PLANS}/${planId}`,
    headerSnapshot = await tx.get(db.doc(headerPath)),
    header = object(headerSnapshot.data());
  const originalRoot = object(header.originalRoot),
    intentFingerprint = desiredProviderDeletionDocumentFingerprint(intent);
  if (
    !headerSnapshot.exists ||
    header.schemaVersion !== 1 ||
    header.planId !== planId ||
    header.projectId !== ref.projectId ||
    header.jobId !== ref.jobId ||
    header.sermonId !== sermonId ||
    header.generation !== intent.generation ||
    header.workflowId !== job.workflowId ||
    header.intentFingerprint !== intentFingerprint ||
    !['prepared', 'root_removed', 'completed'].includes(String(header.state)) ||
    !sha(header.originalRootDigest) ||
    header.originalRootDigest !== acknowledgedProjectionDigest(originalRoot) ||
    header.pointerClearRootDigest !== header.originalRootDigest ||
    !Array.isArray(header.requests) ||
    header.requests.length !== 0 ||
    !Array.isArray(header.verifications) ||
    header.verifications.length !== 0 ||
    !absent(originalRoot.subsplashId) ||
    !absent(originalRoot.soundCloudTrackId)
  )
    return fail();
  // Local-only means no mutable request can be inferred, overridden or synthesized.
  const sessions = await tx.get(
    db
      .collection(PROVIDER_MUTATION_SESSIONS)
      .where('scope.projectId', '==', ref.projectId)
      .where('scope.jobId', '==', ref.jobId)
      .limit(1)
  );
  if (!sessions.empty) return fail();
  const creates = await tx.get(
    db
      .collection('temporalProviderReceipts')
      .where('projectId', '==', ref.projectId)
      .where('jobId', '==', ref.jobId)
      .limit(1)
  );
  if (!creates.empty) return fail();
  const root = await tx.get(db.doc(`sermons/${sermonId}`));
  if (header.state === 'prepared') {
    if (
      !root.exists ||
      acknowledgedProjectionDigest(root.data()) !== header.originalRootDigest ||
      header.rootRemoval !== undefined
    )
      return fail();
  } else {
    const checkpoint = object(header.rootRemoval);
    if (
      root.exists ||
      checkpoint.schemaVersion !== 1 ||
      checkpoint.generation !== header.generation ||
      checkpoint.workflowId !== header.workflowId ||
      checkpoint.intentFingerprint !== intentFingerprint ||
      checkpoint.rootSourceDigest !== header.originalRootDigest ||
      checkpoint.originalEvidenceDigest !==
        desiredProviderDeletionDocumentFingerprint({ localOnly: true, intentFingerprint })
    )
      return fail();
  }
  const headerProjection = localSermonDeletionHeaderProjection(header),
    digest = acknowledgedProjectionDigest(headerProjection);
  const plan: SermonDeletionMirrorPlan = {
    ...ref,
    sermonId,
    planId,
    generation: Number(intent.generation),
    workflowId: String(job.workflowId),
    ...(header.operation !== undefined ? { operation: String(header.operation) } : {}),
  };
  return {
    operation: { kind: 'local_sermon_delete', planId },
    sourceEvidence: { path: headerPath, digest },
    sourceEvidenceDigest: digest,
    headerProjection,
    plan,
    commit: () => {},
  };
}
/** Only a prepared, source-captured local root produces a real typed repair operation. */
export const prepareLocalSermonDeletionRepair = (
  tx: Transaction,
  db: Firestore,
  input: { ref: DurableJobRef; expectedRevision?: number }
): Promise<LocalSermonDeletionRepairSource> => readSource(tx, db, input);

async function authorizeSource(
  tx: Transaction,
  ref: DurableJobRef,
  op: LocalSermonDeletionRepairOperation,
  deps: LocalSermonDeletionRepairDependencies
): Promise<void> {
  await deps.authorizeInTransaction(tx, ref, op);
  const grantSnapshot = await tx.get(deps.firestore.doc(`durableJobCriticalRepairGrants/${ref.jobId}`)),
    grant = object(grantSnapshot.data());
  if (
    !grantSnapshot.exists ||
    grant.schemaVersion !== 1 ||
    grant.projectId !== ref.projectId ||
    grant.jobId !== ref.jobId ||
    !id(grant.actorUid) ||
    !id(grant.commandId) ||
    !sha(grant.certificateId) ||
    !Array.isArray(grant.operations) ||
    !grant.operations.some((value) => {
      const operation = object(value);
      return Object.keys(operation).length === 2 && operation.kind === op.kind && operation.planId === op.planId;
    })
  )
    return fail();
  const source = await readSource(tx, deps.firestore, { ref, planId: op.planId, reviewedCleanup: true });
  if (
    grant.generation !== source.plan.generation ||
    grant.workflowId !== source.plan.workflowId ||
    !Array.isArray(grant.sourceEvidenceDigests) ||
    !grant.sourceEvidenceDigests.includes(source.sourceEvidenceDigest)
  )
    return fail();
  const intent = await tx.get(deps.firestore.doc(`durableJobIntents/${ref.jobId}`));
  if (grant.intentFingerprint !== acknowledgedProjectionDigest(intent.data())) return fail();
  const job = await tx.get(deps.firestore.doc(`durableJobs/${ref.jobId}`));
  if (job.get('state') === 'cancel_requested') {
    const cancellation = await tx.get(deps.firestore.doc(`durableJobCancellationIntents/${ref.jobId}`));
    if (
      !cancellation.exists ||
      cancellation.get('purpose') !== 'critical_repair_cleanup' ||
      cancellation.get('projectId') !== ref.projectId ||
      cancellation.get('jobId') !== ref.jobId ||
      cancellation.get('generation') !== source.plan.generation ||
      cancellation.get('workflowId') !== source.plan.workflowId ||
      cancellation.get('certificateId') !== grant.certificateId
    )
      return fail();
  }
}
/** The existing root-first helper retains its private root-removal checkpoint and
 * paged source-ledger checks. This interpreter issues no HTTP, storage or provider RPC.
 */
export async function runLocalSermonDeletionRepair(
  ref: DurableJobRef,
  operation: LocalSermonDeletionRepairOperation,
  deps: LocalSermonDeletionRepairDependencies
): Promise<{ state: 'completed'; planId: string }> {
  if (
    !operation ||
    Object.keys(operation).length !== 2 ||
    operation.kind !== 'local_sermon_delete' ||
    !sha(operation.planId) ||
    typeof deps.authorizeInTransaction !== 'function' ||
    typeof deps.commitCurrent !== 'function'
  )
    return fail();
  let prepared: LocalSermonDeletionRepairSource | undefined;
  await deps.commitCurrent(ref, async (tx) => {
    await authorizeSource(tx, ref, operation, deps);
    prepared = await readSource(tx, deps.firestore, { ref, planId: operation.planId, reviewedCleanup: true });
  });
  if (!prepared) return fail();
  const source = prepared as LocalSermonDeletionRepairSource;
  await runCriticalPublishingRepair(
    ref.jobId,
    () =>
      removeSermonDeletionMirrors(deps.firestore, source.plan, {
        assertOriginalProviderEffects: async (tx) => authorizeSource(tx, ref, operation, deps),
      }),
    (mutate) => deps.commitCurrent(ref, mutate)
  );
  return { state: 'completed', planId: operation.planId };
}

/** Read-only certificate evidence validation; mutable progress never alters authority. */
export async function validateLocalSermonDeletionRepairEvidence(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  evidence: { path: string; digest: string }
): Promise<void> {
  if (!evidence || Object.keys(evidence).length !== 2 || !sha(evidence.digest)) return fail();
  const source = await readSource(tx, db, { ref, reviewedCleanup: true });
  if (evidence.path !== source.sourceEvidence.path || evidence.digest !== source.sourceEvidenceDigest) return fail();
}
