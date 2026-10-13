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
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { auth: jest.fn(), firestore: jest.fn() },
}));
jest.mock('../../invites/inviteEmail', () => ({
  buildInviteClaimUrl: (token: string) => `https://example.test/invite?token=${token}`,
}));
jest.mock('../../speakers/speakerMutations', () => ({
  requireTrimmedSpeakerName: jest.fn(),
  requireSquareImage: jest.fn(),
}));
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { normalizeAccountAdmission } from './admission';
import type { DurableAdmissionRequest } from '@upperroom/contracts/temporal';
import type { Transaction } from 'firebase-admin/firestore';

describe('canonical account admission', () => {
  const request: DurableAdmissionRequest = {
    requestId: 'operation1',
    kind: 'role.resolve',
    entity: { type: 'user', id: 'forged-user' },
    payload: { decision: 'accept', requestId: 'role1', role: 'admin', uid: 'forged-user' },
  };
  let actor: { uid: string; customClaims: { role: string }; disabled: boolean };
  let source: Record<string, unknown>;
  beforeEach(() => {
    actor = { uid: 'admin1', customClaims: { role: 'admin' }, disabled: false };
    source = { status: 'pending', requesterUid: 'real-user', requestedRole: 'uploader' };
    (firebaseAdmin.auth as jest.Mock).mockReturnValue({ getUser: async () => actor });
    (firebaseAdmin.firestore as unknown as jest.Mock).mockReturnValue({
      collection: () => ({ doc: (id: string) => ({ id, get: async () => ({ exists: true, data: () => source }) }) }),
    });
  });
  it('uses the source request target and role instead of forged input', async () => {
    const plan = await normalizeAccountAdmission(request, actor.uid);
    expect(plan.entity).toEqual({ type: 'user', id: 'real-user' });
    expect(plan.payload).toEqual({ action: 'role-accept', requestId: 'role1' });
  });
  it('rejects changed admin permissions before reserving any request', async () => {
    actor.customClaims.role = 'publisher';
    await expect(normalizeAccountAdmission(request, actor.uid)).rejects.toThrow('Admin authorization required.');
  });
  it('rejects concurrent accept/deny reservation', async () => {
    const plan = await normalizeAccountAdmission(request, actor.uid);
    source.temporalJobId = 'other-job';
    const update = jest.fn();
    const tx = { get: async () => ({ data: () => source }), update } as unknown as Transaction;
    await expect(plan.reserve(tx, { projectId: 'urm-app-staging', jobId: 'job1' })).rejects.toThrow(
      'Request resolution already in progress.'
    );
    expect(update).not.toHaveBeenCalled();
  });
  it('rejects elevation through a modified source role request', async () => {
    source.requestedRole = 'admin';
    await expect(normalizeAccountAdmission(request, actor.uid)).rejects.toThrow('Requested role is invalid.');
  });
  it('requires a token for invitation claims instead of accepting a supplied invite ID', async () => {
    await expect(
      normalizeAccountAdmission(
        { ...request, kind: 'invite.claim', payload: { inviteId: 'forged', claimantUid: actor.uid } },
        actor.uid
      )
    ).rejects.toThrow('Invite token is required.');
  });
});
