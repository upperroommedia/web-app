import { assertSynchronousProviderMutationCompleted } from './providerMutationCompletion';
import { preparePublishingAllocationReplacement } from './allocationBarrier';
import axios from '../../providerSandbox/http';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { readFirebaseDownloadUrl } from '../../storageDownloadUrl';
import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { isSubsplashAudioPlayable, isSoundCloudTrackEncoded } from './providerReadiness';
import { executeProviderCreate, providerReceiptId } from './providerReceipts';
import { authenticateSubsplash, createAxiosConfig } from '../../subsplashUtils';
import { withSubsplashLocks } from '../../locks/withSubsplashLocks';
import { runWithSoundCloudAccessToken } from '../../soundcloudSecrets';
import { uploadToSoundCloudDomain } from '../../uploadToSoundCloud';
import { deletePublishingSoundCloudTrack } from './providerDeletion';
import { normalizeSoundCloudAccountId } from '../../soundcloudClient';
import type { CallableRequest } from 'firebase-functions/v2/https';
import type { Sermon } from '@upperroom/shared/types/SermonTypes';
import {
  reserveDurableProviderBindings,
  markPublishingCritical,
  beginProviderMutationPlan,
  runPublishingProviderMutation,
  prepareProviderMutationPlanCommit,
  prepareAcknowledgedProjectionPlan,
  publishingMutationRequestFingerprint,
} from './durableOperationContext';
import type { PrivatePublishingIntent, PublishingJobRef } from './types';

