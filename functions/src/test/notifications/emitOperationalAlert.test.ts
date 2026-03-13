import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { logger } from 'firebase-functions/v2';
import { emitOperationalAlert } from '../../notifications/emitOperationalAlert';
import * as queueEmailModule from '../../notifications/queueEmail';
import { SOUNDCLOUD_ADVANCED_PATH, SOUNDCLOUD_AUTH_RECONNECT_REQUIRED_CODE } from '../../../../shared/soundcloudAuth';

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

describe('emitOperationalAlert', () => {
  beforeEach(async () => {
    jest.restoreAllMocks();
    await clearCollection('mail');
  });

  it('logs structured metadata and enqueues an alert email for each invocation', async () => {
    const loggerSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const initialCount = (await firestore.collection('mail').get()).size;

    await emitOperationalAlert({
      alertCode: 'AUDIO_PIPELINE_FAILURE',
      summary: 'Audio processing failed.',
      error: new Error('ffmpeg failed'),
      context: {
        functionName: 'addintrooutrotaskhandler',
        operationKey: 'audio-op-1',
        mediaItemId: 'media-123',
      },
    });

    expect(loggerSpy).toHaveBeenCalledTimes(1);
    expect(loggerSpy.mock.calls[0]).toMatchObject([
      'operational alert emitted',
      {
        alertCode: 'AUDIO_PIPELINE_FAILURE',
        summary: 'Audio processing failed.',
        errorMessage: 'ffmpeg failed',
        context: {
          functionName: 'addintrooutrotaskhandler',
          operationKey: 'audio-op-1',
          mediaItemId: 'media-123',
        },
      },
    ]);

    const snapshot = await firestore.collection('mail').get();
    expect(snapshot.size).toBe(initialCount + 1);
    expect(snapshot.docs[snapshot.docs.length - 1].data()).toMatchObject({
      meta: {
        source: 'runtime-alert',
        alertType: 'runtime-error',
        alertCode: 'AUDIO_PIPELINE_FAILURE',
      },
      message: {
        subject: '[URM] Runtime alert: AUDIO_PIPELINE_FAILURE',
      },
    });
  });

  it('does not dedupe repeated runtime errors and enqueues each occurrence', async () => {
    const initialCount = (await firestore.collection('mail').get()).size;

    await emitOperationalAlert({
      alertCode: 'UPLOAD_RUNTIME_FAILURE',
      summary: 'Upload failed.',
      error: new Error('network timeout'),
      context: { functionName: 'uploadToSubsplash', operationKey: 'op-repeat' },
    });

    await emitOperationalAlert({
      alertCode: 'UPLOAD_RUNTIME_FAILURE',
      summary: 'Upload failed.',
      error: new Error('network timeout'),
      context: { functionName: 'uploadToSubsplash', operationKey: 'op-repeat' },
    });

    const snapshot = await firestore.collection('mail').get();
    expect(snapshot.size).toBe(initialCount + 2);
  });

  it('includes Advanced page recovery instructions for SoundCloud reconnect alerts', async () => {
    const initialCount = (await firestore.collection('mail').get()).size;

    await emitOperationalAlert({
      alertCode: 'PUBLISH_SOUNDCLOUD_UPLOAD_RUNTIME_FAILURE',
      summary: 'SoundCloud upload needs re-authorization.',
      error: new Error('SoundCloud authorization is missing or expired.'),
      context: {
        functionName: 'uploadToSoundCloud',
        audioStoragePath: 'intro-outro-sermons/sermon-123',
        soundCloudRecoveryCode: SOUNDCLOUD_AUTH_RECONNECT_REQUIRED_CODE,
      },
    });

    const snapshot = await firestore.collection('mail').get();
    expect(snapshot.size).toBe(initialCount + 1);
    const mail = snapshot.docs[snapshot.docs.length - 1].data();
    expect(mail.message.text).toContain(`http://localhost:3000${SOUNDCLOUD_ADVANCED_PATH}`);
    expect(mail.message.text).toContain('reconnect the account');
    expect(mail.message.html).toContain(`http://localhost:3000${SOUNDCLOUD_ADVANCED_PATH}`);
    expect(mail.message.html).toContain('Open Advanced Settings');
  });

  it('logs delivery failures instead of swallowing the original runtime path', async () => {
    const loggerSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    jest.spyOn(queueEmailModule, 'queueEmail').mockRejectedValue(new Error('mail queue unavailable'));

    await expect(
      emitOperationalAlert({
        alertCode: 'ROLE_REQUEST_EMAIL_ENQUEUE_FAILED',
        summary: 'Failed to enqueue role request email.',
        error: new Error('upstream provider unavailable'),
        context: { functionName: 'createRoleRequest', requestId: 'req-123' },
      })
    ).resolves.toBeUndefined();

    expect(loggerSpy).toHaveBeenCalledTimes(2);
    expect(loggerSpy.mock.calls[1]).toMatchObject([
      'failed to deliver operational alert',
      expect.objectContaining({
        alertCode: 'ROLE_REQUEST_EMAIL_ENQUEUE_FAILED',
        deliveryErrorMessage: 'mail queue unavailable',
        originalErrorMessage: 'upstream provider unavailable',
      }),
    ]);
  });
});
