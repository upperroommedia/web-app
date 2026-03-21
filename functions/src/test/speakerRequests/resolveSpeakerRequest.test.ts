import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { CallableRequest } from 'firebase-functions/v2/https';
import { acceptSpeakerRequestHandler } from '../../speakerRequests/acceptSpeakerRequest';
import { denySpeakerRequestHandler } from '../../speakerRequests/denySpeakerRequest';
import * as queueSpeakerRequestOutcomeEmailModule from '../../speakerRequests/queueSpeakerRequestOutcomeEmail';
import * as speakerMutationsModule from '../../speakers/speakerMutations';
import {
  AcceptSpeakerRequestInputType,
  DenySpeakerRequestInputType,
  PersistedSpeakerRequestDocument,
  SPEAKER_REQUESTS_COLLECTION,
  SpeakerRequestImageAsset,
} from '../../speakerRequests/speakerRequestTypes';
import { ImageType } from '@upperroom/shared/types/Image';

jest.mock('../../speakerRequests/queueSpeakerRequestOutcomeEmail', () => ({
  queueSpeakerRequestOutcomeEmail: jest.fn(),
}));

jest.mock('../../speakers/speakerMutations', () => {
  const actual = jest.requireActual('../../speakers/speakerMutations');
  return {
    ...actual,
    createSpeakerMutation: jest.fn(),
  };
});

jest.setTimeout(45_000);

const firestore = firebaseAdmin.firestore();
const mockQueueOutcomeEmail =
  queueSpeakerRequestOutcomeEmailModule.queueSpeakerRequestOutcomeEmail as jest.MockedFunction<
    typeof queueSpeakerRequestOutcomeEmailModule.queueSpeakerRequestOutcomeEmail
  >;
const mockCreateSpeakerMutation = speakerMutationsModule.createSpeakerMutation as jest.MockedFunction<
  typeof speakerMutationsModule.createSpeakerMutation
>;

const createSpeakerRequestImage = (id = 'request-image'): SpeakerRequestImageAsset => ({
  downloadLink: `https://example.com/${id}.jpg`,
  storagePath: `speaker-request-images/${id}.jpg`,
  fileName: `${id}.jpg`,
  contentType: 'image/jpeg',
});

const createSquareImage = (id = 'request-image'): ImageType => ({
  id,
  type: 'square',
  size: 'large',
  width: 600,
  height: 600,
  downloadLink: `https://example.com/${id}.jpg`,
  name: id,
  dateAddedMillis: Date.now(),
});

const clearCollection = async (collectionName: string): Promise<void> => {
  const snapshot = await firestore.collection(collectionName).get();
  if (snapshot.empty) {
    return;
  }

  const batch = firestore.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
};

const createSpeakerRequestDocument = async (id: string): Promise<void> => {
  const createdAtMs = Date.now();
  const document: PersistedSpeakerRequestDocument = {
    requesterUid: 'requester-1',
    requesterEmail: 'requester@example.org',
    requesterDisplayName: 'Requester Name',
    speakerName: 'Jane Doe',
    description: 'Known for weekly teaching.',
    image: createSpeakerRequestImage(),
    status: 'pending',
    createdAtMs,
    updatedAtMs: createdAtMs,
    adminUrl: 'https://admin.upperroommedia.test/admin/speakers',
    notification: { status: 'queued', attemptedAtMs: createdAtMs },
  };

  await firestore.collection(SPEAKER_REQUESTS_COLLECTION).doc(id).set(document);
};

describe('resolveSpeakerRequest', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await clearCollection(SPEAKER_REQUESTS_COLLECTION);
    await createSpeakerRequestDocument('speaker-request-1');
    mockQueueOutcomeEmail.mockResolvedValue({
      status: 'queued',
      queueMailId: 'mail-1',
      attemptedAtMs: Date.now(),
    });
  });

  it('accepts a speaker request, creates the speaker, and persists resolution metadata', async () => {
    mockCreateSpeakerMutation.mockResolvedValue({
      status: 'success',
      speakerId: 'speaker-1',
      speaker: {
        id: 'speaker-1',
        name: 'Jane Doe',
        shortDescription: '',
        description: 'Known for weekly teaching.',
        images: [createSquareImage('speaker-1')],
        sermonCount: 0,
      },
      speakerListCreated: false,
    });

    const response = await acceptSpeakerRequestHandler({
      auth: {
        uid: 'admin-1',
        token: {
          role: 'admin',
          email: 'admin@example.org',
        },
      },
      data: {
        speakerRequestId: 'speaker-request-1',
        speaker: {
          name: 'Jane Doe',
          description: 'Known for weekly teaching.',
          images: [createSquareImage('speaker-1')],
        },
      },
    } as unknown as CallableRequest<AcceptSpeakerRequestInputType>);

    expect(response.status).toBe('success');
    if (response.status !== 'success') {
      throw new Error(response.error);
    }

    expect(mockCreateSpeakerMutation).toHaveBeenCalled();
    expect(mockQueueOutcomeEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        speakerRequestId: 'speaker-request-1',
        requesterEmail: 'requester@example.org',
        status: 'accepted',
        speakerId: 'speaker-1',
      })
    );

    const persisted = await firestore.collection(SPEAKER_REQUESTS_COLLECTION).doc('speaker-request-1').get();
    expect(persisted.data()).toMatchObject({
      status: 'accepted',
      speakerId: 'speaker-1',
      speakerNameAtResolution: 'Jane Doe',
      resolvedByUid: 'admin-1',
      resolvedByEmail: 'admin@example.org',
    });
  });

  it('denies a speaker request and stores the decline message', async () => {
    const response = await denySpeakerRequestHandler({
      auth: {
        uid: 'admin-1',
        token: {
          role: 'admin',
          email: 'admin@example.org',
        },
      },
      data: {
        speakerRequestId: 'speaker-request-1',
        message: 'Please provide more context about this speaker before we add them.',
      },
    } as unknown as CallableRequest<DenySpeakerRequestInputType>);

    expect(response.status).toBe('success');
    if (response.status !== 'success') {
      throw new Error(response.error);
    }

    expect(mockQueueOutcomeEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        speakerRequestId: 'speaker-request-1',
        requesterEmail: 'requester@example.org',
        status: 'denied',
        message: 'Please provide more context about this speaker before we add them.',
      })
    );

    const persisted = await firestore.collection(SPEAKER_REQUESTS_COLLECTION).doc('speaker-request-1').get();
    expect(persisted.data()).toMatchObject({
      status: 'denied',
      declineMessage: 'Please provide more context about this speaker before we add them.',
      resolvedByUid: 'admin-1',
      resolvedByEmail: 'admin@example.org',
    });
  });
});
