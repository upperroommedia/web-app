export type YouTubeCookieHealthStatus = 'missing' | 'uploaded' | 'healthy' | 'stale_or_challenged' | 'unknown';

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
  metadata: YouTubeCookieMetadata | null;
}
