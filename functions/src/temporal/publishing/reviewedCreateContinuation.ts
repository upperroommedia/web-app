import { createHash } from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import {
  DURABLE_COLLECTIONS,
  durableActivityDrainKey,
  type DurableJobIntent,
  type DurableActivityExecution,
} from '../../../../packages/orchestration/src/job-store';
import { acknowledgedProjectionDigest as digest } from './criticalAcknowledgedRepair';
import {
  PROVIDER_RECEIPTS_COLLECTION,
  providerReceiptId,
  providerPayloadFingerprint,
  inferProviderReceiptScope,
  type ProviderReceipt,
} from './providerReceipts';
import type { PublishingPlan, PrivatePublishingIntent } from './types';

export const PUBLISHING_CREATE_REVIEW_CHECKPOINTS = 'temporalPublishingCreateReviewCheckpoints';
export const PUBLISHING_REVIEW_ACTIVITY_STAGES = [
  'ensurePublishingSoundCloud',
  'checkPublishingSoundCloudReady',
  'ensurePublishingMedia',
  'checkPublishingMediaReady',
  'applyPublishingLists',
  'applyPublishingSeries',
  'commitPublishingProjection',
] as const;
export type PublishingReviewedActivityStage = (typeof PUBLISHING_REVIEW_ACTIVITY_STAGES)[number];
export interface ReviewedEntityCreatePlan {
  kind: string;
  entity: { type: string; id: string };
  generation: number;
  continuation: 'reviewed-create';
  receiptId: string;
  receiptStep: string;
}
export type PublishingCreateReviewContinuation =
  | {
      workflow: 'publishing';
      waitingStep: string;
      completedStages: PublishingReviewedActivityStage[];
      plan: PublishingPlan;
    }
  | { workflow: 'publishingEntity'; waitingStep: 'entity'; completedStages: []; plan: ReviewedEntityCreatePlan };
