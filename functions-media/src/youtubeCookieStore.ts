import { createHash } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import type { GetYouTubeCookieStatusOutputType } from '@upperroom/contracts/getYouTubeCookieStatus';
import type { SetYouTubeCookiesInput } from '@upperroom/contracts/setYouTubeCookies';
import { YOUTUBE_BROWSER_FALLBACK_BLOCKER_REASON } from '@upperroom/contracts/processAudioQueue';
import type { YouTubeCookieMetadata } from '@upperroom/contracts/youtubeCookies';
import { getBrowserFallbackSessionStatus } from './browserFallbackService';
import { beginYouTubeQueueProbe, buildYouTubeCookieStatus, getYouTubeQueueSnapshot } from './processAudioQueueStore';
import { getProcessAudioTargetUri } from './processAudioService';

const COOKIE_KEY = 'yt-dlp-cookies';
const COOKIE_META_KEY = 'yt-dlp-cookies-meta';
const MAX_BASE64_LENGTH = 2_000_000;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type YouTubeCookieActor = {
  uid: string;
  email?: string;
};

const normalizeBase64 = (value: string): string => value.replace(/\s+/g, '');

const decodeBase64 = (value: string): string => {
  const normalized = normalizeBase64(value);

  if (!normalized) {
    throw new HttpsError('invalid-argument', 'Cookie file content cannot be empty.');
  }

  if (normalized.length > MAX_BASE64_LENGTH) {
    throw new HttpsError('invalid-argument', 'Cookie file is too large to store.');
  }

  if (!BASE64_PATTERN.test(normalized)) {
    throw new HttpsError('invalid-argument', 'Cookie file is not valid base64.');
  }

  const decoded = Buffer.from(normalized, 'base64').toString('utf8');
  const reencoded = Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/u, '');
  if (reencoded !== normalized.replace(/=+$/u, '')) {
    throw new HttpsError('invalid-argument', 'Cookie file is not valid base64.');
  }

  return decoded;
};

const validateCookiesText = (decodedCookies: string): void => {
  if (!decodedCookies.trim()) {
    throw new HttpsError('invalid-argument', 'Cookie file cannot be empty.');
  }

  const cookieLines = decodedCookies
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  const hasTabSeparatedCookies = cookieLines.some((line) => line.split('\t').length >= 7);
  const mentionsYouTube = /(^|[\s\t])(\.?youtube\.com|\.?google\.com)([\s\t]|$)/iu.test(decodedCookies);

  if (!hasTabSeparatedCookies || !mentionsYouTube) {
    throw new HttpsError('invalid-argument', 'Cookie file must look like a Netscape cookies.txt export for YouTube.');
  }
};

export const getYouTubeCookieStatus = async (database: Database): Promise<GetYouTubeCookieStatusOutputType> => {
  const [cookiesSnapshot, metadataSnapshot] = await Promise.all([
    database.ref(COOKIE_KEY).get(),
    database.ref(COOKIE_META_KEY).get(),
  ]);

  const metadata = metadataSnapshot.exists() ? (metadataSnapshot.val() as YouTubeCookieMetadata) : null;
  let { queueState, deferredCount } = await getYouTubeQueueSnapshot(database);
  const browserFallbackStatus = await getBrowserFallbackSessionStatus(database);

  if (
    queueState.blockerReason === YOUTUBE_BROWSER_FALLBACK_BLOCKER_REASON &&
    browserFallbackStatus.reachable &&
    browserFallbackStatus.sessionState === 'authenticated'
  ) {
    try {
      await beginYouTubeQueueProbe({
        database,
        targetUri: getProcessAudioTargetUri(),
        ownerId: `browser-status:${Date.now()}`,
        probeMode: 'browser_fallback',
      });
      ({ queueState, deferredCount } = await getYouTubeQueueSnapshot(database));
    } catch (error) {
      logger.warn('Failed to schedule browser fallback YouTube queue probe while reading status', {
        error,
      });
      ({ queueState, deferredCount } = await getYouTubeQueueSnapshot(database));
    }
  }

  return buildYouTubeCookieStatus(cookiesSnapshot.exists(), metadata, queueState, deferredCount, {
    configured: browserFallbackStatus.configured,
    reachable: browserFallbackStatus.reachable,
    sessionState: browserFallbackStatus.sessionState,
    profileUpdatedAt: browserFallbackStatus.profileUpdatedAt,
  });
};

export const writeYouTubeCookies = async (
  database: Database,
  input: SetYouTubeCookiesInput,
  actor: YouTubeCookieActor
): Promise<GetYouTubeCookieStatusOutputType> => {
  const normalizedBase64 = normalizeBase64(input.cookiesBase64);
  const decodedCookies = decodeBase64(normalizedBase64);
  validateCookiesText(decodedCookies);

  const now = new Date().toISOString();
  const cookieHash = createHash('sha256').update(normalizedBase64).digest('hex').slice(0, 16);
  const metadata: YouTubeCookieMetadata = {
    cookieHash,
    uploadedAt: now,
    uploadedByUid: actor.uid,
    uploadedByEmail: actor.email,
    sourceFileName: input.fileName,
    lastUsedAt: null,
    lastValidatedAt: null,
    lastValidatedVideoId: null,
    lastSuccessfulMode: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureClass: null,
    lastFailureMessage: null,
    lastHealthCheckAt: null,
    lastHealthStatus: 'uploaded_unverified',
    consecutiveFailures: 0,
    disabledUntil: null,
  };

  await Promise.all([
    database.ref(COOKIE_KEY).set(normalizedBase64),
    database.ref(COOKIE_META_KEY).set(metadata),
  ]);

  const { queueState, deferredCount } = await getYouTubeQueueSnapshot(database);
  return buildYouTubeCookieStatus(true, metadata, queueState, deferredCount);
};
