import type { File } from '@google-cloud/storage';
import { readFirebaseDownloadUrl } from '../../storageDownloadUrl';

describe('readFirebaseDownloadUrl', () => {
  const originalEmulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  afterEach(() => {
    if (originalEmulatorHost === undefined) delete process.env.FIREBASE_STORAGE_EMULATOR_HOST;
    else process.env.FIREBASE_STORAGE_EMULATOR_HOST = originalEmulatorHost;
  });

  function source(tokens?: string) {
    const getMetadata = jest
      .fn()
      .mockResolvedValue([
        { generation: '123', metadata: { firebaseStorageDownloadTokens: tokens, retained: 'value' } },
      ]);
    const setMetadata = jest.fn();
    // The worker can read GCS metadata, while the Firebase metadata endpoint rejects it.
    const makeAuthenticatedRequest = jest.fn(() => {
      throw new Error('Firebase metadata endpoint denied');
    });
    const file = {
      name: 'workflow-audio/owned/final audio.mp3',
      bucket: { name: 'urm-app-staging.firebasestorage.app' },
      storage: { makeAuthenticatedRequest },
      getMetadata,
      setMetadata,
    } as unknown as File;
    return { file, getMetadata, setMetadata, makeAuthenticatedRequest };
  }

  it('uses the existing GCS token without requiring Firebase metadata access or changing the object', async () => {
    delete process.env.FIREBASE_STORAGE_EMULATOR_HOST;
    const fixture = source(' , existing/token+value , retained-token');
    await expect(readFirebaseDownloadUrl(fixture.file)).resolves.toBe(
      'https://firebasestorage.googleapis.com/v0/b/urm-app-staging.firebasestorage.app/o/workflow-audio%2Fowned%2Ffinal%20audio.mp3?alt=media&token=existing%2Ftoken%2Bvalue'
    );
    expect(fixture.getMetadata).toHaveBeenCalledTimes(1);
    expect(fixture.makeAuthenticatedRequest).not.toHaveBeenCalled();
    expect(fixture.setMetadata).not.toHaveBeenCalled();
  });

  it.each([undefined, '', ' , , '])('refuses a missing token (%s) without minting one', async (tokens) => {
    const fixture = source(tokens);
    await expect(readFirebaseDownloadUrl(fixture.file)).rejects.toMatchObject({
      code: 'PUBLISHING_SOURCE_DOWNLOAD_TOKEN_MISSING',
    });
    expect(fixture.setMetadata).not.toHaveBeenCalled();
  });

  it('propagates inaccessible object metadata instead of attempting token creation', async () => {
    const fixture = source('existing-token');
    fixture.getMetadata.mockRejectedValue(Object.assign(new Error('GCS denied'), { code: 403 }));
    await expect(readFirebaseDownloadUrl(fixture.file)).rejects.toMatchObject({ code: 403 });
    expect(fixture.setMetadata).not.toHaveBeenCalled();
  });

  it('keeps emulator-backed tests on their dedicated Storage endpoint', async () => {
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:19199';
    await expect(readFirebaseDownloadUrl(source('existing-token').file)).resolves.toBe(
      'http://127.0.0.1:19199/v0/b/urm-app-staging.firebasestorage.app/o/workflow-audio%2Fowned%2Ffinal%20audio.mp3?alt=media&token=existing-token'
    );
  });
});
