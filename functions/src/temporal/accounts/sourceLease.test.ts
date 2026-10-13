jest.mock('firebase-functions/v2', () => ({
  logger: { debug: jest.fn(), error: jest.fn() },
  https: { onCall: (callback: unknown) => callback },
}));
jest.mock('firebase-functions/v2/https', () => ({
  HttpsError: class extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { auth: jest.fn(), firestore: jest.fn() },
}));
jest.mock('../../handleError', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../legacyAdmissionLease', () => ({ withLegacyAdmissionLease: jest.fn() }));
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { setUserRoleHandler } from '../../setUserRole';
import type { SetUserRoleInputType } from '../../setUserRole';
import { withLegacyAdmissionLease } from '../legacyAdmissionLease';
import type { LegacyAdmissionLease } from '../legacyAdmissionLease';
import { withLegacyAccountSource } from './sourceAdmission';

describe('legacy account effect acknowledgement', () => {
  const request = {
    data: { uid: 'recipient1', role: 'publisher' },
    auth: { uid: 'admin1', token: { role: 'admin' } },
  } as unknown as CallableRequest<SetUserRoleInputType>;
  const originalFlag = process.env.TASK_ORCHESTRATOR_ACCOUNTS;
  afterAll(() => {
    if (originalFlag === undefined) delete process.env.TASK_ORCHESTRATOR_ACCOUNTS;
    else process.env.TASK_ORCHESTRATOR_ACCOUNTS = originalFlag;
  });
  let events: string[];
  let grant: jest.Mock;
  let revoke: jest.Mock;
  let lease: LegacyAdmissionLease;
  beforeEach(() => {
    delete process.env.TASK_ORCHESTRATOR_ACCOUNTS;
    events = [];
    grant = jest.fn(async () => {
      events.push('grant');
    });
    revoke = jest.fn(async () => {
      events.push('revoke');
    });
    lease = {
      leaseId: 'lease1',
      heartbeat: async () => {},
      markEffectsStarted: jest.fn(async () => {
        events.push('acknowledge');
      }),
    };
    (firebaseAdmin.auth as jest.Mock).mockReturnValue({
      getUser: async () => ({ uid: 'recipient1', customClaims: { role: 'user', unrelated: 'preserve' } }),
      setCustomUserClaims: grant,
      revokeRefreshTokens: revoke,
    });
  });
  it('awaits the durable lease acknowledgement before claims and session effects', async () => {
    expect(await setUserRoleHandler(request, lease)).toMatchObject({ status: 'success' });
    expect(events).toEqual(['acknowledge', 'grant', 'revoke']);
    expect(grant).toHaveBeenCalledWith('recipient1', { role: 'publisher', unrelated: 'preserve' });
  });
  it('never grants a role when the effect acknowledgement fails', async () => {
    (lease.markEffectsStarted as jest.Mock).mockRejectedValue(new Error('LEASE_ACK_FAILED'));
    expect(await setUserRoleHandler(request, lease)).toMatchObject({ status: 'error' });
    expect(grant).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });
  it('returned legacy errors after effects retain a review lease while preserving the response', async () => {
    revoke.mockRejectedValue(new Error('SESSION_REVOKE_FAILED'));
    let uncertain = false;
    (withLegacyAdmissionLease as jest.Mock).mockImplementation(
      async (_db, _options, callback: (value: LegacyAdmissionLease) => Promise<unknown>) => {
        try {
          return await callback(lease);
        } catch (error) {
          uncertain = events.includes('grant');
          throw error;
        }
      }
    );
    const result = await withLegacyAccountSource(firebaseAdmin.firestore(), 'admin1', 'role.assign', (value) =>
      setUserRoleHandler(request, value)
    );
    expect(result).toMatchObject({ status: 'error', error: 'SESSION_REVOKE_FAILED' });
    expect(uncertain).toBe(true);
  });
});
