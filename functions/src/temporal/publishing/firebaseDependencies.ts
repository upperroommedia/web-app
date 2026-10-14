import { preparePublishingMetadataCheckpoint, assertPublishingMetadataCheckpoint } from './metadataCheckpoint';
import {
  captureSermonDeletionDestinations,
  revalidateSermonDeletionDestinationSources,
  executeSermonDeletionDestinations,
} from '../../helpers/sermonDeletionDestinations';
import {
  prepareSermonDeletionMirrors,
  removeSermonDeletionMirrors,
  loadSermonDeletionMirrorPlan,
  validateSermonDeletionEffectsForClosing,
  validateSermonDeletionCompletion,
  SERMON_DELETION_MIRROR_PLANS,
} from '../../helpers/sermonDeletionMirrors';
import { settlePublishingDeletionReceipts } from './settlePublishingDeletionReceipts';
import { abortCancelledDesiredProviderDeletions } from './desiredDeletionCancellation';
import {
  prepareDesiredProviderDeletions,
  prepareDesiredProviderDeletionSettlement,
} from '../../../../packages/orchestration/src/provider-usage';
import { assertSynchronousProviderMutationCompleted } from './providerMutationCompletion';
import type { FrozenProjectionRequest, FrozenProviderVerification } from './criticalAcknowledgedRepair';
import { AsyncLocalStorage } from 'node:async_hooks';
import { buildPublishingMutationResourcePlan, assertMutationResourcePlanCurrent } from './mutationResourcePlan';
import { runWithSoundCloudAccessToken } from '../../soundcloudSecrets';
import { getAuthenticatedSoundCloudAccountId, formatTagList } from '../../soundcloudClient';
import type { ProviderMutationResource } from './providerMutationGuard';
import { abortProvablyUnsentProviderMutationSessionsForJob } from './providerMutationGuard';
import { reconcilePublishingDeletionCheckpoints } from './providerDeletion';
import { deletePublishingSubsplashMedia, deletePublishingSoundCloudTrack } from './providerDeletion';
import {
  claimPublishingAllocation,
  capturePublishingAllocationSource,
  assertPublishingContentUpdateAllocationsSettled,
  assertPublishingDeletionAllocationsSettled,
  preparePublishingAllocationCommit,
  preparePublishingAllocationRetirement,
  settleCancelledPublishingAllocations,
} from './allocationBarrier';
import {
  releaseCanonicalProviderBindingsForCurrentJob,
  markPublishingCritical,
  abortProviderMutationPlan,
  beginProviderMutationPlan,
  runPublishingProviderMutation,
  prepareProviderMutationPlanCommit,
  prepareProviderMutationEffectsClosed,
  prepareAcknowledgedProjectionPlan,
  publishingMutationRequestFingerprint,
  runDurableTransaction,
} from './durableOperationContext';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { getDownloadURL } from 'firebase-admin/storage';
import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { CallableRequest } from 'firebase-functions/v2/https';
import type { Sermon } from '@upperroom/shared/types/SermonTypes';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { uploadToSubsplashDomain } from '../../uploadToSubsplash';
import { uploadToSoundCloudDomain } from '../../uploadToSoundCloud';
import { createNewSubsplashList } from '../../createNewSubsplashList';
import { addToListDomain } from '../../addToList';
import { removeFromListDomain } from '../../removeFromList';
import { bulkAddToSeriesDomain } from '../../bulkAddToSeries';
import { removeFromSeriesDomain } from '../../removeFromSeries';
import { createSeriesDomain } from '../../createSeries';
import { editSubsplashSermonDomain } from '../../editSubsplashSermon';
import { editSoundCloudSermonDomain } from '../../editSoundCloudSermon';
import axios from '../../providerSandbox/http';
import { isSubsplashMediaPlayable, isSoundCloudTrackPlayable } from './providerReadiness';
import { createAxiosConfig } from '../../subsplashUtils';
import { cancelPublishingEffects } from './cancellation';
import { reconcilePublishingUpdateMemberships, commitPublishingUpdateMemberships } from './updateMembership';
import { replacePublishedSubsplashAudio, replacePublishedSoundCloudAudio } from './audioReplacement';
import { withSubsplashLocks } from '../../locks/withSubsplashLocks';
import { authenticateSubsplash } from '../../subsplashUtils';
import { getSeriesItems } from '../../helpers/seriesHelpers';
import { createSeriesMediaItemMembershipHash } from '../../helpers/seriesRemoteState';
import { auditPublishedListDrift } from '../../helpers/publishedListDrift';
import type { SubsplashMediaItem } from '@upperroom/contracts/types/Subsplash';
import type { PublishingDomainDependencies, PublishingJobRef, PrivatePublishingIntent } from './types';

type Store = Pick<
  PublishingDomainDependencies,
  | 'getSourceStepIds'
  | 'loadIntent'
  | 'assertCurrent'
  | 'recordStep'
  | 'markCritical'
  | 'beginProviderMutationPlan'
  | 'runPublishingProviderMutation'
  | 'prepareProviderMutationPlanCommit'
  | 'prepareAcknowledgedProjectionPlan'
  | 'abortProviderMutationPlan'
  | 'prepareProviderMutationEffectsClosed'
