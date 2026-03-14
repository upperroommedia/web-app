import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { HttpsError } from 'firebase-functions/v2/https';
import * as lockStore from '../../locks/subsplashLockStore';
import { sortLockKeys, withSubsplashLocks } from '../../locks/withSubsplashLocks';
import * as releaseFailureSink from '../../locks/releaseFailureSink';

jest.setTimeout(45_000);

const database = firebaseAdmin.database();
const firestore = firebaseAdmin.firestore();

const clearCollection = async (collectionName: string): Promise<void> => {
  const snapshot = await firestore.collection(collectionName).get();
  if (snapshot.empty) {
    return;
  }

  const batch = firestore.batch();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });
  await batch.commit();
};

describe('subsplash lock store', () => {
  beforeEach(async () => {
    jest.restoreAllMocks();
    await database.ref('subsplashLocks').remove();
    await clearCollection('lockReleaseFailures');
  });

  it('times out waiting for an active lock after 10 seconds', async () => {
    const lockKey = 'series:timeout-check';
    await lockStore.acquireWithWait(lockKey, {
      ownerToken: 'owner-1',
      leaseTtlMs: 400,
      pollIntervalMs: 25,
    });

    const heartbeat = lockStore.startHeartbeat(lockKey, {
      ownerToken: 'owner-1',
      leaseTtlMs: 400,
      intervalMs: 100,
    });

    const startedAt = Date.now();
    let thrown: unknown;
    try {
      await lockStore.acquireWithWait(lockKey, {
        ownerToken: 'owner-2',
      });
    } catch (error) {
      thrown = error;
    } finally {
      heartbeat.stop();
      await lockStore.releaseLock(lockKey, 'owner-1').catch(() => undefined);
    }

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(9_900);
    expect(thrown).toBeInstanceOf(HttpsError);
    expect((thrown as HttpsError).details).toMatchObject({
      code: 'SUBSPLASH_LOCK_BUSY',
      locked_keys: [lockKey],
      wait_ms: 10_000,
    });
  });

  it('allows stale lock takeover after lease expiry', async () => {
    const lockKey = 'series:stale-takeover';
    await lockStore.acquireWithWait(lockKey, {
      ownerToken: 'owner-stale',
      leaseTtlMs: 250,
      pollIntervalMs: 25,
    });

    await new Promise((resolve) => setTimeout(resolve, 350));

    const reclaimed = await lockStore.acquireWithWait(lockKey, {
      ownerToken: 'owner-fresh',
      waitTimeoutMs: 2_000,
      pollIntervalMs: 25,
      leaseTtlMs: 1_000,
    });

    expect(reclaimed.ownerToken).toBe('owner-fresh');
    await lockStore.releaseLock(lockKey, 'owner-fresh');
  });

  it('uses deterministic order for multi-lock acquisition', async () => {
    expect(sortLockKeys(['media-item:z', 'series:b', 'list:a', 'series:a'])).toEqual([
      'series:a',
      'series:b',
      'list:a',
      'media-item:z',
    ]);

    const acquireSpy = jest
      .spyOn(lockStore, 'acquireWithWait')
      .mockImplementation(async (lockKey, options: lockStore.AcquireWithWaitOptions = {}) => ({
        lockKey,
        ownerToken: options.ownerToken ?? 'ordered-owner',
        leaseTtlMs: options.leaseTtlMs ?? 1_000,
        acquiredAtMs: Date.now(),
      }));
    const heartbeatStop = jest.fn();
    jest.spyOn(lockStore, 'startHeartbeat').mockReturnValue({ stop: heartbeatStop });
    jest.spyOn(lockStore, 'releaseLock').mockResolvedValue(undefined);

    await withSubsplashLocks(['media-item:z', 'series:b', 'list:a', 'series:a'], async () => true, {
      ownerToken: 'ordered-owner',
    });

    expect(acquireSpy.mock.calls.map(([lockKey]) => lockKey)).toEqual([
      'series:a',
      'series:b',
      'list:a',
      'media-item:z',
    ]);
  });

  it('records release failures in dead-letter sink and still resolves', async () => {
    jest
      .spyOn(lockStore, 'acquireWithWait')
      .mockResolvedValue({
        lockKey: 'series:release-failure',
        ownerToken: 'owner-1',
        leaseTtlMs: 1_000,
        acquiredAtMs: Date.now(),
      });
    jest.spyOn(lockStore, 'startHeartbeat').mockReturnValue({ stop: jest.fn() });
    jest.spyOn(lockStore, 'releaseLock').mockRejectedValue(new Error('release failed'));
    const deadLetterSpy = jest
      .spyOn(releaseFailureSink, 'logLockReleaseFailure')
      .mockResolvedValue(undefined);

    await expect(
      withSubsplashLocks(['series:release-failure'], async () => 'done', { ownerToken: 'owner-1' })
    ).resolves.toBe('done');

    expect(deadLetterSpy).toHaveBeenCalledTimes(1);
  });
});
