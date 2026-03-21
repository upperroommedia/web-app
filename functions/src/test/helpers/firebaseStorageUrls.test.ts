import {
  buildFirebaseStorageDownloadUrl,
  extractStoragePathFromDownloadUrl,
} from '@upperroom/shared/shared/firebaseStorageUrls';
import { ensureFirebaseDownloadUrl } from '../../storageDownloadUrl';

describe('firebaseStorageUrls', () => {
  const bucketName = 'urm-app-staging-images';
  const objectPath = 'speaker-images/URM_icon-square.png';
  const token = 'test-download-token';

  it('builds tokenized Firebase Storage download URLs', () => {
    expect(buildFirebaseStorageDownloadUrl(bucketName, objectPath, token)).toBe(
      'https://firebasestorage.googleapis.com/v0/b/urm-app-staging-images/o/speaker-images%2FURM_icon-square.png?alt=media&token=test-download-token'
    );
  });

  it('extracts a storage path from a Firebase Storage download URL', () => {
    const url = buildFirebaseStorageDownloadUrl(bucketName, objectPath, token);
    expect(extractStoragePathFromDownloadUrl(url, bucketName)).toBe(objectPath);
  });

  it('extracts a storage path from a legacy storage.googleapis.com URL', () => {
    const legacyUrl = `https://storage.googleapis.com/${bucketName}/${encodeURIComponent(objectPath)}`;
    expect(extractStoragePathFromDownloadUrl(legacyUrl, bucketName)).toBe(objectPath);
  });

  it('returns null when the URL is not for the expected bucket', () => {
    const otherBucketUrl = buildFirebaseStorageDownloadUrl('another-bucket', objectPath, token);
    expect(extractStoragePathFromDownloadUrl(otherBucketUrl, bucketName)).toBeNull();
  });

  it('builds emulator download URLs when the storage emulator is configured', async () => {
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199';
    const getMetadata = jest.fn().mockResolvedValue([{ metadata: { firebaseStorageDownloadTokens: token } }]);
    const file = {
      bucket: { name: bucketName },
      name: objectPath,
      getMetadata,
      setMetadata: jest.fn(),
    } as any;

    await expect(ensureFirebaseDownloadUrl(file)).resolves.toBe(
      'http://127.0.0.1:9199/v0/b/urm-app-staging-images/o/speaker-images%2FURM_icon-square.png?alt=media&token=test-download-token'
    );

    delete process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  });
});
