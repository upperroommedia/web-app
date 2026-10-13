import axios from 'axios';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationFailure } from '@temporalio/common';
import { Context, heartbeat } from '@temporalio/activity';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { Storage } from '@google-cloud/storage';
import type {
  DurableJob,
  DurableJobRef,
  DurableJobStep,
  DurableJobState,
  DurableJobAttention,
  DurableSafeError,
} from '@upperroom/contracts/temporal';
import { authenticateSubsplash, createAxiosConfig } from '../../subsplashUtils';
import computeMetadataForImage from '../../computeMetadataForImage';
import { ensureFirebaseDownloadUrl } from '../../storageDownloadUrl';
import { createDurableJobStore } from '../../../../packages/orchestration/src/job-store';
import type { ImageActivities, ImageIntent } from './types';
import { assertProviderMutationTransportAllowed } from '../publishing/providerTransportPolicy';

export interface ImageDependencies {
  firestore: Firestore;
  getActor(uid: string): Promise<{ disabled: boolean; customClaims?: { role?: unknown } }>;
  storage: Storage;
  loadIntent(ref: DurableJobRef): Promise<{ payload: ImageIntent }>;
  loadJob(ref: DurableJobRef): Promise<DurableJob>;
  assertCurrentInTransaction(tx: Transaction, ref: DurableJobRef): Promise<unknown>;
  assertCurrent(ref: DurableJobRef): Promise<void>;
  recordStep(ref: DurableJobRef, step: DurableJobStep): Promise<void>;
  project(
    ref: DurableJobRef,
    patch: {
      state: DurableJobState;
      actions?: ('resolve' | 'cancel' | 'resume')[];
      result?: Record<string, unknown>;
      attention?: DurableJobAttention;
      error?: DurableSafeError;
    }
  ): Promise<void>;
}

export function configuredImageProviderAccount(): ImageIntent['providerAccount'] {
  const principal = process.env.SUBSPLASH_EMAIL?.trim().toLowerCase();
  return principal
    ? { appKey: '9XTSHD', principalHash: createHash('sha256').update(`app:9XTSHD:${principal}`).digest('hex') }
    : undefined;
}
function assertImageMutationTransportAllowed(): void {
  try {
    assertProviderMutationTransportAllowed('subsplash');
  } catch {
    throw ApplicationFailure.nonRetryable(
      'Image writes require a verified isolated destination account',
      'ProviderAccountIsolationRequired'
    );
  }
}
function sameImageAccount(account: ImageIntent['providerAccount']): boolean {
  const configured = configuredImageProviderAccount();
  return (
    !!account &&
    !!configured &&
    account.appKey === configured.appKey &&
    account.principalHash === configured.principalHash
  );
}
async function verifyFixedImageAbsent(remoteId: string, account: ImageIntent['providerAccount']): Promise<boolean> {
  if (!sameImageAccount(account)) return false;
  const token = await authenticateSubsplash();
  try {
    const response = await axios({
      ...createAxiosConfig(`https://core.subsplash.com/files/v1/images/${encodeURIComponent(remoteId)}`, token, 'GET'),
      timeout: 30000,
      validateStatus: (status) => status === 200 || status === 404,
    });
    return response.status === 404;
  } catch {
    throw ApplicationFailure.retryable('Shared image presence could not be verified', 'ImagePresenceUnavailable');
  }
}

function sharedImageReview(
  ref: DurableJobRef,
  remoteId: string,
  account: ImageIntent['providerAccount']
): DurableJobAttention {
  return {
    kind: 'external_result_unknown',
    message:
      'This image may be used outside this project. Retain it or verify that it was already removed; this service will not delete a shared image.',
    resolutionKind: 'retain_existing_resource',
    receiptId: ref.jobId,
    remoteId,
    resolutionDecisions: sameImageAccount(account)
      ? ['retain_existing_resource', 'confirm_existing_resource_absent']
      : ['retain_existing_resource'],
  };
}

export function imageDeletionIntentHash(intent: ImageIntent): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        intent.imageId,
        intent.remoteId ?? null,
        intent.source.bucket,
        intent.source.path,
        intent.source.generation,
      ])
    )
    .digest('hex');
}

