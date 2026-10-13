import { providerMutationFingerprint } from '../temporal/publishing/providerMutationGuard';
import {
  validateSermonDeletionPartialStopOperation,
  validateSermonDeletionPartialStopRead,
  runSermonDeletionPartialStop,
  type SermonDeletionPartialStopDependencies,
  type SermonDeletionPartialStopOperation,
} from './sermonDeletionPartialStop';
import type { Firestore, Transaction } from 'firebase-admin/firestore';

const operation: SermonDeletionPartialStopOperation = {
  kind: 'sermon_deletion_partial_stop',
  planId: providerMutationFingerprint('plan'),
  sessionId: providerMutationFingerprint('session'),
};
const ref = { projectId: 'urm-app', jobId: 'delete-job' };

describe('sermon deletion partial stop authority boundaries', () => {
  test('accepts only the exact opaque source operation, without caller supplied mutation instructions', () => {
    expect(validateSermonDeletionPartialStopOperation(operation)).toBe(true);
    for (const input of [
      { ...operation, planId: 'unreviewed' },
      { ...operation, sessionId: 'foreign/session' },
      { ...operation, kind: 'provider_delete' },
      { ...operation, httpMethod: 'DELETE' },
      { ...operation, grant: { approved: true } },
    ])
      expect(validateSermonDeletionPartialStopOperation(input)).toBe(false);
  });
  test('a malformed operation cannot enter source reads or dispatch any provider work', async () => {
    const commitCurrent = jest.fn(),
      readProvider = jest.fn(),
      authorizeRead = jest.fn();
    const deps = {
      commitCurrent,
      readProvider,
      authorizeRead,
      prepareUnclaimedReservationDisposition: jest.fn(),
    } as unknown as SermonDeletionPartialStopDependencies;
    await expect(runSermonDeletionPartialStop(ref, { ...operation, planId: 'tampered' }, deps)).rejects.toMatchObject({
      code: 'SERMON_DELETION_PARTIAL_STOP_PROOF_REQUIRED',
    });
    expect(commitCurrent).not.toHaveBeenCalled();
    expect(readProvider).not.toHaveBeenCalled();
    expect(authorizeRead).not.toHaveBeenCalled();
  });
  test('read authority never accepts a mutable request, even for the exact certified resource', async () => {
    const get = jest.fn(),
      tx = { get } as unknown as Transaction,
      db = { doc: jest.fn() } as unknown as Firestore;
    await expect(
      validateSermonDeletionPartialStopRead(tx, db, ref, operation, {
        provider: 'subsplash',
        resourceType: 'media',
        resourceId: 'original-media',
        accountId: 'app:9XTSHD',
        method: 'DELETE' as never,
      })
    ).rejects.toMatchObject({ code: 'SERMON_DELETION_PARTIAL_STOP_PROOF_REQUIRED' });
    expect(get).not.toHaveBeenCalled();
    expect(db.doc).not.toHaveBeenCalled();
  });
  test('missing unclaimed-reservation disposition authority fails before factual projection', async () => {
    const commitCurrent = jest.fn();
    const deps = {
      commitCurrent,
      authorizeRead: jest.fn(),
      readProvider: jest.fn(),
    } as unknown as SermonDeletionPartialStopDependencies;
    await expect(runSermonDeletionPartialStop(ref, operation, deps)).rejects.toMatchObject({
      code: 'SERMON_DELETION_PARTIAL_STOP_PROOF_REQUIRED',
    });
    expect(commitCurrent).not.toHaveBeenCalled();
  });
});
