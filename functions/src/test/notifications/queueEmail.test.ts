import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { queueEmail } from '../../notifications/queueEmail';

jest.setTimeout(45_000);

const firestore = firebaseAdmin.firestore();

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

describe('queueEmail', () => {
  beforeEach(async () => {
    await clearCollection('mail');
  });

  it('writes extension-compatible outbox documents with required metadata fields', async () => {
    const mailId = await queueEmail({
      to: ['ops@example.org'],
      source: 'runtime-alert',
      alertType: 'runtime-error',
      alertCode: 'UPLOAD_RUNTIME_FAILURE',
      message: {
        subject: 'Runtime alert',
        text: 'Upload failed while processing media item.',
      },
      metadata: {
        functionName: 'uploadToSubsplash',
        operationKey: 'op-123',
      },
    });

    const written = await firestore.collection('mail').doc(mailId).get();
    expect(written.exists).toBe(true);
    expect(written.data()).toMatchObject({
      to: ['ops@example.org'],
      message: {
        subject: 'Runtime alert',
        text: 'Upload failed while processing media item.',
      },
      meta: {
        source: 'runtime-alert',
        alertType: 'runtime-error',
        alertCode: 'UPLOAD_RUNTIME_FAILURE',
        metadata: {
          functionName: 'uploadToSubsplash',
          operationKey: 'op-123',
        },
      },
    });
    expect(typeof written.data()?.meta?.queuedAtMs).toBe('number');
  });
});
