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
import type { DocumentReference } from 'firebase-admin/firestore';
import { createRequestWithEmails } from '../../notifications/createRequestWithEmails';

describe('access request atomic mail outbox', () => {
  let records: Map<string, Record<string, unknown>>;
  let failMailWrite: boolean;
  const target = (id: string) => ({ id, path: `speakerRequests/${id}` } as DocumentReference);
  const snapshot = (ref: { id: string; path: string }, values: Map<string, Record<string, unknown>>) => ({
    exists: values.has(ref.path),
    id: ref.id,
    data: () => values.get(ref.path),
    get: (key: string) => values.get(ref.path)?.[key],
  });
  const input = {
    to: ['user@example.test'],
    source: 'speaker-request' as const,
    alertType: 'created',
    message: { subject: 'Received' },
  };
  beforeEach(() => {
    records = new Map([
      [
        '_control/temporalRelease',
        {
          schemaVersion: 1,
          revision: 1,
          admission: 'open',
          domains: { accounts: { owner: 'temporal', admission: 'open' } },
        },
      ],
    ]);
    failMailWrite = false;
    (firebaseAdmin.firestore as unknown as jest.Mock).mockReturnValue({
      doc: (path: string) => ({ id: path.split('/').pop(), path }),
      collection: (collection: string) => ({ doc: (id: string) => ({ id, path: `${collection}/${id}` }) }),
      runTransaction: async (operation: (tx: unknown) => Promise<unknown>) => {
        const pending = new Map(records);
        const result = await operation({
          get: async (ref: { id: string; path: string }) => snapshot(ref, pending),
          create: (ref: { path: string }, value: Record<string, unknown>) => {
            if (failMailWrite && ref.path.startsWith('mail/')) throw new Error('SIMULATED_COMMIT_FAILURE');
            pending.set(ref.path, value);
          },
          set: (ref: { path: string }, value: Record<string, unknown>) => {
            pending.set(ref.path, value);
          },
        });
        records = pending;
        return result;
      },
    });
  });
  it('commits request and both notification intents together', async () => {
    const result = await createRequestWithEmails({
      target: target('one'),
      document: { status: 'pending' },
      pendingKey: 'speaker:user1:name',
      emails: [
        { field: 'notification', input },
        { field: 'confirmationNotification', input },
      ],
    });
    expect(result.created).toBe(true);
    expect([...records.keys()].filter((path) => path.startsWith('mail/'))).toHaveLength(2);
    expect(records.get('speakerRequests/one')).toMatchObject({
      notification: { status: 'queued' },
      confirmationNotification: { status: 'queued' },
    });
  });
  it('a commit failure leaves no orphan request', async () => {
    failMailWrite = true;
    await expect(
      createRequestWithEmails({
        target: target('one'),
        document: { status: 'pending' },
        pendingKey: 'speaker:user1:name',
        emails: [{ field: 'notification', input }],
      })
    ).rejects.toThrow('SIMULATED_COMMIT_FAILURE');
    expect([...records.keys()].filter((path) => path !== '_control/temporalRelease')).toHaveLength(0);
  });
  it('a release pause prevents new request and mail writes in the same transaction', async () => {
    records.set('_control/temporalRelease', {
      schemaVersion: 1,
      revision: 2,
      admission: 'paused',
      domains: { accounts: { owner: 'temporal', admission: 'open' } },
    });
    await expect(
      createRequestWithEmails({
        target: target('one'),
        document: { status: 'pending' },
        pendingKey: 'speaker:user1:name',
        emails: [{ field: 'notification', input }],
      })
    ).rejects.toThrow('New tasks are paused');
    expect([...records.keys()].filter((path) => path !== '_control/temporalRelease')).toHaveLength(0);
  });

  it('concurrent retries reuse the pending request and its original outbox', async () => {
    const options = {
      document: { status: 'pending' },
      pendingKey: 'speaker:user1:name',
      emails: [{ field: 'notification' as const, input }],
    };
    await createRequestWithEmails({ ...options, target: target('one') });
    const second = await createRequestWithEmails({ ...options, target: target('two') });
    expect(second).toMatchObject({ created: false, id: 'one' });
    expect(records.has('speakerRequests/two')).toBe(false);
    expect([...records.keys()].filter((path) => path.startsWith('mail/'))).toHaveLength(1);
  });
});
