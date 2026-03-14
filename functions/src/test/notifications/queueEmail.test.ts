import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { queueEmail } from '../../notifications/queueEmail';

jest.setTimeout(45_000);

const firestore = firebaseAdmin.firestore();
const originalProjectEnv = {
  GCLOUD_PROJECT: process.env.GCLOUD_PROJECT,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
};

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
  afterAll(() => {
    process.env.GCLOUD_PROJECT = originalProjectEnv.GCLOUD_PROJECT;
    process.env.GOOGLE_CLOUD_PROJECT = originalProjectEnv.GOOGLE_CLOUD_PROJECT;
    process.env.FIREBASE_PROJECT_ID = originalProjectEnv.FIREBASE_PROJECT_ID;
  });

  beforeEach(async () => {
    process.env.GCLOUD_PROJECT = 'urm-app';
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.FIREBASE_PROJECT_ID;
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

  it('prefixes subject lines in staging', async () => {
    process.env.GCLOUD_PROJECT = 'urm-app-staging';

    const mailId = await queueEmail({
      to: ['ops@example.org'],
      source: 'runtime-alert',
      alertType: 'runtime-error',
      message: {
        subject: 'Runtime alert',
        text: 'Upload failed while processing media item.',
      },
    });

    const written = await firestore.collection('mail').doc(mailId).get();
    expect(written.exists).toBe(true);
    expect(written.data()?.message?.subject).toBe('[STAGING] Runtime alert');
  });

  it('does not double-prefix staging subject lines', async () => {
    process.env.GCLOUD_PROJECT = 'urm-app-staging';

    const mailId = await queueEmail({
      to: ['ops@example.org'],
      source: 'runtime-alert',
      alertType: 'runtime-error',
      message: {
        subject: '[STAGING] Runtime alert',
        text: 'Upload failed while processing media item.',
      },
    });

    const written = await firestore.collection('mail').doc(mailId).get();
    expect(written.exists).toBe(true);
    expect(written.data()?.message?.subject).toBe('[STAGING] Runtime alert');
  });
});
