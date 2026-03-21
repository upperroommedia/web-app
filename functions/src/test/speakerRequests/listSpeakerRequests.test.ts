import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { CallableRequest } from 'firebase-functions/v2/https';
import { listSpeakerRequestsHandler } from '../../speakerRequests/listSpeakerRequests';
import {
  ListSpeakerRequestsInputType,
  PersistedSpeakerRequestDocument,
  SPEAKER_REQUESTS_COLLECTION,
  SpeakerRequestImageAsset,
} from '../../speakerRequests/speakerRequestTypes';

jest.setTimeout(45_000);

const firestore = firebaseAdmin.firestore();

const createSpeakerRequestImage = (id: string): SpeakerRequestImageAsset => ({
  downloadLink: `https://example.com/${id}.jpg`,
  storagePath: `speaker-request-images/${id}.jpg`,
  fileName: `${id}.jpg`,
  contentType: 'image/jpeg',
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

const buildRequest = (
  data: ListSpeakerRequestsInputType,
  auth?: { uid: string; token: { role?: string } }
): CallableRequest<ListSpeakerRequestsInputType> =>
  ({
    data,
    auth,
  }) as unknown as CallableRequest<ListSpeakerRequestsInputType>;

const createSpeakerRequestDocument = async (
  id: string,
  data: Partial<PersistedSpeakerRequestDocument> & Pick<PersistedSpeakerRequestDocument, 'requesterUid' | 'requesterEmail'>
): Promise<void> => {
  const createdAtMs = data.createdAtMs ?? Date.now();
  const document: PersistedSpeakerRequestDocument = {
    requesterUid: data.requesterUid,
    requesterEmail: data.requesterEmail,
    ...(data.requesterDisplayName ? { requesterDisplayName: data.requesterDisplayName } : {}),
    speakerName: data.speakerName ?? 'Speaker Request',
    description: data.description ?? 'Speaker description',
    image: data.image ?? createSpeakerRequestImage(id),
    status: data.status ?? 'pending',
    createdAtMs,
    updatedAtMs: data.updatedAtMs ?? createdAtMs,
    adminUrl: data.adminUrl ?? 'https://admin.upperroommedia.test/admin/speakers',
    notification: data.notification ?? { status: 'queued', attemptedAtMs: createdAtMs },
    ...(data.confirmationNotification ? { confirmationNotification: data.confirmationNotification } : {}),
    ...(data.resolutionNotification ? { resolutionNotification: data.resolutionNotification } : {}),
    ...(data.resolvedAtMs ? { resolvedAtMs: data.resolvedAtMs } : {}),
    ...(data.resolvedByUid ? { resolvedByUid: data.resolvedByUid } : {}),
    ...(data.resolvedByEmail !== undefined ? { resolvedByEmail: data.resolvedByEmail } : {}),
    ...(data.declineMessage ? { declineMessage: data.declineMessage } : {}),
    ...(data.speakerId ? { speakerId: data.speakerId } : {}),
    ...(data.speakerNameAtResolution ? { speakerNameAtResolution: data.speakerNameAtResolution } : {}),
  };

  await firestore.collection(SPEAKER_REQUESTS_COLLECTION).doc(id).set(document);
};

describe('listSpeakerRequests', () => {
  beforeEach(async () => {
    await clearCollection(SPEAKER_REQUESTS_COLLECTION);
  });

  it('returns all requests for admins ordered by most recent first', async () => {
    await createSpeakerRequestDocument('s1', {
      requesterUid: 'user-1',
      requesterEmail: 'user1@example.org',
      createdAtMs: 1_000,
    });
    await createSpeakerRequestDocument('s2', {
      requesterUid: 'user-2',
      requesterEmail: 'user2@example.org',
      speakerName: 'Speaker Two',
      createdAtMs: 3_000,
      notification: { status: 'queue_failed', attemptedAtMs: 3_100 },
    });

    const response = await listSpeakerRequestsHandler(buildRequest({ limit: 25 }, { uid: 'admin-1', token: { role: 'admin' } }));
    expect(response.status).toBe('success');
    if (response.status !== 'success') {
      throw new Error(response.error);
    }

    expect(response.data.speakerRequests.map((request) => request.speakerRequestId)).toEqual(['s2', 's1']);
  });

  it('returns only the authenticated user requests for non-admin callers', async () => {
    await createSpeakerRequestDocument('mine', {
      requesterUid: 'user-1',
      requesterEmail: 'user1@example.org',
    });
    await createSpeakerRequestDocument('other', {
      requesterUid: 'user-2',
      requesterEmail: 'user2@example.org',
    });

    const response = await listSpeakerRequestsHandler(buildRequest({ limit: 25 }, { uid: 'user-1', token: { role: 'user' } }));
    expect(response.status).toBe('success');
    if (response.status !== 'success') {
      throw new Error(response.error);
    }

    expect(response.data.speakerRequests).toHaveLength(1);
    expect(response.data.speakerRequests[0].speakerRequestId).toBe('mine');
  });
});
