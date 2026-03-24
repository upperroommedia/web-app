import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { CallableRequest } from 'firebase-functions/v2/https';
import { claimInviteHandler } from '../../invites/claimInvite';
import { createInviteHandler } from '../../invites/createInvite';
import { listInvitesHandler } from '../../invites/listInvites';
import { resendInviteHandler } from '../../invites/resendInvite';
import { revokeInviteHandler } from '../../invites/revokeInvite';
import {
  ClaimInviteInputType,
  CreateInviteInputType,
  InviteLifecycleStatus,
  ListInvitesInputType,
  ROLE_INVITES_COLLECTION,
  ResendInviteInputType,
  RevokeInviteInputType,
} from '../../invites/inviteTypes';

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

const buildListInvitesRequest = (
  data: ListInvitesInputType,
  authContext?: { uid: string; token: { role?: string; email?: string } }
): CallableRequest<ListInvitesInputType> =>
  ({
    data,
    auth: authContext,
  }) as unknown as CallableRequest<ListInvitesInputType>;

const buildRevokeInviteRequest = (
  data: RevokeInviteInputType,
  authContext?: { uid: string; token: { role?: string; email?: string } }
): CallableRequest<RevokeInviteInputType> =>
  ({
    data,
    auth: authContext,
  }) as unknown as CallableRequest<RevokeInviteInputType>;

const buildResendInviteRequest = (
  data: ResendInviteInputType,
  authContext?: { uid: string; token: { role?: string; email?: string } }
): CallableRequest<ResendInviteInputType> =>
  ({
    data,
    auth: authContext,
  }) as unknown as CallableRequest<ResendInviteInputType>;

const issueInvite = async (
  email: string,
  role: CreateInviteInputType['role']
): Promise<{ inviteId: string; token: string }> => {
  const createdInvite = await createInviteHandler(
    buildCreateInviteRequest(
      { email, role },
      { uid: 'admin-1', token: { role: 'admin', email: 'admin@example.org' } }
    )
  );

  if (createdInvite.status !== 'success') {
    throw new Error(createdInvite.error);
  }

  const inviteUrl = new URL(createdInvite.data.inviteUrl, 'https://example.test');
  const token = inviteUrl.searchParams.get('token');
  if (!token) {
    throw new Error('Missing invite token.');
  }

  return { inviteId: createdInvite.data.inviteId, token };
};

describe('invite management', () => {
  beforeEach(async () => {
    await clearCollection(ROLE_INVITES_COLLECTION);
    await clearCollection('mail');
    await clearAuthUsers();
  });

  it('lists invite lifecycle statuses with role and actions', async () => {
    const { inviteId: openInviteId } = await issueInvite('open@example.org', 'uploader');
    const { inviteId: expiredInviteId } = await issueInvite('expired@example.org', 'uploader');
    const { inviteId: claimedInviteId, token: claimToken } = await issueInvite('claimed@example.org', 'publisher');

    await firestore.collection(ROLE_INVITES_COLLECTION).doc(expiredInviteId).update({
      expiresAtMs: Date.now() - 1,
    });

    await auth.createUser({ uid: 'claimed-user', email: 'claimed@example.org' });
    const claimResult = await claimInviteHandler(
      buildClaimInviteRequest(
        { token: claimToken },
        { uid: 'claimed-user', token: { role: 'user', email: 'claimed@example.org' } }
      )
    );
    expect(claimResult.status).toBe('success');

    const response = await listInvitesHandler(
      buildListInvitesRequest({ limit: 25 }, { uid: 'admin-1', token: { role: 'admin', email: 'admin@example.org' } })
    );
    expect(response.status).toBe('success');
    if (response.status !== 'success') {
      throw new Error(response.error);
    }

    const byId = new Map(response.data.invites.map((invite) => [invite.inviteId, invite]));

    expect(byId.get(openInviteId)?.lifecycleStatus).toBe(InviteLifecycleStatus.SENT);
    expect(byId.get(openInviteId)?.invitedRole).toBe('uploader');
    expect(byId.get(openInviteId)?.canRevoke).toBe(true);

    expect(byId.get(expiredInviteId)?.lifecycleStatus).toBe(InviteLifecycleStatus.EXPIRED);
    expect(byId.get(expiredInviteId)?.canResend).toBe(true);

    expect(byId.get(claimedInviteId)?.lifecycleStatus).toBe(InviteLifecycleStatus.CLAIMED);
    expect(byId.get(claimedInviteId)?.canRevoke).toBe(false);
  });

  it('revokes open invites and blocks revoke for claimed invites', async () => {
    const { inviteId: openInviteId } = await issueInvite('revoke-open@example.org', 'uploader');
    const revokeResponse = await revokeInviteHandler(
      buildRevokeInviteRequest(
        { inviteId: openInviteId },
        { uid: 'admin-1', token: { role: 'admin', email: 'admin@example.org' } }
      )
    );
    expect(revokeResponse.status).toBe('success');

    const revokedInvite = await firestore.collection(ROLE_INVITES_COLLECTION).doc(openInviteId).get();
    expect(typeof revokedInvite.data()?.revokedAtMs).toBe('number');

    const { inviteId: claimedInviteId, token: claimToken } = await issueInvite('cannot-revoke@example.org', 'publisher');
    await auth.createUser({ uid: 'cannot-revoke-user', email: 'cannot-revoke@example.org' });
    const claimResult = await claimInviteHandler(
      buildClaimInviteRequest(
        { token: claimToken },
        { uid: 'cannot-revoke-user', token: { role: 'user', email: 'cannot-revoke@example.org' } }
      )
    );
    expect(claimResult.status).toBe('success');

    const revokeClaimedResponse = await revokeInviteHandler(
      buildRevokeInviteRequest(
        { inviteId: claimedInviteId },
        { uid: 'admin-1', token: { role: 'admin', email: 'admin@example.org' } }
      )
    );
    expect(revokeClaimedResponse).toEqual({
      status: 'error',
      error: 'Claimed invites cannot be revoked.',
    });
  });

  it('resends expired invites by creating a fresh invite and queueing new email', async () => {
    const { inviteId: oldInviteId } = await issueInvite('resend@example.org', 'uploader');
    await firestore.collection(ROLE_INVITES_COLLECTION).doc(oldInviteId).update({
      expiresAtMs: Date.now() - 1,
    });

    const response = await resendInviteHandler(
      buildResendInviteRequest(
        { inviteId: oldInviteId },
        { uid: 'admin-2', token: { role: 'admin', email: 'admin2@example.org' } }
      )
    );

    expect(response.status).toBe('success');
    if (response.status !== 'success') {
      throw new Error(response.error);
    }
    expect(response.data.resentFromInviteId).toBe(oldInviteId);
    expect(response.data.invitedEmail).toBe('resend@example.org');

    const previousInvite = await firestore.collection(ROLE_INVITES_COLLECTION).doc(oldInviteId).get();
    expect(previousInvite.data()?.resentByInviteId).toBe(response.data.inviteId);

    const newInvite = await firestore.collection(ROLE_INVITES_COLLECTION).doc(response.data.inviteId).get();
    expect(newInvite.exists).toBe(true);
    expect(newInvite.data()?.resendOfInviteId).toBe(oldInviteId);

    const mailSnapshot = await firestore.collection('mail').get();
    expect(mailSnapshot.size).toBe(2);
  });
});
