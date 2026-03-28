import type { YouTubeQueueProbeStatus } from './processAudioQueue';
import type { BrowserFallbackErrorCode, BrowserFallbackSessionState } from './browserFallback';

export type YouTubeCookieHealthStatus =
  | 'missing'
  | 'uploaded'
  | 'uploaded_unverified'
  | 'healthy'
  | 'stale_or_challenged'
  | 'unknown';

export interface YouTubeCookieMetadata {
  cookieHash?: string;
  uploadedAt?: string;
  uploadedByUid?: string;
  uploadedByEmail?: string;
  sourceFileName?: string;
  lastUsedAt?: string | null;
  lastValidatedAt?: string | null;
  lastValidatedVideoId?: string | null;
  lastSuccessfulMode?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  lastFailureClass?: string | null;
  lastFailureMessage?: string | null;
  lastHealthCheckAt?: string | null;
  lastHealthStatus?: YouTubeCookieHealthStatus;
  consecutiveFailures?: number;
  disabledUntil?: string | null;
}

export interface YouTubeCookieStatus {
  hasCookies: boolean;
  cookieBreakerOpen: boolean;
  disabledUntil?: string | null;
  youtubeQueueBlocked: boolean;
  browserFallbackBlocked: boolean;
  probeStatus: YouTubeQueueProbeStatus;
  deferredYouTubeTaskCount: number;
  blockerReason?: string | null;
  blockerEpisodeId?: string | null;
  blockerUpdatedAt?: string | null;
  browserFallbackConfigured: boolean;
  browserFallbackReachable: boolean;
  browserFallbackHealthy: boolean;
  browserFallbackSessionState: BrowserFallbackSessionState;
  browserFallbackHealthcheckConfigured: boolean;
  browserFallbackProfileUpdatedAt?: string | null;
  browserFallbackLastCheckedAt?: string | null;
  browserFallbackLastErrorCode?: BrowserFallbackErrorCode | null;
  browserFallbackLastErrorMessage?: string | null;
  metadata: YouTubeCookieMetadata | null;
}
