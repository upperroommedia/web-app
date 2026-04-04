import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import * as emitOperationalAlertModule from '../../notifications/emitOperationalAlert';
import * as queueEmailModule from '../../notifications/queueEmail';
import createSpeakerRequest from '../../speakerRequests/createSpeakerRequest';
import {
  CreateSpeakerRequestInputType,
  CreateSpeakerRequestOutputType,
  SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED,
  SPEAKER_REQUESTS_COLLECTION,
  SpeakerRequestImageAsset,
} from '../../speakerRequests/speakerRequestTypes';

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

type SpeakerRequestTestAuth = {
  uid: string;
  token?: {
    email?: string;
    name?: string;
  };
};

type SpeakerRequestTestRequest<T> = {
  auth?: SpeakerRequestTestAuth;
  data: T;
};

const createSpeakerRequestHandler = createSpeakerRequest as unknown as (
  request: SpeakerRequestTestRequest<CreateSpeakerRequestInputType>
) => Promise<CreateSpeakerRequestOutputType>;

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

const createSpeakerRequestImage = (id = 'request-image'): SpeakerRequestImageAsset => ({
  downloadLink: `https://example.com/${id}.jpg`,
  storagePath: `speaker-request-images/${id}.jpg`,
  fileName: `${id}.jpg`,
  contentType: 'image/jpeg',
});

const buildRequest = (
  overrides: Partial<SpeakerRequestTestRequest<CreateSpeakerRequestInputType>> = {}
): SpeakerRequestTestRequest<CreateSpeakerRequestInputType> => ({
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
    speakerName: 'Jane Doe',
    description: 'Known for weekly teaching.',
    image: createSpeakerRequestImage(),
    ...(overrides.data ?? {}),
  },
});

describe('createSpeakerRequest', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.ADMIN_REQUEST_RECIPIENTS = '["ops@example.org","admins@example.org"]';
    process.env.ADMIN_BASE_URL = 'https://admin.upperroommedia.test/';

    await clearCollection(SPEAKER_REQUESTS_COLLECTION);

    mockQueueEmail
      .mockResolvedValueOnce('mail-admin-1')
      .mockResolvedValueOnce('mail-requester-1');
    mockEmitOperationalAlert.mockResolvedValue(undefined);
  });

  it('rejects unauthenticated requests', async () => {
    const response = await createSpeakerRequestHandler(buildRequest({ auth: undefined }));

    expect(response).toEqual({
      status: 'error',
      error: 'Unauthorized.',
    });
    expect(mockQueueEmail).not.toHaveBeenCalled();
  });

  it('persists a new request and queues both admin and requester emails', async () => {
    const response = await createSpeakerRequestHandler(
      buildRequest({
        data: {
          speakerName: '  Jane   Doe ',
          description: '  Known   for   weekly teaching. ',
          image: createSpeakerRequestImage('jane-doe'),
        },
      })
    );

    expect(response.status).toBe('success');
    if (response.status !== 'success') {
      throw new Error('Expected successful response');
    }

    expect(response.data.requestStatus).toBe('created');
    expect(response.data.notification.status).toBe('queued');
    expect(response.data.confirmationNotification.status).toBe('queued');

    const persisted = await firestore.collection(SPEAKER_REQUESTS_COLLECTION).doc(response.data.speakerRequestId).get();
    expect(persisted.exists).toBe(true);
    expect(persisted.data()).toMatchObject({
      requesterUid: 'requester-1',
      requesterEmail: 'requester@example.org',
      requesterDisplayName: 'Requester Name',
      speakerName: 'Jane Doe',
      description: 'Known for weekly teaching.',
      status: 'pending',
      adminUrl: 'https://admin.upperroommedia.test/admin/speakers',
      notification: {
        status: 'queued',
        queueMailId: 'mail-admin-1',
      },
      confirmationNotification: {
        status: 'queued',
        queueMailId: 'mail-requester-1',
      },
    });

    expect(mockQueueEmail).toHaveBeenCalledTimes(2);
    expect(mockQueueEmail.mock.calls[0][0]).toMatchObject({
      to: ['ops@example.org', 'admins@example.org'],
      source: 'speaker-request',
      alertType: 'speaker-request-created',
      message: {
        subject: '[URM] Speaker request: Jane Doe',
      },
    });
    expect(mockQueueEmail.mock.calls[1][0]).toMatchObject({
      to: ['requester@example.org'],
      source: 'speaker-request',
      alertType: 'speaker-request-confirmation',
      message: {
        subject: 'UpperRoom Media speaker request received',
      },
    });
  });

  it('returns existing for duplicate pending speaker requests by the same requester', async () => {
    const first = await createSpeakerRequestHandler(buildRequest());
    const second = await createSpeakerRequestHandler(
      buildRequest({
        data: {
          speakerName: '  jane doe ',
          description: 'A different description should not create a duplicate.',
          image: createSpeakerRequestImage('jane-doe-2'),
        },
      })
    );

    expect(first.status).toBe('success');
    expect(second.status).toBe('success');
    if (first.status !== 'success' || second.status !== 'success') {
      throw new Error('Expected successful responses');
    }

    expect(second.data.requestStatus).toBe('existing');
    expect(second.data.speakerRequestId).toBe(first.data.speakerRequestId);
    expect(mockQueueEmail).toHaveBeenCalledTimes(2);
  });

  it('keeps persisted request when an email enqueue fails', async () => {
    mockQueueEmail.mockReset();
    mockQueueEmail
      .mockRejectedValueOnce(new Error('admin queue unavailable'))
      .mockResolvedValueOnce('mail-requester-1');

    const response = await createSpeakerRequestHandler(buildRequest());

    expect(response.status).toBe('success');
    if (response.status !== 'success') {
      throw new Error('Expected successful response');
    }

    expect(response.data.warning).toEqual({
      code: SPEAKER_REQUEST_EMAIL_ENQUEUE_FAILED,
      message: 'Speaker request persisted, but one or more emails could not be queued.',
    });
    expect(response.data.notification.status).toBe('queue_failed');
    expect(response.data.confirmationNotification.status).toBe('queued');
    expect(mockEmitOperationalAlert).toHaveBeenCalledTimes(1);
  });
});
