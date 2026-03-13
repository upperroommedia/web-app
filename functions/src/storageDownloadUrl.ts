import type { File } from '@google-cloud/storage';
import { randomUUID } from 'crypto';
import { buildFirebaseStorageDownloadUrl } from '../../shared/firebaseStorageUrls';

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

export const ensureFirebaseDownloadUrl = async (file: File): Promise<string> => {
  const [fileMetadata] = await file.getMetadata();
  const existingToken = getExistingDownloadToken(fileMetadata as StorageObjectMetadata);
  if (existingToken) {
    return buildFirebaseStorageDownloadUrl(file.bucket.name, file.name, existingToken);
  }

  const token = randomUUID();
  await file.setMetadata({
    metadata: {
      ...(fileMetadata.metadata ?? {}),
      firebaseStorageDownloadTokens: token,
    },
  });

  return buildFirebaseStorageDownloadUrl(file.bucket.name, file.name, token);
};
