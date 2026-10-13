import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import type { Sermon } from '@upperroom/shared/types/SermonTypes';
import type { PrivatePublishingIntent } from '../../../functions/src/temporal/publishing/types';
import type { MediaReference } from './admission';
import {
  mediaArtifactId,
  prepareMediaReference,
  prepareMediaReferenceRelease,
} from '../../../packages/orchestration/src/media-artifacts';
import type { ProviderReceipt } from '../../../functions/src/temporal/publishing/providerReceipts';

export interface PublishingMediaDependencyOptions {
  firestore: Firestore;
  bucket: Bucket;
  projectId: string;
  loadIntent: (ref: DurableJobRef) => Promise<PrivatePublishingIntent>;
  /** Must recheck canonical actor permissions and publishing generation. */
  assertCurrent: (ref: DurableJobRef) => Promise<void>;
  assertCurrentInTransaction: (transaction: Transaction, ref: DurableJobRef) => Promise<unknown>;
  admitMedia: (
    payload: AddIntroOutroInputType,
    actorUid: string,
    requestId: string,
    parentJobRef: DurableJobRef
  ) => Promise<{ ref: MediaReference }>;
  verifyProviderFetchSettled?: (
    ref: DurableJobRef,
    receipts: Array<{ receiptId: string; receipt: ProviderReceipt }>
  ) => Promise<boolean>;
}

