import { getProviderExecutionProfile, assertSandboxIntentProfile } from '../../providerSandbox/profile';
import { assertProviderAdmissionCatalog } from '../../providerSandbox/admission';
import type { Firestore } from 'firebase-admin/firestore';
import type { DurableJobRef, DurableEntityRef, ProviderExecution } from '@upperroom/contracts/temporal';
import { type DurableJobPatch, createDurableJobStore } from '../../../../packages/orchestration/src/job-store';
import { prepareProviderBinding } from '../../../../packages/orchestration/src/provider-usage';
import { assertAdmissionReleaseInTransaction } from '../releaseControl';
import {
  acknowledgementHasReviewedDisposition,
  assertProviderReceiptExecutionProfile,
  providerAcknowledgementFingerprint,
  providerPayloadFingerprint,
  providerReceiptId,
  type ProviderAcknowledgementFact,
  type ProviderReceipt,
} from './providerReceipts';

export interface ProviderOrphanReviewIntent extends Record<string, unknown> {
  schemaVersion: 1;
  providerExecution?: ProviderExecution;
  sourceJobId: string;
  sourceAcknowledgementId: string;
  acknowledgementFingerprint: string;
}
export interface ProviderOrphanReviewActivities {
  reviewProviderOrphanAcknowledgement(ref: DurableJobRef): Promise<'pending' | 'complete'>;
}
const identity = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
export const providerOrphanReviewJobId = (projectId: string, acknowledgementId: string): string =>
  providerPayloadFingerprint(['provider-orphan-review', projectId, acknowledgementId]);

/** Public identity is checked against the immutable authenticated ACK and its original private intent.
 * A later operator adoption may change the receipt's selected result, never this original claim. */
export function validateProviderOrphanAcknowledgement(
  ref: DurableJobRef,
  acknowledgementId: string,
  fact: ProviderAcknowledgementFact,
  receipt: ProviderReceipt
): void {
  if (
    !fact ||
    !receipt ||
    fact.schemaVersion !== 1 ||
    fact.disposition !== 'orphaned' ||
    fact.projectId !== ref.projectId ||
    fact.jobId !== ref.jobId ||
    !identity(fact.remoteId) ||
    !identity(fact.attemptOwner) ||
    !Number.isSafeInteger(fact.claimRevision) ||
    fact.claimRevision < 1 ||
    !Number.isFinite(fact.acknowledgedAtMillis) ||
    providerPayloadFingerprint([fact.receiptId, fact.attemptOwner, fact.claimRevision, fact.remoteId]) !==
      acknowledgementId ||
    receipt.projectId !== ref.projectId ||
    receipt.jobId !== ref.jobId ||
    !receipt.operationKey?.startsWith(`durable:${ref.projectId}:${ref.jobId}:`) ||
    fact.receiptId !== providerReceiptId(receipt.operationKey, receipt.step) ||
    receipt.step !== fact.step ||
    receipt.fingerprint !== fact.payloadFingerprint ||
    providerPayloadFingerprint(receipt.providerAccount) !== providerPayloadFingerprint(fact.providerAccount) ||
    providerPayloadFingerprint(receipt.providerExecutionProfile) !==
      providerPayloadFingerprint(fact.providerExecutionProfile) ||
    !fact.providerAccount ||
    !['subsplash', 'soundcloud'].includes(fact.providerAccount.provider) ||
    !identity(fact.providerAccount.account)
  )
    throw new Error('Provider orphan acknowledgement proof is invalid');
}

/** A late factual ACK inherits its original environment/scenario, never a newly selected default. */
export function providerOrphanReviewPayload(
  sourceRef: DurableJobRef,
  acknowledgementId: string,
  fact: ProviderAcknowledgementFact,
  original: Record<string, any>
): ProviderOrphanReviewIntent {
  let providerExecution: ProviderExecution | undefined;
  if (sourceRef.projectId === 'urm-app-staging') {
    const profile = getProviderExecutionProfile(sourceRef.projectId);
    if (profile.mode !== 'sandbox') throw new Error('Provider orphan profile unavailable');
    providerExecution = assertSandboxIntentProfile(profile, original);
  }
  assertProviderReceiptExecutionProfile(
    providerExecution
      ? { mode: providerExecution.mode, profileId: providerExecution.profileId, version: providerExecution.version }
      : undefined,
    fact.providerExecutionProfile
  );
  return {
    schemaVersion: 1,
    sourceJobId: sourceRef.jobId,
    sourceAcknowledgementId: acknowledgementId,
    acknowledgementFingerprint: providerAcknowledgementFingerprint(fact),
    ...(providerExecution ? { providerExecution } : {}),
  };
}