export const AUDIO_REPLACEMENTS_COLLECTION = 'temporalPublishingAudioReplacements';
const stop: (code: string) => never = (code) => {
  throw Object.assign(new Error(code), { code });
};
export interface AudioReplacementStore {
  assertCurrent(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<void>;
  leaseAudio(ref: PublishingJobRef, sermonId?: string, sourcePath?: string): Promise<void>;
  commitCurrent(ref: PublishingJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void>;
}
export interface AudioReplacementRecord {
  oldSoundCloudId?: string;
  oldSoundCloudAccount?: string;
  oldSubsplashAudioId?: string;
  subsplashBound?: boolean;
  soundcloudBound?: boolean;
  soundcloudCleanupComplete?: boolean;
  providerMetadata?: Record<string, string | number | boolean>;
  artworkUrl?: string;
}
const request = async <T>(actorUid: string, data: T): Promise<Pick<CallableRequest<T>, 'data' | 'auth'>> => {
  const actor = await firebaseAdmin.auth().getUser(actorUid);
  if (actor.disabled || !['admin', 'publisher'].includes(actor.customClaims?.role))
    stop('PUBLISHING_PERMISSION_CHANGED');
  return {
    data,
    auth: {
      uid: actorUid,
      rawToken: '',
      token: { ...actor.customClaims, uid: actorUid } as NonNullable<CallableRequest<T>['auth']>['token'],
    },
  };
};
const source = async (ref: PublishingJobRef, intent: PrivatePublishingIntent) => {
  const db = firebaseAdmin.firestore();
  const [sermonDoc, dependency] = await Promise.all([
    db.collection('sermons').doc(intent.sermonId).get(),
    db.collection('temporalPublishingAudioDependencies').doc(ref.jobId).get(),
  ]);
  const sermon = sermonDoc.data() as Sermon | undefined;
  const expected = dependency.get('mediaRef') as { jobId?: string; requestVersion?: string } | undefined;
  if (
    !sermon ||
    !expected?.jobId ||
    sermon.audioArtifacts?.jobId !== expected.jobId ||
    sermon.audioArtifacts.requestVersion !== expected.requestVersion
  )
    stop('PUBLISHING_AUDIO_SUPERSEDED');
  return { sermon, path: sermon.audioArtifacts.finalPath };
};
const id = (ref: PublishingJobRef, intent: PrivatePublishingIntent) => `${ref.jobId}-${intent.sermonId}`;
const operationKey = (ref: PublishingJobRef, intent: PrivatePublishingIntent) =>
  `durable:${ref.projectId}:${ref.jobId}:${intent.sermonId}:audio-replacement`;

/** Fixed remote media identity is retained; the old audio binding is never deleted. */
export async function replacePublishedSubsplashAudio(
  ref: PublishingJobRef,
  intent: PrivatePublishingIntent,
  store: AudioReplacementStore
): Promise<void> {
  const { sermon, path } = await source(ref, intent);
  if (!sermon.subsplashId) return;
  const mediaId = sermon.subsplashId;
  await request(intent.actorUid, {});
  await withSubsplashLocks([`media-item:${sermon.subsplashId}`], async () => {
    await store.assertCurrent(ref, intent);
    const db = firebaseAdmin.firestore();
    const ledger = db.collection(AUDIO_REPLACEMENTS_COLLECTION).doc(id(ref, intent));
    const token = await authenticateSubsplash();
    const mediaUrl = `https://core.subsplash.com/media/v1/media-items/${sermon.subsplashId}`;
    const getMedia = async () => {
      const config = createAxiosConfig(mediaUrl, token, 'GET');
      config.params = { include: 'audio' };
      return (await axios(config)).data;
    };
    const media = await getMedia();
    const existing = (await ledger.get()).data() as AudioReplacementRecord | undefined;
    if (existing?.subsplashBound) return;
    const previousAudioId = existing?.oldSubsplashAudioId ?? media._embedded?.audio?.id;
    if (!previousAudioId) stop('PUBLISHING_PROVIDER_REPAIR_REQUIRED');
    await store.commitCurrent(ref, async (tx) => {
      tx.set(ledger, { oldSubsplashAudioId: previousAudioId }, { merge: true });
    });
    await store.leaseAudio(ref, intent.sermonId, path);
    const audioUrl = await readFirebaseDownloadUrl(firebaseAdmin.storage().bucket().file(path));
    const title = (intent.payload.sermon as Sermon).title;
    const payload = { audioTitle: title, audioUrl, sourcePath: path };
    const op = operationKey(ref, intent);
    const audioId = await executeProviderCreate({
      operationKey: op,
      step: 'subsplash-audio',
      payload,
      execute: async () => {
        const config = createAxiosConfig('https://core.subsplash.com/files/v1/audios', token, 'POST', {
          app_key: '9XTSHD',
          title,
        });
        const created = (await axios({ ...config, skipSubsplashEdgeRetry: true } as typeof config)).data;
        if (typeof created.id !== 'string' || !created.id) stop('PUBLISHING_PROVIDER_REPAIR_REQUIRED');
        return created.id;
      },
    });
    const transcoding = await executeProviderCreate<{ id: string; status?: string }>({
      operationKey: op,
      step: 'subsplash-transcode',
      payload,
      prepare: () =>
        reserveDurableProviderBindings(
          [{ provider: 'subsplash', account: 'app:9XTSHD', remoteId: audioId }],
          `${op}:transcode-audio`,
          { targetReceiptId: providerReceiptId(op, 'subsplash-transcode') }
        ),
      execute: async () => {
        const config = createAxiosConfig('https://core.subsplash.com/transcoder/v1/jobs', token, 'POST', {
          app_key: '9XTSHD',
          file_name: audioUrl,
          _embedded: { audio: { id: audioId }, source: { id: '1c2eb938-c8a9-4be3-9ad9-6cded7e63b59' } },
        });
        return (await axios({ ...config, skipSubsplashEdgeRetry: true } as typeof config)).data;
      },
    });
    if (!transcoding.id) stop('PUBLISHING_PROVIDER_REPAIR_REQUIRED');
    const job = (
      await axios(createAxiosConfig(`https://core.subsplash.com/transcoder/v1/jobs/${transcoding.id}`, token, 'GET'))
    ).data;
    const state = String(job.status ?? '').toLowerCase();
    if (['failed', 'error', 'cancelled'].includes(state)) stop('PUBLISHING_AUDIO_TRANSCODE_FAILED');
    if (!['completed', 'complete', 'succeeded', 'success', 'finished'].includes(state))
      stop('PUBLISHING_AUDIO_PROCESSING');
    if (!(await isSubsplashAudioPlayable(audioId, token))) stop('PUBLISHING_AUDIO_PROCESSING');
    const current = await getMedia();
    const currentAudioId = current._embedded?.audio?.id;
    if (currentAudioId !== previousAudioId && currentAudioId !== audioId) stop('PUBLISHING_DRIFT');
    if (currentAudioId !== audioId)
      await reserveDurableProviderBindings(
        [{ provider: 'subsplash', account: 'app:9XTSHD', remoteId: audioId }],
        `${op}:media-audio:${sermon.subsplashId}`,
        { target: { provider: 'subsplash', kind: 'media-item', remoteId: mediaId } }
      );
    const mutationOperation = `${op}:binding`;
    await beginProviderMutationPlan({
      operation: mutationOperation,
      resources: [{ provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'media', resourceId: mediaId }],
    });
    if (currentAudioId !== audioId) {
      const patch = { app_key: '9XTSHD', _embedded: { audio: { id: audioId } } };
      await store.commitCurrent(ref, async (tx) => {
        const freeze = await prepareAcknowledgedProjectionPlan(tx, {
          operation: mutationOperation,
          uiStepIds: ['provider-audio'],
          requests: [
            {
              step: 'audio-binding',
              method: 'PATCH',
              target: { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'media', resourceId: mediaId },
              payload: patch,
              fingerprint: publishingMutationRequestFingerprint({
                method: 'PATCH',
                target: { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'media', resourceId: mediaId },
                payload: patch,
              }),
            },
          ],
          writes: [
            {
              path: ledger.path,
              expectedFields: { oldSubsplashAudioId: previousAudioId },
              patch: { subsplashBound: true, newSubsplashAudioId: audioId },
            },
          ],
          verifications: [
            {
              provider: 'subsplash',
              account: 'app:9XTSHD',
              resourceType: 'media',
              resourceId: mediaId,
              expectedProviderFields: { id: mediaId, app_key: '9XTSHD', _embedded: { audio: { id: audioId } } },
            },
          ],
        });
        freeze.commit();
      });
      if (currentAudioId !== audioId)
        await markPublishingCritical('PUBLISHING_AUDIO_BIND_CRITICAL', {
          provider: 'subsplash',
          resourceType: 'media',
          resourceId: mediaId,
          accountId: 'app:9XTSHD',
          method: 'PATCH',
          canonicalPaths: [`sermons/${intent.sermonId}`],
        });
      await runPublishingProviderMutation({
        operation: mutationOperation,
        target: { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'media', resourceId: mediaId },
        step: 'audio-binding',
        method: 'PATCH',
        payload: patch,
        send: async () => {
          const response = await axios({
            ...createAxiosConfig(mediaUrl, token, 'PATCH', patch),
            maxRedirects: 0,
            skipSubsplashEdgeRetry: true,
          } as ReturnType<typeof createAxiosConfig>);
          assertSynchronousProviderMutationCompleted(response);
          return { completion: 'acknowledged', result: { audioId } };
        },
      });
    }
    const confirmed = await getMedia();
    if (confirmed._embedded?.audio?.id !== audioId) stop('PUBLISHING_PROVIDER_REPAIR_REQUIRED');
    await store.commitCurrent(ref, async (tx) => {
      const settle = await prepareProviderMutationPlanCommit(tx, { operation: mutationOperation });
      if (settle?.alreadyCommitted) return;
      tx.set(ledger, { subsplashBound: true, newSubsplashAudioId: audioId }, { merge: true });
      settle?.commit();
    });
  });
}

/** SoundCloud does not support replacing audio through its update API. */
export async function replacePublishedSoundCloudAudio(
  ref: PublishingJobRef,
  intent: PrivatePublishingIntent,
  store: AudioReplacementStore
): Promise<void> {
  const range = intent.payload.processAudio as { soundcloudPolicy?: string };
  const db = firebaseAdmin.firestore();
  const ledger = db.collection(AUDIO_REPLACEMENTS_COLLECTION).doc(id(ref, intent));
  await withSubsplashLocks([`media-item:soundcloud:${intent.sermonId}`], async () => {
    await store.assertCurrent(ref, intent);
    const { sermon, path } = await source(ref, intent);
    const existing = (await ledger.get()).data() as AudioReplacementRecord | undefined;
    const oldId = existing?.oldSoundCloudId ?? sermon.soundCloudTrackId;
    if (!oldId) return;
    if (range.soundcloudPolicy === 'keep_existing_audio') {
      await store.commitCurrent(ref, async (tx) => {
        tx.set(
          ledger,
          {
            oldSoundCloudId: oldId,
            soundcloudPolicy: 'keep_existing_audio',
            soundcloudBound: true,
            soundcloudCleanupComplete: true,
          },
          { merge: true }
        );
      });
      return;
    }
    if (range.soundcloudPolicy !== 'recreate_track') stop('PUBLISHING_SOUNDCLOUD_DECISION_REQUIRED');
    let providerMetadata = existing?.providerMetadata;
    let artworkUrl = existing?.artworkUrl;
    let originalAccount = existing?.oldSoundCloudAccount;
    if (!providerMetadata || !originalAccount) {
      const previous = await runWithSoundCloudAccessToken(async (token) => {
        const headers = { Authorization: `OAuth ${token}`, Accept: 'application/json' };
        const me = (await axios.get('https://api.soundcloud.com/me', { headers, timeout: 30000 })).data;
        const track = (
          await axios.get(`https://api.soundcloud.com/tracks/${encodeURIComponent(oldId)}`, { headers, timeout: 30000 })
        ).data;
        const owner = normalizeSoundCloudAccountId(track.user),
          account = normalizeSoundCloudAccountId(me);
        if (!owner || owner !== account) stop('PUBLISHING_PROVIDER_REPAIR_REQUIRED');
        return { ...track, originalAccount: account };
      });
      originalAccount = previous.originalAccount;
      const fields = [
        'sharing',
        'embeddable_by',
        'purchase_url',
        'genre',
        'label_name',
        'release',
        'release_date',
        'streamable',
        'downloadable',
        'license',
        'commentable',
        'reveal_stats',
        'reveal_comments',
        'isrc',
      ];
      providerMetadata = Object.fromEntries(
        fields
          .filter((field) => ['string', 'number', 'boolean'].includes(typeof previous[field]))
          .map((field) => [field, previous[field]])
      );
      if (typeof previous.metadata_artist === 'string') providerMetadata!.artist = previous.metadata_artist;
      artworkUrl = typeof previous.artwork_url === 'string' ? previous.artwork_url : undefined;
      await store.commitCurrent(ref, async (tx) => {
        tx.set(
          ledger,
          {
            oldSoundCloudId: oldId,
            oldSoundCloudAccount: previous.originalAccount,
            providerMetadata,
            ...(artworkUrl ? { artworkUrl } : {}),
          },
          { merge: true }
        );
      });
    }
    const desired = intent.payload.sermon as Sermon;
    await request(intent.actorUid, {});
    await store.leaseAudio(ref, intent.sermonId, path);
    const result = await uploadToSoundCloudDomain(
      {
        operationKey: operationKey(ref, intent),
        audioStoragePath: path,
        title: desired.title,
        description: desired.description,
        speakers: desired.speakers.map((speaker) => speaker.name),
        tags: [desired.subtitle, ...desired.topics],
        imageSource: desired.images.find((image) => image.type === 'square')?.downloadLink ?? artworkUrl,
        providerMetadata,
      },
      { expectedProviderAccount: originalAccount }
    );
    const ready = await isSoundCloudTrackEncoded(result.soundCloudTrackId, providerMetadata?.streamable !== false);
    if (!ready) stop('PUBLISHING_AUDIO_PROCESSING');
    // The canonical swap commits to the new identity and old-resource cleanup.
    if (!originalAccount) stop('PUBLISHING_PROVIDER_REPAIR_REQUIRED');
    await markPublishingCritical('PUBLISHING_REPLACEMENT_CRITICAL', {
      provider: 'soundcloud',
      resourceType: 'track',
      resourceId: oldId,
      accountId: originalAccount,
      method: 'DELETE',
      canonicalPaths: [`sermons/${intent.sermonId}`],
    });
    await store.commitCurrent(ref, async (tx) => {
      const jobRef = db.collection('durableJobs').doc(ref.jobId),
        job = await tx.get(jobRef);
      const bindAllocation = await preparePublishingAllocationReplacement(
        tx,
        db,
        { ref, sermonId: intent.sermonId, provider: 'soundcloud', operationKey: operationKey(ref, intent) },
        oldId,
        result.soundCloudTrackId
      );
      const publication = {
        streamable: providerMetadata?.streamable !== false,
        ...(['public', 'private'].includes(String(providerMetadata?.sharing))
          ? { sharing: providerMetadata!.sharing }
          : {}),
      };
      const message = publication.streamable
        ? publication.sharing === 'private'
          ? 'Playable replacement ready. Existing private sharing was preserved.'
          : 'Playable replacement confirmed.'
        : publication.sharing === 'private'
        ? 'Encoded replacement ready. Existing private, non-streaming settings were preserved.'
        : 'Encoded replacement ready. Existing non-streaming setting was preserved.';
      if (job.exists) {
        const destinations = Array.isArray(job.get('destinations'))
          ? (job.get('destinations') as Array<{ destination: string }>)
          : [];
        tx.update(jobRef, {
          destinations: [
            ...destinations.filter((value) => value.destination !== 'soundcloud'),
            { destination: 'soundcloud', state: 'confirmed', message },
          ],
          revision: FieldValue.increment(1),
          updatedAt: Date.now(),
        });
      }
      tx.update(db.collection('sermons').doc(intent.sermonId), {
        soundCloudTrackId: result.soundCloudTrackId,
        soundCloudPublication: publication,
        soundCloudTrackUrl: result.soundCloudTrackUrl ?? FieldValue.delete(),
        'status.soundCloud': 'UPLOADED',
      });
      tx.set(ledger, { soundcloudBound: true, newSoundCloudId: result.soundCloudTrackId }, { merge: true });
      bindAllocation();
    });
    if (!existing?.soundcloudCleanupComplete && oldId !== result.soundCloudTrackId)
      await deletePublishingSoundCloudTrack(ref, intent, store, oldId);
    await store.commitCurrent(ref, async (tx) => {
      tx.set(ledger, { soundcloudCleanupComplete: true }, { merge: true });
    });
  });
}
