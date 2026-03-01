import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { CallableRequest } from 'firebase-functions/v2/https';
import { createInviteHandler } from '../../invites/createInvite';
import { hashInviteToken } from '../../invites/inviteToken';
import { CreateInviteInputType, INVITE_EXPIRY_MS, InviteClaimStatus, ROLE_INVITES_COLLECTION } from '../../invites/inviteTypes';

jest.setTimeout(45_000);

const firestore = firebaseAdmin.firestore();

const clearCollection = async (collectionName: string): Promise<void> => {
  const snapshot = await firestore.collection(collectionName).get();
  if (snapshot.empty) {
    return;
  }

  const batch = firestore.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
};

const buildRequest = (
  data: CreateInviteInputType,
  auth?: { uid: string; token: { role?: string; email?: string } }
): CallableRequest<CreateInviteInputType> =>
  ({
    data,
    auth,
  }) as unknown as CallableRequest<CreateInviteInputType>;

describe('createInvite', () => {
  beforeEach(async () => {
    await clearCollection(ROLE_INVITES_COLLECTION);
  });

  it('allows admins to create invites and persists only token hashes', async () => {
    const response = await createInviteHandler(
      buildRequest(
        {
          email: 'Invitee@Example.org',
          role: 'uploader',
        },
        { uid: 'admin-1', token: { role: 'admin', email: 'Admin@Example.org' } }
      )
    );

    expect(response.status).toBe('success');
    if (response.status !== 'success') {
      throw new Error(response.error);
    }

    const inviteUrl = new URL(response.data.inviteUrl, 'https://example.test');
    const rawToken = inviteUrl.searchParams.get('token');
    expect(rawToken).toBeTruthy();

    const docSnapshot = await firestore.collection(ROLE_INVITES_COLLECTION).doc(response.data.inviteId).get();
    expect(docSnapshot.exists).toBe(true);

    const written = docSnapshot.data();
    expect(written).toMatchObject({
      invitedEmail: 'invitee@example.org',
      invitedRole: 'uploader',
      createdByUid: 'admin-1',
      createdByEmail: 'admin@example.org',
      claimStatus: InviteClaimStatus.PENDING,
    });

    const hashedToken = hashInviteToken(rawToken as string);
    expect(written?.tokenHash).toBe(hashedToken);
    expect(written?.tokenHash).not.toBe(rawToken);

    expect(typeof written?.createdAtMs).toBe('number');
    expect(typeof written?.expiresAtMs).toBe('number');
    expect((written?.expiresAtMs as number) - (written?.createdAtMs as number)).toBe(INVITE_EXPIRY_MS);
  });

  it('rejects non-admin invite creation attempts', async () => {
    const response = await createInviteHandler(
      buildRequest(
        {
          email: 'invitee@example.org',
          role: 'user',
        },
        { uid: 'uploader-1', token: { role: 'uploader', email: 'uploader@example.org' } }
      )
    );

    expect(response).toEqual({
      status: 'error',
      error: 'Not Authorized',
    });
  });
});