interface StageEvidence {
  stage: PublishingReviewedActivityStage;
  proofDigest: string;
}
interface Checkpoint {
  schemaVersion: 1;
  projectId: string;
  jobId: string;
  generation: number;
  workflowId: string;
  intentDigest: string;
  planDigest: string;
  workflow: 'publishing' | 'publishingEntity';
  waitingStep: string;
  completedStages: PublishingReviewedActivityStage[];
  evidence: StageEvidence[];
  receiptId: string;
  receipt: {
    operationKey: string;
    step: string;
    fingerprint: string;
    owner: string;
    revision: number;
    providerAccount: unknown;
  };
  plan: PublishingPlan | ReviewedEntityCreatePlan;
  savedRevision: number;
}
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
const id = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 256 && !/[\s/?#]/.test(value);
const refHash = (ref: DurableJobRef, name: string) =>
  createHash('sha256')
    .update(JSON.stringify([ref.projectId, ref.jobId, name]))
    .digest('hex');
const stageUi: Record<PublishingReviewedActivityStage, string> = {
  ensurePublishingSoundCloud: 'soundcloud-track',
  checkPublishingSoundCloudReady: 'soundcloud-track',
  ensurePublishingMedia: 'subsplash-media',
  checkPublishingMediaReady: 'subsplash-media',
  applyPublishingLists: 'lists',
  applyPublishingSeries: 'series',
  commitPublishingProjection: 'projection',
};
function mainPlan(intent: DurableJobIntent<unknown>): PublishingPlan | undefined {
  const value = object(intent.payload) as unknown as PrivatePublishingIntent;
  if (
    intent.kind !== 'sermon.publish' ||
    intent.entity.type !== 'sermon' ||
    value.action !== 'publish' ||
    value.sermonId !== intent.entity.id ||
    value.generation !== intent.generation ||
    value.actorUid !== intent.actorUid ||
    !Array.isArray(value.destinations?.listIds) ||
    value.destinations.listIds.some((item) => !id(item)) ||
    (value.destinations.seriesId !== undefined && !id(value.destinations.seriesId)) ||
    typeof value.destinations.soundcloud !== 'boolean'
  )
    return;
  return {
    sermonId: value.sermonId,
    action: value.action,
    generation: value.generation,
    lists: value.destinations.listIds.length > 0,
    series: Boolean(value.destinations.seriesId),
    soundcloud: value.destinations.soundcloud,
    needsMedia: value.destinations.listIds.length > 0 || Boolean(value.destinations.seriesId),
    requiresAudio: false,
    needsSoundCloud: value.destinations.soundcloud,
    requiresMemberships: false,
  };
}
function allowedStages(plan: PublishingPlan): PublishingReviewedActivityStage[] {
  return PUBLISHING_REVIEW_ACTIVITY_STAGES.filter((stage) =>
    stage === 'commitPublishingProjection' || stage === 'applyPublishingLists'
      ? stage === 'commitPublishingProjection' || plan.lists
      : stage === 'applyPublishingSeries'
      ? plan.series
      : stage.includes('SoundCloud')
      ? plan.soundcloud
      : plan.needsMedia
  );
}
function validReceipt(ref: DurableJobRef, receiptId: string, receipt: ProviderReceipt): boolean {
  const scope = inferProviderReceiptScope(receipt.operationKey);
  return (
    sha(receiptId) &&
    providerReceiptId(receipt.operationKey, receipt.step) === receiptId &&
    scope?.projectId === ref.projectId &&
    scope.jobId === ref.jobId &&
    receipt.projectId === ref.projectId &&
    receipt.jobId === ref.jobId &&
    sha(receipt.fingerprint) &&
    receipt.fingerprint === providerPayloadFingerprint(receipt.intentPayload) &&
    id(receipt.owner) &&
    Number.isSafeInteger(receipt.revision) &&
    Number(receipt.revision) >= 1 &&
    (receipt.providerAccount?.provider === 'subsplash'
      ? receipt.providerAccount.account === 'app:9XTSHD'
      : receipt.providerAccount?.provider === 'soundcloud' &&
        /^soundcloud:users:[0-9]+$/.test(receipt.providerAccount.account))
  );
}
function receiptRoutes(
  intent: DurableJobIntent<unknown>,
  workflow: Checkpoint['workflow'],
  waitingStep: string
): Array<{ operationKey: string; step: string }> {
  const prefix = `durable:${intent.projectId}:${intent.jobId}:`;
  if (workflow === 'publishing')
    return waitingStep === 'soundcloud-track'
      ? [{ operationKey: `${prefix}${intent.entity.id}:soundcloud-create`, step: 'soundcloud-track' }]
      : waitingStep === 'subsplash-media'
      ? ['subsplash-audio', 'subsplash-transcode', 'subsplash-media-item'].map((step) => ({
          operationKey: `${prefix}${intent.entity.id}:subsplash-create`,
          step,
        }))
      : [];
  const value = object(intent.payload),
    payload = object(value.payload);
  if (
    waitingStep !== 'entity' ||
    value.kind !== intent.kind ||
    digest(value.entity) !== digest(intent.entity) ||
    payload.operation !== 'create'
  )
    return [];
  const key = `${prefix}${intent.kind}:create`;
  return intent.kind === 'list.create'
    ? [{ operationKey: key, step: 'list-create' }]
    : intent.kind === 'series.create'
    ? [{ operationKey: key, step: 'subsplash-series' }]
    : intent.kind === 'speaker.mutate'
    ? [
        { operationKey: `${key}:create-speaker-tag`, step: 'speaker-tag-create' },
        { operationKey: `${key}:create-speaker-list`, step: 'list-create' },
      ]
    : [];
}
function receiptFits(
  intent: DurableJobIntent<unknown>,
  workflow: Checkpoint['workflow'],
  waitingStep: string,
  receipt: ProviderReceipt
): boolean {
  return receiptRoutes(intent, workflow, waitingStep).some(
    (route) => route.operationKey === receipt.operationKey && route.step === receipt.step
  );
}
function orderedHints(stages: string[]): boolean {
  const index = (stage: string) => stages.indexOf(stage),
    before = (parent: string, child: string) => index(parent) < 0 || index(child) < 0 || index(parent) < index(child);
  return (
    before('ensurePublishingMedia', 'checkPublishingMediaReady') &&
    before('ensurePublishingSoundCloud', 'checkPublishingSoundCloudReady') &&
    before('checkPublishingMediaReady', 'applyPublishingLists') &&
    before('checkPublishingMediaReady', 'applyPublishingSeries') &&
    before('applyPublishingLists', 'applyPublishingSeries') &&
    stages.every((stage) => stage === 'commitPublishingProjection' || before(stage, 'commitPublishingProjection'))
  );
}

async function currentPrivate(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef
): Promise<{ intent: DurableJobIntent<unknown>; job: Record<string, any> } | undefined> {
  const [raw, jobDoc, cancel, critical] = await Promise.all([
    tx.get(db.doc(`${DURABLE_COLLECTIONS.intents}/${ref.jobId}`)),
    tx.get(db.doc(`${DURABLE_COLLECTIONS.jobs}/${ref.jobId}`)),
    tx.get(db.doc(`durableJobCancellationIntents/${ref.jobId}`)),
    tx.get(db.doc(`${DURABLE_COLLECTIONS.critical}/${ref.jobId}`)),
  ]);
  const intent = raw.data() as DurableJobIntent<unknown> | undefined,
    job = jobDoc.data();
  if (
    !intent ||
    !job ||
    intent.projectId !== ref.projectId ||
    intent.jobId !== ref.jobId ||
    job.projectId !== ref.projectId ||
    job.jobId !== ref.jobId ||
    job.generation !== intent.generation ||
    job.kind !== intent.kind ||
    digest(job.entity) !== digest(intent.entity) ||
    job.requestedBy !== intent.actorUid ||
    !id(intent.actorUid) ||
    !Number.isSafeInteger(intent.generation) ||
    intent.generation < 1 ||
    typeof job.workflowId !== 'string' ||
    !job.workflowId ||
    cancel.exists ||
    critical.exists ||
    job.result?.resolutionPurpose === 'cleanup' ||
    job.attention?.resolutionKind === 'critical_repair' ||
    ['cancel_requested', 'cancelled', 'superseded', 'succeeded', 'failed'].includes(job.state)
  )
    return;
  return { intent, job };
}
async function activityProof(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  job: Record<string, any>,
  stage: PublishingReviewedActivityStage,
  requireProjected = true
): Promise<Record<string, unknown> | undefined> {
  const activity = await tx.get(db.doc(`${DURABLE_COLLECTIONS.executions}/${refHash(ref, stage)}`)),
    head = activity.data();
  if (
    !head ||
    head.projectId !== ref.projectId ||
    head.jobId !== ref.jobId ||
    head.workflowId !== job.workflowId ||
    head.activityType !== stage ||
    !sha(head.executionId) ||
    !Number.isInteger(head.epoch) ||
    head.epoch < 1 ||
    !head.stepIds?.includes(stageUi[stage])
  )
    return;
  const drained = await tx.get(
    db.doc(
      `${DURABLE_COLLECTIONS.drains}/${durableActivityDrainKey(
        ref.projectId,
        ref.jobId,
        head as DurableActivityExecution
      )}`
    )
  );
  if (
    !drained.exists ||
    drained.get('state') !== 'drained' ||
    drained.get('source') !== 'worker_settled' ||
    drained.get('executionId') !== head.executionId ||
    drained.get('projectId') !== ref.projectId ||
    drained.get('jobId') !== ref.jobId
  )
    return;
  if (requireProjected) {
    const step = object(job.steps?.find((value: any) => value.id === stageUi[stage])),
      bound = await tx.get(db.doc(`${DURABLE_COLLECTIONS.stepExecutions}/${refHash(ref, stageUi[stage])}`));
    if (
      step.state !== 'succeeded' ||
      bound.get('activityType') !== stage ||
      bound.get('executionId') !== head.executionId ||
      bound.get('workflowId') !== job.workflowId
    )
      return;
    return { activity: head, drained: drained.data(), step, bound: bound.data() };
  }
  return { activity: head, drained: drained.data() };
}
async function deriveStages(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  intent: DurableJobIntent<unknown>,
  job: Record<string, any>,
  plan: PublishingPlan
): Promise<StageEvidence[]> {
  const evidence: StageEvidence[] = [];
  for (const stage of allowedStages(plan)) {
    let proof = await activityProof(tx, db, ref, job, stage);
    if (stage === 'ensurePublishingMedia' || stage === 'ensurePublishingSoundCloud') {
      const execution = await activityProof(tx, db, ref, job, stage, false);
      if (!execution) continue;
      const provider = stage === 'ensurePublishingMedia' ? 'subsplash' : 'soundcloud',
        field = provider === 'subsplash' ? 'subsplashId' : 'soundCloudTrackId',
        sermon = await tx.get(db.doc(`sermons/${plan.sermonId}`)),
        known = sermon.get(field);
      if (!id(known)) continue;
      const original = object(object(intent.payload).payload).sermon;
      if (object(original)[field] === known) proof = { ...execution, canonicalId: known, admittedId: known };
      else {
        const markerId = createHash('sha256')
            .update(JSON.stringify([ref.projectId, plan.sermonId, provider]))
            .digest('hex'),
          marker = await tx.get(db.doc(`temporalPublishingAllocations/${markerId}`));
        const operationKey = `durable:${ref.projectId}:${ref.jobId}:${plan.sermonId}:${
            provider === 'subsplash' ? 'subsplash' : 'soundcloud'
          }-create`,
          step = provider === 'subsplash' ? 'subsplash-media-item' : 'soundcloud-track',
          receiptId = providerReceiptId(operationKey, step),
          receipt = (await tx.get(db.doc(`${PROVIDER_RECEIPTS_COLLECTION}/${receiptId}`))).data() as
            | ProviderReceipt
            | undefined;
        const result = object(receipt?.result),
          remote = typeof receipt?.result === 'string' ? receipt.result : result.id ?? result.soundCloudTrackId;
        if (
          marker.get('state') !== 'bound' ||
          marker.get('projectId') !== ref.projectId ||
          marker.get('ownerJobId') !== ref.jobId ||
          marker.get('operationKey') !== operationKey ||
          marker.get('remoteId') !== known ||
          !marker.get('receiptIds')?.includes(receiptId) ||
          !receipt ||
          receipt.state !== 'confirmed' ||
          !validReceipt(ref, receiptId, receipt) ||
          remote !== known
        )
          continue;
        proof = { ...execution, canonicalId: known, marker: marker.data(), receiptDigest: digest(receipt) };
      }
    }
    if (stage === 'checkPublishingMediaReady' && ref.projectId === 'urm-app') {
      const publication = await tx.get(db.doc(`temporalPublishingPublications/${ref.jobId}-${plan.sermonId}`)),
        sermon = await tx.get(db.doc(`sermons/${plan.sermonId}`));
      if (
        publication.get('status') !== 'confirmed' ||
        publication.get('remoteId') !== sermon.get('subsplashId') ||
        sermon.get('status.subsplash') !== 'UPLOADED'
      )
        continue;
      if (proof) proof = { ...proof, publication: publication.data(), canonicalId: sermon.get('subsplashId') };
    }
    if (proof) evidence.push({ stage, proofDigest: digest(proof) });
  }
  // A downstream green projection cannot erase a missing prerequisite proof.
  const selected: StageEvidence[] = [];
  const has = (stage: PublishingReviewedActivityStage) => selected.some((value) => value.stage === stage);
  for (const value of evidence) {
    const ready =
      value.stage === 'checkPublishingMediaReady'
        ? has('ensurePublishingMedia')
        : value.stage === 'checkPublishingSoundCloudReady'
        ? has('ensurePublishingSoundCloud')
        : value.stage === 'applyPublishingLists'
        ? has('checkPublishingMediaReady')
        : value.stage === 'applyPublishingSeries'
        ? has('checkPublishingMediaReady') && (!plan.lists || has('applyPublishingLists'))
        : value.stage === 'commitPublishingProjection'
        ? (!plan.soundcloud || has('checkPublishingSoundCloudReady')) &&
          (!plan.needsMedia || has('checkPublishingMediaReady')) &&
          (!plan.lists || has('applyPublishingLists')) &&
          (!plan.series || has('applyPublishingSeries'))
        : true;
    if (ready) selected.push(value);
  }
  return selected;
}
async function desiredReview(
  tx: Transaction,
  db: Firestore,
  ref: DurableJobRef,
  job: Record<string, any>,
  receipt: ProviderReceipt
): Promise<boolean> {
  const audit = receipt.adoptionAudit;
  if (
    receipt.state !== 'confirmed' ||
    !id(receipt.resolvedBy) ||
    !id(receipt.resolutionCommandId) ||
    !sha(receipt.resolutionFingerprint) ||
    receipt.cleanupReview ||
    audit?.decision !== 'adopt_existing_resource' ||
    audit.duplicateRiskAcknowledged !== true ||
    !audit.reason?.trim() ||
    !audit.evidenceReference?.trim()
  )
    return false;
  const result = receipt.result,
    remote =
      typeof result === 'string'
        ? result
        : object(result).id ??
          object(result).audioId ??
          object(result).listId ??
          object(result).tagId ??
          object(result).soundCloudTrackId;
  if (
    !id(remote) ||
    receipt.resolutionFingerprint !==
      providerPayloadFingerprint({ resolution: { type: 'adopt', remoteId: remote }, adoptionAudit: audit })
  )
    return false;
  const command = await tx.get(db.doc(`${DURABLE_COLLECTIONS.commands}/${receipt.resolutionCommandId}`));
  return (
    command.exists &&
    command.get('projectId') === ref.projectId &&
    command.get('jobId') === ref.jobId &&
    command.get('workflowId') === job.workflowId &&
    command.get('actorUid') === receipt.resolvedBy &&
    command.get('action') === 'resolve' &&
    command.get('signal.name') === 'publishingResume' &&
    command.get('receipt.requestId') === receipt.resolutionCommandId &&
    ['pending', 'dispatching', 'dispatched'].includes(command.get('state'))
  );
}
export async function savePublishingCreateReviewCheckpoint(
  ref: DurableJobRef,
  input: { workflow: 'publishing' | 'publishingEntity'; waitingStep: string; completedStages: string[] },
  options: {
    firestore: Firestore;
    commitCurrent: (ref: DurableJobRef, mutate: (tx: Transaction) => Promise<void>) => Promise<void>;
  }
): Promise<{ checkpointId: string } | undefined> {
  if (
    !['publishing', 'publishingEntity'].includes(input.workflow) ||
    !Array.isArray(input.completedStages) ||
    new Set(input.completedStages).size !== input.completedStages.length ||
    input.completedStages.some(
      (stage) => !PUBLISHING_REVIEW_ACTIVITY_STAGES.includes(stage as PublishingReviewedActivityStage)
    )
  )
    return;
  let result: { checkpointId: string } | undefined;
  await options.commitCurrent(ref, async (tx) => {
    const current = await currentPrivate(tx, options.firestore, ref);
    if (!current) return;
    const { intent, job } = current;
    let receiptId: unknown = job.attention?.stepId === input.waitingStep ? job.attention?.receiptId : undefined,
      receipt: ProviderReceipt | undefined;
    if (sha(receiptId))
      receipt = (await tx.get(options.firestore.doc(`${PROVIDER_RECEIPTS_COLLECTION}/${receiptId}`))).data() as
        | ProviderReceipt
        | undefined;
    if (!receipt) {
      // Rescue only fixed original-intent routes with an already committed desired review command.
      for (const route of [...receiptRoutes(intent, input.workflow, input.waitingStep)].reverse()) {
        const candidateId = providerReceiptId(route.operationKey, route.step),
          candidate = (await tx.get(options.firestore.doc(`${PROVIDER_RECEIPTS_COLLECTION}/${candidateId}`))).data() as
            | ProviderReceipt
            | undefined;
        if (candidate && validReceipt(ref, candidateId, candidate)) {
          // An older adopted primitive cannot supersede a later unresolved create in the same stage.
          if (['executing', 'needs_review'].includes(candidate.state)) return;
          if (await desiredReview(tx, options.firestore, ref, job, candidate)) {
            receiptId = candidateId;
            receipt = candidate;
            break;
          }
        }
      }
    }
    if (!sha(receiptId)) return;
    if (
      !receipt ||
      !validReceipt(ref, receiptId, receipt) ||
      !receiptFits(intent, input.workflow, input.waitingStep, receipt) ||
      (!['executing', 'needs_review'].includes(receipt.state) &&
        !(await desiredReview(tx, options.firestore, ref, job, receipt)))
    )
      return;
    const publishing = mainPlan(intent);
    let plan: Checkpoint['plan'];
    let evidence: StageEvidence[] = [];
    if (input.workflow === 'publishing') {
      if (
        !publishing ||
        (input.waitingStep === 'subsplash-media' && !publishing.needsMedia) ||
        (input.waitingStep === 'soundcloud-track' && !publishing.soundcloud)
      )
        return;
      plan = publishing;
      evidence = await deriveStages(tx, options.firestore, ref, intent, job, publishing);
    } else {
      if (input.completedStages.length) return;
      plan = {
        kind: intent.kind,
        entity: { type: intent.entity.type, id: intent.entity.id },
        generation: intent.generation,
        continuation: 'reviewed-create',
        receiptId,
        receiptStep: receipt.step,
      };
    }
    const completedStages = evidence.map((value) => value.stage);
    if (
      input.completedStages.some((stage) => !completedStages.includes(stage as PublishingReviewedActivityStage)) ||
      !orderedHints(input.completedStages)
    )
      return;
    const checkpoint: Checkpoint = {
      schemaVersion: 1,
      ...ref,
      generation: intent.generation,
      workflowId: job.workflowId,
      intentDigest: digest(intent),
      planDigest: digest(plan),
      workflow: input.workflow,
      waitingStep: input.waitingStep,
      completedStages,
      evidence,
      receiptId,
      receipt: {
        operationKey: receipt.operationKey,
        step: receipt.step,
        fingerprint: receipt.fingerprint,
        owner: receipt.owner!,
        revision: receipt.revision!,
        providerAccount: receipt.providerAccount,
      },
      plan,
      savedRevision: job.revision,
    };
    const checkpointId = digest(checkpoint),
      target = options.firestore.doc(`${PUBLISHING_CREATE_REVIEW_CHECKPOINTS}/${checkpointId}`),
      existing = await tx.get(target);
    if (existing.exists && digest(existing.data()) !== checkpointId)
      throw new Error('PUBLISHING_CREATE_REVIEW_CHECKPOINT_CHANGED');
    if (!existing.exists) tx.create(target, checkpoint);
    result = { checkpointId };
  });
  return result;
}
export async function loadPublishingCreateReviewContinuation(
  ref: DurableJobRef,
  checkpointId: string,
  options: {
    firestore: Firestore;
    assertCurrent: (ref: DurableJobRef, intent: DurableJobIntent<unknown>) => Promise<void>;
  }
): Promise<PublishingCreateReviewContinuation | undefined> {
  if (!sha(checkpointId)) return;
  const result = await options.firestore.runTransaction(async (tx) => {
    const snapshot = await tx.get(options.firestore.doc(`${PUBLISHING_CREATE_REVIEW_CHECKPOINTS}/${checkpointId}`)),
      checkpoint = snapshot.data() as Checkpoint | undefined,
      current = await currentPrivate(tx, options.firestore, ref);
    if (!checkpoint || digest(checkpoint) !== checkpointId || !current) return;
    const { intent, job } = current;
    if (
      checkpoint.schemaVersion !== 1 ||
      checkpoint.projectId !== ref.projectId ||
      checkpoint.jobId !== ref.jobId ||
      checkpoint.generation !== intent.generation ||
      checkpoint.workflowId !== job.workflowId ||
      checkpoint.intentDigest !== digest(intent) ||
      checkpoint.planDigest !== digest(checkpoint.plan)
    )
      return;
    await options.assertCurrent(ref, intent);
    const receipt = (
      await tx.get(options.firestore.doc(`${PROVIDER_RECEIPTS_COLLECTION}/${checkpoint.receiptId}`))
    ).data() as ProviderReceipt | undefined;
    if (
      !receipt ||
      !validReceipt(ref, checkpoint.receiptId, receipt) ||
      !receiptFits(intent, checkpoint.workflow, checkpoint.waitingStep, receipt) ||
      receipt.operationKey !== checkpoint.receipt.operationKey ||
      receipt.step !== checkpoint.receipt.step ||
      receipt.fingerprint !== checkpoint.receipt.fingerprint ||
      receipt.owner !== checkpoint.receipt.owner ||
      digest(receipt.providerAccount) !== digest(checkpoint.receipt.providerAccount) ||
      Number(receipt.revision) < checkpoint.receipt.revision ||
      !(await desiredReview(tx, options.firestore, ref, job, receipt))
    )
      return;
    if (checkpoint.workflow === 'publishing') {
      const plan = mainPlan(intent);
      if (!plan || digest(plan) !== checkpoint.planDigest) return;
      const evidence = await deriveStages(tx, options.firestore, ref, intent, job, plan);
      if (
        checkpoint.evidence.some(
          (saved) => !evidence.some((value) => value.stage === saved.stage && value.proofDigest === saved.proofDigest)
        )
      )
        return;
      return {
        intent,
        continuation: {
          workflow: 'publishing' as const,
          waitingStep: checkpoint.waitingStep,
          completedStages: evidence.map((value) => value.stage),
          plan,
        },
      };
    }
    if (checkpoint.completedStages.length) return;
    return {
      intent,
      continuation: {
        workflow: 'publishingEntity' as const,
        waitingStep: 'entity' as const,
        completedStages: [] as [],
        plan: checkpoint.plan as ReviewedEntityCreatePlan,
      },
    };
  });
  if (result) {
    await options.assertCurrent(ref, result.intent);
    return result.continuation;
  }
  return;
}