/** Fact-first trigger admission can retry through release/index pauses. Terminal originals stay terminal. */
export async function ensureProviderOrphanReview(
  firestore: Firestore,
  sourceRef: DurableJobRef,
  acknowledgementId: string
): Promise<DurableJobRef> {
  const ref = {
    projectId: sourceRef.projectId,
    jobId: providerOrphanReviewJobId(sourceRef.projectId, acknowledgementId),
  };
  const store = createDurableJobStore({ firestore, projectId: ref.projectId });
  await firestore.runTransaction(async (tx) => {
    const [factSnapshot, originalSnapshot, childSnapshot] = await Promise.all([
      tx.get(firestore.collection('temporalProviderAcknowledgements').doc(acknowledgementId)),
      tx.get(firestore.collection('durableJobIntents').doc(sourceRef.jobId)),
      tx.get(firestore.collection('durableJobs').doc(ref.jobId)),
    ]);
    const fact = factSnapshot.data() as ProviderAcknowledgementFact;
    const original = originalSnapshot.data();
    if (!fact || fact.disposition !== 'orphaned') return;
    const receipt = (
      await tx.get(firestore.collection('temporalProviderReceipts').doc(fact.receiptId))
    ).data() as ProviderReceipt;
    validateProviderOrphanAcknowledgement(sourceRef, acknowledgementId, fact, receipt);
    if (
      !original ||
      original.projectId !== ref.projectId ||
      original.jobId !== sourceRef.jobId ||
      typeof original.actorUid !== 'string' ||
      !original.actorUid ||
      original.actorUid.length > 128 ||
      !original.entity
    )
      throw new Error('Provider orphan original intent is unavailable');
    const payload = providerOrphanReviewPayload(sourceRef, acknowledgementId, fact, original);
    if (childSnapshot.exists) {
      const childIntent = await tx.get(firestore.collection('durableJobIntents').doc(ref.jobId));
      if (
        childIntent.get('kind') !== 'provider.orphan_review' ||
        childIntent.get('payload.sourceAcknowledgementId') !== acknowledgementId ||
        childIntent.get('payload.acknowledgementFingerprint') !== providerAcknowledgementFingerprint(fact) ||
        providerPayloadFingerprint(childIntent.get('payload')) !== providerPayloadFingerprint(payload) ||
        providerPayloadFingerprint(childSnapshot.get('providerExecution')) !==
          providerPayloadFingerprint(payload.providerExecution)
      )
        throw new Error('Provider orphan review identity collision');
      return;
    }
    if (payload.providerExecution) {
      const profile = getProviderExecutionProfile(sourceRef.projectId);
      if (profile.mode !== 'sandbox') throw new Error('Provider orphan profile unavailable');
      await assertProviderAdmissionCatalog(tx, firestore, { profile });
    }
    await assertAdmissionReleaseInTransaction(tx, firestore, 'provider.orphan_review', { continuation: true });
    const reviewSeal = await tx.get(
      firestore.collection('temporalProviderAcknowledgementReviews').doc(acknowledgementId)
    );
    const reviewed =
      acknowledgementHasReviewedDisposition(fact) &&
      reviewSeal.get('projectId') === ref.projectId &&
      reviewSeal.get('jobId') === sourceRef.jobId &&
      reviewSeal.get('acknowledgementFingerprint') === providerAcknowledgementFingerprint(fact) &&
      reviewSeal.get('decision') === fact.review?.decision &&
      reviewSeal.get('commandId') === fact.review?.commandId;
    if (fact.review && !reviewed) throw new Error('Provider orphan disposition seal is invalid');
    const binding = reviewed
      ? () => {}
      : await prepareProviderBinding(tx, firestore, {
          resource: {
            projectId: ref.projectId,
            provider: fact.providerAccount!.provider,
            account: fact.providerAccount!.provider === 'soundcloud' ? 'configured-account' : 'app:9XTSHD',
            remoteId: fact.remoteId,
          },
          jobId: ref.jobId,
          bindingId: `pending-provider-ack:${acknowledgementId}`,
        });
    // Separate entity: several ACKs for one sermon must remain independently reviewable concurrently.
    const entity: DurableEntityRef = {
      type: 'maintenance',
      id: `provider-orphan-${ref.jobId}`,
      label: 'Additional provider resource review',
    };
    const input = {
      ref,
      kind: 'provider.orphan_review' as const,
      entity,
      actorUid: original.actorUid,
      requestId: `provider-ack-review:${acknowledgementId}`,
      generation: 1,
      createdAt: Date.now(),
      payload,
      dispatch: {
        ref,
        workflowType: 'ProviderOrphanReview',
        workflowId: `provider-ack-review:${ref.projectId}:${ref.jobId}`,
        taskQueue: 'urm-orchestration',
      },
    };
    const prepare = await store.prepareCreateInTransaction(tx, input);
    prepare();
    store.createInTransaction(tx, input);
    binding();
    tx.update(firestore.collection('durableJobs').doc(ref.jobId), {
      actions: [],
      result: {
        sourceJobId: sourceRef.jobId,
        sourceEntityId: original.entity.id,
        sourceEntityType: original.entity.type,
      },
    });
  });
  return ref;
}

