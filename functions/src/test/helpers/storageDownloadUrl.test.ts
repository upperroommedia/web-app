import type { File } from '@google-cloud/storage';
import { readFirebaseDownloadUrl, readPublishingAudioUrl } from '../../storageDownloadUrl';
import { currentSandboxProfile } from '../../providerSandbox/http';

jest.mock('../../providerSandbox/http', () => ({ currentSandboxProfile: jest.fn() }));

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

describe('readPublishingAudioUrl', () => {
  const generation = '90071992547409931';
  function pinnedSource(metadata = { generation, size: '128' }) {
    const getMetadata = jest.fn().mockResolvedValue([metadata]);
    const getSignedUrl = jest.fn().mockResolvedValue(['https://signed.example.invalid/']);
    const file = {
      bucket: { name: 'urm-app-staging.firebasestorage.app' },
      name: 'workflow-audio/owned/final audio.mp3',
      getMetadata,
      getSignedUrl,
    } as unknown as File;
    return { file, getMetadata, getSignedUrl };
  }

  beforeEach(() => jest.mocked(currentSandboxProfile).mockReset());

  it('verifies the exact nonempty generation before exposing a sandbox source', async () => {
    jest.mocked(currentSandboxProfile).mockReturnValue({ mode: 'sandbox' } as ReturnType<typeof currentSandboxProfile>);
    const fixture = pinnedSource();
    await expect(readPublishingAudioUrl(fixture.file, generation)).resolves.toBe(
      `gs://urm-app-staging.firebasestorage.app/workflow-audio/owned/final%20audio.mp3?generation=${generation}`
    );
    expect(fixture.getMetadata).toHaveBeenCalledTimes(1);
    expect(fixture.getSignedUrl).not.toHaveBeenCalled();
  });

  it.each([
    { generation: '90071992547409932', size: '128' },
    { generation, size: '0' },
  ])('does not expose an invalid sandbox source (%j)', async (metadata) => {
    jest.mocked(currentSandboxProfile).mockReturnValue({ mode: 'sandbox' } as ReturnType<typeof currentSandboxProfile>);
    const fixture = pinnedSource(metadata);
    await expect(readPublishingAudioUrl(fixture.file, generation)).rejects.toThrow('The retained audio');
    expect(fixture.getMetadata).toHaveBeenCalledTimes(1);
    expect(fixture.getSignedUrl).not.toHaveBeenCalled();
  });

  it('signs the verified generation without rounding it', async () => {
    const fixture = pinnedSource();
    await expect(readPublishingAudioUrl(fixture.file, generation)).resolves.toBe('https://signed.example.invalid/');
    expect(fixture.getMetadata).toHaveBeenCalledTimes(1);
    expect(fixture.getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'read', version: 'v4', queryParams: { generation } })
    );
  });
});
