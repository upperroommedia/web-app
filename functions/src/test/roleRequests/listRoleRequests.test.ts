import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { CallableRequest } from 'firebase-functions/v2/https';
import { listRoleRequestsHandler } from '../../roleRequests/listRoleRequests';
import {
  ListRoleRequestsInputType,
  PersistedRoleRequestDocument,
  ROLE_REQUESTS_COLLECTION,
} from '../../roleRequests/roleRequestTypes';

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
  data: ListRoleRequestsInputType,
  auth?: { uid: string; token: { role?: string } }
): CallableRequest<ListRoleRequestsInputType> =>
  ({
    data,
    auth,
  }) as unknown as CallableRequest<ListRoleRequestsInputType>;

const createRoleRequestDocument = async (
  id: string,
  data: Partial<PersistedRoleRequestDocument> & Pick<PersistedRoleRequestDocument, 'requesterUid' | 'requesterEmail'>
): Promise<void> => {
  const createdAtMs = data.createdAtMs ?? Date.now();
  const document: PersistedRoleRequestDocument = {
    requesterUid: data.requesterUid,
    requesterEmail: data.requesterEmail,
    ...(data.requesterDisplayName ? { requesterDisplayName: data.requesterDisplayName } : {}),
    requestedRole: data.requestedRole ?? 'publisher',
    reason: data.reason ?? 'Need publish permissions.',
    status: 'pending',
    createdAtMs,
    updatedAtMs: data.updatedAtMs ?? createdAtMs,
    adminUrl: data.adminUrl ?? 'https://admin.upperroommedia.test/admin/users',
    notification: data.notification ?? { status: 'queued', attemptedAtMs: createdAtMs },
  };

  await firestore.collection(ROLE_REQUESTS_COLLECTION).doc(id).set(document);
};

describe('listRoleRequests', () => {
  beforeEach(async () => {
    await clearCollection(ROLE_REQUESTS_COLLECTION);
  });

  it('rejects unauthenticated callers', async () => {
    const response = await listRoleRequestsHandler(buildRequest({ limit: 25 }));
    expect(response).toEqual({
      status: 'error',
      error: 'Not Authorized',
    });
  });

  it('returns all requests for admins ordered by most recent first', async () => {
    await createRoleRequestDocument('r1', {
      requesterUid: 'user-1',
      requesterEmail: 'user1@example.org',
      createdAtMs: 1_000,
    });
    await createRoleRequestDocument('r2', {
      requesterUid: 'user-2',
      requesterEmail: 'user2@example.org',
      requestedRole: 'uploader',
      createdAtMs: 3_000,
      notification: { status: 'queue_failed', attemptedAtMs: 3_100 },
    });

    const response = await listRoleRequestsHandler(buildRequest({ limit: 25 }, { uid: 'admin-1', token: { role: 'admin' } }));
    expect(response.status).toBe('success');
    if (response.status !== 'success') {
      throw new Error(response.error);
    }

    expect(response.data.roleRequests).toHaveLength(2);
    expect(response.data.roleRequests[0]).toMatchObject({
      roleRequestId: 'r2',
      requesterEmail: 'user2@example.org',
      requestedRole: 'uploader',
      notificationStatus: 'queue_failed',
    });
    expect(response.data.roleRequests[1]).toMatchObject({
      roleRequestId: 'r1',
      requesterEmail: 'user1@example.org',
      requestedRole: 'publisher',
      notificationStatus: 'queued',
    });
    expect(response.data.nextPageToken).toBeUndefined();
  });

  it('returns only the authenticated user requests for non-admin callers', async () => {
    await createRoleRequestDocument('mine', {
      requesterUid: 'user-1',
      requesterEmail: 'user1@example.org',
    });
    await createRoleRequestDocument('other', {
      requesterUid: 'user-2',
      requesterEmail: 'user2@example.org',
    });

    const response = await listRoleRequestsHandler(buildRequest({ limit: 25 }, { uid: 'user-1', token: { role: 'user' } }));
    expect(response.status).toBe('success');
    if (response.status !== 'success') {
      throw new Error(response.error);
    }

    expect(response.data.roleRequests).toHaveLength(1);
    expect(response.data.roleRequests[0].roleRequestId).toBe('mine');
    expect(response.data.nextPageToken).toBeUndefined();
  });

  it('rejects non-admin callers attempting to list another user requests', async () => {
    const response = await listRoleRequestsHandler(
      buildRequest({ requesterUid: 'other-user', limit: 25 }, { uid: 'user-1', token: { role: 'user' } })
    );

    expect(response).toEqual({
      status: 'error',
      error: 'Not Authorized',
    });
  });

  it('supports paginated results with nextPageToken', async () => {
    await createRoleRequestDocument('r1', {
      requesterUid: 'user-1',
      requesterEmail: 'user1@example.org',
      createdAtMs: 1_000,
    });
    await createRoleRequestDocument('r2', {
      requesterUid: 'user-2',
      requesterEmail: 'user2@example.org',
      createdAtMs: 2_000,
    });
    await createRoleRequestDocument('r3', {
      requesterUid: 'user-3',
      requesterEmail: 'user3@example.org',
      createdAtMs: 3_000,
    });

    const firstPage = await listRoleRequestsHandler(buildRequest({ limit: 2 }, { uid: 'admin-1', token: { role: 'admin' } }));
    expect(firstPage.status).toBe('success');
    if (firstPage.status !== 'success') {
      throw new Error(firstPage.error);
    }
    expect(firstPage.data.roleRequests.map((request) => request.roleRequestId)).toEqual(['r3', 'r2']);
    expect(typeof firstPage.data.nextPageToken).toBe('string');

    const secondPage = await listRoleRequestsHandler(
      buildRequest(
        { limit: 2, pageToken: firstPage.data.nextPageToken },
        { uid: 'admin-1', token: { role: 'admin' } }
      )
    );
    expect(secondPage.status).toBe('success');
    if (secondPage.status !== 'success') {
      throw new Error(secondPage.error);
    }
    expect(secondPage.data.roleRequests.map((request) => request.roleRequestId)).toEqual(['r1']);
    expect(secondPage.data.nextPageToken).toBeUndefined();
  });

  it('rejects malformed page tokens', async () => {
    const response = await listRoleRequestsHandler(
      buildRequest({ limit: 25, pageToken: 'not-a-valid-token' }, { uid: 'admin-1', token: { role: 'admin' } })
    );

    expect(response).toEqual({
      status: 'error',
      error: 'Invalid page token.',
    });
  });
});
