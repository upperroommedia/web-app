import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import * as emitOperationalAlertModule from '../../notifications/emitOperationalAlert';
import * as queueEmailModule from '../../notifications/queueEmail';
import createRoleRequest from '../../roleRequests/createRoleRequest';
import {
  CreateRoleRequestInputType,
  CreateRoleRequestOutputType,
  ROLE_REQUEST_EMAIL_ENQUEUE_FAILED,
  ROLE_REQUESTS_COLLECTION,
} from '../../roleRequests/roleRequestTypes';

jest.mock('firebase-functions/v2/https', () => {
  const actual = jest.requireActual('firebase-functions/v2/https');
  return {
    ...actual,
    onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: unknown) =>
      (typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler)
    ),
  };
});

jest.mock('../../notifications/queueEmail', () => ({
  queueEmail: jest.fn(),
}));

jest.mock('../../notifications/emitOperationalAlert', () => ({
  emitOperationalAlert: jest.fn(async () => undefined),
}));

jest.setTimeout(45_000);

type RoleRequestTestAuth = {
  uid: string;
  token?: {
    email?: string;
    name?: string;
  };
};

type RoleRequestTestRequest<T> = {
  auth?: RoleRequestTestAuth;
  data: T;
};

const createRoleRequestHandler = createRoleRequest as unknown as (
  request: RoleRequestTestRequest<CreateRoleRequestInputType>
) => Promise<CreateRoleRequestOutputType>;

const firestore = firebaseAdmin.firestore();
const mockQueueEmail = queueEmailModule.queueEmail as jest.MockedFunction<typeof queueEmailModule.queueEmail>;
const mockEmitOperationalAlert = emitOperationalAlertModule.emitOperationalAlert as jest.MockedFunction<
  typeof emitOperationalAlertModule.emitOperationalAlert
>;

const clearCollection = async (collectionName: string): Promise<void> => {
  const snapshot = await firestore.collection(collectionName).get();
  if (snapshot.empty) {
    return;
  }

  const batch = firestore.batch();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });
  await batch.commit();
};

const buildRequest = (
  overrides: Partial<RoleRequestTestRequest<CreateRoleRequestInputType>> = {}
): RoleRequestTestRequest<CreateRoleRequestInputType> => ({
  auth: Object.prototype.hasOwnProperty.call(overrides, 'auth')
    ? overrides.auth
    : {
        uid: 'requester-1',
        token: {
          email: 'Requester@Example.org',
          name: 'Requester Name',
        },
      },
  data: {
    requestedRole: 'publisher',
    reason: 'Need publish access for weekly uploads.',
    ...(overrides.data ?? {}),
  },
});

