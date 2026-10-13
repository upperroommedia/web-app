import { assertAdmissionReleaseInTransaction, assertLegacyAdmissionInTransaction } from './releaseControl';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
const firestore = { doc: jest.fn((path: string) => ({ path })) } as unknown as Firestore;
const transaction = (data?: Record<string, unknown>) =>
  ({ get: jest.fn().mockResolvedValue({ exists: !!data, data: () => data }) } as unknown as Transaction);
const control = (owner: 'legacy' | 'temporal', admission: 'open' | 'paused' = 'open') => ({
  schemaVersion: 1,
  revision: 1,
  admission,
  domains: { media: { owner, admission: 'open' } },
  updatedAt: 1,
  releaseId: 'test',
});
describe('release ownership and admission pause', () => {
  it('freezes even legacy continuations while the same release provider index is being built', async () => {
    const tx = transaction(control('legacy', 'paused'));
    (tx.get as jest.Mock)
      .mockResolvedValueOnce({ exists: true, data: () => control('legacy', 'paused') })
      .mockResolvedValueOnce({ exists: true, data: () => ({ releaseId: 'test', status: 'building' }) });
    await expect(
      assertLegacyAdmissionInTransaction(tx, firestore, 'media', { continuation: true })
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('requires explicit Temporal ownership even with runtime flags enabled', async () => {
    await expect(assertAdmissionReleaseInTransaction(transaction(), firestore, 'upload.create')).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    await expect(
      assertAdmissionReleaseInTransaction(transaction(control('legacy')), firestore, 'upload.create')
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
  it('pauses new Temporal work while allowing admitted child continuations', async () => {
    await expect(
      assertAdmissionReleaseInTransaction(transaction(control('temporal', 'paused')), firestore, 'audio.process')
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(
      assertAdmissionReleaseInTransaction(transaction(control('temporal', 'paused')), firestore, 'audio.process', {
        continuation: true,
      })
    ).resolves.toBeUndefined();
  });
  it('does not permit a continuation to cross an ownership rollback', async () => {
    await expect(
      assertAdmissionReleaseInTransaction(transaction(control('legacy', 'paused')), firestore, 'audio.process', {
        continuation: true,
      })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
  it('preserves legacy compatibility before release control exists', async () => {
    await expect(assertLegacyAdmissionInTransaction(transaction(), firestore, 'media')).resolves.toBeUndefined();
    await expect(
      assertLegacyAdmissionInTransaction(transaction(control('legacy')), firestore, 'media')
    ).resolves.toBeUndefined();
  });
  it('stops stale legacy backend revisions when ownership moves to Temporal', async () => {
    await expect(
      assertLegacyAdmissionInTransaction(transaction(control('temporal')), firestore, 'media')
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
  it('permits already-admitted legacy work to drain during a pause', async () => {
    await expect(
      assertLegacyAdmissionInTransaction(transaction(control('legacy', 'paused')), firestore, 'media')
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(
      assertLegacyAdmissionInTransaction(transaction(control('legacy', 'paused')), firestore, 'media', {
        continuation: true,
      })
    ).resolves.toBeUndefined();
  });
});
