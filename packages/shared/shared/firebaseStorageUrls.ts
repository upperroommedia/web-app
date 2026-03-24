export const buildFirebaseStorageDownloadUrl = (bucketName: string, objectPath: string, token: string): string =>
  `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectPath)}?alt=media&token=${encodeURIComponent(token)}`;

export const extractStoragePathFromDownloadUrl = (downloadUrl: string, bucketName: string): string | null => {
  try {
    const url = new URL(downloadUrl);

    if (url.hostname === 'storage.googleapis.com') {
      const prefix = `/${bucketName}/`;
      if (url.pathname.startsWith(prefix)) {
        return decodeURIComponent(url.pathname.slice(prefix.length));
      }
    }

    if (url.hostname === 'firebasestorage.googleapis.com') {
      const prefix = `/v0/b/${bucketName}/o/`;
      if (url.pathname.startsWith(prefix)) {
        return decodeURIComponent(url.pathname.slice(prefix.length));
      }
    }
  } catch {
    // Fall through to legacy string parsing below.
  }

  const legacyMarker = `${bucketName}/`;
  const legacyIndex = downloadUrl.indexOf(legacyMarker);
  if (legacyIndex === -1) {
    return null;
  }

  return decodeURIComponent(downloadUrl.slice(legacyIndex + legacyMarker.length).split('?')[0]);
};