/** Read-only private admission proof shared by runtime's narrow trusted-source authorizer. */
export async function loadValidatedProviderOrphanReview(firestore: Firestore, ref: DurableJobRef) {
  const store = createDurableJobStore({ firestore, projectId: ref.projectId });
  const intent = await store.loadIntent<ProviderOrphanReviewIntent>(ref);
  if (
    intent.kind !== 'provider.orphan_review' ||
    intent.payload.schemaVersion !== 1 ||
    providerOrphanReviewJobId(ref.projectId, intent.payload.sourceAcknowledgementId) !== ref.jobId ||
    intent.entity.type !== 'maintenance' ||
    intent.entity.id !== `provider-orphan-${ref.jobId}`
  )
    throw new Error('Provider orphan review admission proof is invalid');
  const [factSnapshot, original] = await Promise.all([
    firestore.collection('temporalProviderAcknowledgements').doc(intent.payload.sourceAcknowledgementId).get(),
    firestore.collection('durableJobIntents').doc(intent.payload.sourceJobId).get(),
  ]);
  const fact = factSnapshot.data() as ProviderAcknowledgementFact;
  const receipt = (
    await firestore
      .collection('temporalProviderReceipts')
      .doc(fact?.receiptId ?? '__missing__')
      .get()
  ).data() as ProviderReceipt;
  validateProviderOrphanAcknowledgement(
    { projectId: ref.projectId, jobId: intent.payload.sourceJobId },
    intent.payload.sourceAcknowledgementId,
    fact,
    receipt
  );
  if (
    providerAcknowledgementFingerprint(fact) !== intent.payload.acknowledgementFingerprint ||
    original.get('projectId') !== ref.projectId ||
    original.get('jobId') !== intent.payload.sourceJobId ||
    original.get('actorUid') !== intent.actorUid ||
    providerPayloadFingerprint(intent.payload) !==
      providerPayloadFingerprint(
        providerOrphanReviewPayload(
          { projectId: ref.projectId, jobId: intent.payload.sourceJobId },
          intent.payload.sourceAcknowledgementId,
          fact,
          original.data() ?? {}
        )
      )
  )
    throw new Error('Provider orphan review immutable evidence changed');
  return { intent, fact, receipt };
}

/** No provider transport or original desired-operation handler exists in this activity. */
export function createProviderOrphanReviewActivities(
  firestore: Firestore,
  projectId: string,
  project: (ref: DurableJobRef, patch: DurableJobPatch) => Promise<unknown>
): ProviderOrphanReviewActivities {
  return {
    async reviewProviderOrphanAcknowledgement(ref) {
      const { intent, fact } = await loadValidatedProviderOrphanReview(firestore, ref);
      const seal = await firestore
        .collection('temporalProviderAcknowledgementReviews')
        .doc(intent.payload.sourceAcknowledgementId)
        .get();
      const complete =
        acknowledgementHasReviewedDisposition(fact) &&
        seal.get('acknowledgementFingerprint') === intent.payload.acknowledgementFingerprint &&
        seal.get('decision') === fact.review?.decision &&
        seal.get('commandId') === fact.review?.commandId &&
        seal.get('projectId') === projectId &&
        seal.get('jobId') === intent.payload.sourceJobId;
      if (ref.projectId !== projectId) throw new Error('Provider orphan review project mismatch');
      // A completed projection may have committed before the activity response was lost.
      // Never change its terminal timestamp or reopen the case during an SDK retry.
      const current = await createDurableJobStore({ firestore, projectId }).loadJob(ref);
      if (current.state === 'succeeded') {
        if (!complete) throw new Error('Completed provider orphan review lost its sealed disposition');
        return 'complete';
      }
      await project(
        ref,
        complete
          ? { state: 'succeeded', actions: [], finishedAt: Date.now() }
          : {
              state: 'needs_attention',
              actions: ['resolve'],
              attention: {
                kind: 'external_result_unknown',
                message:
                  'An additional original provider resource needs an administrator to retain it or verify that it is already absent.',
                acknowledgementId: intent.payload.sourceAcknowledgementId,
                provider: fact.providerAccount!.provider,
              },
            }
      );
      return complete ? 'complete' : 'pending';
    },
  };
}
