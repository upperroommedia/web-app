import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  claimOperation,
  completeOperation,
  getOperationResult,
  markOperationFailed,
} from '../../locks/idempotencyStore';
import { withIdempotency } from '../../locks/withIdempotency';

jest.setTimeout(45_000);

const firestore = firebaseAdmin.firestore();

const clearCollection = async (collectionName: string): Promise<void> => {
  const snapshot = await firestore.collection(collectionName).get();
  if (snapshot.empty) {
    return;
  }

  const batch = firestore.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
};

describe('idempotency store', () => {
  beforeEach(async () => {
    await clearCollection('subsplashOperationKeys');
  });

  it('allows first claim and returns in-progress for concurrent claim', async () => {
    const operationKey = 'op-claim-1';

    const firstClaim = await claimOperation(operationKey);
    const secondClaim = await claimOperation(operationKey);

    expect(firstClaim.status).toBe('claimed');
    expect(firstClaim.record.status).toBe('in_progress');
    expect(secondClaim.status).toBe('in_progress');
    expect(secondClaim.record.status).toBe('in_progress');
  });

  it('replays stored success payload when operation already completed', async () => {
    const operationKey = 'op-complete-1';
    const terminalResult = {
      status: 'success',
      entityId: 'series:abc123',
      updatedCount: 3,
    };

    await claimOperation(operationKey);
    await completeOperation(operationKey, terminalResult);

    const replayClaim = await claimOperation(operationKey);
    const storedRecord = await getOperationResult(operationKey);

    expect(replayClaim.status).toBe('completed');
    expect(replayClaim.record.result).toEqual(terminalResult);
    expect(storedRecord?.status).toBe('completed');
    expect(storedRecord?.result).toEqual(terminalResult);

    const replayResult = await withIdempotency(operationKey, async () => {
      throw new Error('should not execute when replaying');
    });
    expect(replayResult).toEqual(terminalResult);
  });

  it('stores failure metadata and clears stale success payload on failure', async () => {
    const operationKey = 'op-failed-1';
    const staleResult = { status: 'success', entityId: 'list:xyz' };

    await claimOperation(operationKey);
    await completeOperation(operationKey, staleResult);
    await markOperationFailed(operationKey, new Error('subsplash patch failed'));

    const failedRecord = await getOperationResult(operationKey);
    expect(failedRecord?.status).toBe('failed');
    expect(failedRecord?.result).toBeUndefined();
    expect(failedRecord?.failure?.message).toBe('subsplash patch failed');

    const retryClaim = await claimOperation(operationKey);
    expect(retryClaim.status).toBe('claimed');
    expect(retryClaim.record.status).toBe('in_progress');
  });

  it('requires non-empty operation keys in wrapper', async () => {
    await expect(withIdempotency('', async () => 'ok')).rejects.toBeInstanceOf(HttpsError);
  });
});