/** URLs and image metadata stay in private receipts, never in Activity arguments/results. */
export function createImageActivities(deps: ImageDependencies): ImageActivities {
  const receipt = (ref: DurableJobRef) => deps.firestore.collection('temporalImageReceipts').doc(ref.jobId);
  async function source(ref: DurableJobRef) {
    await deps.assertCurrent(ref);
    const { payload } = await deps.loadIntent(ref);
    const file = deps.storage
      .bucket(payload.source.bucket)
      .file(payload.source.path, { generation: payload.source.generation });
    return { intent: payload, file };
  }
  async function step(ref: DurableJobRef, id: string, label: string, operation: () => Promise<void>) {
    const previous = (await deps.loadJob(ref)).steps.find((item) => item.id === id);
    if (previous?.state === 'succeeded') return;
    // Manual resume schedules a fresh Activity whose SDK attempt resets to one.
    // Keep the public business-step attempt monotonic across those executions.
    const attempt = (previous?.attempt ?? 0) + 1;
    await deps.recordStep(ref, { id, label, state: 'running', attempt });
    heartbeat({ step: id });
    const timer = setInterval(() => heartbeat({ step: id }), 5000);
    try {
      await operation();
    } catch (error) {
      if (error instanceof ApplicationFailure) throw error;
      if ((error as { code?: string })?.code === 'STALE_GENERATION')
        throw ApplicationFailure.nonRetryable('Image operation was superseded', 'STALE_GENERATION');
      // Axios errors contain signed URLs and authorization headers. Never cross the history boundary.
      if (Context.current().cancellationSignal.aborted) throw error;
      throw ApplicationFailure.retryable('Image provider operation failed', 'ImageProviderFailure');
    } finally {
      clearInterval(timer);
    }
    await deps.recordStep(ref, { id, label, state: 'succeeded', attempt });
  }
  const activities: ImageActivities = {
    async prepareImage(ref) {
      await step(ref, 'source', 'Verify image source', async () => {
        const { intent, file } = await source(ref);
        const [metadata] = await file.getMetadata();
        if (
          String(metadata.generation) !== intent.source.generation ||
          metadata.contentType !== intent.source.contentType ||
          Number(metadata.size) > 25 * 1024 * 1024
        ) {
          throw ApplicationFailure.nonRetryable(
            'The selected image source changed or exceeds 25 MB',
            'ImageSourceInvalid'
          );
        }
        await deps.project(ref, { state: 'running' });
      });
    },
    async allocateImage(ref) {
      await step(ref, 'allocate', 'Reserve destination image', async () => {
        assertImageMutationTransportAllowed();
        const { intent } = await source(ref);
        const target = receipt(ref);
        const claimId = randomUUID();
        const claimFingerprint = createHash('sha256')
          .update(JSON.stringify([ref.projectId, ref.jobId, intent.source, intent.imageId, intent.name, intent.type]))
          .digest('hex');
        const providerAccount = configuredImageProviderAccount();
        const shouldCreate = await deps.firestore.runTransaction(async (tx) => {
          const saved = (await tx.get(target)).data();
          if (saved?.remoteId) return false;
          if (saved?.state === 'allocating' || saved?.state === 'needs_attention') {
            throw ApplicationFailure.nonRetryable(
              'Image allocation needs operator reconciliation',
              'ImageAllocationAmbiguous'
            );
          }
          tx.set(target, {
            state: 'allocating',
            allocationClaim: {
              claimId,
              fingerprint: claimFingerprint,
              ...(providerAccount ? { providerAccount } : {}),
            },
            originalAllocationStatus: 'submitting',
            sourceGeneration: intent.source.generation,
            imageId: intent.imageId,
            updatedAt: Date.now(),
          });
          return true;
        });
        if (!shouldCreate) return;
        try {
          const token = await authenticateSubsplash();
          await deps.assertCurrent(ref);
          assertImageMutationTransportAllowed();
          const response = await axios({
            ...createAxiosConfig('https://core.subsplash.com/files/v1/images', token, 'POST', {
              app_key: '9XTSHD',
              content_type: intent.source.contentType,
              title: intent.name,
              type: intent.type,
            }),
            signal: Context.current().cancellationSignal,
            maxRedirects: 0,
            timeout: 30000,
          });
          const remoteId = response.data?.id;
          const uploadUrl = response.data?._links?.presigned_upload_url?.href;
          if (typeof remoteId !== 'string' || typeof uploadUrl !== 'string')
            throw new Error('Invalid allocation response');
          const disposition = await recordImageAllocationAcknowledgement(
            deps.firestore,
            ref,
            { claimId, fingerprint: claimFingerprint, providerAccount },
            intent,
            { remoteId, uploadUrl }
          );
          if (disposition !== 'allocated')
            throw ApplicationFailure.nonRetryable(
              'Original image allocation was acknowledged after review and requires its own retention review',
              'ImageAdditionalAllocationReview'
            );
        } catch (error) {
          if (error instanceof ApplicationFailure && error.type === 'ImageAdditionalAllocationReview') throw error;
          if ((error as { code?: string })?.code === 'STALE_GENERATION') {
            await deps.firestore.runTransaction(async (tx) => {
              const current = await tx.get(target);
              if (current.get('state') === 'allocating' && current.get('allocationClaim')?.claimId === claimId)
                tx.set(target, { state: 'not_created', updatedAt: Date.now() }, { merge: true });
            });
            throw ApplicationFailure.nonRetryable(
              'Image operation was superseded before allocation',
              'STALE_GENERATION'
            );
          }
          await deps.firestore.runTransaction(async (tx) => {
            const current = await tx.get(target);
            if (current.get('state') === 'allocating' && current.get('allocationClaim')?.claimId === claimId)
              tx.set(
                target,
                { state: 'needs_attention', originalAllocationStatus: 'unknown', updatedAt: Date.now() },
                { merge: true }
              );
          });
          throw ApplicationFailure.nonRetryable(
            'Image allocation result is unknown; resolve before retrying',
            'ImageAllocationAmbiguous'
          );
        }
      });
    },
    async uploadImageBytes(ref) {
      await step(ref, 'upload', 'Transfer image to destination', async () => {
        assertImageMutationTransportAllowed();
        const { intent, file } = await source(ref);
        const saved = (await receipt(ref).get()).data();
        if (saved?.state === 'retained' || saved?.resolutionCommandId)
          throw ApplicationFailure.nonRetryable(
            'An existing provider image cannot be overwritten without verified original bytes',
            'ImageByteIdentityUnverified'
          );
        if (saved?.state === 'uploaded' || saved?.state === 'committed') return;
        if (!saved?.uploadUrl || !saved.remoteId)
          throw ApplicationFailure.nonRetryable('Destination allocation is missing', 'ImageAllocationAmbiguous');
        const directory = await mkdtemp(join(tmpdir(), 'urm-image-'));
        try {
          const localPath = join(directory, 'source');
          await file.download({ destination: localPath });
          Context.current().cancellationSignal.throwIfAborted();
          const dimensions = await computeMetadataForImage(localPath, true);
          if (
            dimensions.width > 16384 ||
            dimensions.height > 16384 ||
            dimensions.width * dimensions.height > 40_000_000
          )
            throw ApplicationFailure.nonRetryable(
              'Image dimensions exceed the processing limit',
              'ImageDimensionsInvalid'
            );
          const metadata = await computeMetadataForImage(localPath);
          assertImageMutationTransportAllowed();
          const stream = createReadStream(localPath);
          try {
            await axios({
              url: saved.uploadUrl,
              method: 'PUT',
              maxRedirects: 0,
              data: stream,
              timeout: 120000,
              signal: Context.current().cancellationSignal,
              maxBodyLength: 25 * 1024 * 1024,
              headers: { 'Content-Type': intent.source.contentType, 'x-amz-acl': 'public-read' },
            });
          } finally {
            stream.destroy();
          }
          await receipt(ref).set({ state: 'uploaded', metadata, updatedAt: Date.now() }, { merge: true });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    },
    async commitImage(ref) {
      await step(ref, 'commit', 'Make image available', async () => {
        const { intent, file } = await source(ref);
        const saved = (await receipt(ref).get()).data();
        if (!['uploaded', 'committed'].includes(saved?.state))
          throw ApplicationFailure.nonRetryable('Image bytes have not been confirmed', 'ImageNotUploaded');
        const downloadLink = await ensureFirebaseDownloadUrl(file);
        await deps.assertCurrent(ref);
        await deps.firestore.runTransaction(async (tx) => {
          await deps.assertCurrentInTransaction(tx, ref);
          tx.set(deps.firestore.collection('images').doc(intent.imageId), {
            id: intent.imageId,
            subsplashId: saved!.remoteId,
            ...saved!.metadata,
            size: 'original',
            type: intent.type,
            downloadLink,
            name: intent.name,
            dateAddedMillis: Date.now(),
            source: intent.source,
            durableJobId: ref.jobId,
          });
        });
        await receipt(ref).set({ state: 'committed', updatedAt: Date.now() }, { merge: true });
      });
    },
    async deleteImageProviders(ref) {
      await step(ref, 'delete', 'Remove image destinations', async () => {
        const { payload: intent } = await deps.loadIntent(ref);
        if (intent.operation !== 'delete')
          throw ApplicationFailure.nonRetryable('Invalid image deletion intent', 'ImageDeletionInvalid');
        const intentHash = imageDeletionIntentHash(intent);
        const target = receipt(ref);
        let saved = (await target.get()).data();
        if (saved?.deletion?.intentHash && saved.deletion.intentHash !== intentHash)
          throw ApplicationFailure.nonRetryable('Image deletion intent changed', 'ImageDeletionInvalid');
        if (!saved?.deletion) {
          await deps.assertCurrent(ref);
          await target.set(
            {
              state: 'deleting',
              ...(intent.remoteId ? { remoteId: intent.remoteId } : {}),
              ...(intent.providerAccount ? { providerAccount: intent.providerAccount } : {}),
              deletion: {
                schemaVersion: 1,
                intentHash,
                remoteState: intent.remoteId ? 'pending' : 'not_required',
                storageState: 'pending',
                imageId: intent.imageId,
                ...(intent.remoteId ? { remoteId: intent.remoteId } : {}),
                source: intent.source,
              },
            },
            { merge: true }
          );
          saved = (await target.get()).data();
        }
        async function authorizeRemainingEffect() {
          try {
            await deps.assertCurrent(ref);
            return;
          } catch (error) {
            if ((error as { code?: string })?.code !== 'PERMISSION_CHANGED') throw error;
            const grant = (
              await deps.firestore.collection('temporalImageCleanupAuthorizations').doc(ref.jobId).get()
            ).data();
            const job = await deps.loadJob(ref);
            if (
              !grant ||
              grant.intentHash !== intentHash ||
              grant.generation !== job.generation ||
              typeof grant.actorUid !== 'string'
            )
              throw ApplicationFailure.nonRetryable(
                'An administrator must finish this partially completed image deletion',
                'ImageCleanupPermissionChanged'
              );
            const administrator = await deps.getActor(grant.actorUid);
            if (administrator.disabled || administrator.customClaims?.role !== 'admin')
              throw ApplicationFailure.nonRetryable(
                'Image cleanup approval is no longer authorized',
                'ImageCleanupPermissionChanged'
              );
            await deps.firestore.runTransaction(async (tx) => {
              await deps.assertCurrentInTransaction(tx, ref);
            });
          }
        }
        if (intent.remoteId && !['confirmed', 'retained'].includes(saved?.deletion?.remoteState)) {
          await authorizeRemainingEffect();
          if (!(await verifyFixedImageAbsent(intent.remoteId, saved?.providerAccount))) {
            await target.set({ state: 'needs_attention' }, { merge: true });
            throw ApplicationFailure.nonRetryable(
              'This shared image must be retained or verified already absent before local cleanup',
              'ImageSharedReferenceReviewRequired'
            );
          }
          await target.set(
            {
              deletion: {
                remoteState: 'confirmed',
                remoteConfirmedAt: Date.now(),
                presenceProof: 'authenticated_fixed_id_404',
              },
            },
            { merge: true }
          );
        }
        saved = (await target.get()).data();
        if (saved?.deletion?.storageState !== 'confirmed') {
          await authorizeRemainingEffect();
          await deps.storage
            .bucket(intent.source.bucket)
            .file(intent.source.path, { generation: intent.source.generation })
            .delete({ ignoreNotFound: true, ifGenerationMatch: intent.source.generation });
          await target.set(
            { deletion: { storageState: 'confirmed', storageConfirmedAt: Date.now() } },
            { merge: true }
          );
        }
        // This transaction completes only canonical consistency for effects proven absent.
        // It neither re-authorizes the revoked actor nor starts additional provider work.
        await deps.firestore.runTransaction(async (tx) => {
          await deps.assertCurrentInTransaction(tx, ref);
          const [proof, canonical] = await Promise.all([
            tx.get(target),
            tx.get(deps.firestore.collection('images').doc(intent.imageId)),
          ]);
          const deletion = proof.get('deletion');
          if (
            deletion?.intentHash !== intentHash ||
            deletion.storageState !== 'confirmed' ||
            !['confirmed', 'retained', 'not_required'].includes(deletion.remoteState)
          )
            throw ApplicationFailure.nonRetryable(
              'Image deletion evidence is incomplete',
              'ImageDeletionProofIncomplete'
            );
          if (canonical.exists) {
            const current = canonical.data()!;
            if (
              (current.subsplashId ?? null) !== (intent.remoteId ?? null) ||
              current.source?.bucket !== intent.source.bucket ||
              current.source?.path !== intent.source.path ||
              current.source?.generation !== intent.source.generation
            )
              throw ApplicationFailure.nonRetryable(
                'Canonical image changed during cleanup',
                'ImageDeletionCanonicalChanged'
              );
            tx.delete(canonical.ref);
          }
          tx.set(
            target,
            { deletion: { canonicalState: 'confirmed', canonicalConfirmedAt: Date.now() } },
            { merge: true }
          );
        });
      });
    },
    async supersedeImage(ref) {
      const { payload } = await deps.loadIntent(ref);
      const oldReceipt = (await receipt(ref).get()).data();
      const canonical = (await deps.firestore.collection('images').doc(payload.imageId).get()).data();
      if (
        oldReceipt &&
        ((oldReceipt.remoteId && canonical?.subsplashId !== oldReceipt.remoteId) ||
          ['allocating', 'needs_attention'].includes(oldReceipt.state))
      ) {
        const jobId = createHash('sha256').update(`image-reconciliation:${ref.projectId}:${ref.jobId}`).digest('hex');
        const cleanupRef = { ...ref, jobId };
        const store = createDurableJobStore({ firestore: deps.firestore, projectId: ref.projectId });
        await deps.firestore.runTransaction(async (tx) => {
          const existing = await tx.get(deps.firestore.collection('durableJobs').doc(jobId));
          if (existing.exists) return;
          const currentReceipt = (await tx.get(receipt(ref))).data();
          if (!currentReceipt) return;
          store.createInTransaction(tx, {
            ref: cleanupRef,
            kind: 'image.delete',
            entity: { type: 'image', id: `cleanup-${jobId}` },
            actorUid: 'system:firebase-event',
            requestId: `image-reconciliation:${ref.jobId}`,
            generation: 1,
            createdAt: Date.now(),
            payload: {
              ...payload,
              operation: 'reconcile',
              originalJobId: ref.jobId,
              canonicalImageId: payload.imageId,
            },
            dispatch: {
              ref: cleanupRef,
              workflowType: 'ImageReceiptReconciliation',
              workflowId: `image-reconcile:${ref.projectId}:${jobId}`,
              taskQueue: 'urm-images',
            },
          });
          tx.update(deps.firestore.collection('durableJobs').doc(jobId), { actions: [] });
          tx.create(receipt(cleanupRef), {
            ...currentReceipt,
            originalJobId: ref.jobId,
            state: currentReceipt.remoteId ? 'allocated' : 'needs_attention',
          });
        });
      }
      await deps.project(ref, { state: 'superseded', actions: [] });
    },
    async reconcileImageReceipt(ref) {
      const { payload } = await deps.loadIntent(ref);
      if (payload.operation !== 'reconcile' || !payload.originalJobId || !payload.canonicalImageId)
        throw ApplicationFailure.nonRetryable('Invalid image reconciliation intent', 'ImageReconciliationInvalid');
      await deps.assertCurrent(ref);
      const saved = (await receipt(ref).get()).data();
      if (saved?.state === 'cleaned') {
        await deps.project(ref, { state: 'succeeded', actions: [], result: { deleted: true } });
        return 'complete';
      }
      if (!saved?.remoteId) {
        await deps.project(ref, {
          state: 'needs_attention',
          actions: ['resolve'],
          result: { resolutionPurpose: 'cleanup' },
        });
        return 'review';
      }
      if (saved?.state === 'retained') {
        await deps.project(ref, {
          state: 'succeeded',
          actions: [],
          result: { status: 'remote_retained', deleted: false },
        });
        return 'complete';
      }
      const canonical = (await deps.firestore.collection('images').doc(payload.canonicalImageId).get()).data();
      if (!(await verifyFixedImageAbsent(saved.remoteId, saved.providerAccount))) {
        await receipt(ref).set({ state: 'needs_attention' }, { merge: true });
        await deps.project(ref, {
          state: 'needs_attention',
          actions: ['resolve'],
          result: { resolutionPurpose: 'cleanup' },
          attention: sharedImageReview(ref, saved.remoteId, saved.providerAccount),
        });
        return 'review';
      }
      const verifiedAt = Date.now();
      await deps.firestore.runTransaction(async (tx) => {
        const current = (await tx.get(receipt(ref))).data();
        await deps.assertCurrentInTransaction(tx, ref);
        if (
          !current ||
          current.remoteId !== saved.remoteId ||
          JSON.stringify(current?.providerAccount) !== JSON.stringify(saved.providerAccount)
        )
          throw ApplicationFailure.nonRetryable(
            'Image receipt changed during absence verification',
            'ImageReceiptChanged'
          );
        let releasePending: (() => void) | undefined;
        if (current.pendingAcknowledgementBinding) {
          const { prepareProviderBindingRelease } = await import(
            '../../../../packages/orchestration/src/provider-usage'
          );
          releasePending = await prepareProviderBindingRelease(tx, deps.firestore, {
            resource: {
              projectId: ref.projectId,
              provider: 'subsplash',
              account: 'app:9XTSHD',
              remoteId: saved.remoteId,
            },
            jobId: ref.jobId,
            bindingId: current.pendingAcknowledgementBinding,
          });
        }
        releasePending?.();
        tx.set(
          receipt(ref),
          {
            state: 'cleaned',
            cleanedAt: verifiedAt,
            absenceProof: {
              source: 'authenticated_fixed_id_404',
              remoteId: saved.remoteId,
              providerAccount: saved.providerAccount,
              verifiedAt,
            },
            canonicalReferencePreserved: canonical?.subsplashId === saved.remoteId,
          },
          { merge: true }
        );
      });
      await deps.firestore
        .collection('temporalImageReceipts')
        .doc(payload.originalJobId)
        .set(
          { reconciliationJobId: ref.jobId, reconciliationState: 'selected_resource_cleanup_completed' },
          { merge: true }
        );
      await deps.project(ref, {
        state: 'succeeded',
        actions: [],
        result: { deleted: canonical?.subsplashId !== saved.remoteId },
      });
      return 'complete';
    },
    async cancelImage(ref) {
      const { payload } = await deps.loadIntent(ref);
      const canonical = (await deps.firestore.collection('images').doc(payload.imageId).get()).data();
      const saved = (await receipt(ref).get()).data();
      if (saved?.state === 'committed' || canonical?.durableJobId === ref.jobId) {
        await deps.project(ref, { state: 'succeeded', actions: [], result: { imageId: payload.imageId } });
        return;
      }
      if (saved?.state === 'allocating' || saved?.state === 'needs_attention') {
        await activities.supersedeImage(ref);
        return;
      }
      if (saved?.remoteId) {
        await activities.supersedeImage(ref);
        return;
      }
      await deps.project(ref, { state: 'cancelled', actions: [] });
    },
    ...createImageControlActivities(deps),
  };
  return activities;
}

export interface ImageAllocationReview {
  actorUid: string;
  commandId: string;
  expectedJobRevision: number;
  expectedGeneration: number;
  assertCurrentInTransaction(tx: Transaction): Promise<void>;
  onResolutionCommit?(tx: Transaction): Promise<void>;
  decision: 'adopt_existing_resource' | 'retain_existing_resource' | 'confirm_existing_resource_absent';
  duplicateRiskAcknowledged: true;
  evidenceReference: string;
  reason: string;
}

/** Read-only retention never claims matching metadata proves the original POST or source bytes.
 * A private audit retains unresolved-original risk; existing provider bytes are never overwritten. */
export async function resolveImageAllocation(
  deps: Pick<ImageDependencies, 'firestore' | 'loadIntent' | 'assertCurrent' | 'assertCurrentInTransaction'>,
  ref: DurableJobRef,
  remoteId: string,
  review: ImageAllocationReview
): Promise<void> {
  const { payload } = await deps.loadIntent(ref);
  if (payload.operation === 'ingest' && review.decision !== 'retain_existing_resource')
    throw new Error(
      'Original provider bytes are not verifiable. Retain the existing resource and start a separate upload; it will not be overwritten.'
    );
  return resolveImageDeletionReview(deps, ref, {
    ...review,
    remoteId,
    decision: review.decision as ImageDeletionReview['decision'],
  });
}

export interface ImageDeletionReview extends Omit<ImageAllocationReview, 'decision'> {
  remoteId: string;
  decision: 'retain_existing_resource' | 'confirm_existing_resource_absent';
}
export async function resolveImageDeletionReview(
  deps: Pick<ImageDependencies, 'firestore' | 'loadIntent' | 'assertCurrent' | 'assertCurrentInTransaction'>,
  ref: DurableJobRef,
  review: ImageDeletionReview
): Promise<void> {
  if (
    !['retain_existing_resource', 'confirm_existing_resource_absent'].includes(review.decision) ||
    review.duplicateRiskAcknowledged !== true ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(review.remoteId) ||
    !review.evidenceReference?.trim() ||
    !review.reason?.trim()
  )
    throw new Error('Retain the shared resource or verify fixed-ID absence; forced deletion is unavailable');
  const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const inputHash = fingerprint([
    ref,
    review.remoteId,
    review.actorUid,
    review.commandId,
    review.expectedGeneration,
    review.expectedJobRevision,
    review.decision,
    review.evidenceReference,
    review.reason,
  ]);
  const audit = deps.firestore.collection('temporalImageResolutionAudits').doc(review.commandId);
  const previous = await audit.get();
  if (previous.exists) {
    if (previous.get('inputHash') !== inputHash) throw new Error('Image review command was reused');
    if (previous.get('state') === 'completed') return;
  }
  const { payload } = await deps.loadIntent(ref);
  if (!['delete', 'reconcile', 'ingest'].includes(payload.operation))
    throw new Error('Image retention requires a cleanup operation');
  const target = deps.firestore.collection('temporalImageReceipts').doc(ref.jobId),
    saved = (await target.get()).data();
  if (saved?.state !== 'needs_attention') throw new Error('Image cleanup is not awaiting review');
  if (saved.remoteId && payload.remoteId && saved.remoteId !== payload.remoteId)
    throw new Error('Private image receipt identity differs from the immutable intent');
  const knownId = saved.remoteId ?? payload.remoteId;
  if (knownId && knownId !== review.remoteId) throw new Error('Review must match the sealed image identity');
  if (payload.operation === 'ingest' && review.decision !== 'retain_existing_resource')
    throw new Error('An unknown upload may only retain the selected resource');
  if (review.decision === 'confirm_existing_resource_absent') {
    if (!knownId || !(await verifyFixedImageAbsent(knownId, saved.providerAccount ?? payload.providerAccount)))
      throw new Error('The fixed image ID is not proven absent under the original account');
  } else if (!knownId) {
    const token = await authenticateSubsplash();
    let remote;
    try {
      remote = (
        await axios({
          ...createAxiosConfig(
            `https://core.subsplash.com/files/v1/images/${encodeURIComponent(review.remoteId)}`,
            token,
            'GET'
          ),
          timeout: 30000,
        })
      ).data;
    } catch {
      throw new Error('The selected resource could not be verified for retention');
    }
    if (remote?.id !== review.remoteId || remote?.app_key !== '9XTSHD')
      throw new Error('The selected retention resource does not belong to the configured app');
  }
  const receiptHash = fingerprint(saved);
  await deps.firestore.runTransaction(async (tx) => {
    const oldAudit = await tx.get(audit);
    if (oldAudit.exists) {
      if (oldAudit.get('inputHash') !== inputHash) throw new Error('Image review command was reused');
      if (oldAudit.get('state') === 'completed') return;
    }
    await review.assertCurrentInTransaction(tx);
    await deps.assertCurrentInTransaction(tx, ref);
    const [job, fresh] = await Promise.all([
      tx.get(deps.firestore.collection('durableJobs').doc(ref.jobId)),
      tx.get(target),
    ]);
    if (
      job.get('revision') !== review.expectedJobRevision ||
      job.get('generation') !== review.expectedGeneration ||
      fresh.get('state') !== 'needs_attention' ||
      fingerprint(fresh.data()) !== receiptHash
    )
      throw new Error('Image changed during cleanup review');
    const resource = {
      projectId: ref.projectId,
      provider: 'subsplash' as const,
      account: 'app:9XTSHD',
      remoteId: review.remoteId,
    };
    let bind: (() => void) | undefined;
    if (review.decision === 'retain_existing_resource') {
      const { prepareProviderBinding } = await import('../../../../packages/orchestration/src/provider-usage');
      bind = await prepareProviderBinding(tx, deps.firestore, {
        resource,
        jobId: ref.jobId,
        bindingId: `retained-image:${ref.jobId}:${review.commandId}`,
      });
    }
    let releasePending: (() => void) | undefined;
    if (saved.pendingAcknowledgementBinding) {
      const { prepareProviderBindingRelease } = await import('../../../../packages/orchestration/src/provider-usage');
      releasePending = await prepareProviderBindingRelease(tx, deps.firestore, {
        resource,
        jobId: ref.jobId,
        bindingId: saved.pendingAcknowledgementBinding,
      });
    }
    if (review.onResolutionCommit) await review.onResolutionCommit(tx);
    bind?.();
    releasePending?.();
    if (payload.operation === 'delete') {
      tx.set(
        target,
        {
          state: 'reviewed',
          deletion: {
            remoteState: review.decision === 'retain_existing_resource' ? 'retained' : 'confirmed',
            remoteReviewedAt: Date.now(),
            reviewCommandId: review.commandId,
          },
        },
        { merge: true }
      );
      tx.set(deps.firestore.collection('temporalImageCleanupAuthorizations').doc(ref.jobId), {
        schemaVersion: 1,
        ...ref,
        actorUid: review.actorUid,
        commandId: review.commandId,
        generation: review.expectedGeneration,
        intentHash: imageDeletionIntentHash(payload),
        purpose: 'finish_local_cleanup_after_remote_review',
        createdAt: Date.now(),
      });
    } else
      tx.set(
        target,
        {
          state: review.decision === 'retain_existing_resource' ? 'retained' : 'cleaned',
          retainedRemoteId: review.remoteId,
          originalAllocationStatus: saved.originalAllocationStatus ?? 'unknown',
          remoteId: review.remoteId,
          reviewCommandId: review.commandId,
          reviewedAt: Date.now(),
          ...(review.decision === 'confirm_existing_resource_absent'
            ? {
                absenceProof: {
                  source: 'authenticated_fixed_id_404',
                  remoteId: review.remoteId,
                  providerAccount: saved.providerAccount ?? payload.providerAccount,
                  verifiedAt: Date.now(),
                },
              }
            : {}),
        },
        { merge: true }
      );
    const evidence = {
      schemaVersion: 1,
      ...ref,
      inputHash,
      commandId: review.commandId,
      duplicateRiskAcknowledged: true,
      receiptId: ref.jobId,
      state: 'completed',
      actorUid: review.actorUid,
      remoteId: review.remoteId,
      generation: review.expectedGeneration,
      revision: review.expectedJobRevision,
      decision: review.decision,
      evidenceReference: review.evidenceReference,
      reason: review.reason,
      resource,
      receiptFingerprint: receiptHash,
      originalAllocationMayExist: payload.operation !== 'delete',
      reviewedAt: Date.now(),
    };
    tx.set(audit, evidence);
    if (review.decision === 'retain_existing_resource')
      tx.set(deps.firestore.collection('temporalImageResourceRetentions').doc(review.commandId), {
        ...evidence,
        bindingId: `retained-image:${ref.jobId}:${review.commandId}`,
      });
  });
}

/** Call before command transaction writes; only fresh admin review may authorize remaining
 * effects of an immutable deletion already proven partially completed. */
export async function authorizeImageDeletionContinuation(
  firestore: Firestore,
  tx: Transaction,
  ref: DurableJobRef,
  review: {
    actorUid: string;
    commandId: string;
    expectedRevision: number;
    assertAdmin(): Promise<void>;
  }
): Promise<() => void> {
  await review.assertAdmin();
  const [job, intent, receipt, grant] = await Promise.all([
    tx.get(firestore.collection('durableJobs').doc(ref.jobId)),
    tx.get(firestore.collection('durableJobIntents').doc(ref.jobId)),
    tx.get(firestore.collection('temporalImageReceipts').doc(ref.jobId)),
    tx.get(firestore.collection('temporalImageCleanupAuthorizations').doc(ref.jobId)),
  ]);
  const payload = intent.get('payload') as ImageIntent;
  const deletion = receipt.get('deletion');
  if (
    job.get('projectId') !== ref.projectId ||
    job.get('kind') !== 'image.delete' ||
    job.get('revision') !== review.expectedRevision ||
    payload?.operation !== 'delete' ||
    deletion?.intentHash !== imageDeletionIntentHash(payload) ||
    ![deletion.remoteState, deletion.storageState].includes('confirmed')
  )
    throw new Error('Only a partially confirmed immutable image deletion can be continued by an administrator');
  if (grant.exists && grant.get('commandId') === review.commandId) return () => undefined;
  return () =>
    tx.set(grant.ref, {
      schemaVersion: 1,
      ...ref,
      actorUid: review.actorUid,
      commandId: review.commandId,
      generation: job.get('generation'),
      intentHash: deletion.intentHash,
      createdAt: Date.now(),
      purpose: 'finish_confirmed_partial_deletion',
    });
}

export type ImageControlActivities = Pick<ImageActivities, 'finishImage' | 'getImageDisposition'>;
export function createImageControlActivities(
  deps: Pick<ImageDependencies, 'firestore' | 'loadIntent' | 'project'>
): ImageControlActivities {
  const receipt = (ref: DurableJobRef) => deps.firestore.collection('temporalImageReceipts').doc(ref.jobId);
  return {
    async getImageDisposition(ref) {
      const snapshot = await receipt(ref).get(),
        saved = snapshot.data();
      if (saved?.state !== 'retained') return 'continue';
      for (const [ackId, additional] of Object.entries(saved.additionalAcknowledgements ?? {}) as [
        string,
        { jobId: string; remoteId: string }
      ][]) {
        const child = await receipt({ projectId: ref.projectId, jobId: additional.jobId }).get();
        if (
          child.get('originalJobId') !== ref.jobId ||
          child.get('sourceAcknowledgementId') !== ackId ||
          child.get('remoteId') !== additional.remoteId
        )
          return 'additional_review';
        if (child.get('state') === 'retained' && child.get('reviewCommandId')) continue;
        const proof = child.get('absenceProof');
        if (
          child.get('state') !== 'cleaned' ||
          proof?.source !== 'authenticated_fixed_id_404' ||
          proof.remoteId !== additional.remoteId ||
          !proof.providerAccount ||
          JSON.stringify(proof.providerAccount) !== JSON.stringify(child.get('providerAccount')) ||
          !Number.isFinite(proof.verifiedAt)
        )
          return 'additional_review';
      }
      return 'retained';
    },
    async finishImage(ref, state, failureCode) {
      const { payload } = await deps.loadIntent(ref);
      const saved = (await receipt(ref).get()).data();
      const additionalReview = failureCode === 'ImageAdditionalAllocationReview';
      const sharedReferenceReview =
        failureCode === 'ImageSharedReferenceReviewRequired' ||
        (payload.operation === 'reconcile' && saved?.state === 'needs_attention' && !!saved?.remoteId);
      const permissionChanged = failureCode === 'ImageCleanupPermissionChanged';
      const sourceInvalid = ['ImageSourceInvalid', 'ImageDimensionsInvalid'].includes(failureCode ?? '');
      const ambiguous =
        failureCode === 'ImageAllocationAmbiguous' || (saved?.state === 'needs_attention' && !saved?.remoteId);
      const actions: ('resolve' | 'cancel' | 'resume')[] =
        state !== 'needs_attention'
          ? []
          : additionalReview
          ? []
          : sharedReferenceReview
          ? ['resolve']
          : payload.operation === 'reconcile'
          ? saved?.remoteId
            ? ['resume']
            : ['resolve']
          : sourceInvalid
          ? ['cancel']
          : ambiguous
          ? ['resolve', 'cancel']
          : ['resume', 'cancel'];
      const message = additionalReview
        ? 'An additional original image allocation is known. Its separate retention or absence review must finish before this upload can close.'
        : sharedReferenceReview
        ? 'This shared image may still be used manually or from another project. Retain it or verify it is already absent before cleanup.'
        : permissionChanged
        ? 'Deletion partially completed before permissions changed. An administrator must finish the cleanup.'
        : sourceInvalid
        ? 'Choose a new image and upload it again.'
        : ambiguous
        ? 'The destination image allocation could not be confirmed. An administrator must review it.'
        : 'The image operation could not be completed. Retry it after checking the destination service.';
      await deps.project(ref, {
        state,
        ...(['succeeded', 'cancelled'].includes(state)
          ? {
              result: {
                imageId: payload.imageId,
                ...(['retained'].includes(saved?.state) || saved?.deletion?.remoteState === 'retained'
                  ? { status: 'remote_retained', deleted: false }
                  : {}),
              },
            }
          : {}),
        actions,
        ...(state === 'cancelled' && saved?.state === 'retained' && saved.originalAllocationStatus !== 'acknowledged'
          ? {
              attention: {
                kind: 'external_result_unknown' as const,
                message:
                  'The upload was stopped and the selected resource retained. The original allocation remains unknown and is preserved in the review audit.',
              },
            }
          : {}),
        ...(state === 'needs_attention'
          ? {
              attention: {
                ...(sharedReferenceReview && (saved?.remoteId ?? payload.remoteId)
                  ? sharedImageReview(
                      ref,
                      saved?.remoteId ?? payload.remoteId!,
                      saved?.providerAccount ?? payload.providerAccount
                    )
                  : {}),
                kind: sharedReferenceReview
                  ? 'external_result_unknown'
                  : permissionChanged
                  ? 'permission_changed'
                  : sourceInvalid
                  ? 'source_unavailable'
                  : ambiguous
                  ? 'external_result_unknown'
                  : 'remote_drift',
                message,
              },
              error: {
                code: sourceInvalid
                  ? 'IMAGE_SOURCE_INVALID'
                  : ambiguous
                  ? 'IMAGE_ALLOCATION_UNKNOWN'
                  : 'IMAGE_OPERATION_UNAVAILABLE',
                message,
                retryable: !sourceInvalid && !ambiguous,
              },
            }
          : {}),
      });
    },
  };
}

/** An authenticated POST response is a fact even after review or cancellation. Keep it
 * separate from selected receipts and queue each additional resource for conservative review. */
export async function recordImageAllocationAcknowledgement(
  firestore: Firestore,
  ref: DurableJobRef,
  claim: { claimId: string; fingerprint: string; providerAccount?: ImageIntent['providerAccount'] },
  intent: ImageIntent,
  result: { remoteId: string; uploadUrl: string }
): Promise<'allocated' | 'review_required'> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(result.remoteId) || !claim.claimId || !claim.fingerprint)
    throw new Error('Invalid image acknowledgement identity');
  const id = createHash('sha256')
    .update(JSON.stringify([ref.projectId, ref.jobId, claim.claimId, result.remoteId]))
    .digest('hex');
  const journal = firestore.collection('temporalImageAllocationAcknowledgements').doc(id),
    target = firestore.collection('temporalImageReceipts').doc(ref.jobId);
  const childId = createHash('sha256').update(`image-ack-review:${ref.projectId}:${id}`).digest('hex');
  // Fact-first: owner/control/index changes cannot roll back a positive POST acknowledgment.
  return firestore.runTransaction(async (tx) => {
    const [existing, current] = await Promise.all([tx.get(journal), tx.get(target)]),
      saved = current.data();
    if (existing.exists) return existing.get('disposition') === 'owned_allocation' ? 'allocated' : 'review_required';
    if (saved?.allocationClaim?.claimId !== claim.claimId || saved.allocationClaim.fingerprint !== claim.fingerprint)
      throw new Error('Image acknowledgement does not match its immutable allocation claim');
    const owns = saved.state === 'allocating' && !saved.reviewCommandId && !saved.resolutionCommandId;
    const sameSelected = saved.state === 'retained' && saved.remoteId === result.remoteId;
    tx.create(journal, {
      schemaVersion: 1,
      ...ref,
      claimId: claim.claimId,
      payloadFingerprint: claim.fingerprint,
      remoteId: result.remoteId,
      ...(claim.providerAccount ? { providerAccount: claim.providerAccount } : {}),
      source: 'authenticated_post_response',
      acknowledgedAt: Date.now(),
      disposition: owns
        ? 'owned_allocation'
        : sameSelected
        ? 'retained_original_allocation'
        : 'additional_original_allocation',
      ...(!owns && !sameSelected ? { reconciliationJobId: childId } : {}),
    });
    if (owns)
      tx.set(
        target,
        {
          state: 'allocated',
          remoteId: result.remoteId,
          uploadUrl: result.uploadUrl,
          ...(claim.providerAccount ? { providerAccount: claim.providerAccount } : {}),
          originalAllocationStatus: 'acknowledged',
          originalAcknowledgementId: id,
          updatedAt: Date.now(),
        },
        { merge: true }
      );
    else
      tx.set(
        target,
        {
          originalAllocationStatus: 'acknowledged',
          originalAcknowledgementId: id,
          ...(!sameSelected
            ? { additionalAcknowledgements: { [id]: { jobId: childId, remoteId: result.remoteId } } }
            : {}),
        },
        { merge: true }
      );
    return owns ? 'allocated' : 'review_required';
  });
}

/** Replayable admission from an immutable ACK. Failed index/control checks leave the fact intact. */
export async function ensureImageAcknowledgementReview(
  firestore: Firestore,
  ref: DurableJobRef,
  acknowledgementId: string
): Promise<void> {
  const { assertAdmissionReleaseInTransaction } = await import('../releaseControl');
  const { prepareProviderBinding } = await import('../../../../packages/orchestration/src/provider-usage');
  const store = createDurableJobStore({ firestore, projectId: ref.projectId });
  await firestore.runTransaction(async (tx) => {
    const [factSnapshot, intentSnapshot, receiptSnapshot] = await Promise.all([
      tx.get(firestore.collection('temporalImageAllocationAcknowledgements').doc(acknowledgementId)),
      tx.get(firestore.collection('durableJobIntents').doc(ref.jobId)),
      tx.get(firestore.collection('temporalImageReceipts').doc(ref.jobId)),
    ]);
    const fact = factSnapshot.data(),
      original = intentSnapshot.data(),
      saved = receiptSnapshot.data();
    if (
      !fact ||
      fact.projectId !== ref.projectId ||
      fact.jobId !== ref.jobId ||
      fact.source !== 'authenticated_post_response' ||
      fact.schemaVersion !== 1
    )
      throw new Error('Invalid image ACK review fact');
    if (fact.disposition !== 'additional_original_allocation') return;
    if (
      !original ||
      original.projectId !== ref.projectId ||
      original.jobId !== ref.jobId ||
      saved?.allocationClaim?.claimId !== fact.claimId ||
      saved?.allocationClaim?.fingerprint !== fact.payloadFingerprint
    )
      throw new Error('Image ACK fact is not bound to its original claim');
    const intent = original.payload as ImageIntent,
      childRef = { projectId: ref.projectId, jobId: String(fact.reconciliationJobId) };
    const child = await tx.get(firestore.collection('durableJobs').doc(childRef.jobId));
    if (child.exists) return;
    await assertAdmissionReleaseInTransaction(tx, firestore, 'image.delete', { continuation: true });
    const resource = {
      projectId: ref.projectId,
      provider: 'subsplash' as const,
      account: 'app:9XTSHD',
      remoteId: String(fact.remoteId),
    };
    const binding = await prepareProviderBinding(tx, firestore, {
      resource,
      jobId: childRef.jobId,
      bindingId: `pending-image-ack:${acknowledgementId}`,
    });
    store.createInTransaction(tx, {
      ref: childRef,
      kind: 'image.delete',
      entity: { type: 'image', id: `ack-cleanup-${childRef.jobId}` },
      actorUid: 'system:firebase-event',
      requestId: `image-ack-review:${acknowledgementId}`,
      generation: 1,
      createdAt: Date.now(),
      payload: {
        ...intent,
        operation: 'reconcile',
        originalJobId: ref.jobId,
        canonicalImageId: intent.imageId,
        sourceAcknowledgementId: acknowledgementId,
        remoteId: fact.remoteId,
        ...(fact.providerAccount ? { providerAccount: fact.providerAccount } : {}),
      },
      dispatch: {
        ref: childRef,
        workflowType: 'ImageReceiptReconciliation',
        workflowId: `image-ack-reconcile:${ref.projectId}:${childRef.jobId}`,
        taskQueue: 'urm-images',
      },
    });
    binding();
    tx.update(firestore.collection('durableJobs').doc(childRef.jobId), { actions: [] });
    tx.create(firestore.collection('temporalImageReceipts').doc(childRef.jobId), {
      state: 'allocated',
      remoteId: fact.remoteId,
      originalJobId: ref.jobId,
      sourceAcknowledgementId: acknowledgementId,
      pendingAcknowledgementBinding: `pending-image-ack:${acknowledgementId}`,
      ...(fact.providerAccount ? { providerAccount: fact.providerAccount } : {}),
    });
  });
}
