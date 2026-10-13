import { randomUUID } from 'node:crypto';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { claimPublishingAllocation, PUBLISHING_ALLOCATIONS } from '../../temporal/publishing/allocationBarrier';
import {
  executeProviderCreate,
  providerReceiptId,
  PROVIDER_RECEIPTS_COLLECTION,
} from '../../temporal/publishing/providerReceipts';
import { runDurablePublishingOperation } from '../../temporal/publishing/durableOperationContext';
import { withSubsplashLocks } from '../../locks/withSubsplashLocks';
import type { Transaction } from 'firebase-admin/firestore';

/** Never attach this regression to a live project or an already-running dev stack. */
beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_DATABASE_EMULATOR_HOST)
    throw new Error('Use the dedicated firebase.test.json emulator harness for allocation integration tests.');
});
it('retains shared allocation ownership after an actual durable receipt records a lost POST and its volatile lock is gone', async () => {
  const db = firebaseAdmin.firestore(),
    projectId = firebaseAdmin.app().options.projectId!,
    suffix = randomUUID(),
    sermonId = `allocation-${suffix}`,
    first = { projectId, jobId: `list-${suffix}` },
    second = { projectId, jobId: `sermon-${suffix}` };
  const input = (ref = first) => ({
    ref,
    sermonId,
    provider: 'subsplash' as const,
    operationKey: `durable:${projectId}:${ref.jobId}:${sermonId}:subsplash-create`,
  });
  const commitCurrent = async (_ref: unknown, mutate: (tx: Transaction) => Promise<void>) => db.runTransaction(mutate);
  const store = { commitCurrent },
    post = jest.fn(async () => {
      throw Object.assign(new Error('Lost response after provider accepted POST'), { code: 'ETIMEDOUT' });
    });
  const operation = input(first),
    receiptId = providerReceiptId(operation.operationKey, 'subsplash-audio');
  await db.collection('sermons').doc(sermonId).set({ title: 'Synthetic durable allocation regression' });
  try {
    await expect(
      runDurablePublishingOperation(
        first.jobId,
        () =>
          withSubsplashLocks([`media-item:${sermonId}`], async () => {
            await claimPublishingAllocation(db, store, operation);
            await executeProviderCreate({
              operationKey: operation.operationKey,
              step: 'subsplash-audio',
              payload: { title: 'Synthetic allocation' },
              execute: post,
            });
          }),
        (mutate) => commitCurrent(first, mutate)
      )
    ).rejects.toMatchObject({ details: { reason: 'PROVIDER_RESULT_AMBIGUOUS' } });
    expect((await db.collection(PROVIDER_RECEIPTS_COLLECTION).doc(receiptId).get()).get('state')).toBe('needs_review');
    // The renewable lock has been released; its disappearance does not establish provider absence.
    await expect(
      runDurablePublishingOperation(
        second.jobId,
        () =>
          withSubsplashLocks([`media-item:${sermonId}`], async () => {
            await claimPublishingAllocation(db, store, input(second));
            await executeProviderCreate({
              operationKey: input(second).operationKey,
              step: 'subsplash-audio',
              payload: { title: 'Synthetic allocation' },
              execute: post,
            });
          }),
        (mutate) => commitCurrent(second, mutate)
      )
    ).rejects.toMatchObject({
      code: 'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
      details: { blockingJobId: first.jobId },
    });
    expect(post).toHaveBeenCalledTimes(1);
    const allocations = await db.collection(PUBLISHING_ALLOCATIONS).where('ownerJobId', '==', first.jobId).get();
    expect(allocations.size).toBe(1);
    expect(allocations.docs[0].get('state')).toBe('allocating');
  } finally {
    const allocations = await db.collection(PUBLISHING_ALLOCATIONS).where('sermonId', '==', sermonId).get();
    await Promise.all([
      ...allocations.docs.map((doc) => doc.ref.delete()),
      db.collection(PROVIDER_RECEIPTS_COLLECTION).doc(receiptId).delete(),
      db.collection('sermons').doc(sermonId).delete(),
    ]);
  }
});
