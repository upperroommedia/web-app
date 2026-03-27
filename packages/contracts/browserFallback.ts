export type BrowserFallbackAction = 'resolve_audio_url' | 'download_section';

export type BrowserFallbackSessionState =
  | 'unknown'
  | 'missing_profile'
  | 'authenticated'
  | 'auth_required'
  | 'fake_mode';

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

export interface BrowserFallbackResolveAudioUrlResponse {
  url: string;
  format?: string;
  duration?: number;
}

export interface BrowserFallbackDownloadSectionResponse {
  downloadUrl: string;
  ext?: string;
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
}

export interface BrowserFallbackRuntimeConfig {
  serviceUrl: string | null;
  enabled: boolean;
  updatedAt: string | null;
}

export const BROWSER_FALLBACK_RUNTIME_CONFIG_PATH = 'runtimeConfig/youtube/browserFallback';
