import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { CallableRequest } from 'firebase-functions/v2/https';
import { claimInviteHandler } from '../../invites/claimInvite';
import { createInviteHandler } from '../../invites/createInvite';
import { ClaimInviteInputType, CreateInviteInputType, InviteClaimStatus, ROLE_INVITES_COLLECTION } from '../../invites/inviteTypes';

jest.setTimeout(45_000);

const firestore = firebaseAdmin.firestore();
const auth = firebaseAdmin.auth();

const clearCollection = async (collectionName: string): Promise<void> => {
  const snapshot = await firestore.collection(collectionName).get();
  if (snapshot.empty) {
    return;
  }

  const batch = firestore.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
};

const clearAuthUsers = async (): Promise<void> => {
  let pageToken: string | undefined;
  do {
    const listedUsers = await auth.listUsers(1000, pageToken);
    await Promise.all(listedUsers.users.map((user) => auth.deleteUser(user.uid)));
    pageToken = listedUsers.pageToken;
  } while (pageToken);
};

const buildCreateInviteRequest = (
  data: CreateInviteInputType,
  authContext: { uid: string; token: { role?: string; email?: string } }
): CallableRequest<CreateInviteInputType> =>
  ({
    data,
    auth: authContext,
  }) as unknown as CallableRequest<CreateInviteInputType>;

const buildClaimInviteRequest = (
  data: ClaimInviteInputType,
  authContext?: { uid: string; token: { role?: string; email?: string } }
): CallableRequest<ClaimInviteInputType> =>
  ({
    data,
    auth: authContext,
  }) as unknown as CallableRequest<ClaimInviteInputType>;

const issueInvite = async (email: string, role: string): Promise<{ inviteId: string; token: string }> => {
  const createdInvite = await createInviteHandler(
    buildCreateInviteRequest(
      { email, role: role as CreateInviteInputType['role'] },
      { uid: 'admin-1', token: { role: 'admin', email: 'admin@example.org' } }
    )
  );

  if (createdInvite.status !== 'success') {
    throw new Error(createdInvite.error);
  }

  const inviteUrl = new URL(createdInvite.data.inviteUrl, 'https://example.test');
  const token = inviteUrl.searchParams.get('token');
  if (!token) {
    throw new Error('Invite URL did not include token parameter.');
  }

  return {
    inviteId: createdInvite.data.inviteId,
    token,
  };
};

