import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserFallbackSessionState, BrowserFallbackSessionStatusResponse } from '@upperroom/contracts/browserFallback';
import { YOUTUBE_BROWSER_FALLBACK_LEASE_PATH } from '@upperroom/contracts/processAudioQueue';
import type { Database } from 'firebase-admin/database';
import type { Bucket } from '@google-cloud/storage';

const PROFILE_LEASE_TTL_MS = 10 * 60 * 1000;

type BrowserFallbackProfileMetadata = {
  sessionState: BrowserFallbackSessionState;
  profileUpdatedAt: string | null;
  profileGeneration: string | null;
};

const getProfileArchiveObject = (): string => process.env.BROWSER_FALLBACK_PROFILE_OBJECT || 'browser-fallback/profile/latest.tar.gz';
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

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, { stdio: 'inherit' });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
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

async function removeTransientProfileLocks(profileDir: string): Promise<void> {
  const candidates = [
    'SingletonCookie',
    'SingletonLock',
    'SingletonSocket',
    'lockfile',
    'Crashpad',
    'chrome_debug.log',
  ];

  await Promise.all(
    candidates.map(async (entry) => {
      await rm(path.join(profileDir, entry), { recursive: true, force: true });
      await rm(path.join(profileDir, 'Default', entry), { recursive: true, force: true });
    })
  );
}

export async function hydrateBrowserProfile(args: {
  bucket: Bucket;
  database: Database;
}): Promise<{ profileDir: string; metadata: BrowserFallbackProfileMetadata }> {
  const { bucket, database } = args;
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'browser-profile-'));
  const metadata = await readBrowserFallbackProfileMetadata(bucket);
  const archiveFile = bucket.file(getProfileArchiveObject());
  const [exists] = await archiveFile.exists();
  if (!exists) {
    await mkdir(profileDir, { recursive: true });
    return { profileDir, metadata };
  }

  const archivePath = path.join(os.tmpdir(), `${randomUUID()}.tar.gz`);

  await withProfileLease(database, `hydrate:${randomUUID()}`, async () => {
    await archiveFile.download({ destination: archivePath });
    await runCommand('tar', ['-xzf', archivePath, '-C', profileDir]);
  });

  await removeTransientProfileLocks(profileDir);
  await rm(archivePath, { force: true });
  return { profileDir, metadata };
}

export async function checkpointBrowserProfile(args: {
  bucket: Bucket;
  database: Database;
  profileDir: string;
  sessionState: BrowserFallbackSessionState;
}): Promise<BrowserFallbackProfileMetadata> {
  const { bucket, database, profileDir, sessionState } = args;
  await stat(profileDir);
  await removeTransientProfileLocks(profileDir);
  const archivePath = path.join(os.tmpdir(), `${randomUUID()}.tar.gz`);
  const ownerId = `checkpoint:${randomUUID()}`;

  return await withProfileLease(database, ownerId, async () => {
    await runCommand('tar', ['-czf', archivePath, '-C', profileDir, '.']);
    const archiveFile = bucket.file(getProfileArchiveObject());
    await archiveFile.save(await readFile(archivePath), {
      resumable: false,
      contentType: 'application/gzip',
    });
    const [archiveMetadata] = await archiveFile.getMetadata();

    const metadata: BrowserFallbackProfileMetadata = {
      sessionState,
      profileUpdatedAt: getNowIsoString(),
      profileGeneration: archiveMetadata.generation ? String(archiveMetadata.generation) : null,
    };
    await bucket.file(getProfileMetaObject()).save(JSON.stringify(metadata, null, 2), {
      resumable: false,
      contentType: 'application/json',
    });
    await rm(archivePath, { force: true });
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
    ok: true,
    service: 'browser-fallback',
    configured: fakeMode || !!process.env.BROWSER_FALLBACK_PROFILE_BUCKET,
    sessionState: metadata.sessionState,
    profileUpdatedAt: metadata.profileUpdatedAt,
    profileGeneration: metadata.profileGeneration,
    fakeMode,
  };
}