> & {
  commitCurrent(ref: PublishingJobRef, mutation: (tx: Transaction) => Promise<void>): Promise<void>;
  leaseAudio(ref: PublishingJobRef, sermonId?: string, sourcePath?: string): Promise<void>;
  releaseAudio(ref: PublishingJobRef): Promise<{ released: boolean }>;
};
const fail: (code: string) => never = (code) => {
  throw Object.assign(new Error(code), { code });
};
const key = (ref: PublishingJobRef, step: string): string => `durable:${ref.projectId}:${ref.jobId}:${step}`;
const db = () => firebaseAdmin.firestore();
const sermonRef = (intent: PrivatePublishingIntent) => db().collection('sermons').doc(intent.sermonId);
const canonical = async (intent: PrivatePublishingIntent): Promise<Sermon> => {
  const doc = await sermonRef(intent).get();
  if (!doc.exists) throw new HttpsError('not-found', 'Sermon no longer exists.');
  return { ...doc.data(), id: intent.sermonId } as Sermon;
};
const content = (intent: PrivatePublishingIntent): Sermon => intent.payload.sermon as unknown as Sermon;
const authorizedRequest = async <T>(
  intent: PrivatePublishingIntent,
  data: T
): Promise<Pick<CallableRequest<T>, 'data' | 'auth'>> => {
  const actor = await firebaseAdmin.auth().getUser(intent.actorUid);
  if (actor.disabled || !['admin', 'publisher'].includes(actor.customClaims?.role))
    fail('PUBLISHING_PERMISSION_CHANGED');
  return {
    data,
    auth: {
      uid: actor.uid,
      rawToken: '',
      token: { ...actor.customClaims, uid: actor.uid } as NonNullable<CallableRequest<T>['auth']>['token'],
    },
  };
};
/** Audio refresh is authorized only by this parent's exact completed dependency. */
async function publishingAllocationInput(
  ref: PublishingJobRef,
  intent: PrivatePublishingIntent,
  sermon: Sermon
): Promise<{ source: ReturnType<typeof capturePublishingAllocationSource>; audioPath: string }> {
  const source = intent.payload.allocationSource as ReturnType<typeof capturePublishingAllocationSource> | undefined;
  if (
    !source ||
    !Number.isFinite(source.editedAtMillis) ||
    !/[a-f0-9]{64}/.test(source.contentFingerprint) ||
    !/[a-f0-9]{64}/.test(source.audioFingerprint)
  )
    fail('PUBLISHING_ALLOCATION_SOURCE_CHANGED');
  let audioPath =
    typeof intent.payload.audioStoragePath === 'string'
      ? intent.payload.audioStoragePath
      : `intro-outro-sermons/${intent.sermonId}`;
  if (!intent.payload.processAudio) return { source, audioPath };
  const dependency = await db().collection('temporalPublishingAudioDependencies').doc(ref.jobId).get();
  const media = dependency.get('mediaRef') as
    | { projectId?: string; jobId?: string; sermonId?: string; revision?: number; requestVersion?: string }
    | undefined;
  const artifact = (
    sermon as unknown as {
      audioArtifacts?: { jobId?: string; revision?: number; requestVersion?: string; finalPath?: string };
    }
  ).audioArtifacts;
  if (
    dependency.get('projectId') !== ref.projectId ||
    dependency.get('parentJobId') !== ref.jobId ||
    !media?.jobId ||
    media.projectId !== ref.projectId ||
    media.sermonId !== intent.sermonId ||
    artifact?.jobId !== media.jobId ||
    artifact.revision !== media.revision ||
    artifact.requestVersion !== media.requestVersion ||
    !artifact.finalPath
  )
    fail('PUBLISHING_AUDIO_SUPERSEDED');
  const child = await db().collection('durableJobs').doc(media.jobId).get();
  if (child.get('projectId') !== ref.projectId || child.get('state') !== 'succeeded')
    fail('PUBLISHING_AUDIO_SUPERSEDED');
  audioPath = artifact.finalPath;
  return {
    source: {
      ...source,
      audioFingerprint: capturePublishingAllocationSource(sermon as unknown as Record<string, unknown>)
        .audioFingerprint,
    },
    audioPath,
  };
}
/** An edit owns one complete membership graph until its canonical selection commits. */
const membershipMutationScope = new AsyncLocalStorage<string>();
async function beginMembershipMutation(
  ref: PublishingJobRef,
  intent: PrivatePublishingIntent,
  step: 'lists' | 'series'
) {
  const shared = membershipMutationScope.getStore();
  if (shared) return { operation: shared, ownsSettlement: false };
  const rebuild = async () => {
    const plan = await buildPublishingMutationResourcePlan({ db: db(), ref, intent, logicalStep: step });
    return {
      ...plan,
      operation: `${plan.operation}:${intent.action}:${
        step === 'series' ? intent.destinations.seriesId ?? 'none' : 'all'
      }`,
    };
  };
  const plan = await rebuild();
  await beginProviderMutationPlan(plan);
  try {
    await assertMutationResourcePlanCurrent(plan, rebuild);
  } catch {
    // Only a proved unsent/rejected session may be abandoned. An original ACK
    // or unknown request keeps its ownership and replaces this error with review.
    await abortProviderMutationPlan({ operation: plan.operation });
    throw Object.assign(
      new Error('This step stopped before changing destination relationships. Refresh and start a new task.'),
      { code: 'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT' }
    );
  }
  return { operation: plan.operation, ownsSettlement: true };
}
/** All provider responses stay in private activity memory/receipts, never in workflow results. */
export function createFirebasePublishingDependencies(store: Store): PublishingDomainDependencies {
  const dependencies: PublishingDomainDependencies = {
    ...store,
    async ensureSubsplashMedia(ref, intent) {
      const sermon = await canonical(intent);
      if (sermon.subsplashId) return;
      await authorizedRequest(intent, {});
      const { source: allocationSource, audioPath } = await publishingAllocationInput(ref, intent, sermon);
      await store.leaseAudio(ref, intent.sermonId, audioPath);
      const audioUrl = await getDownloadURL(firebaseAdmin.storage().bucket().file(audioPath));
      const result = (await uploadToSubsplashDomain(
        {
          operationKey: key(ref, `${intent.sermonId}:subsplash-create`),
          lockKey: intent.sermonId,
          title: content(intent).title,
          subtitle: content(intent).subtitle,
          description: content(intent).description,
          speakers: content(intent).speakers,
          topics: content(intent).topics,
          images: content(intent).images,
          audioTitle: content(intent).title,
          audioUrl,
          date: new Date(content(intent).dateMillis),
          autoPublish: false,
        },
        {
          readExistingMedia: async () => {
            await store.assertCurrent(ref, intent);
            return (await canonical(intent)).subsplashId;
          },
          beforeCreateMedia: () =>
            claimPublishingAllocation(db(), store, {
              ref,
              sermonId: intent.sermonId,
              provider: 'subsplash',
              operationKey: key(ref, `${intent.sermonId}:subsplash-create`),
              source: allocationSource,
            }),
          commitCreatedMedia: async (created) => {
            if (!created.id) fail('PROVIDER_CREATE_AMBIGUOUS');
            await store.commitCurrent(ref, async (tx) => {
              const settle = await preparePublishingAllocationCommit(
                tx,
                db(),
                {
                  ref,
                  sermonId: intent.sermonId,
                  provider: 'subsplash',
                  operationKey: key(ref, `${intent.sermonId}:subsplash-create`),
                  source: allocationSource,
                },
                created.id
              );
              tx.update(sermonRef(intent), { subsplashId: created.id, approverId: intent.actorUid });
              settle();
            });
          },
        }
      )) as { id?: string };
      if (!result?.id) fail('PROVIDER_CREATE_AMBIGUOUS');
    },
    async ensureSoundCloudTrack(ref, intent) {
      const removals = intent.payload.removals as PrivatePublishingIntent['destinations'] | undefined;
      if (removals?.soundcloud)
        await dependencies.deleteProviders(ref, {
          ...intent,
          action: 'unpublish',
          destinations: { listIds: [], soundcloud: true },
        });
      if (!intent.destinations.soundcloud) return;
      await withSubsplashLocks([`media-item:soundcloud:${intent.sermonId}`], async () => {
        await store.assertCurrent(ref, intent);
        const sermon = await canonical(intent);
        if (sermon.soundCloudTrackId) return;
        const { source: allocationSource, audioPath } = await publishingAllocationInput(ref, intent, sermon);
        await claimPublishingAllocation(db(), store, {
          ref,
          sermonId: intent.sermonId,
          provider: 'soundcloud',
          operationKey: key(ref, `${intent.sermonId}:soundcloud-create`),
          source: allocationSource,
        });
        await authorizedRequest(intent, {});
        await store.leaseAudio(ref, intent.sermonId, audioPath);
        const result = await uploadToSoundCloudDomain({
          operationKey: key(ref, `${intent.sermonId}:soundcloud-create`),
          audioStoragePath: audioPath,
          title: content(intent).title,
          description: content(intent).description,
          tags: [content(intent).subtitle, ...content(intent).topics],
          speakers: content(intent).speakers.map((s) => s.name),
          imageSource: content(intent).images.find((image) => image.type === 'square')?.downloadLink,
        });
        await store.assertCurrent(ref, intent);
        await store.commitCurrent(ref, async (tx) => {
          const settle = await preparePublishingAllocationCommit(
            tx,
            db(),
            {
              ref,
              sermonId: intent.sermonId,
              provider: 'soundcloud',
              operationKey: key(ref, `${intent.sermonId}:soundcloud-create`),
              source: allocationSource,
            },
            result.soundCloudTrackId
          );
          tx.update(sermonRef(intent), {
            soundCloudTrackId: result.soundCloudTrackId,
            soundCloudTrackUrl: result.soundCloudTrackUrl ?? FieldValue.delete(),
            'status.soundCloud': uploadStatus.NOT_UPLOADED,
          });
          settle();
        });
      });
    },
    async awaitSubsplashReady(ref, intent) {
      const sermon = await canonical(intent);
      if (!sermon.subsplashId) fail('PUBLISHING_MEDIA_MISSING');
      if (!(await isSubsplashMediaPlayable(sermon.subsplashId))) fail('PUBLISHING_AUDIO_PROCESSING');
      if (ref.projectId === 'urm-app')
        await withSubsplashLocks([`media-item:${sermon.subsplashId}`], async () => {
          await store.assertCurrent(ref, intent);
          const publication = db().collection('temporalPublishingPublications').doc(`${ref.jobId}-${intent.sermonId}`);
          let publishedAt = (await publication.get()).get('publishedAt');
          if (typeof publishedAt !== 'string') {
            publishedAt = new Date().toISOString();
            await store.commitCurrent(ref, async (tx) => {
              tx.set(publication, { publishedAt }, { merge: true });
            });
          }
          const token = await authenticateSubsplash();
          const url = `https://core.subsplash.com/media/v1/media-items/${sermon.subsplashId}`;
          const current = (await axios(createAxiosConfig(url, token, 'GET'))).data;
          const operation = key(ref, `${intent.sermonId}:publication`);
          await beginProviderMutationPlan({
            operation,
            resources: [
              { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'media', resourceId: sermon.subsplashId! },
            ],
          });
          if (current.status !== 'published') {
            const payload = { app_key: '9XTSHD', status: 'published', auto_publish: true, published_at: publishedAt };
            await store.commitCurrent(ref, async (tx) => {
              const freeze = await prepareAcknowledgedProjectionPlan(tx, {
                operation,
                uiStepIds: ['subsplash-media'],
                requests: [
                  {
                    step: 'publication',
                    method: 'PATCH',
                    target: {
                      provider: 'subsplash',
                      account: 'app:9XTSHD',
                      resourceType: 'media',
                      resourceId: sermon.subsplashId!,
                    },
                    payload,
                    fingerprint: publishingMutationRequestFingerprint({
                      method: 'PATCH',
                      target: {
                        provider: 'subsplash',
                        account: 'app:9XTSHD',
                        resourceType: 'media',
                        resourceId: sermon.subsplashId!,
                      },
                      payload,
                    }),
                  },
                ],
                writes: [
                  {
                    path: publication.path,
                    expectedFields: { publishedAt },
                    patch: { remoteId: sermon.subsplashId!, status: 'confirmed', publishedAt },
                  },
                  {
                    path: sermonRef(intent).path,
                    expectedFields: { subsplashId: sermon.subsplashId! },
                    patch: { 'status.subsplash': uploadStatus.UPLOADED },
                  },
                ],
                verifications: [
                  {
                    provider: 'subsplash',
                    account: 'app:9XTSHD',
                    resourceType: 'media',
                    resourceId: sermon.subsplashId!,
                    expectedProviderFields: { id: sermon.subsplashId!, app_key: '9XTSHD', status: 'published' },
                  },
                ],
              });
              freeze.commit();
            });
            if (current.status !== 'published')
              await markPublishingCritical('PUBLISHING_PUBLICATION_CRITICAL', {
                provider: 'subsplash',
                resourceType: 'media',
                resourceId: sermon.subsplashId!,
                accountId: 'app:9XTSHD',
                method: 'PATCH',
                canonicalPaths: [`sermons/${intent.sermonId}`],
              });
            await runPublishingProviderMutation({
              operation,
              target: {
                provider: 'subsplash',
                account: 'app:9XTSHD',
                resourceType: 'media',
                resourceId: sermon.subsplashId!,
              },
              step: 'publication',
              method: 'PATCH',
              payload,
              send: async () => {
                const response = await axios({
                  ...createAxiosConfig(url, token, 'PATCH', payload),
                  maxRedirects: 0,
                  skipSubsplashEdgeRetry: true,
                } as ReturnType<typeof createAxiosConfig>);
                assertSynchronousProviderMutationCompleted(response);
                return { completion: 'acknowledged', result: { published: true } };
              },
            });
          }
          const confirmed = (await axios(createAxiosConfig(url, token, 'GET'))).data;
          if (confirmed.status !== 'published') fail('PUBLISHING_PROVIDER_REPAIR_REQUIRED');
          await store.commitCurrent(ref, async (tx) => {
            const settle = await prepareProviderMutationPlanCommit(tx, { operation });
            if (settle.alreadyCommitted) return;
            tx.set(publication, { remoteId: sermon.subsplashId, status: 'confirmed', publishedAt }, { merge: true });
            tx.update(sermonRef(intent), { 'status.subsplash': uploadStatus.UPLOADED });
            settle.commit();
          });
        });
    },
    async awaitSoundCloudReady(ref, intent) {
      const sermon = await canonical(intent);
      if (!sermon.soundCloudTrackId) fail('PUBLISHING_MEDIA_MISSING');
      if (!(await isSoundCloudTrackPlayable(sermon.soundCloudTrackId))) fail('PUBLISHING_AUDIO_PROCESSING');
      await store.commitCurrent(ref, async (tx) => {
        tx.update(sermonRef(intent), { 'status.soundCloud': uploadStatus.UPLOADED });
      });
    },
    async mutateLists(ref, intent) {
      const removals = intent.payload.removals as PrivatePublishingIntent['destinations'] | undefined;
      const removeIds = intent.action === 'unpublish' ? intent.destinations.listIds : removals?.listIds ?? [];
      const addIds = intent.action === 'unpublish' ? [] : intent.destinations.listIds;
      if (!removeIds.length && !addIds.length) return;
      const sermon = await canonical(intent);
      if (!sermon.subsplashId) {
        if (!addIds.length) return;
        fail('PUBLISHING_MEDIA_MISSING');
      }
      const remoteToLocal = new Map<string, string>();
      const localLists = new Map<string, Record<string, unknown>>();
      // Allocation has its own single-shot receipt. Freeze the mutation graph only
      // after newly allocated provider IDs have been saved canonically.
      for (const localId of addIds) {
        const listRef = db().collection('lists').doc(localId);
        const list = (await listRef.get()).data();
        if (!list) fail('PUBLISHING_LIST_MISSING');
        let remoteId: string = list.subsplashId ?? '';
        if (!remoteId) {
          if (membershipMutationScope.getStore()) fail('PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT');
          const created = await createNewSubsplashList({
            title: list.name,
            images: list.images,
            operationKey: key(ref, `${intent.sermonId}:list-create:${localId}`),
          });
          remoteId = created.listId;
          await store.commitCurrent(ref, async (tx) => {
            tx.update(listRef, { subsplashId: remoteId });
          });
        }
        remoteToLocal.set(remoteId, localId);
        localLists.set(localId, { ...list, id: localId, subsplashId: remoteId });
      }
      const plan = await beginMembershipMutation(ref, intent, 'lists');
      const projectionWrites: Array<(tx: Transaction) => void> = [];
      if (removeIds.length) {
        const memberships = await db().collection('sermons').doc(intent.sermonId).collection('sermonLists').get();
        for (const doc of memberships.docs.filter((row) => removeIds.includes(row.id))) {
          const membership = doc.data();
          if (membership.uploadStatus?.status !== uploadStatus.UPLOADED) continue;
          const result = await removeFromListDomain(
            await authorizedRequest(intent, {
              operationKey: key(ref, `${intent.sermonId}:list-remove:${doc.id}`),
              listIds: [membership.subsplashId],
              listItemIds: [membership.uploadStatus.listItemId],
              itemIds: [sermon.subsplashId!],
              itemTypes: ['media-item'],
              sermonIds: [intent.sermonId],
            })
          );
          if (result.some((item) => item.status === 'error')) fail('PUBLISHING_LIST_PARTIAL');
          projectionWrites.push((tx) => {
            tx.update(doc.ref, { uploadStatus: { status: uploadStatus.NOT_UPLOADED } });
          });
        }
      }
      if (addIds.length) {
        const result = await addToListDomain(
          await authorizedRequest(intent, {
            operationKey: key(ref, `${intent.sermonId}:list-add`),
            destinationListIds: [...remoteToLocal.keys()],
            mediaItem: { id: sermon.subsplashId!, type: 'media-item' } as SubsplashMediaItem,
          })
        );
        if (result.some((item) => item.status === 'error')) fail('PUBLISHING_LIST_PARTIAL');
        for (const item of result) {
          if (item.status !== 'success') continue;
          const localId = remoteToLocal.get(item.listId);
          const listItemId = item.listItemId ?? item.actualPlacement?.listItemId;
          if (!localId || !listItemId) fail('PUBLISHING_LIST_PARTIAL');
          projectionWrites.push((tx) => {
            tx.set(
              db().collection('sermons').doc(intent.sermonId).collection('sermonLists').doc(localId!),
              {
                ...localLists.get(localId!),
                _durableMembershipJobId: ref.jobId,
                uploadStatus: { status: uploadStatus.UPLOADED, listItemId },
              },
              { merge: true }
            );
          });
        }
      }
      await store.commitCurrent(ref, async (tx) => {
        const settlement = plan.ownsSettlement
          ? await prepareProviderMutationPlanCommit(tx, { operation: plan.operation })
          : undefined;
        if (settlement?.alreadyCommitted) return;
        projectionWrites.forEach((write) => write(tx));
        settlement?.commit();
      });
    },
    async mutateSeries(ref, intent) {
      const removals = intent.payload.removals as PrivatePublishingIntent['destinations'] | undefined;
      if (intent.action === 'publish' && removals?.seriesId)
        await dependencies.mutateSeries(ref, { ...intent, action: 'unpublish', destinations: removals });
      const sermon = await canonical(intent);
      const seriesId = intent.destinations.seriesId;
      if (!seriesId || !sermon.subsplashId) return;
      const seriesRef = db().collection('series').doc(seriesId);
      const seriesDoc = await seriesRef.get();
      if (!seriesDoc.exists) fail('PUBLISHING_SERIES_MISSING');
      const series = seriesDoc.data()!;
      let remoteId: string = series.subsplashId ?? '';
      if (!remoteId && intent.action !== 'unpublish') {
        if (membershipMutationScope.getStore()) fail('PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT');
        const created = await createSeriesDomain(
          {
            firestoreId: seriesId,
            title: series.name,
            summary: series.summary,
            ownerId: series.ownerId ?? intent.actorUid,
            images: series.images,
            operationKey: key(ref, `${intent.sermonId}:series-create`),
          },
          (
            await authorizedRequest(intent, {})
          ).auth?.token.role,
          { commitCurrent: (write) => store.commitCurrent(ref, write) }
        );
        if (created.status !== 'success' || !created.subsplashId) fail('PUBLISHING_SERIES_PARTIAL');
        remoteId = created.subsplashId;
      }
      if (!remoteId) return;
      const plan = await beginMembershipMutation(ref, intent, 'series');
      if (intent.action === 'unpublish') {
        const result = await removeFromSeriesDomain(
          await authorizedRequest(intent, {
            firestoreSeriesId: seriesId,
            mediaItemId: sermon.subsplashId,
            operationKey: key(ref, `${intent.sermonId}:series-remove:${seriesId}`),
          })
        );
        if (result.status !== 'success') fail('PUBLISHING_SERIES_PARTIAL');
      } else {
        const token = await authenticateSubsplash();
        const remote = await getSeriesItems(remoteId, token);
        const ids = remote.map((item) => item.id);
        const expected =
          typeof intent.payload.expectedPublishedMembershipHash === 'string'
            ? intent.payload.expectedPublishedMembershipHash
            : createSeriesMediaItemMembershipHash(remote.map((item) => ({ id: item.id })));
        const order = Array.isArray(intent.payload.publishedItemOrder)
          ? (intent.payload.publishedItemOrder as string[])
          : [...ids.filter((id) => id !== sermon.subsplashId), sermon.subsplashId];
        const result = await bulkAddToSeriesDomain(
          await authorizedRequest(intent, {
            firestoreSeriesId: seriesId,
            seriesSubsplashId: remoteId,
            operationKey: key(ref, `${intent.sermonId}:series-add:${seriesId}`),
            expectedPublishedMembershipHash: expected,
            adds: [{ mediaItemId: sermon.subsplashId, sermonId: intent.sermonId }],
            publishedItemOrder: order,
            rollbackOnFailure: false,
          })
        );
        if (result.status !== 'success') fail('PUBLISHING_SERIES_PARTIAL');
      }
      await store.commitCurrent(ref, async (tx) => {
        const settlement = plan.ownsSettlement
          ? await prepareProviderMutationPlanCommit(tx, { operation: plan.operation })
          : undefined;
        if (settlement?.alreadyCommitted) return;
        tx.set(
          seriesRef.collection('seriesItems').doc(intent.sermonId),
          { publishedToSubsplash: intent.action !== 'unpublish' },
          { merge: true }
        );
        settlement?.commit();
      });
    },
    async replaceAudio(ref, intent) {
      await replacePublishedSubsplashAudio(ref, intent, store);
      await replacePublishedSoundCloudAudio(ref, intent, store);
    },
    async updateMemberships(ref, intent) {
      if (intent.action !== 'update' || intent.payload.hasMembershipSelection !== true) return;
      const previousSeriesId =
        typeof intent.payload.previousSeriesId === 'string' ? intent.payload.previousSeriesId : undefined;
      const desiredSeriesId =
        typeof intent.payload.desiredSeriesId === 'string' ? intent.payload.desiredSeriesId : undefined;
      if (intent.payload.previousSeriesPublished === true && desiredSeriesId && previousSeriesId !== desiredSeriesId) {
        const target = await db().collection('series').doc(desiredSeriesId).get();
        if (!target.exists) fail('PUBLISHING_SERIES_MISSING');
        if (!target.get('subsplashId')) {
          const series = target.data()!;
          const created = await createSeriesDomain(
            {
              firestoreId: desiredSeriesId,
              title: series.name,
              summary: series.summary,
              ownerId: series.ownerId ?? intent.actorUid,
              images: series.images,
              operationKey: key(ref, `${intent.sermonId}:series-create:${desiredSeriesId}`),
            },
            (
              await authorizedRequest(intent, {})
            ).auth?.token.role,
            { commitCurrent: (write) => store.commitCurrent(ref, write) }
          );
          if (created.status !== 'success' || !created.subsplashId) fail('PUBLISHING_SERIES_PARTIAL');
        }
      }
      const rebuild = () => buildPublishingMutationResourcePlan({ db: db(), ref, intent, logicalStep: 'lists' });
      const plan = await rebuild();
      if (plan.resources.length) {
        await beginProviderMutationPlan(plan);
        try {
          await assertMutationResourcePlanCurrent(plan, rebuild);
        } catch {
          await abortProviderMutationPlan({ operation: plan.operation });
          throw Object.assign(
            new Error('This step stopped before changing destination relationships. Refresh and start a new task.'),
            { code: 'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT' }
          );
        }
      }
      await membershipMutationScope.run(plan.operation, () =>
        reconcilePublishingUpdateMemberships(ref, intent, { ...dependencies, ...store })
      );
      await store.commitCurrent(ref, async (tx) => {
        const settlement = plan.resources.length
          ? await prepareProviderMutationPlanCommit(tx, { operation: plan.operation })
          : undefined;
        if (settlement?.alreadyCommitted) return;
        // Selection, both membership mirrors, and mutation ownership settle together.
        await commitPublishingUpdateMemberships(ref, intent, tx, true);
        settlement?.commit();
      });
    },
    async updateMetadata(ref, intent) {
      const sermon = await canonical(intent);
      const operation = key(ref, `${intent.sermonId}:metadata`);
      const resources: ProviderMutationResource[] = [];
      if (sermon.subsplashId)
        resources.push({
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: sermon.subsplashId,
        });
      const soundcloud = sermon.soundCloudTrackId
        ? await runWithSoundCloudAccessToken(async (token) => ({
            token,
            account: await getAuthenticatedSoundCloudAccountId(token),
          }))
        : undefined;
      if (soundcloud)
        resources.push({
          provider: 'soundcloud',
          account: soundcloud.account,
          resourceType: 'track',
          resourceId: sermon.soundCloudTrackId!,
        });
      if (resources.length) await beginProviderMutationPlan({ operation, resources });
      await store.commitCurrent(ref, async (tx) => {
        const current = await tx.get(sermonRef(intent));
        if (
          !current.exists ||
          current.get('subsplashId') !== sermon.subsplashId ||
          current.get('soundCloudTrackId') !== sermon.soundCloudTrackId
        )
          fail('PUBLISHING_METADATA_DESTINATIONS_CHANGED');
        const stamp = await preparePublishingMetadataCheckpoint(
          tx,
          db(),
          ref,
          intent,
          current.data()!,
          resources.length ? 'prepared' : 'completed'
        );
        stamp();
      });
      const imageSource = content(intent).images.find((image) => image.type === 'square')?.downloadLink;
      const scData = {
        trackId: sermon.soundCloudTrackId!,
        title: content(intent).title,
        description: content(intent).description,
        tags: [content(intent).subtitle, ...content(intent).topics],
        ...(imageSource === undefined ? {} : { imageSource }),
      };
      let frozenPatch: Record<string, unknown> | undefined;
      const freezeMetadata = async (prepared?: { requestData: string; images?: unknown[] }) => {
        const requests: FrozenProjectionRequest[] = [],
          verifications: FrozenProviderVerification[] = [];
        if (sermon.subsplashId) {
          if (!prepared) fail('PROVIDER_ACK_PROJECTION_CONTEXT_REQUIRED');
          requests.push({
            step: 'subsplash-metadata',
            method: 'PATCH' as const,
            target: {
              provider: 'subsplash',
              account: 'app:9XTSHD',
              resourceType: 'media',
              resourceId: sermon.subsplashId,
            },
            payload: prepared.requestData,
            fingerprint: publishingMutationRequestFingerprint({
              method: 'PATCH',
              target: {
                provider: 'subsplash',
                account: 'app:9XTSHD',
                resourceType: 'media',
                resourceId: sermon.subsplashId,
              },
              payload: prepared.requestData,
            }),
          });
          const fields = JSON.parse(prepared.requestData) as Record<string, unknown>;
          verifications.push({
            provider: 'subsplash' as const,
            account: 'app:9XTSHD',
            resourceType: 'media' as const,
            resourceId: sermon.subsplashId,
            requiredSteps: ['subsplash-metadata'],
            expectedProviderFields: fields,
          });
        }
        if (soundcloud) {
          requests.push({
            step: 'soundcloud-metadata',
            method: 'PUT' as const,
            target: {
              provider: 'soundcloud',
              account: soundcloud.account,
              resourceType: 'track',
              resourceId: sermon.soundCloudTrackId!,
            },
            payload: scData,
            fingerprint: publishingMutationRequestFingerprint({
              method: 'PUT',
              target: {
                provider: 'soundcloud',
                account: soundcloud.account,
                resourceType: 'track',
                resourceId: sermon.soundCloudTrackId!,
              },
              payload: scData,
            }),
          });
          verifications.push({
            provider: 'soundcloud' as const,
            account: soundcloud.account,
            resourceType: 'track' as const,
            resourceId: sermon.soundCloudTrackId!,
            requiredSteps: ['soundcloud-metadata'],
            expectedProviderFields: {
              title: scData.title,
              description: scData.description,
              tag_list: formatTagList(scData.tags),
            },
          });
        }
        await store.commitCurrent(ref, async (tx) => {
          const current = await tx.get(sermonRef(intent));
          if (!current.exists) fail('PUBLISHING_MEDIA_MISSING');
          const patch = Object.fromEntries(
            Object.entries(intent.payload.patch as Record<string, unknown>).filter(
              ([field]) => !['seriesId', 'subsplashId', 'soundCloudTrackId'].includes(field)
            )
          );
          if (prepared?.images && Array.isArray(patch.images)) patch.images = prepared.images;
          const measured = current.get('audioArtifacts.durationSeconds');
          if (intent.payload.processAudio && typeof measured === 'number') patch.durationSeconds = measured;
          const job = await tx.get(db().collection('durableJobs').doc(ref.jobId));
          const admittedAt = Number(job.get('createdAt'));
          if (!Number.isFinite(admittedAt)) fail('PROVIDER_ACK_PROJECTION_CONTEXT_REQUIRED');
          patch.editedAtMillis = Math.max(
            admittedAt,
            Number((intent.payload.sermon as Record<string, unknown>).editedAtMillis ?? 0) + 1
          );
          frozenPatch = patch;
          const expectedFields: Record<string, unknown> = {};
          const absentFields: string[] = [];
          for (const field of ['subsplashId', 'soundCloudTrackId', 'editedAtMillis']) {
            const value = current.get(field);
            if (value === undefined) absentFields.push(field);
            else expectedFields[field] = value;
          }
          const freeze = await prepareAcknowledgedProjectionPlan(tx, {
            operation,
            requests,
            verifications,
            uiStepIds: ['projection'],
            writes: [
              {
                path: sermonRef(intent).path,
                expectedFields,
                absentFields,
                requiredAnySteps: requests.map((request) => request.step),
                patch: Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null)),
                deleteFields: Object.entries(patch)
                  .filter(([, value]) => value === null)
                  .map(([field]) => field),
              },
            ],
          });
          freeze.commit();
        });
      };
      if (!sermon.subsplashId && resources.length) await freezeMetadata();
      if (sermon.subsplashId)
        await editSubsplashSermonDomain(
          await authorizedRequest(intent, {
            operationKey: key(ref, `${intent.sermonId}:subsplash-update`),
            subsplashId: sermon.subsplashId,
            title: content(intent).title,
            subtitle: content(intent).subtitle,
            description: content(intent).description,
            speakers: content(intent).speakers,
            topics: content(intent).topics,
            images: content(intent).images,
            date: new Date(content(intent).dateMillis),
          }),
          { providerMutationOperation: operation, onPrepared: freezeMetadata }
        );
      if (sermon.soundCloudTrackId) {
        const result = await editSoundCloudSermonDomain(await authorizedRequest(intent, scData), {
          providerMutationOperation: operation,
          accessToken: soundcloud!.token,
          providerAccount: soundcloud!.account,
        });
        if (result.soundCloudTrackMissing) fail('PUBLISHING_MEDIA_MISSING');
      }
      if (resources.length)
        await store.commitCurrent(ref, async (tx) => {
          const settle = await prepareProviderMutationPlanCommit(tx, { operation });
          if (settle.alreadyCommitted) return;
          const current = await tx.get(sermonRef(intent));
          if (!current.exists) fail('PUBLISHING_MEDIA_MISSING');
          if (
            sermon.subsplashId !== current.get('subsplashId') ||
            sermon.soundCloudTrackId !== current.get('soundCloudTrackId')
          )
            fail('PUBLISHING_DRIFT');
          if (!frozenPatch) fail('PROVIDER_ACK_PROJECTION_CONTEXT_REQUIRED');
          const patch = Object.fromEntries(
            Object.entries(frozenPatch).map(([field, value]) => [field, value === null ? FieldValue.delete() : value])
          );
          const expected = { ...current.data() };
          for (const [field, value] of Object.entries(frozenPatch)) {
            if (value === null) delete expected[field];
            else expected[field] = value;
          }
          const metadata = await preparePublishingMetadataCheckpoint(tx, db(), ref, intent, expected, 'completed');
          tx.update(sermonRef(intent), patch);
          metadata();
          settle.commit();
        });
    },
    async prepareDeletePlan(ref, intent) {
      if (intent.action !== 'delete') fail('PUBLISHING_PROVIDER_REPAIR_REQUIRED');
      const sermon = await canonical(intent);
      const providerResources: ProviderMutationResource[] = [];
      if (sermon.subsplashId)
        providerResources.push({
          provider: 'subsplash',
          account: 'app:9XTSHD',
          resourceType: 'media',
          resourceId: sermon.subsplashId,
        });
      if (sermon.soundCloudTrackId) {
        await authorizedRequest(intent, {});
        const account = await runWithSoundCloudAccessToken((token) => getAuthenticatedSoundCloudAccountId(token));
        providerResources.push({
          provider: 'soundcloud',
          account,
          resourceType: 'track',
          resourceId: sermon.soundCloudTrackId,
        });
      }
      const destinations = sermon.subsplashId
        ? await captureSermonDeletionDestinations(
            db(),
            { ...ref, sermonId: intent.sermonId, mediaId: sermon.subsplashId },
            await authenticateSubsplash()
          )
        : undefined;
      const resources = [
        ...new Map(
          [...providerResources, ...(destinations?.resources ?? [])].map((resource) => [
            JSON.stringify([resource.provider, resource.account, resource.resourceType, resource.resourceId]),
            resource,
          ])
        ).values(),
      ];
      const operation = key(ref, `${intent.sermonId}:provider-delete:${intent.action}`);
      if (resources.length) await beginProviderMutationPlan({ operation, resources });
      if (destinations) {
        if (destinations.operation !== operation) fail('PUBLISHING_PROVIDER_REPAIR_REQUIRED');
        try {
          await revalidateSermonDeletionDestinationSources(db(), destinations.ref);
        } catch {
          await abortProviderMutationPlan({ operation });
          fail('PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT');
        }
      }
      const requests: FrozenProjectionRequest[] = providerResources.map((target) => ({
        step: `delete:${target.provider}:${target.resourceId}`,
        method: 'DELETE',
        target,
        payload: { id: target.resourceId },
        fingerprint: publishingMutationRequestFingerprint({
          method: 'DELETE',
          target,
          payload: { id: target.resourceId },
        }),
      }));
      const verifications: FrozenProviderVerification[] = providerResources.map((target) => ({
        ...target,
        resourceType: target.provider === 'subsplash' ? 'media' : 'track',
        expectedState: 'absent',
        expectedProviderFields: {},
        requiredSteps: [`delete:${target.provider}:${target.resourceId}`],
      }));
      await prepareSermonDeletionMirrors(db(), {
        ref,
        sermonId: intent.sermonId,
        operation: resources.length ? operation : undefined,
        requests,
        verifications,
        ...(destinations ? { destinationProgram: destinations.ref } : {}),
      });
      await markPublishingCritical('PUBLISHING_DELETE_PLAN_CRITICAL', undefined, async (tx) => {
        await assertPublishingDeletionAllocationsSettled(tx, db(), {
          ref,
          sermonId: intent.sermonId,
          subsplashId: sermon.subsplashId,
          soundCloudTrackId: sermon.soundCloudTrackId,
        });
        return providerResources.length
          ? prepareDesiredProviderDeletions(
              tx,
              db(),
              providerResources.map((target) => ({
                resource: {
                  projectId: ref.projectId,
                  provider: target.provider,
                  account: target.provider === 'subsplash' ? 'app:9XTSHD' : 'configured-account',
                  remoteId: target.resourceId,
                },
                jobId: ref.jobId,
                resourceType: target.provider === 'subsplash' ? ('media' as const) : ('track' as const),
              }))
            )
          : () => {};
      });
    },
    async deleteProviders(ref, intent) {
      const sermon = await canonical(intent);
      const mediaId = intent.action === 'delete' ? sermon.subsplashId : undefined;
      const trackId =
        intent.action === 'delete' || intent.destinations.soundcloud ? sermon.soundCloudTrackId : undefined;
      if (!mediaId && !trackId) return;
      await authorizedRequest(intent, {});
      // The transport's actual account, rather than a client hint, scopes the
      // complete set before either provider can observe a DELETE.
      const soundcloudAccount = trackId
        ? await runWithSoundCloudAccessToken((token) => getAuthenticatedSoundCloudAccountId(token))
        : undefined;
      const resources: ProviderMutationResource[] = [];
      if (mediaId)
        resources.push({ provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'media', resourceId: mediaId });
      if (trackId)
        resources.push({
          provider: 'soundcloud',
          account: soundcloudAccount!,
          resourceType: 'track',
          resourceId: trackId,
        });
      const operation = key(ref, `${intent.sermonId}:provider-delete:${intent.action}`);
      const destinations =
        intent.action === 'delete' && mediaId
          ? await captureSermonDeletionDestinations(
              db(),
              { ...ref, sermonId: intent.sermonId, mediaId },
              await authenticateSubsplash()
            )
          : undefined;
      const wholeResources = [
        ...new Map(
          [...resources, ...(destinations?.resources ?? [])].map((resource) => [
            JSON.stringify([resource.provider, resource.account, resource.resourceType, resource.resourceId]),
            resource,
          ])
        ).values(),
      ];
      await beginProviderMutationPlan({ operation, resources: wholeResources });
      await store.assertCurrent(ref, intent);
      const current = await canonical(intent);
      if ((mediaId && current.subsplashId !== mediaId) || (trackId && current.soundCloudTrackId !== trackId)) {
        await abortProviderMutationPlan({ operation });
        fail('PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT');
      }
      // Freeze each exact DELETE and its factual pointer removal before either
      // request is claimed. A partial original ACK can then be repaired without
      // replaying the other provider's request or reconstructing later state.
      if (intent.action !== 'delete')
        await store.commitCurrent(ref, async (tx) => {
          const requests: FrozenProjectionRequest[] = resources.map((target) => {
            const step = `delete:${target.provider}:${target.resourceId}`;
            const payload = { id: target.resourceId };
            return {
              step,
              method: 'DELETE',
              target,
              payload,
              fingerprint: publishingMutationRequestFingerprint({ method: 'DELETE', target, payload }),
            };
          });
          const writes = resources.map((target) => {
            const subsplash = target.provider === 'subsplash';
            return {
              path: sermonRef(intent).path,
              requiredSteps: [`delete:${target.provider}:${target.resourceId}`],
              expectedFields: { [subsplash ? 'subsplashId' : 'soundCloudTrackId']: target.resourceId },
              patch: { [subsplash ? 'status.subsplash' : 'status.soundCloud']: uploadStatus.NOT_UPLOADED },
              deleteFields: subsplash
                ? ['subsplashId']
                : ['soundCloudTrackId', 'soundCloudTrackUrl', 'soundCloudPublication'],
            };
          });
          const verifications: FrozenProviderVerification[] = resources.map((target) => ({
            ...target,
            resourceType: target.provider === 'subsplash' ? 'media' : 'track',
            requiredSteps: [`delete:${target.provider}:${target.resourceId}`],
            expectedState: 'absent',
            expectedProviderFields: {},
          }));
          const freeze = await prepareAcknowledgedProjectionPlan(tx, {
            operation,
            requests,
            writes,
            verifications,
            finalFragment: intent.action !== 'delete',
            completesActivity: false,
          });
          freeze.commit();
        });
      await markPublishingCritical('PUBLISHING_DELETE_PROVIDERS_CRITICAL', undefined, async (tx) =>
        prepareDesiredProviderDeletions(
          tx,
          db(),
          resources.map((target) => ({
            resource: {
              projectId: ref.projectId,
              provider: target.provider,
              account: target.provider === 'subsplash' ? 'app:9XTSHD' : 'configured-account',
              remoteId: target.resourceId,
            },
            jobId: ref.jobId,
            resourceType: target.provider === 'subsplash' ? ('media' as const) : ('track' as const),
          }))
        )
      );
      if (destinations) await executeSermonDeletionDestinations(db(), destinations.ref, await authenticateSubsplash());
      if (mediaId)
        await deletePublishingSubsplashMedia(
          ref,
          intent,
          store,
          await authorizedRequest(intent, {
            operationKey: key(ref, `${intent.sermonId}:subsplash-delete`),
            subsplashId: mediaId,
          })
        );
      if (trackId) await deletePublishingSoundCloudTrack(ref, intent, store, trackId);
      await store.commitCurrent(ref, async (tx) => {
        const deletionPlan =
          intent.action === 'delete' ? await loadSermonDeletionMirrorPlan(db(), ref, intent.sermonId, tx) : undefined;
        const closure = deletionPlan
          ? await prepareProviderMutationEffectsClosed(tx, {
              operation,
              validateSourceEffects: (transaction) =>
                validateSermonDeletionEffectsForClosing(transaction, db(), deletionPlan),
            })
          : undefined;
        const settlement = deletionPlan ? undefined : await prepareProviderMutationPlanCommit(tx, { operation });
        if (settlement?.alreadyCommitted) return;
        const canonicalRef = sermonRef(intent),
          existing = await tx.get(canonicalRef);
        if (
          !existing.exists ||
          (mediaId && existing.get('subsplashId') !== mediaId) ||
          (trackId && existing.get('soundCloudTrackId') !== trackId)
        )
          fail('PUBLISHING_DRIFT');
        const retireMedia = mediaId
          ? await preparePublishingAllocationRetirement(
              tx,
              db(),
              { ref, sermonId: intent.sermonId, provider: 'subsplash' },
              mediaId
            )
          : () => {};
        const retireTrack = trackId
          ? await preparePublishingAllocationRetirement(
              tx,
              db(),
              { ref, sermonId: intent.sermonId, provider: 'soundcloud' },
              trackId
            )
          : () => {};
        const patch: Record<string, unknown> = {};
        if (mediaId)
          Object.assign(patch, { subsplashId: FieldValue.delete(), 'status.subsplash': uploadStatus.NOT_UPLOADED });
        if (trackId)
          Object.assign(patch, {
            soundCloudTrackId: FieldValue.delete(),
            soundCloudTrackUrl: FieldValue.delete(),
            soundCloudPublication: FieldValue.delete(),
            'status.soundCloud': uploadStatus.NOT_UPLOADED,
          });
        tx.update(canonicalRef, patch);
        retireMedia();
        retireTrack();
        closure?.commit();
        settlement?.commit();
      });
      // The reference reservation remains held until final mirror cleanup. An
      // absent provider resource must not be attached by another in-flight job.
    },
    async commitProjection(ref, intent) {
      await store.assertCurrent(ref, intent);
      if (intent.action === 'delete') {
        const plan = await loadSermonDeletionMirrorPlan(db(), ref, intent.sermonId);
        await removeSermonDeletionMirrors(db(), plan, {
          assertOriginalProviderEffects: async (tx, current) => {
            if (current.operation) await validateSermonDeletionEffectsForClosing(tx, db(), current);
          },
        });
        await store.commitCurrent(ref, async (tx) => {
          const captured = await tx.get(db().collection(SERMON_DELETION_MIRROR_PLANS).doc(plan.planId));
          if (captured.get('state') !== 'completed') fail('PUBLISHING_DRIFT');
          const settlement = plan.operation
            ? await prepareProviderMutationPlanCommit(tx, {
                operation: plan.operation,
                validateSourceCompletion: (transaction, _session, seal) =>
                  validateSermonDeletionCompletion(transaction, db(), plan, seal),
              })
            : undefined;
          if (settlement?.alreadyCommitted) return;
          const verifications = captured.get('verifications') as FrozenProviderVerification[];
          const indexSettlements = [];
          for (const target of verifications)
            indexSettlements.push(
              await prepareDesiredProviderDeletionSettlement(tx, db(), {
                resource: {
                  projectId: ref.projectId,
                  provider: target.provider,
                  account: target.provider === 'subsplash' ? 'app:9XTSHD' : 'configured-account',
                  remoteId: target.resourceId,
                },
                jobId: ref.jobId,
                resourceType: target.provider === 'subsplash' ? 'media' : 'track',
              })
            );
          for (const commit of indexSettlements) commit();
          settlement?.commit();
        });
      } else
        await store.commitCurrent(ref, async (tx) => {
          const existing = await tx.get(sermonRef(intent));
          if (!existing.exists) return;
          if (intent.action === 'update') {
            await assertPublishingContentUpdateAllocationsSettled(tx, db(), { ref, sermonId: intent.sermonId });
            await assertPublishingMetadataCheckpoint(tx, db(), ref, intent, existing.data()!);
          }
          {
            if (intent.action === 'update' && intent.payload.hasMembershipSelection)
              await commitPublishingUpdateMemberships(ref, intent, tx);
            const patch =
              intent.action === 'update'
                ? Object.fromEntries(
                    Object.entries(intent.payload.patch as Record<string, unknown>).map(([field, value]) => [
                      field,
                      value === null ? FieldValue.delete() : value,
                    ])
                  )
                : {};
            const measuredDuration = existing.data()?.audioArtifacts?.durationSeconds;
            tx.update(sermonRef(intent), {
              ...patch,
              ...(intent.payload.processAudio && typeof measuredDuration === 'number'
                ? { durationSeconds: measuredDuration }
                : {}),
              editedAtMillis: Math.max(
                Date.now(),
                (typeof existing.get('editedAtMillis') === 'number' ? existing.get('editedAtMillis') : 0) + 1
              ),
              approverId: intent.actorUid,
              publishActivity: FieldValue.delete(),
            });
          }
        });
      if (intent.action === 'unpublish' || intent.action === 'update')
        await settlePublishingDeletionReceipts(db(), ref, { commitCurrent: store.commitCurrent });
      await releaseCanonicalProviderBindingsForCurrentJob();
      await store.releaseAudio(ref);
    },
    async cancelEffects(ref, intent) {
      const unresolved = (
        await abortProvablyUnsentProviderMutationSessionsForJob(db(), ref, (mutate) =>
          runDurableTransaction(db(), mutate)
        )
      ).find((session) => session.state === 'active');
      if (unresolved)
        return {
          state: 'blocked',
          code: 'PUBLISHING_CANCEL_MUTATION_REVIEW_REQUIRED',
          mutationSessionId: unresolved.sessionId,
        };
      await abortCancelledDesiredProviderDeletions(db(), ref, store);
      const deletion = await reconcilePublishingDeletionCheckpoints(ref, intent, {
        assertCurrent: (current) => store.assertCurrent(current, intent),
        commitCurrent: store.commitCurrent,
      });
      if (deletion.state !== 'completed') return deletion;
      const result = await cancelPublishingEffects(ref, intent, {
        assertCurrent: (current) => store.assertCurrent(current, intent),
        commitCurrent: store.commitCurrent,
      });
      if (result.state === 'completed') await settleCancelledPublishingAllocations(db(), store, ref);
      return result;
    },
    async reconcile(_ref, intent) {
      const token = await authenticateSubsplash();
      for (const listId of intent.destinations.listIds) {
        const state = await auditPublishedListDrift(listId, token);
        // Auditing never silently imports/deletes remote-only content.
        if (!state.inSync) fail('PUBLISHING_DRIFT');
      }
    },
  };
  return dependencies;
}
