jest.mock('../../locks/idempotencyStore', () => ({
  claimOperation: jest.fn(),
  completeOperation: jest.fn(),
  markOperationFailed: jest.fn(),
  getOperationResult: jest.fn(),
}));
import { withIdempotency } from '../../locks/withIdempotency';
import { claimOperation, completeOperation } from '../../locks/idempotencyStore';
import { isDurablePublishingOperation, runDurablePublishingOperation } from './durableOperationContext';
describe('durable publishing idempotency boundary', () => {
  beforeEach(() => jest.clearAllMocks());
  it('uses provider receipts rather than stale legacy whole-call claims inside trusted context', async () => {
    const run = jest.fn().mockResolvedValue('confirmed');
    await expect(runDurablePublishingOperation('job', () => withIdempotency('durable:job:step', run))).resolves.toBe(
      'confirmed'
    );
    expect(claimOperation).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(isDurablePublishingOperation()).toBe(false);
  });
  it('does not allow a client-controlled key prefix to bypass legacy idempotency', async () => {
    (claimOperation as jest.Mock).mockResolvedValue({ status: 'completed', record: { result: 'existing' } });
    const run = jest.fn();
    await expect(withIdempotency('durable:fake:step', run)).resolves.toBe('existing');
    expect(run).not.toHaveBeenCalled();
    expect(claimOperation).toHaveBeenCalledWith('durable:fake:step');
  });
  it('does not leak trusted context into concurrent unrelated requests', async () => {
    const inside = runDurablePublishingOperation('job', async () => {
      await Promise.resolve();
      expect(isDurablePublishingOperation()).toBe(true);
    });
    expect(isDurablePublishingOperation()).toBe(false);
    await inside;
    expect(completeOperation).not.toHaveBeenCalled();
  });
});

import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { createDurableWriteBatch } from './durableOperationContext';

describe('durable canonical batches', () => {
  const harness = () => {
    const native = {
      set: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      create: jest.fn(),
      commit: jest.fn().mockResolvedValue(['write-time']),
    };
    const transaction = { set: jest.fn(), update: jest.fn(), delete: jest.fn(), create: jest.fn() };
    const db = { batch: () => native } as unknown as Firestore;
    return { native, transaction, db };
  };
  it('keeps native batch completion outside durable workers', async () => {
    const h = harness();
    const batch = createDurableWriteBatch(h.db);
    const ref = { path: 'lists/list' };
    batch.set(ref as never, { name: 'List' });
    await expect(batch.commit()).resolves.toEqual(['write-time']);
    expect(h.native.commit).toHaveBeenCalledTimes(1);
    expect(h.transaction.set).not.toHaveBeenCalled();
  });
  it('commits staged operations atomically with the generation fence', async () => {
    const h = harness();
    const ref = { path: 'lists/list' };
    const commit = jest.fn(async (write: (tx: Transaction) => Promise<void>) =>
      write(h.transaction as unknown as Transaction)
    );
    await runDurablePublishingOperation(
      'job',
      async () => {
        const batch = createDurableWriteBatch(h.db);
        const data = { name: 'Original', nested: { count: 1 } };
        batch.set(ref as never, data, { merge: true }).update(ref as never, { count: 2 });
        data.name = 'Changed';
        data.nested.count = 99;
        await batch.commit();
      },
      commit
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(h.transaction.set).toHaveBeenCalledWith(ref, { name: 'Original', nested: { count: 1 } }, { merge: true });
    expect(h.transaction.update).toHaveBeenCalledWith(ref, { count: 2 });
    expect(h.native.commit).not.toHaveBeenCalled();
  });
  it('does not write when a superseded generation rejects its fence', async () => {
    const h = harness();
    await expect(
      runDurablePublishingOperation(
        'job',
        async () => {
          const batch = createDurableWriteBatch(h.db);
          batch.delete({ path: 'speakers/speaker' } as never);
          await batch.commit();
        },
        async () => {
          throw new Error('superseded');
        }
      )
    ).rejects.toThrow('superseded');
    expect(h.native.commit).not.toHaveBeenCalled();
    expect(h.transaction.delete).not.toHaveBeenCalled();
  });
});

import { markPublishingCritical } from './durableOperationContext';
describe('irreversible publishing phase', () => {
  it('registers critical ownership before a desired DELETE and suppresses effects when cancellation won', async () => {
    const events: string[] = [],
      post = jest.fn(async () => events.push('delete'));
    await runDurablePublishingOperation(
      'job',
      async () => {
        await markPublishingCritical('PUBLISHING_DELETE_MEDIA');
        await post();
      },
      undefined,
      {
        markCritical: async () => {
          events.push('critical');
        },
      }
    );
    expect(events).toEqual(['critical', 'delete']);
    post.mockClear();
    await expect(
      runDurablePublishingOperation(
        'job',
        async () => {
          await markPublishingCritical('PUBLISHING_DELETE_MEDIA');
          await post();
        },
        undefined,
        {
          markCritical: async () => {
            throw new Error('Cancellation already requested');
          },
        }
      )
    ).rejects.toThrow('Cancellation already requested');
    expect(post).not.toHaveBeenCalled();
  });
  it('keeps cleanup-only authority separate and fails closed for an incomplete desired context', async () => {
    const critical = jest.fn();
    await runDurablePublishingOperation('job', () => markPublishingCritical('PUBLISHING_DELETE_MEDIA'), undefined, {
      cancelOnly: true,
      markCritical: critical,
    });
    expect(critical).not.toHaveBeenCalled();
    await expect(
      runDurablePublishingOperation('job', () => markPublishingCritical('PUBLISHING_DELETE_MEDIA'))
    ).rejects.toThrow('PUBLISHING_CRITICAL_CONTEXT_REQUIRED');
  });
});
