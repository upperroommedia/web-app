import type { Firestore, Transaction, DocumentReference } from 'firebase-admin/firestore';
import type { createDurableJobStore } from '@upperroom/orchestration/job-store';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import {
  PUBLISHING_CREATE_REVIEW_CHECKPOINTS,
  savePublishingCreateReviewCheckpoint,
  loadPublishingCreateReviewContinuation,
} from '../../../../functions/src/temporal/publishing/reviewedCreateContinuation';
/** Checkpoint capture is private metadata. Only the source loader can approve a desired stage. */
export function createReviewedCreateActivities(
  db: Firestore,
  store: Pick<ReturnType<typeof createDurableJobStore>, 'assertCurrentInTransaction' | 'assertCurrent'>,
  projectId: string
) {
  const check = (ref: DurableJobRef) => {
    if (ref.projectId !== projectId)
      throw Object.assign(new Error('Review checkpoint project mismatch'), { code: 'PROJECT_MISMATCH' });
  };
  return {
    savePublishingCreateReviewCheckpoint: async (
      ref: DurableJobRef,
      input: Parameters<typeof savePublishingCreateReviewCheckpoint>[1]
    ) => {
      check(ref);
      return savePublishingCreateReviewCheckpoint(ref, input, {
        firestore: db,
        commitCurrent: async (current, mutate) => {
          if (current.projectId !== ref.projectId || current.jobId !== ref.jobId)
            throw Object.assign(new Error('Review checkpoint scope mismatch'), { code: 'PROJECT_MISMATCH' });
          await db.runTransaction(async (tx) => {
            await store.assertCurrentInTransaction(tx, current);
            let proxy: Transaction;
            proxy = new Proxy(tx, {
              get(target, property) {
                const value = Reflect.get(target, property, target);
                if (['set', 'create', 'update', 'delete'].includes(String(property)))
                  return (reference: DocumentReference, ...args: unknown[]) => {
                    const parts = reference?.path?.split('/') ?? [];
                    if (
                      reference.firestore !== db ||
                      parts.length !== 2 ||
                      parts[0] !== PUBLISHING_CREATE_REVIEW_CHECKPOINTS ||
                      !/^[a-f0-9]{64}$/.test(parts[1])
                    )
                      throw Object.assign(new Error('Review checkpoint writer scope mismatch'), {
                        code: 'PERMISSION_CHANGED',
                      });
                    Reflect.apply(value, target, [reference, ...args]);
                    return proxy;
                  };
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
            await mutate(proxy);
          });
        },
      });
    },
    loadPublishingCreateReviewContinuation: async (ref: DurableJobRef, checkpointId: string) => {
      check(ref);
      return loadPublishingCreateReviewContinuation(ref, checkpointId, {
        firestore: db,
        assertCurrent: async (current) => {
          await store.assertCurrent(current);
        },
      });
    },
  };
}
