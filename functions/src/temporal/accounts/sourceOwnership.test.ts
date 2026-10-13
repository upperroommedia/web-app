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
jest.mock('../../handleError', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../invites/inviteEmail', () => ({ buildInviteClaimUrl: jest.fn(), queueInviteEmail: jest.fn() }));
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { createInviteHandlerSource } from '../../invites/createInvite';
import type { CreateInviteInputType } from '../../invites/inviteTypes';
import { assertLegacyAdmissionAllowed } from '../releaseControl';

describe('legacy account source ownership', () => {
  let control: Record<string, unknown> | undefined;
  const request = {
    data: { email: 'recipient@example.test', role: 'uploader' },
    auth: { uid: 'admin1', token: { role: 'admin' } },
  } as unknown as CallableRequest<CreateInviteInputType>;
  const originalFlag = process.env.TASK_ORCHESTRATOR_ACCOUNTS;
  beforeEach(() => {
    delete process.env.TASK_ORCHESTRATOR_ACCOUNTS;
    control = {
      schemaVersion: 1,
      revision: 1,
      admission: 'open',
      domains: { accounts: { owner: 'legacy', admission: 'open' } },
    };
    (firebaseAdmin.firestore as unknown as jest.Mock).mockReturnValue({
      doc: () => ({}),
      collection: () => ({ doc: (id: string) => ({ id, path: `legacyAdmissionLeases/${id}` }) }),
      runTransaction: async (run: (tx: unknown) => Promise<unknown>) =>
        run({ get: async () => ({ exists: Boolean(control), data: () => control }) }),
    });
  });
  afterAll(() => {
    if (originalFlag === undefined) delete process.env.TASK_ORCHESTRATOR_ACCOUNTS;
    else process.env.TASK_ORCHESTRATOR_ACCOUNTS = originalFlag;
  });
  it('the current backend rejects old mutation callables in Temporal mode', async () => {
    process.env.TASK_ORCHESTRATOR_ACCOUNTS = 'temporal';
    await expect(createInviteHandlerSource(request)).rejects.toThrow('moved to the durable task service');
  });

  it('stale legacy environment flags cannot admit grants after Temporal owns accounts', async () => {
    control = { ...control, domains: { accounts: { owner: 'temporal', admission: 'open' } } };
    await expect(createInviteHandlerSource(request)).rejects.toThrow('moved to the durable task service');
  });
  it('a release pause blocks the old callable before its delegate creates an invite', async () => {
    control = { ...control, admission: 'paused' };
    await expect(createInviteHandlerSource(request)).rejects.toThrow('New tasks are paused');
  });
  it('missing control retains the pre-migration legacy owner', async () => {
    control = undefined;
    await expect(assertLegacyAdmissionAllowed(firebaseAdmin.firestore(), 'accounts')).resolves.toBeUndefined();
  });
  it('an explicit proved continuation can drain while legacy admission is paused', async () => {
    control = { ...control, admission: 'paused' };
    await expect(
      assertLegacyAdmissionAllowed(firebaseAdmin.firestore(), 'accounts', { continuation: true })
    ).resolves.toBeUndefined();
  });
});
