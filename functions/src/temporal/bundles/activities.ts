import { randomUUID } from 'node:crypto';
import { durableEntityKey } from '../../../../packages/orchestration/src/job-store';
import { isDurableJobTerminal } from '@upperroom/contracts/temporal';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import * as configs from '@upperroom/shared/shared/bundleConfigs';
import type { BundleConfig } from '@upperroom/shared/shared/bundleConfigs';
import type { Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import { generateAndStoreBundle } from '../../utils/bundleCreationUtils';

export interface BundleIntent {
  bundleType: string;
}
export interface BundleStore {
  loadIntent<T>(ref: DurableJobRef): Promise<{ payload: T }>;
  assertCurrent(ref: DurableJobRef): Promise<void>;
  assertCurrentInTransaction(tx: Transaction, ref: DurableJobRef): Promise<{ generation: number }>;
  recordStep(ref: DurableJobRef, step: string, state: { state: 'completed' }): Promise<void>;
}
/** Only predefined configurations are allowed, never caller-supplied query paths. */
export function getDurableBundleConfig(bundleType: string): BundleConfig<unknown> {
  const config = Object.values(configs).find(
    (value) => value && typeof value === 'object' && 'bundleType' in value && value.bundleType === bundleType
  );
  if (!config) throw Object.assign(new Error('UNKNOWN_BUNDLE_TYPE'), { code: 'UNKNOWN_BUNDLE_TYPE' });
  return config as BundleConfig<unknown>;
}
export function createBundleActivities(store: BundleStore) {
  return {
    async resolveLatestBundleJob(ref: DurableJobRef): Promise<DurableJobRef | null> {
      const { payload } = await store.loadIntent<BundleIntent>(ref);
      getDurableBundleConfig(payload.bundleType);
      const key = durableEntityKey(ref.projectId, { type: 'bundle', id: payload.bundleType }, 'bundle.regenerate');
      const entity = (await firebaseAdmin.firestore().collection('durableJobEntities').doc(key).get()).data();
      if (!entity || entity.projectId !== ref.projectId || typeof entity.activeJobId !== 'string')
        throw new Error('BUNDLE_DESIRED_STATE_MISSING');
      const job = (await firebaseAdmin.firestore().collection('durableJobs').doc(entity.activeJobId).get()).data();
      if (
        !job ||
        job.projectId !== ref.projectId ||
        job.kind !== 'bundle.regenerate' ||
        job.entity?.id !== payload.bundleType
      )
        throw new Error('BUNDLE_DESIRED_STATE_INVALID');
      if (isDurableJobTerminal(job.state)) return null;
      return { jobId: entity.activeJobId, projectId: ref.projectId };
    },
    async regenerateBundle(ref: DurableJobRef): Promise<void> {
      try {
        const { payload } = await store.loadIntent<BundleIntent>(ref);
        const config = getDurableBundleConfig(payload.bundleType);
        await store.assertCurrent(ref);
        // Timed-out attempts may finish later. Each job writes only its immutable
        // artifact; the transactionally fenced pointer is the serving authority.
        const attemptOwner = randomUUID();
        const claim = firebaseAdmin.firestore().collection('_durableBundleAttempts').doc(ref.jobId);
        await firebaseAdmin.firestore().runTransaction(async (tx) => {
          await store.assertCurrentInTransaction(tx, ref);
          tx.set(claim, { owner: attemptOwner });
        });
        const storagePath = `bundles/durable/${config.bundleType}/${ref.jobId}/${attemptOwner}.bin`;
        const count = await generateAndStoreBundle({ ...config, bundlePath: storagePath }, undefined, {
          publishMetadata: false,
        });
        const publishedAt = Date.now();
        const generation = await firebaseAdmin.firestore().runTransaction(async (tx) => {
          const current = await store.assertCurrentInTransaction(tx, ref);
          const attempt = await tx.get(claim);
          if (attempt.get('owner') !== attemptOwner)
            throw Object.assign(new Error('BUNDLE_ATTEMPT_SUPERSEDED'), { code: 'STALE_GENERATION' });
          tx.set(firebaseAdmin.firestore().collection('_durableBundlePointers').doc(config.bundleType), {
            projectId: ref.projectId,
            jobId: ref.jobId,
            generation: current.generation,
            storagePath,
            count,
            publishedAt,
          });
          return current.generation;
        });
        // RTDB is a cache/projection only. A delayed old write never regresses its
        // generation; serving reads the canonical Firestore pointer above.
        await firebaseAdmin
          .database()
          .ref(config.metadataDocPath)
          .transaction((current) => {
            if (current?.generation > generation) return;
            return {
              ...current,
              generation,
              lastUpdated: publishedAt,
              [`${config.bundleType}-count`]: count,
              storagePath,
            };
          });
        await store.recordStep(ref, 'bundle', { state: 'completed' });
      } catch (error) {
        if ((error as { code?: string })?.code === 'STALE_GENERATION') return;
        throw error;
      }
    },
  };
}
