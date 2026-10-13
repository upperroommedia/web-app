jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), log: jest.fn(), debug: jest.fn() },
}));
jest.mock('firebase-functions/v2/https', () => ({
  onCall: (options: unknown, handler?: unknown) => handler ?? options,
  HttpsError: class extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({ __esModule: true, default: { firestore: jest.fn() } }));
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { queueEmail } from '../../notifications/queueEmail';

describe('deterministic notification outbox', () => {
  it('reuses a mail ID without resetting a delivered message', async () => {
    const records = new Map<string, unknown>();
    const create = jest.fn((target: { id: string }, value: unknown) => {
      records.set(target.id, value);
    });
    const collection = { doc: (id: string) => ({ id }), add: jest.fn(async () => ({ id: 'legacy' })) };
    (firebaseAdmin.firestore as unknown as jest.Mock).mockReturnValue({
      collection: () => collection,
      runTransaction: async (run: (tx: unknown) => Promise<void>) =>
        run({ get: async (target: { id: string }) => ({ exists: records.has(target.id) }), create }),
    });
    const input = {
      to: ['user@example.test'],
      source: 'role-request' as const,
      alertType: 'accepted',
      idempotencyKey: 'account:job:notification',
      message: { subject: 'Accepted', text: 'Private body' },
    };
    const first = await queueEmail(input);
    records.set(first, { delivery: { state: 'SUCCESS' } });
    expect(await queueEmail(input)).toBe(first);
    expect(first).toMatch(/^notification-[a-f0-9]{64}$/);
    expect(create).toHaveBeenCalledTimes(1);
    expect(records.get(first)).toEqual({ delivery: { state: 'SUCCESS' } });
    expect(collection.add).not.toHaveBeenCalled();
  });
  it('preserves legacy random-ID enqueue callers', async () => {
    const add = jest.fn(async () => ({ id: 'legacy-mail' }));
    (firebaseAdmin.firestore as unknown as jest.Mock).mockReturnValue({ collection: () => ({ add }) });
    expect(
      await queueEmail({
        to: ['user@example.test'],
        source: 'runtime-alert',
        alertType: 'error',
        message: { subject: 'Alert' },
      })
    ).toBe('legacy-mail');
    expect(add).toHaveBeenCalledTimes(1);
  });
});