describe('claimInvite', () => {
  beforeEach(async () => {
    await clearCollection(ROLE_INVITES_COLLECTION);
    await clearCollection('mail');
    await clearAuthUsers();
  });

  it('rejects unauthenticated claim attempts', async () => {
    const { token } = await issueInvite('invitee@example.org', 'user');

    const response = await claimInviteHandler(buildClaimInviteRequest({ token }));

    expect(response).toEqual({
      status: 'error',
      error: 'Unauthorized.',
    });
  });

  it('rejects claim when authenticated email does not match invited email', async () => {
    const { token, inviteId } = await issueInvite('target@example.org', 'uploader');
    await auth.createUser({ uid: 'user-mismatch', email: 'other@example.org' });

    const response = await claimInviteHandler(
      buildClaimInviteRequest(
        { token },
        { uid: 'user-mismatch', token: { role: 'user', email: 'other@example.org' } }
      )
    );

    expect(response.status).toBe('error');
    if (response.status !== 'error') {
      throw new Error('Expected mismatch claim to fail.');
    }
    expect(response.error).toContain('does not match');

    const inviteSnapshot = await firestore.collection(ROLE_INVITES_COLLECTION).doc(inviteId).get();
    expect(inviteSnapshot.data()?.claimStatus).toBe(InviteClaimStatus.PENDING);
  });

  it('rejects expired invites', async () => {
    const { token, inviteId } = await issueInvite('expired@example.org', 'uploader');
    await auth.createUser({ uid: 'expired-user', email: 'expired@example.org' });

    await firestore.collection(ROLE_INVITES_COLLECTION).doc(inviteId).update({
      expiresAtMs: Date.now() - 1,
    });

    const response = await claimInviteHandler(
      buildClaimInviteRequest(
        { token },
        { uid: 'expired-user', token: { role: 'user', email: 'expired@example.org' } }
      )
    );

    expect(response).toEqual({
      status: 'error',
      error: 'Invite has expired.',
    });
  });

  it('rejects revoked invites', async () => {
    const { token, inviteId } = await issueInvite('revoked@example.org', 'uploader');
    await auth.createUser({ uid: 'revoked-user', email: 'revoked@example.org' });

    await firestore.collection(ROLE_INVITES_COLLECTION).doc(inviteId).update({
      revokedAtMs: Date.now(),
      revokedByUid: 'admin-1',
      revokedByEmail: 'admin@example.org',
    });

    const response = await claimInviteHandler(
      buildClaimInviteRequest(
        { token },
        { uid: 'revoked-user', token: { role: 'user', email: 'revoked@example.org' } }
      )
    );

    expect(response).toEqual({
      status: 'error',
      error: 'Invite has been revoked.',
    });
  });

  it('consumes invite once, applies invite role exactly, and revokes refresh tokens', async () => {
    await auth.createUser({ uid: 'upgrade-user', email: 'upgrade@example.org' });
    await auth.setCustomUserClaims('upgrade-user', { role: 'user', source: 'existing-claim' });

    const { token: upgradeToken, inviteId: upgradeInviteId } = await issueInvite('upgrade@example.org', 'publisher');
    const revokeSpy = jest.spyOn(auth, 'revokeRefreshTokens');

    const upgradeResponse = await claimInviteHandler(
      buildClaimInviteRequest(
        { token: upgradeToken },
        { uid: 'upgrade-user', token: { role: 'user', email: 'upgrade@example.org' } }
      )
    );

    expect(upgradeResponse.status).toBe('success');
    if (upgradeResponse.status !== 'success') {
      throw new Error(upgradeResponse.error);
    }
    expect(upgradeResponse.data.effectiveRole).toBe('publisher');
    expect(revokeSpy).toHaveBeenCalledWith('upgrade-user');

    const upgradedUser = await auth.getUser('upgrade-user');
    expect(upgradedUser.customClaims).toMatchObject({
      role: 'publisher',
      source: 'existing-claim',
    });

    const consumedInvite = await firestore.collection(ROLE_INVITES_COLLECTION).doc(upgradeInviteId).get();
    expect(consumedInvite.data()?.claimStatus).toBe(InviteClaimStatus.COMPLETE);

    const duplicateResponse = await claimInviteHandler(
      buildClaimInviteRequest(
        { token: upgradeToken },
        { uid: 'upgrade-user', token: { role: 'publisher', email: 'upgrade@example.org' } }
      )
    );
    expect(duplicateResponse.status).toBe('success');
    if (duplicateResponse.status !== 'success') {
      throw new Error(duplicateResponse.error);
    }
    expect(duplicateResponse.data).toMatchObject({
      inviteId: upgradeInviteId,
      invitedEmail: 'upgrade@example.org',
      invitedRole: 'publisher',
      effectiveRole: 'publisher',
      claimStatus: InviteClaimStatus.COMPLETE,
    });

    await auth.createUser({ uid: 'admin-user', email: 'admin-user@example.org' });
    await auth.setCustomUserClaims('admin-user', { role: 'admin', retain: true });

    const { token: downgradeToken } = await issueInvite('admin-user@example.org', 'user');
    const downgradeResponse = await claimInviteHandler(
      buildClaimInviteRequest(
        { token: downgradeToken },
        { uid: 'admin-user', token: { role: 'admin', email: 'admin-user@example.org' } }
      )
    );

    expect(downgradeResponse.status).toBe('success');
    if (downgradeResponse.status !== 'success') {
      throw new Error(downgradeResponse.error);
    }
    expect(downgradeResponse.data.effectiveRole).toBe('user');

    const adminUser = await auth.getUser('admin-user');
    expect(adminUser.customClaims).toMatchObject({
      role: 'user',
      retain: true,
    });

    revokeSpy.mockRestore();
  });
});