describe('createRoleRequest', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.ADMIN_REQUEST_RECIPIENTS = '["ops@example.org","admins@example.org"]';
    process.env.ADMIN_BASE_URL = 'https://admin.upperroommedia.test/';

    await clearCollection(ROLE_REQUESTS_COLLECTION);

    mockQueueEmail.mockResolvedValue('mail-1');
    mockEmitOperationalAlert.mockResolvedValue(undefined);
  });

  it('rejects unauthenticated requests', async () => {
    const response = await createRoleRequestHandler(buildRequest({ auth: undefined }));

    expect(response).toEqual({
      status: 'error',
      error: 'Unauthorized.',
    });
    expect(mockQueueEmail).not.toHaveBeenCalled();

    const snapshot = await firestore.collection(ROLE_REQUESTS_COLLECTION).get();
    expect(snapshot.empty).toBe(true);
  });

  it('validates requestable roles and required reason fields', async () => {
    const invalidRoleResponse = await createRoleRequestHandler(
      buildRequest({ data: { requestedRole: 'admin', reason: 'please' } })
    );
    const blankReasonResponse = await createRoleRequestHandler(
      buildRequest({ data: { requestedRole: 'publisher', reason: '    ' } })
    );

    expect(invalidRoleResponse).toEqual({
      status: 'error',
      error: 'Invalid requestedRole. Supported values: user, uploader, publisher',
    });
    expect(blankReasonResponse).toEqual({
      status: 'error',
      error: 'Reason is required.',
    });
    expect(mockQueueEmail).not.toHaveBeenCalled();
  });

  it('persists a new request, sanitizes reason, and enqueues a notification payload with identity metadata', async () => {
    const response = await createRoleRequestHandler(
      buildRequest({
        data: {
          requestedRole: 'publisher',
          reason: '  Need   publish   access   for Sunday uploads.  ',
        },
      })
    );

    expect(response.status).toBe('success');
    if (response.status !== 'success') {
      throw new Error('Expected successful response');
    }

    expect(response.data.requestStatus).toBe('created');
    expect(response.data.notification.status).toBe('queued');
    expect(response.data.notification.queueMailId).toBe('mail-1');

    const persisted = await firestore.collection(ROLE_REQUESTS_COLLECTION).doc(response.data.roleRequestId).get();
    expect(persisted.exists).toBe(true);

    const persistedData = persisted.data();
    expect(persistedData).toMatchObject({
      requesterUid: 'requester-1',
      requesterEmail: 'requester@example.org',
      requesterDisplayName: 'Requester Name',
      requestedRole: 'publisher',
      reason: 'Need publish access for Sunday uploads.',
      status: 'pending',
      adminUrl: 'https://admin.upperroommedia.test/admin/users',
      notification: {
        status: 'queued',
        queueMailId: 'mail-1',
      },
    });
    expect(typeof persistedData?.createdAtMs).toBe('number');
    expect(typeof persistedData?.updatedAtMs).toBe('number');

    expect(mockQueueEmail).toHaveBeenCalledTimes(1);
    const queueInput = mockQueueEmail.mock.calls[0][0];
    expect(queueInput).toMatchObject({
      to: ['ops@example.org', 'admins@example.org'],
      source: 'role-request',
      alertType: 'role-request-created',
      metadata: {
        roleRequestId: response.data.roleRequestId,
        requesterUid: 'requester-1',
        requesterEmail: 'requester@example.org',
        requestedRole: 'publisher',
        adminUrl: 'https://admin.upperroommedia.test/admin/users',
      },
      message: {
        subject: '[URM] Role request: publisher',
      },
    });
    expect(typeof queueInput.metadata?.requestedAtMs).toBe('number');
    expect(queueInput.metadata?.requestedAtMs).toBe(persistedData?.createdAtMs);
    expect(queueInput.metadata?.reason).toBe('Need publish access for Sunday uploads.');
    expect(queueInput.message.text).toContain('A new role request was submitted.');
    expect(queueInput.message.text).toContain('Requester: Requester Name <requester@example.org>');
    expect(queueInput.message.text).toContain('Requested role: publisher');
    expect(queueInput.message.text).toContain('Reason: Need publish access for Sunday uploads.');
    expect(queueInput.message.text).toContain('Review request: https://admin.upperroommedia.test/admin/users');
    expect(queueInput.message.html).toContain('New role request submitted');
    expect(queueInput.message.html).toContain('Requester Name &lt;requester@example.org&gt;');
    expect(queueInput.message.html).toContain('Review requests');
  });

  it('attempts queueing only for newly-created requests and returns existing on duplicate pending role request', async () => {
    const first = await createRoleRequestHandler(buildRequest());
    const second = await createRoleRequestHandler(
      buildRequest({
        data: {
          requestedRole: 'publisher',
          reason: 'Second reason should not create a duplicate pending request.',
        },
      })
    );

    expect(first.status).toBe('success');
    expect(second.status).toBe('success');
    if (first.status !== 'success' || second.status !== 'success') {
      throw new Error('Expected successful responses');
    }

    expect(first.data.requestStatus).toBe('created');
    expect(second.data.requestStatus).toBe('existing');
    expect(second.data.notification.status).toBe('skipped_existing');
    expect(second.data.roleRequestId).toBe(first.data.roleRequestId);

    expect(mockQueueEmail).toHaveBeenCalledTimes(1);

    const snapshot = await firestore.collection(ROLE_REQUESTS_COLLECTION).get();
    expect(snapshot.size).toBe(1);
  });

  it('keeps persisted request when queueEmail fails and emits operational alert with warning metadata', async () => {
    mockQueueEmail.mockRejectedValueOnce(new Error('mail queue unavailable'));

    const response = await createRoleRequestHandler(buildRequest());

    expect(response.status).toBe('success');
    if (response.status !== 'success') {
      throw new Error('Expected successful response');
    }

    expect(response.data.requestStatus).toBe('created');
    expect(response.data.notification.status).toBe('queue_failed');
    expect(response.data.notification.warningCode).toBe(ROLE_REQUEST_EMAIL_ENQUEUE_FAILED);
    expect(response.data.warning).toEqual({
      code: ROLE_REQUEST_EMAIL_ENQUEUE_FAILED,
      message: 'Role request persisted, but notification enqueue failed.',
    });

    const persisted = await firestore.collection(ROLE_REQUESTS_COLLECTION).doc(response.data.roleRequestId).get();
    expect(persisted.exists).toBe(true);
    expect(persisted.data()).toMatchObject({
      requesterUid: 'requester-1',
      requestedRole: 'publisher',
      status: 'pending',
      notification: {
        status: 'queue_failed',
        warningCode: ROLE_REQUEST_EMAIL_ENQUEUE_FAILED,
        queueErrorMessage: 'mail queue unavailable',
      },
    });

    expect(mockEmitOperationalAlert).toHaveBeenCalledTimes(1);
    expect(mockEmitOperationalAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertCode: ROLE_REQUEST_EMAIL_ENQUEUE_FAILED,
        summary: 'Failed to enqueue role-request notification email.',
        context: expect.objectContaining({
          functionName: 'createRoleRequest',
          roleRequestId: response.data.roleRequestId,
          requesterUid: 'requester-1',
          requesterEmail: 'requester@example.org',
          requestedRole: 'publisher',
        }),
      })
    );
  });
});
