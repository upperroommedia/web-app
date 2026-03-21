import type { File } from '@google-cloud/storage';
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

  return rawTokens
    .split(',')
    .map((token: string) => token.trim())
    .find((token: string) => token.length > 0) ?? null;
};

const buildEmulatorDownloadUrl = (bucketName: string, objectPath: string, token: string, emulatorHost: string): string => {
  const normalizedHost = emulatorHost.startsWith('http://') || emulatorHost.startsWith('https://')
    ? emulatorHost
    : `http://${emulatorHost}`;
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
