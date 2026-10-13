import axios from 'axios';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import { authenticateSubsplash, createAxiosConfig } from '../../subsplashUtils';
import { runWithSoundCloudAccessToken } from '../../soundcloudSecrets';
import { deleteTrack, normalizeSoundCloudAccountId } from '../../soundcloudClient';
import { withSubsplashLocks } from '../../locks/withSubsplashLocks';
import {
  listProviderReceiptsForJob,
  listProviderAcknowledgementsForJob,
  acknowledgementHasReviewedDisposition,
  isProviderReceiptExplicitlyRetained,
  type ProviderReceipt,
} from './providerReceipts';
import type { PrivatePublishingIntent, PublishingStepResult } from './types';
import type { PublishingEntityIntent } from './entityMutations';
import { releaseCancelledProviderBindings } from './bindingReconciliation';
import {
  prepareProviderCleanupClaim,
  prepareProviderCleanupSettlement,
  type ProviderResource,
  type ProviderCleanupProof,
} from '../../../../packages/orchestration/src/provider-usage';

export { PUBLISHING_CANCELLATION_RECEIPTS, verifyPublishingCancellationFetchSettled } from './cancellationEvidence';
import { PUBLISHING_CANCELLATION_RECEIPTS, verifyPublishingCancellationFetchSettled } from './cancellationEvidence';
type Intent = PrivatePublishingIntent | PublishingEntityIntent;
export interface PublishingCancellationStore {
  assertCurrent(ref: DurableJobRef): Promise<void>;
  commitCurrent(ref: DurableJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void>;
}
export interface CancellationAllocation {
  receiptId: string;
  receipt: ProviderReceipt;
  remoteId: string;
}
export interface PublishingCancellationDependencies {
  listReceipts(ref: DurableJobRef): ReturnType<typeof listProviderReceiptsForJob>;
  listAcknowledgements(ref: DurableJobRef): ReturnType<typeof listProviderAcknowledgementsForJob>;
  inspect(allocation: CancellationAllocation): Promise<'absent' | 'referenced' | 'unreferenced'>;
  claim(
    ref: DurableJobRef,
    allocation: CancellationAllocation,
    store: PublishingCancellationStore
  ): Promise<'referenced' | 'reserved' | 'deleted'>;
  settle(
    ref: DurableJobRef,
    allocation: CancellationAllocation,
    store: PublishingCancellationStore,
    outcome: 'confirmed_absent' | 'reviewed_retain'
  ): Promise<void>;
  delete(allocation: CancellationAllocation): Promise<void>;
  withLock<T>(allocation: CancellationAllocation, run: () => Promise<T>): Promise<T>;
  releaseBindings(
    ref: DurableJobRef,
    store: PublishingCancellationStore,
    targetReceiptId?: string
  ): Promise<'completed' | 'pending'>;
}
const paths: Record<string, string> = {
  'subsplash-media-item': 'media/v1/media-items',
  'subsplash-series': 'media/v1/media-series',
  'list-create': 'builder/v1/lists',
  'overflow-list-create': 'builder/v1/lists',
  'subsplash-audio': 'files/v1/audios',
  'subsplash-transcode': 'transcoder/v1/jobs',
  'image-create': 'files/v1/images',
  'speaker-tag-create': 'tags/v1/tags',
};
const order: Record<string, number> = {
  'soundcloud-track': 0,
  'subsplash-media-item': 0,
  'subsplash-series': 1,
  'list-create': 1,
  'overflow-list-create': 1,
  'speaker-tag-create': 2,
  'subsplash-transcode': 3,
  'subsplash-audio': 4,
  'image-create': 5,
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const remoteId = (receipt: ProviderReceipt): string => {
  const result = record(receipt.result);
  const value =
    typeof receipt.result === 'string'
      ? receipt.result
      : result.id ?? result.listId ?? result.tagId ?? result.soundCloudTrackId ?? result.trackIdentifier;
  return typeof value === 'string' && value && value.length <= 256 && !/[\s/?#]/.test(value) ? value : '';
};
const status = (error: unknown): unknown => record(record(error).response).status;
const absent = (error: unknown) => status(error) === 404 || status(error) === 410;
const externalReviewRequired = (): never => {
  throw Object.assign(new Error('External provider associations require audited retention review'), {
    code: 'PUBLISHING_CANCEL_EXTERNAL_REFERENCE_REVIEW_REQUIRED',
  });
};
const safeAttention = (receiptId?: string): PublishingStepResult => ({
  state: 'blocked',
  code: 'PUBLISHING_CANCEL_CLEANUP_REQUIRED',
  ...(receiptId ? { receiptId } : {}),
});
const db = () => firebaseAdmin.firestore();
const readSubsplash = async (allocation: CancellationAllocation): Promise<Record<string, unknown> | undefined> => {
  const path = paths[allocation.receipt.step];
  if (!path) throw new Error('Unsupported cancellation allocation');
  const token = await authenticateSubsplash();
  try {
    const remote = record(
      (
        await axios({
          ...createAxiosConfig(
            `https://core.subsplash.com/${path}/${encodeURIComponent(allocation.remoteId)}`,
            token,
            'GET'
          ),
          timeout: 30000,
        })
      ).data
    );
    if (remote.id !== allocation.remoteId || remote.app_key !== '9XTSHD')
      throw new Error('Provider resource ownership could not be verified');
    return remote;
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
};
async function hasCanonicalReference(collection: string, field: string, id: string): Promise<boolean> {
  const docs = await db().collection(collection).where(field, '==', id).limit(1).get();
  return !docs.empty;
}
const usageIdentity = (
  ref: DurableJobRef,
  allocation: CancellationAllocation
): { resource: ProviderResource; proof: ProviderCleanupProof } => ({
  resource: {
    projectId: ref.projectId,
    provider: allocation.receipt.step === 'soundcloud-track' ? 'soundcloud' : 'subsplash',
    account: allocation.receipt.step === 'soundcloud-track' ? 'configured-account' : 'app:9XTSHD',
    remoteId: allocation.remoteId,
  },
  proof: {
    jobId: ref.jobId,
    receiptId: allocation.receiptId,
    fingerprint: allocation.receipt.fingerprint,
    receiptRevision: allocation.receipt.revision ?? 0,
  },
});
export function createFirebasePublishingCancellationDependencies(): PublishingCancellationDependencies {
  return {
    listReceipts: listProviderReceiptsForJob,
    listAcknowledgements: listProviderAcknowledgementsForJob,
    releaseBindings: releaseCancelledProviderBindings,
    async claim(ref, allocation, store) {
      const identity = usageIdentity(ref, allocation);
      let state: 'referenced' | 'reserved' | 'deleted' = 'reserved';
      await store.commitCurrent(ref, async (tx) => {
        const claim = await prepareProviderCleanupClaim(tx, db(), identity.resource, identity.proof);
        state = claim.state;
        claim.commit();
      });
      return state;
    },
    async settle(ref, allocation, store, outcome) {
      const identity = usageIdentity(ref, allocation);
      await store.commitCurrent(ref, async (tx) => {
        const commit = await prepareProviderCleanupSettlement(tx, db(), identity.resource, identity.proof, outcome);
        commit();
      });
    },
    async inspect(allocation) {
      const step = allocation.receipt.step,
        id = allocation.remoteId;
      if (step === 'soundcloud-track') {
        if (await hasCanonicalReference('sermons', 'soundCloudTrackId', id)) return 'referenced';
        return runWithSoundCloudAccessToken(async (token) => {
          const headers = { Authorization: `OAuth ${token}`, Accept: 'application/json' };
          const account = record((await axios.get('https://api.soundcloud.com/me', { headers, timeout: 30000 })).data);
          if (
            allocation.receipt.providerAccount?.provider !== 'soundcloud' ||
            allocation.receipt.providerAccount.account !== normalizeSoundCloudAccountId(account)
          )
            throw new Error('Original SoundCloud account could not be verified');
          try {
            const trackResponse = await axios.get(`https://api.soundcloud.com/tracks/${encodeURIComponent(id)}`, {
              headers,
              timeout: 30000,
            });
            const track = record(trackResponse.data),
              owner = record(track.user);
            const identifiers = [track.id, track.id_str, track.urn].map(String);
            if (track.title !== record(allocation.receipt.intentPayload).title)
              throw new Error('SoundCloud allocation was changed after creation');
            if (
              !identifiers.includes(id) ||
              ![owner.id, owner.id_str, owner.urn].some(
                (value) =>
                  value !== undefined && [account.id, account.id_str, account.urn].map(String).includes(String(value))
              )
            )
              throw new Error('SoundCloud ownership cannot be proved');
            return 'unreferenced';
          } catch (error) {
            if (absent(error)) return 'absent';
            throw error;
          }
        });
      }
      const remote = await readSubsplash(allocation);
      if (!remote) {
        if (
          step === 'subsplash-transcode' &&
          !(await verifyPublishingCancellationFetchSettled(
            { projectId: allocation.receipt.projectId!, jobId: allocation.receipt.jobId! },
            allocation.receiptId,
            allocation.receipt
          ))
        )
          throw Object.assign(new Error('Missing transcoding terminal proof'), {
            code: 'PUBLISHING_CANCEL_PROVIDER_FETCH_PENDING',
          });
        return 'absent';
      }
      if (isProviderReceiptExplicitlyRetained(allocation.receipt, id)) return 'referenced';
      if (step === 'subsplash-media-item') {
        if (await hasCanonicalReference('sermons', 'subsplashId', id)) return 'referenced';
        const title = record(allocation.receipt.intentPayload).title;
        if (typeof title === 'string' && remote.title !== title)
          throw new Error('Media allocation changed after creation');
        // A published object may be used outside the app. Cancellation must not
        // tear down a public publication whose canonical association is unknown.
        if (remote.status === 'published' || remote.auto_publish === true)
          throw new Error('Published media reference proof requires operator review');
        const embedded = record(remote._embedded);
        if (
          (Array.isArray(embedded['media-series']) && embedded['media-series'].length) ||
          typeof record(embedded['media-series']).id === 'string'
        )
          return 'referenced';
        externalReviewRequired();
      } else if (step === 'subsplash-series') {
        if (await hasCanonicalReference('series', 'subsplashId', id)) return 'referenced';
        const title = record(allocation.receipt.intentPayload).title;
        if (typeof title === 'string' && remote.title !== title.trim())
          throw new Error('Series allocation changed after creation');
        if (typeof remote.media_items_count !== 'number') throw new Error('Series membership proof unavailable');
        if (remote.media_items_count !== 0) return 'referenced';
        externalReviewRequired();
      } else if (step === 'list-create' || step === 'overflow-list-create') {
        if (await hasCanonicalReference('lists', 'subsplashId', id)) return 'referenced';
        const title = record(allocation.receipt.intentPayload).title;
        if (typeof title === 'string' && remote.title !== title)
          throw new Error('List allocation changed after creation');
        if (typeof remote.list_rows_count !== 'number') throw new Error('List membership proof unavailable');
        if (remote.list_rows_count !== 0) return 'referenced';
        externalReviewRequired();
      } else if (step === 'subsplash-audio') {
        const title = record(allocation.receipt.intentPayload).audioTitle;
        if (typeof title === 'string' && remote.title !== title)
          throw new Error('Audio allocation changed after creation');
        const query = new URLSearchParams({ 'filter[app_key]': '9XTSHD', 'filter[audio]': id, 'page[size]': '1' });
        const body = record(
          (
            await axios({
              ...createAxiosConfig(
                `https://core.subsplash.com/media/v1/media-items?${query}`,
                await authenticateSubsplash(),
                'GET'
              ),
              timeout: 30000,
            })
          ).data
        );
        const items = record(body._embedded)['media-items'];
        if (!Array.isArray(items)) throw new Error('Audio reference proof unavailable');
        if (items.length) return 'referenced';
      } else if (step === 'image-create') {
        if (await hasCanonicalReference('images', 'subsplashId', id)) return 'referenced';
        const payload = record(allocation.receipt.intentPayload),
          image = record(payload.image);
        if (remote.type !== image.type || remote.content_type !== payload.contentType)
          throw new Error('Image allocation changed after creation');
        // Firebase usage is project-scoped, while this provider app is shared and permits manual association.
        // The provider supplies no authoritative inverse reference proof for images. Retain until audited review.
        externalReviewRequired();
      } else if (step === 'speaker-tag-create') {
        if (await hasCanonicalReference('speakers', 'tagId', id)) return 'referenced';
        const title = record(allocation.receipt.intentPayload).title;
        if (typeof title !== 'string' || !title || remote.title !== title || remote.type !== 'speaker')
          throw new Error('Speaker reference identity unavailable');
        const query = new URLSearchParams({ 'filter[app_key]': '9XTSHD', 'filter[speaker]': title, 'page[size]': '1' });
        const body = record(
          (
            await axios({
              ...createAxiosConfig(
                `https://core.subsplash.com/media/v1/media-items?${query}`,
                await authenticateSubsplash(),
                'GET'
              ),
              timeout: 30000,
            })
          ).data
        );
        const items = record(body._embedded)['media-items'];
        if (!Array.isArray(items)) throw new Error('Speaker reference proof unavailable');
        if (items.length) return 'referenced';
      } else if (step === 'subsplash-transcode') {
        if (typeof remote.status !== 'string') throw new Error('Transcoding status proof unavailable');
        if (
          ![
            'complete',
            'completed',
            'succeeded',
            'success',
            'finished',
            'failed',
            'error',
            'cancelled',
            'canceled',
          ].includes(remote.status.toLowerCase())
        )
          throw Object.assign(new Error('Provider may still fetch retained audio'), {
            code: 'PUBLISHING_CANCEL_PROVIDER_FETCH_PENDING',
          });
        // Completed transcoder jobs are audit history. Retain the terminal job
        // and persist its settled-fetch proof instead of using an unsupported DELETE.
        return 'referenced';
      } else throw new Error('Unsupported cancellation allocation');
      return 'unreferenced';
    },
    async delete(allocation) {
      try {
        if (allocation.receipt.step === 'soundcloud-track')
          await runWithSoundCloudAccessToken((token) => deleteTrack(token, allocation.remoteId));
        else
          await axios({
            ...createAxiosConfig(
              `https://core.subsplash.com/${paths[allocation.receipt.step]}/${encodeURIComponent(allocation.remoteId)}`,
              await authenticateSubsplash(),
              'DELETE'
            ),
            timeout: 30000,
          });
      } catch (error) {
        if (!absent(error)) throw error;
      }
    },
    withLock: (allocation, run) => {
      const step = allocation.receipt.step;
      const family =
        step === 'subsplash-media-item'
          ? 'media-item'
          : step === 'subsplash-series'
          ? 'series'
          : step.includes('list-create')
          ? 'list'
          : step === 'speaker-tag-create'
          ? 'tag'
          : step === 'soundcloud-track'
          ? 'media-item:soundcloud'
          : step;
      return withSubsplashLocks([`${family}:${allocation.remoteId}`], run);
    },
  };
}
/** Cancellation never resumes the desired mutation. Every cleanup is a fixed-ID DELETE of a confirmed allocation. */
export async function cancelPublishingEffects(
  ref: DurableJobRef,
  _intent: Intent,
  store: PublishingCancellationStore,
  dependencies = createFirebasePublishingCancellationDependencies()
): Promise<PublishingStepResult> {
  await store.assertCurrent(ref);
  let receipts: Awaited<ReturnType<typeof listProviderReceiptsForJob>>;
  try {
    receipts = await dependencies.listReceipts(ref);
  } catch {
    return safeAttention();
  }
  let acknowledgements: Awaited<ReturnType<typeof listProviderAcknowledgementsForJob>>;
  try {
    acknowledgements = await dependencies.listAcknowledgements(ref);
  } catch {
    return safeAttention();
  }
  const orphan = acknowledgements
    .filter(
      (item) =>
        item.acknowledgement.disposition === 'orphaned' && !acknowledgementHasReviewedDisposition(item.acknowledgement)
    )
    .sort((a, b) => a.acknowledgementId.localeCompare(b.acknowledgementId))[0];
  if (orphan)
    return {
      state: 'blocked',
      code: 'PUBLISHING_CANCEL_ORPHAN_REVIEW_REQUIRED',
      acknowledgementId: orphan.acknowledgementId,
      receiptId: orphan.acknowledgement.receiptId,
    };
  const unknown = receipts
    .filter((item) => item.receipt.state === 'executing' || item.receipt.state === 'needs_review')
    .sort((a, b) => a.receiptId.localeCompare(b.receiptId))[0];
  if (unknown) return { state: 'needs_review', code: 'PROVIDER_CREATE_AMBIGUOUS', receiptId: unknown.receiptId };
  try {
    if ((await dependencies.releaseBindings(ref, store)) === 'pending')
      return { state: 'blocked', code: 'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING' };
  } catch (error) {
    return record(error).code === 'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING'
      ? { state: 'blocked', code: 'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING' }
      : safeAttention();
  }
  const allocations = receipts
    .filter((item) => item.receipt.state === 'confirmed')
    .sort(
      (a, b) =>
        (order[a.receipt.step] ?? 99) - (order[b.receipt.step] ?? 99) ||
        b.receipt.updatedAtMillis - a.receipt.updatedAtMillis
    );
  for (const item of allocations) {
    const id = remoteId(item.receipt);
    if (!id || order[item.receipt.step] === undefined) return safeAttention(item.receiptId);
    const allocation = { ...item, remoteId: id },
      checkpoint = db().collection(PUBLISHING_CANCELLATION_RECEIPTS).doc(`${ref.jobId}-${item.receiptId}`);
    try {
      await dependencies.withLock(allocation, async () => {
        await store.assertCurrent(ref);
        const claim = await dependencies.claim(ref, allocation, store);
        const proof =
          claim === 'referenced' && item.receipt.step !== 'subsplash-transcode'
            ? 'referenced'
            : await dependencies.inspect(allocation);
        if (claim === 'deleted' && proof !== 'absent')
          throw new Error('A retired provider identity unexpectedly exists');
        if (proof === 'unreferenced') {
          await store.commitCurrent(ref, async (tx) => {
            tx.set(
              checkpoint,
              {
                projectId: ref.projectId,
                jobId: ref.jobId,
                receiptId: item.receiptId,
                remoteId: id,
                providerReceiptFingerprint: item.receipt.fingerprint,
                receiptRevision: item.receipt.revision ?? 0,
                state: 'deleting',
                ...(item.receipt.step === 'subsplash-transcode' ? { fetchSettled: true } : {}),
                confirmedAtMillis: Date.now(),
              },
              { merge: true }
            );
          });
          await store.assertCurrent(ref);
          await dependencies.delete(allocation);
          // The result of DELETE is insufficient. A fresh GET must prove absence.
          if ((await dependencies.inspect(allocation)) !== 'absent')
            throw new Error('Provider deletion has not been confirmed');
        }
        if (claim === 'reserved')
          await dependencies.settle(
            ref,
            allocation,
            store,
            proof === 'referenced' ? 'reviewed_retain' : 'confirmed_absent'
          );
        await store.commitCurrent(ref, async (tx) => {
          tx.set(
            checkpoint,
            {
              projectId: ref.projectId,
              jobId: ref.jobId,
              receiptId: item.receiptId,
              remoteId: id,
              providerReceiptFingerprint: item.receipt.fingerprint,
              receiptRevision: item.receipt.revision ?? 0,
              state: proof === 'referenced' ? 'retained' : 'deleted',
              ...(item.receipt.step === 'subsplash-transcode' ? { fetchSettled: true } : {}),
              confirmedAtMillis: Date.now(),
            },
            { merge: true }
          );
        });
        if ((await dependencies.releaseBindings(ref, store, item.receiptId)) === 'pending')
          throw Object.assign(new Error('Binding cleanup page remains'), {
            code: 'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING',
          });
      });
    } catch (error) {
      if (record(error).code === 'PUBLISHING_CANCEL_EXTERNAL_REFERENCE_REVIEW_REQUIRED')
        return {
          state: 'blocked',
          code: 'PUBLISHING_CANCEL_EXTERNAL_REFERENCE_REVIEW_REQUIRED',
          receiptId: item.receiptId,
        };
      if (record(error).code === 'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING')
        return { state: 'blocked', code: 'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING', receiptId: item.receiptId };
      if (record(error).message === 'PROVIDER_USAGE_INDEX_NOT_READY')
        return { state: 'blocked', code: 'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING', receiptId: item.receiptId };
      return record(error).code === 'PUBLISHING_CANCEL_PROVIDER_FETCH_PENDING'
        ? { state: 'blocked', code: 'PUBLISHING_CANCEL_PROVIDER_FETCH_PENDING', receiptId: item.receiptId }
        : safeAttention(item.receiptId);
    }
  }
  return { state: 'completed' };
}
