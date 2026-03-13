import {
  buildFirebaseStorageDownloadUrl,
  extractStoragePathFromDownloadUrl,
} from '../../../../shared/firebaseStorageUrls';

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
});
