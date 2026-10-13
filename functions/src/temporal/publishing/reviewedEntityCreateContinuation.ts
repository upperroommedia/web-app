import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { PublishingEntityExecutionOptions, PublishingEntityIntent } from './entityMutations';
import { completeReviewedListCreate } from './entityMutations';
import { loadPublishingCreateReviewContinuation } from './reviewedCreateContinuation';
import {
  completeConfirmedSeriesCreate,
  validateSeriesCreateTailCheckpoint,
  type SeriesCreateTailCheckpoint,
  type CreateSeriesInputType,
} from '../../createSeries';
import { getSeriesDetails } from '../../helpers/seriesHelpers';
import { authenticateSubsplash } from '../../subsplashUtils';
import {
  providerPayloadFingerprint,
  providerReceiptId,
  PROVIDER_RECEIPTS_COLLECTION,
  type ProviderReceipt,
} from './providerReceipts';
import { HttpsError } from 'firebase-functions/v2/https';
const fail = (): never => {
  throw new HttpsError(
    'failed-precondition',
    'The reviewed create continuation does not match its original source program.'
  );
};
export type ReviewedEntityCreateContinuationOptions = PublishingEntityExecutionOptions & {
  firestore: Firestore;
  loadIntent(ref: DurableJobRef): Promise<PublishingEntityIntent>;
  assertCurrent(ref: DurableJobRef, intent: PublishingEntityIntent): Promise<void>;
  commitCurrent(ref: DurableJobRef, write: (tx: Transaction) => Promise<void>): Promise<void>;
};
/** Source-approved remaining stages only. The original create primitive is never called. */
export async function executeReviewedPublishingEntityCreateContinuation(
  ref: DurableJobRef,
  checkpointId: string,
  options: ReviewedEntityCreateContinuationOptions
): Promise<Record<string, unknown>> {
  const resumed = await loadPublishingCreateReviewContinuation(ref, checkpointId, {
    firestore: options.firestore,
    assertCurrent: async (current) => options.assertCurrent(current, await options.loadIntent(current)),
  });
  if (!resumed || resumed.workflow !== 'publishingEntity') return fail();
  const plan = resumed.plan,
    intent = await options.loadIntent(ref);
  if (
    intent.kind !== plan.kind ||
    intent.generation !== plan.generation ||
    intent.entity.type !== plan.entity.type ||
    intent.entity.id !== plan.entity.id ||
    intent.payload.operation !== 'create'
  )
    return fail();
  await options.assertCurrent(ref, intent);
  if (intent.kind === 'list.create') return completeReviewedListCreate(ref, intent, plan, options);
  if (intent.kind === 'speaker.mutate') {
    const { parseCreateSpeakerInput, completeConfirmedSpeakerCreate, validateSpeakerCreateTailCheckpoint } =
      await import('../../speakers/speakerMutations');
    const operationKey = `durable:${ref.projectId}:${ref.jobId}:speaker.mutate:create`,
      input = parseCreateSpeakerInput({ ...(intent.payload.input as Record<string, unknown>), operationKey });
    const checkpointDoc = await options.firestore
        .doc(`temporalPublishingSpeakerCreationState/${providerReceiptId(ref.jobId, intent.entity.id)}`)
        .get(),
      checkpoint = checkpointDoc.data() as
        | import('../../speakers/speakerMutations').SpeakerCreateTailCheckpoint
        | undefined;
    if (
      !checkpoint ||
      checkpoint.projectId !== ref.projectId ||
      checkpoint.jobId !== ref.jobId ||
      checkpoint.generation !== plan.generation ||
      !['speaker-tag-create', 'list-create'].includes(plan.receiptStep)
    )
      return fail();
    validateSpeakerCreateTailCheckpoint(checkpoint, input, intent.entity.id);
    const tagKey = `${operationKey}:create-speaker-tag`,
      tagReceiptId = providerReceiptId(tagKey, 'speaker-tag-create'),
      tagReceipt = (await options.firestore.doc(`${PROVIDER_RECEIPTS_COLLECTION}/${tagReceiptId}`).get()).data() as
        | ProviderReceipt
        | undefined;
    const tagId =
      tagReceipt?.result && typeof tagReceipt.result === 'object' && 'tagId' in tagReceipt.result
        ? tagReceipt.result.tagId
        : undefined;
    if (
      tagReceipt?.state !== 'confirmed' ||
      tagReceipt.projectId !== ref.projectId ||
      tagReceipt.jobId !== ref.jobId ||
      tagReceipt.operationKey !== tagKey ||
      tagReceipt.step !== 'speaker-tag-create' ||
      tagReceipt.providerAccount?.provider !== 'subsplash' ||
      tagReceipt.providerAccount.account !== 'app:9XTSHD' ||
      tagReceipt.fingerprint !== providerPayloadFingerprint(checkpoint.tagPayload) ||
      typeof tagId !== 'string' ||
      !tagId ||
      /[\s/?#]/.test(tagId)
    )
      return fail();
    const selectedKey = plan.receiptStep === 'speaker-tag-create' ? tagKey : `${operationKey}:create-speaker-list`;
    if (plan.receiptId !== providerReceiptId(selectedKey, plan.receiptStep)) return fail();
    if (plan.receiptStep === 'list-create') {
      const selected = (
        await options.firestore.doc(`${PROVIDER_RECEIPTS_COLLECTION}/${plan.receiptId}`).get()
      ).data() as ProviderReceipt | undefined;
      if (
        !checkpoint.listPayload ||
        selected?.state !== 'confirmed' ||
        selected.operationKey !== selectedKey ||
        selected.step !== 'list-create' ||
        selected.projectId !== ref.projectId ||
        selected.jobId !== ref.jobId ||
        selected.providerAccount?.provider !== 'subsplash' ||
        selected.providerAccount.account !== 'app:9XTSHD' ||
        selected.fingerprint !== providerPayloadFingerprint(checkpoint.listPayload)
      )
        return fail();
    }
    await options.assertCurrent(ref, intent);
    const result = await completeConfirmedSpeakerCreate(
      input,
      { tagId },
      {
        checkpoint,
        speakerId: intent.entity.id,
        firestore: options.firestore,
        commitCurrent: (write) => options.commitCurrent(ref, write),
      }
    );
    return {
      speakerId: result.speakerId,
      ...(result.listId ? { listId: result.listId } : {}),
      ...(result.listSubsplashId ? { listSubsplashId: result.listSubsplashId } : {}),
    };
  }

  if (intent.kind !== 'series.create' || plan.receiptStep !== 'subsplash-series') return fail();
  const operationKey = `durable:${ref.projectId}:${ref.jobId}:series.create:create`;
  if (plan.receiptId !== providerReceiptId(operationKey, 'subsplash-series')) return fail();
  const input = intent.payload.input as Record<string, unknown>,
    data = {
      ...input,
      ownerId: intent.actorUid,
      firestoreId: intent.entity.id,
      operationKey,
    } as unknown as CreateSeriesInputType;
  const checkpointRef = options.firestore.doc(
    `temporalPublishingSeriesCreationState/${providerReceiptId(ref.jobId, intent.entity.id)}`
  );
  const [snapshot, receiptDoc] = await Promise.all([
    checkpointRef.get(),
    options.firestore.doc(`${PROVIDER_RECEIPTS_COLLECTION}/${plan.receiptId}`).get(),
  ]);
  const checkpoint = snapshot.data() as SeriesCreateTailCheckpoint | undefined,
    receipt = receiptDoc.data() as ProviderReceipt | undefined;
  if (
    !checkpoint ||
    checkpoint.projectId !== ref.projectId ||
    checkpoint.jobId !== ref.jobId ||
    receipt?.state !== 'confirmed' ||
    receipt.operationKey !== operationKey ||
    receipt.step !== 'subsplash-series' ||
    receipt.projectId !== ref.projectId ||
    receipt.jobId !== ref.jobId ||
    receipt.providerAccount?.provider !== 'subsplash' ||
    receipt.providerAccount.account !== 'app:9XTSHD' ||
    receipt.fingerprint !== providerPayloadFingerprint(data)
  )
    return fail();
  validateSeriesCreateTailCheckpoint(checkpoint, data);
  const remote =
    receipt.result && typeof receipt.result === 'object' && 'id' in receipt.result ? receipt.result.id : undefined;
  if (typeof remote !== 'string' || !remote || /[\s/?#]/.test(remote)) return fail();
  const token = await authenticateSubsplash(),
    confirmed = await getSeriesDetails(remote, token);
  if (
    confirmed.id !== remote ||
    confirmed.app_key !== '9XTSHD' ||
    confirmed.title !== data.title.trim() ||
    (data.summary?.trim() && confirmed.summary !== data.summary.trim())
  )
    return fail();
  await options.assertCurrent(ref, intent);
  const result = await completeConfirmedSeriesCreate(data, confirmed, {
    token,
    checkpoint,
    firestore: options.firestore,
    commitCurrent: (write) => options.commitCurrent(ref, write),
  });
  return {
    firestoreId: result.firestoreId,
    subsplashId: result.subsplashId,
    ...(result.slug ? { slug: result.slug } : {}),
  };
}
