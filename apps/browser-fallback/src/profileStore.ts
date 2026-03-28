import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserFallbackSessionState, BrowserFallbackSessionStatusResponse } from '@upperroom/contracts/browserFallback';
import type { Database } from 'firebase-admin/database';
import type { Bucket } from '@google-cloud/storage';

const PROFILE_LEASE_TTL_MS = 10 * 60 * 1000;
const YOUTUBE_BROWSER_FALLBACK_LEASE_PATH = 'processAudioQueues/youtube/browserFallback/profileLease';

type BrowserFallbackProfileMetadata = {
  sessionState: BrowserFallbackSessionState;
  profileUpdatedAt: string | null;
  profileGeneration: string | null;
};

const getProfileStateObject = (): string =>
  process.env.BROWSER_FALLBACK_PROFILE_OBJECT || 'browser-fallback/profile/storage-state.json';
const getProfileMetaObject = (): string => process.env.BROWSER_FALLBACK_PROFILE_META_OBJECT || 'browser-fallback/profile/latest.json';

function getNowIsoString(): string {
  return new Date().toISOString();
}

function getProfileLeaseTtlMs(): number {
  const raw = Number.parseInt(process.env.BROWSER_FALLBACK_PROFILE_LEASE_TTL_MS || `${PROFILE_LEASE_TTL_MS}`, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : PROFILE_LEASE_TTL_MS;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function withProfileLease<T>(database: Database, ownerId: string, run: () => Promise<T>): Promise<T> {
  const leaseRef = database.ref(YOUTUBE_BROWSER_FALLBACK_LEASE_PATH);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const now = Date.now();
    const transaction = await leaseRef.transaction((current) => {
      const record = asRecord(current);
      const acquiredAt = typeof record?.acquiredAt === 'number' ? record.acquiredAt : 0;
      const requestId = typeof record?.requestId === 'string' ? record.requestId : null;
      const expired = !acquiredAt || now - acquiredAt > getProfileLeaseTtlMs();

      if (requestId && requestId !== ownerId && !expired) {
        return;
      }

      return {
        requestId: ownerId,
        acquiredAt: now,
        acquiredAtIso: new Date(now).toISOString(),
      };
    });

    if (transaction.committed && transaction.snapshot.val()?.requestId === ownerId) {
      try {
        return await run();
      } finally {
        const snapshot = await leaseRef.get();
        if (snapshot.val()?.requestId === ownerId) {
          await leaseRef.remove();
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error('Timed out acquiring browser fallback profile lease.');
}

export async function readBrowserFallbackProfileMetadata(bucket: Bucket): Promise<BrowserFallbackProfileMetadata> {
  const metaFile = bucket.file(getProfileMetaObject());
  const [exists] = await metaFile.exists();
  if (!exists) {
    return {
      sessionState: 'missing_profile',
      profileUpdatedAt: null,
      profileGeneration: null,
    };
  }

  const [buffer] = await metaFile.download();
  const parsed = JSON.parse(buffer.toString('utf8')) as Partial<BrowserFallbackProfileMetadata>;
  return {
    sessionState: parsed.sessionState || 'unknown',
    profileUpdatedAt: parsed.profileUpdatedAt ?? null,
    profileGeneration: parsed.profileGeneration ?? null,
  };
}

export async function hydrateBrowserProfile(args: {
  bucket: Bucket;
  database: Database;
}): Promise<{ profileDir: string; metadata: BrowserFallbackProfileMetadata; storageStatePath: string | null }> {
  const { bucket, database } = args;
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'browser-profile-'));
  const metadata = await readBrowserFallbackProfileMetadata(bucket);
  const stateFile = bucket.file(getProfileStateObject());
  const [exists] = await stateFile.exists();
  if (!exists) {
    await mkdir(profileDir, { recursive: true });
    return { profileDir, metadata, storageStatePath: null };
  }

  const storageStatePath = path.join(profileDir, 'storage-state.json');

  await withProfileLease(database, `hydrate:${randomUUID()}`, async () => {
    await mkdir(profileDir, { recursive: true });
    await stateFile.download({ destination: storageStatePath });
  });

  return { profileDir, metadata, storageStatePath };
}

export async function checkpointBrowserProfile(args: {
  bucket: Bucket;
  database: Database;
  storageState: Record<string, unknown>;
  sessionState: BrowserFallbackSessionState;
}): Promise<BrowserFallbackProfileMetadata> {
  const { bucket, database, storageState, sessionState } = args;
  const statePath = path.join(os.tmpdir(), `${randomUUID()}.json`);
  const ownerId = `checkpoint:${randomUUID()}`;

  return await withProfileLease(database, ownerId, async () => {
    await writeFile(statePath, JSON.stringify(storageState, null, 2), 'utf8');
    const stateFile = bucket.file(getProfileStateObject());
    await stateFile.save(await readFile(statePath), {
      resumable: false,
      contentType: 'application/json',
    });
    const [stateMetadata] = await stateFile.getMetadata();

    const metadata: BrowserFallbackProfileMetadata = {
      sessionState,
      profileUpdatedAt: getNowIsoString(),
      profileGeneration: stateMetadata.generation ? String(stateMetadata.generation) : null,
    };
    await bucket.file(getProfileMetaObject()).save(JSON.stringify(metadata, null, 2), {
      resumable: false,
      contentType: 'application/json',
    });
    await rm(statePath, { force: true });
    return metadata;
  });
}

export async function buildBrowserFallbackSessionStatus(
  bucket: Bucket | null,
  fakeMode: boolean
): Promise<BrowserFallbackSessionStatusResponse> {
  const metadata = fakeMode
    ? {
        sessionState: 'fake_mode' as const,
        profileUpdatedAt: getNowIsoString(),
        profileGeneration: 'fake-mode',
      }
    : bucket
      ? await readBrowserFallbackProfileMetadata(bucket)
      : {
          sessionState: 'missing_profile' as const,
          profileUpdatedAt: null,
          profileGeneration: null,
        };

  return {
    ok: fakeMode || metadata.sessionState === 'authenticated',
    service: 'browser-fallback',
    configured: fakeMode || !!process.env.BROWSER_FALLBACK_PROFILE_BUCKET,
    sessionState: metadata.sessionState,
    profileUpdatedAt: metadata.profileUpdatedAt,
    profileGeneration: metadata.profileGeneration,
    fakeMode,
    healthcheckConfigured: false,
    lastCheckedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  };
}
