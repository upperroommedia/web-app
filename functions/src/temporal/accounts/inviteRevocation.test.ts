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
jest.mock('../../temporal/releaseControl', () => ({
  assertLegacyAdmissionInTransaction: jest.fn(),
  assertAdmissionReleaseInTransaction: jest.fn(),
}));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({ __esModule: true, default: { firestore: jest.fn() } }));
jest.mock('../../handleError', () => ({ __esModule: true, default: jest.fn() }));
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { revokeInviteHandler } from '../../invites/revokeInvite';
import { InviteClaimStatus } from '../../invites/inviteTypes';
import type { RevokeInviteInputType } from '../../invites/inviteTypes';

describe('invitation revocation versus claims', () => {
  let original: Record<string, unknown>;
  let fresh: Record<string, unknown>;
  let jobState: string;
  let update: jest.Mock;
  const request = {
    data: { inviteId: 'invite1' },
    auth: { uid: 'admin1', token: { role: 'admin', email: 'admin@example.test' } },
  } as unknown as CallableRequest<RevokeInviteInputType>;
  beforeEach(() => {
    original = { claimStatus: InviteClaimStatus.ROLE_PENDING, expiresAtMs: Date.now() + 60_000, temporalJobId: 'job1' };
    fresh = { ...original };
    jobState = 'running';
    update = jest.fn();
    const snapshot = (value: Record<string, unknown>) => ({ exists: true, data: () => value });
    (firebaseAdmin.firestore as unknown as jest.Mock).mockReturnValue({
      collection: (name: string) => ({ doc: () => ({ name, get: async () => snapshot(original) }) }),
      runTransaction: async (run: (tx: unknown) => unknown) =>
        run({
          get: async (target: { name: string }) =>
            target.name === 'durableJobs' ? { get: () => jobState } : snapshot(fresh),
          update,
        }),
    });
  });
  it('refuses to revoke while the irreversible claim operation is active', async () => {
    expect(await revokeInviteHandler(request)).toMatchObject({
      status: 'error',
      error: 'Invite claim is in progress. Wait for it to complete before changing access.',
    });
    expect(update).not.toHaveBeenCalled();
  });
  it('rechecks completion inside the revocation transaction', async () => {
    fresh.claimStatus = InviteClaimStatus.COMPLETE;
    expect(await revokeInviteHandler(request)).toMatchObject({
      status: 'error',
      error: 'Claimed invites cannot be revoked.',
    });
    expect(update).not.toHaveBeenCalled();
  });
  it('allows revocation after an unapplied queued claim was cancelled', async () => {
    jobState = 'cancelled';
    expect(await revokeInviteHandler(request)).toMatchObject({ status: 'success' });
    expect(update).toHaveBeenCalledTimes(1);
  });
  it('requires an explicit role change if the grant was already applied', async () => {
    jobState = 'failed';
    fresh.temporalClaimsAppliedJobId = 'job1';
    expect(await revokeInviteHandler(request)).toMatchObject({
      status: 'error',
      error: 'The invited role has already been applied. Change the user role instead.',
    });
    expect(update).not.toHaveBeenCalled();
  });
});
