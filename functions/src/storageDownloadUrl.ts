import type { File } from '@google-cloud/storage';
import { currentSandboxProfile } from './providerSandbox/http';
import { randomUUID } from 'crypto';
import { buildFirebaseStorageDownloadUrl } from '@upperroom/shared/shared/firebaseStorageUrls';

type StorageObjectMetadata = {
  metadata?: Record<string, string | undefined>;
};

const getExistingDownloadToken = (fileMetadata: StorageObjectMetadata): string | null => {
  const rawTokens = fileMetadata.metadata?.firebaseStorageDownloadTokens;
  if (!rawTokens) {
    return null;
  }

  return (
    rawTokens
      .split(',')
      .map((token: string) => token.trim())
      .find((token: string) => token.length > 0) ?? null
  );
};

const buildEmulatorDownloadUrl = (
  bucketName: string,
  objectPath: string,
  token: string,
  emulatorHost: string
): string => {
  const normalizedHost =
    emulatorHost.startsWith('http://') || emulatorHost.startsWith('https://') ? emulatorHost : `http://${emulatorHost}`;
  const url = new URL(`/v0/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectPath)}`, normalizedHost);
  url.searchParams.set('alt', 'media');
  url.searchParams.set('token', token);
  return url.toString();
};

const buildStorageDownloadUrl = (bucketName: string, objectPath: string, token: string): string => {
  const emulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  if (emulatorHost) {
    return buildEmulatorDownloadUrl(bucketName, objectPath, token, emulatorHost);
  }

  return buildFirebaseStorageDownloadUrl(bucketName, objectPath, token);
};

/** Read an already-published object's URL using its bucket-scoped GCS permission.
 * Unlike ensureFirebaseDownloadUrl, publishing must not mint or rotate source tokens.
 */
export const readFirebaseDownloadUrl = async (file: File): Promise<string> => {
  const [fileMetadata] = await file.getMetadata();
  const token = getExistingDownloadToken(fileMetadata as StorageObjectMetadata);
  if (!token) {
    throw Object.assign(new Error('The source audio has no existing download token.'), {
      code: 'PUBLISHING_SOURCE_DOWNLOAD_TOKEN_MISSING',
    });
  }
  return buildStorageDownloadUrl(file.bucket.name, file.name, token);
};

export const ensureFirebaseDownloadUrl = async (file: File): Promise<string> => {
  const [fileMetadata] = await file.getMetadata();
  const existingToken = getExistingDownloadToken(fileMetadata as StorageObjectMetadata);
  if (existingToken) {
    return buildStorageDownloadUrl(file.bucket.name, file.name, existingToken);
  }

  const token = randomUUID();
  await file.setMetadata({
    metadata: {
      ...(fileMetadata.metadata ?? {}),
      firebaseStorageDownloadTokens: token,
    },
  });

  return buildStorageDownloadUrl(file.bucket.name, file.name, token);
};

/** A signing URL is transport only. Keep the exact Storage generation in the
 * server-derived source identity, separately from any rotating URL. */
const signPinnedAudioDownloadUrl = async (file: File, generation: string): Promise<string> => {
  try {
    const [url] = await file.getSignedUrl({
      action: 'read',
      version: 'v4',
      expires: Date.now() + 2 * 60 * 60 * 1000,
      queryParams: { generation },
    });
    return url;
  } catch {
    throw new Error('The retained audio could not be opened.');
  }
};

export const readPublishingAudioUrl = async (file: File, generation: string | undefined): Promise<string> => {
  if (generation === undefined) return readFirebaseDownloadUrl(file);
  if (typeof generation !== 'string' || !/^[1-9][0-9]{0,29}$/.test(generation))
    throw new Error('The retained audio generation changed.');
  const [metadata] = await file.getMetadata();
  if (metadata.generation !== generation) throw new Error('The retained audio generation changed.');
  if (!Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) <= 0) {
    throw new Error('The retained audio is empty or its size is invalid.');
  }
  if (currentSandboxProfile()) {
    const path = file.name.split('/').map(encodeURIComponent).join('/');
    return `gs://${file.bucket.name}/${path}?generation=${generation}`;
  }
  return signPinnedAudioDownloadUrl(file, generation);
};
