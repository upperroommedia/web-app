export type BrowserFallbackAction = 'resolve_audio_url' | 'download_section';

export type BrowserFallbackSessionState =
  | 'unknown'
  | 'missing_profile'
  | 'authenticated'
  | 'auth_required'
  | 'fake_mode'
  | 'public_only';

export type BrowserFallbackStrategy = 'session_backed' | 'public_only';

export type BrowserFallbackCredentialSource = 'none' | 'chromium_profile' | 'legacy_cookies_file';

export type BrowserFallbackErrorCode =
  | 'auth_required'
  | 'session_unhealthy'
  | 'browser_launch_failed'
  | 'artifact_upload_failed'
  | 'temporary_upstream_failure';

export interface BrowserFallbackRequestContext {
  requestId?: string;
  sermonId?: string | null;
  operation?: string | null;
}

export interface BrowserFallbackResolveAudioUrlRequest {
  action: 'resolve_audio_url';
  youtubeUrl: string;
  requestContext?: BrowserFallbackRequestContext;
}

export interface BrowserFallbackDownloadSectionRequest {
  action: 'download_section';
  youtubeUrl: string;
  startTime: number;
  duration?: number;
  requestContext?: BrowserFallbackRequestContext;
}

export type BrowserFallbackRequest = BrowserFallbackResolveAudioUrlRequest | BrowserFallbackDownloadSectionRequest;

export interface BrowserFallbackResolutionMetadata {
  serviceRole: string | null;
  strategy: BrowserFallbackStrategy;
  credentialSource: BrowserFallbackCredentialSource;
}

export interface BrowserFallbackResolveAudioUrlResponse {
  url: string;
  format?: string;
  duration?: number;
  resolution?: BrowserFallbackResolutionMetadata;
}

export interface BrowserFallbackDownloadSectionResponse {
  downloadUrl: string;
  ext?: string;
  resolution?: BrowserFallbackResolutionMetadata;
}

export interface BrowserFallbackErrorResponse {
  code: BrowserFallbackErrorCode;
  message: string;
  sessionState: BrowserFallbackSessionState;
  retryable: boolean;
}

export interface BrowserFallbackSessionStatusResponse {
  ok: boolean;
  service: 'browser-fallback';
  configured: boolean;
  sessionState: BrowserFallbackSessionState;
  profileUpdatedAt: string | null;
  profileGeneration: string | null;
  fakeMode: boolean;
  strategy: BrowserFallbackStrategy;
  serviceRole: string | null;
  credentialSource: BrowserFallbackCredentialSource | null;
  healthcheckConfigured: boolean;
  lastCheckedAt: string | null;
  lastErrorCode: BrowserFallbackErrorCode | null;
  lastErrorMessage: string | null;
}

export interface BrowserFallbackRuntimeConfig {
  serviceUrl: string | null;
  enabled: boolean;
  updatedAt: string | null;
}

export const BROWSER_FALLBACK_RUNTIME_CONFIG_PATH = 'runtimeConfig/youtube/browserFallback';