/** Parent publishing workflow receives only a reference to the atomically admitted audio dependency. */
export function createPublishingMediaDependency(options: PublishingMediaDependencyOptions) {
  return {
    prepareDeletionEffects: async (ref: DurableJobRef): Promise<void> => {
      await options.assertCurrent(ref);
      await options.firestore.runTransaction(async (transaction) => {
        await options.assertCurrentInTransaction(transaction, ref);
        transaction.set(options.firestore.collection('temporalMediaDeletionEffects').doc(ref.jobId), {
          projectId: ref.projectId,
          deletionEffectsStarted: true,
          startedAt: Date.now(),
        });
      });
    },
    clearPublishingDeletionGuard: async (ref: DurableJobRef): Promise<void> => {
      if (ref.projectId !== options.projectId) throw new Error('Deletion project mismatch.');
      const intent = await options.loadIntent(ref);
      await options.firestore.runTransaction(async (transaction) => {
        const saved = await transaction.get(
          options.firestore.collection('temporalMediaDeletionEffects').doc(ref.jobId)
        );
        const stateRef = options.firestore.collection('temporalMediaState').doc(intent.sermonId);
        const state = await transaction.get(stateRef);
        if (!saved.get('deletionEffectsStarted') && state.get('deletionParentRef.jobId') === ref.jobId)
          transaction.update(stateRef, { deletionParentRef: null });
      });
    },
    releaseDeletedSermonArtifacts: async (ref: DurableJobRef): Promise<void> => {
      await options.assertCurrent(ref);
      const intent = await options.loadIntent(ref);
      await options.firestore.runTransaction(async (transaction) => {
        await options.assertCurrentInTransaction(transaction, ref);
        const canonicalRef = options.firestore.collection('temporalMediaCanonicalRefs').doc(intent.sermonId);
        const canonical = await transaction.get(canonicalRef);
        const state = await transaction.get(options.firestore.collection('temporalMediaState').doc(intent.sermonId));
        if (state.get('deletionParentRef.jobId') !== ref.jobId || state.get('runningRef'))
          throw new Error('Media deletion has not drained.');
        const ids = canonical.get('artifactIds') as Record<string, string> | undefined;
        const writes = await Promise.all(
          Object.entries(ids ?? {}).map(([slot, artifactId]) =>
            prepareMediaReferenceRelease(transaction, options.firestore, {
              artifactId,
              projectId: ref.projectId,
              type: 'canonical',
              id: intent.sermonId,
              slot,
              releasedAt: Date.now(),
            })
          )
        );
        writes.forEach((write) => write());
        transaction.set(canonicalRef, {
          projectId: ref.projectId,
          artifactIds: {},
          deletionJobId: ref.jobId,
          releasedAt: Date.now(),
        });
      });
    },
    leasePublishingAudio: async (ref: DurableJobRef, sermonId?: string, sourcePath?: string): Promise<void> => {
      if (ref.projectId !== options.projectId) throw new Error('Publishing media project mismatch.');
      await options.assertCurrent(ref);
      const entityId = sermonId ?? (await options.loadIntent(ref)).sermonId;
      await options.firestore.runTransaction(async (transaction) => {
        await options.assertCurrentInTransaction(transaction, ref);
        // Lease the exact bytes supplied to the provider, even when canonical media advanced
        // after publishing admission. Deterministic path indexing avoids a global scan.
        let artifactId: string | undefined;
        if (sourcePath !== undefined) {
          if (sourcePath.startsWith(`workflow-audio/${entityId}/`) && !sourcePath.includes('..')) {
            artifactId = mediaArtifactId(ref.projectId, sourcePath);
          } else if (![`sermons/${entityId}`, `intro-outro-sermons/${entityId}`].includes(sourcePath)) {
            throw new Error('Publishing audio source is not an owned sermon artifact.');
          }
        } else {
          const canonical = await transaction.get(
            options.firestore.collection('temporalMediaCanonicalRefs').doc(entityId)
          );
          artifactId = canonical.get('artifactIds.final') as string | undefined;
        }
        if (!artifactId) return; // Legacy aliases are outside the indexed immutable cleanup domain.
        const attach = await prepareMediaReference(transaction, options.firestore, {
          artifactId,
          projectId: ref.projectId,
          type: 'publishing_job',
          id: ref.jobId,
          createdAt: Date.now(),
        });
        attach();
        transaction.set(
          options.firestore
            .collection('temporalMediaPublishingLeases')
            .doc(ref.jobId)
            .collection('artifacts')
            .doc(artifactId),
          {
            projectId: ref.projectId,
            artifactId,
            createdAt: Date.now(),
          }
        );
      });
    },
    releasePublishingAudio: async (ref: DurableJobRef): Promise<{ released: boolean }> => {
      if (ref.projectId !== options.projectId) throw new Error('Publishing media project mismatch.');
      const { listProviderReceiptsForJob } = await import(
        '../../../functions/src/temporal/publishing/providerReceipts'
      );
      const receipts = await listProviderReceiptsForJob(ref, options.firestore);
      if (receipts.some((value) => value.receipt.state === 'executing' || value.receipt.state === 'needs_review'))
        return { released: false };
      // Allocation acknowledgements do not prove that an asynchronous transcoder fetched the source.
      if (
        receipts.some((value) => value.receipt.step.includes('subsplash-transcode')) &&
        (!options.verifyProviderFetchSettled || !(await options.verifyProviderFetchSettled(ref, receipts)))
      )
        return { released: false };
      const refs = await options.firestore
        .collection('temporalMediaPublishingLeases')
        .doc(ref.jobId)
        .collection('artifacts')
        .limit(101)
        .get();
      if (refs.size > 100) return { released: false };
      await options.firestore.runTransaction(async (transaction) => {
        const writes = await Promise.all(
          refs.docs.map((reference) =>
            prepareMediaReferenceRelease(transaction, options.firestore, {
              artifactId: reference.id,
              projectId: ref.projectId,
              type: 'publishing_job',
              id: ref.jobId,
              releasedAt: Date.now(),
            })
          )
        );
        writes.forEach((write) => write());
      });
      return { released: true };
    },
    preparePublishingDeletion: async (ref: DurableJobRef): Promise<MediaReference | null> => {
      if (ref.projectId !== options.projectId) throw new Error('Publishing media project mismatch.');
      await options.assertCurrent(ref);
      const intent = await options.loadIntent(ref);
      if (intent.action !== 'delete') throw new Error('Invalid publishing deletion dependency.');
      return options.firestore.runTransaction(async (transaction) => {
        await options.assertCurrentInTransaction(transaction, ref);
        const stateDoc = options.firestore.collection('temporalMediaState').doc(intent.sermonId);
        const [parent, state] = await Promise.all([
          transaction.get(options.firestore.collection('durableJobs').doc(ref.jobId)),
          transaction.get(stateDoc),
        ]);
        if (['cancel_requested', 'cancelled', 'superseded', 'failed'].includes(parent.get('state')))
          throw new Error('Publishing deletion was cancelled or superseded.');
        const active = (state.get('runningRef') ?? state.get('ref')) as MediaReference | undefined;
        const job = active
          ? await transaction.get(options.firestore.collection('durableJobs').doc(active.jobId))
          : undefined;
        transaction.set(stateDoc, { deletionParentRef: ref, deletionRequestedAt: Date.now() }, { merge: true });
        return job?.exists && !['succeeded', 'failed', 'cancelled', 'superseded'].includes(job.get('state'))
          ? active!
          : null;
      });
    },
    preparePublishingAudio: async (ref: DurableJobRef): Promise<MediaReference> => {
      if (ref.projectId !== options.projectId) throw new Error('Publishing media project mismatch.');
      await options.assertCurrent(ref);
      const existingDependency = await options.firestore
        .collection('temporalPublishingAudioDependencies')
        .doc(ref.jobId)
        .get();
      if (existingDependency.exists) {
        if (existingDependency.get('projectId') !== ref.projectId)
          throw new Error('Publishing dependency project mismatch.');
        return existingDependency.get('mediaRef') as MediaReference;
      }
      const intent = await options.loadIntent(ref);
      const range = intent.payload.processAudio as { startTime?: number; duration?: number } | undefined;
      if (
        intent.action !== 'update' ||
        !range ||
        !Number.isFinite(range.startTime) ||
        (range.startTime ?? -1) < 0 ||
        !Number.isFinite(range.duration) ||
        (range.duration ?? 0) <= 0
      )
        throw new Error('Publishing audio dependency is invalid.');
      const snapshot = await options.firestore.collection('sermons').doc(intent.sermonId).get();
      if (!snapshot.exists) throw new Error('Sermon no longer exists.');
      const canonical = snapshot.data() as Sermon;
      const desired = intent.payload.sermon as Sermon;
      const patch = intent.payload.patch as Record<string, unknown> | undefined;
      const changedYouTube =
        patch &&
        Object.prototype.hasOwnProperty.call(patch, 'youtubeUrl') &&
        desired.youtubeUrl !== canonical.youtubeUrl;
      const source =
        changedYouTube && desired.youtubeUrl
          ? { youtubeUrl: desired.youtubeUrl }
          : canonical.audioArtifacts?.sourcePath
          ? { storageFilePath: canonical.audioArtifacts.sourcePath }
          : desired.youtubeUrl
          ? { youtubeUrl: desired.youtubeUrl }
          : { storageFilePath: `sermons/${intent.sermonId}` };
      const bumper = async (kind: 'intro' | 'outro') => {
        const subtitle = desired.subtitle ?? '';
        if (subtitle.includes('/') || subtitle.includes('..'))
          throw new Error('Invalid sermon subtitle for audio bumper.');
        const candidate = `${kind}s/${subtitle}_${kind}.mp3`;
        return subtitle && (await options.bucket.file(candidate).exists())[0]
          ? candidate
          : `${kind}s/default_${kind}.mp3`;
      };
      const [introUrl, outroUrl] = await Promise.all([bumper('intro'), bumper('outro')]);
      await options.assertCurrent(ref);
      const admitted = await options.admitMedia(
        { id: intent.sermonId, ...source, startTime: range.startTime!, duration: range.duration!, introUrl, outroUrl },
        intent.actorUid,
        `publishing:${ref.jobId}:audio`,
        ref
      );
      return admitted.ref;
    },
  };
}
