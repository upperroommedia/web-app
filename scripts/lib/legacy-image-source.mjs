/** A canonical generation may only be inferred if the current object predates publication. */
export function derivePinnedImageSource(image, metadata, bucketName) {
  const url = new URL(image.downloadLink);
  let path;
  if (url.hostname === 'firebasestorage.googleapis.com') {
    const match = url.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
    if (match && decodeURIComponent(match[1]) === bucketName) path = decodeURIComponent(match[2]);
  } else if (url.hostname === 'storage.googleapis.com') {
    const prefix = `/${bucketName}/`;
    if (url.pathname.startsWith(prefix)) path = decodeURIComponent(url.pathname.slice(prefix.length));
  }
  if (!path || !path.startsWith('speaker-images/')) throw new Error('not_a_canonical_image_storage_source');
  if (!metadata) return { bucket: bucketName, path };
  if (!/^\d+$/.test(String(metadata.generation)) || !String(metadata.contentType).startsWith('image/'))
    throw new Error('invalid_storage_generation_or_type');
  const createdAt = Date.parse(metadata.timeCreated);
  if (!Number.isFinite(createdAt) || !Number.isFinite(image.dateAddedMillis) || createdAt > image.dateAddedMillis)
    throw new Error('source_was_replaced_after_image_publication');
  const token = url.searchParams.get('token');
  if (
    token &&
    !String(metadata.metadata?.firebaseStorageDownloadTokens ?? '')
      .split(',')
      .includes(token)
  )
    throw new Error('canonical_download_token_no_longer_matches');
  return { bucket: bucketName, path, generation: String(metadata.generation), contentType: metadata.contentType };
}
