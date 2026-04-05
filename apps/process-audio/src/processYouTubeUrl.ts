import { CancelToken } from './CancelToken';
import { YouTubeUrl } from './types';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Writable } from 'stream';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'fs/promises';
import { Database } from 'firebase-admin/database';
import { GoogleAuth } from 'google-auth-library';
import { createLoggerWithContext } from './WinstonLogger';
import { LogContext } from './context';
import { ensureSafeTempPath, getFFmpegPath } from './utils';
import dns from 'node:dns/promises';
import firebaseAdmin from './firebaseAdmin';
import {
  analyzeYouTubeFailure,
  annotateYouTubeFailure,
  classifyYouTubeFailure,
  shouldEscalateToBrowserFallback,
  shouldEscalateToCookieProvider,
  YouTubeExtractionMode,
  YouTubeFailureClass,
} from './youtubeExtractionPolicy';
import type {
  BrowserFallbackDownloadSectionResponse,
  BrowserFallbackErrorResponse,
  BrowserFallbackRequest,
  BrowserFallbackResolveAudioUrlResponse,
} from '@upperroom/contracts/browserFallback';

interface ObservedOutboundIdentity {
  ipv4: string | null;
  ipv6: string | null;
  checkedAt: string;
  cacheHit: boolean;
}

interface MediaUrlBindingDetails {
  host: string | null;
  boundIp: string | null;
  boundIpFamily: 'ipv4' | 'ipv6' | 'unknown' | null;
}

/**
 * Result from getYouTubeAudioUrl containing the direct stream URL and metadata
 */
export interface YouTubeAudioUrlResult {
  url: string;
  format: string;
  duration?: number;
  httpHeaders?: Record<string, string>;
}

interface YouTubeFragmentFormat {
  format_id?: string;
  url?: string;
  ext?: string;
  vcodec?: string;
  protocol?: string;
  abr?: number;
  duration?: number;
  language?: string;
  language_preference?: number;
  format_note?: string;
  source_preference?: number;
  preference?: number;
  format?: string;
  fragments?: Array<{ url?: string }>;
  http_headers?: Record<string, string>;
}

interface YouTubeJsonInfo {
  duration?: number;
  language?: string;
  live_status?: string;
  was_live?: boolean;
  formats?: YouTubeFragmentFormat[];
}

interface YouTubeAudioFragmentsResult {
  duration?: number;
  formatId: string;
  ext: string;
  fragmentUrls: string[];
  fragmentDurationSeconds: number;
}

export interface YouTubeResolvedDownloadPolicy {
  dashFragmentedDownload: boolean;
  dashConcurrency: string;
  abortOnUnavailableFragments: boolean;
  useExternalDownloader: boolean;
}

interface YouTubeCookieMetadata {
  rotatedAt?: string;
  exportedAt?: string;
  exportMethod?: string;
  profileType?: string;
  cookieHash?: string;
  sourceAccount?: string;
  lastHealthStatus?: 'uploaded_unverified' | 'healthy' | 'stale_or_challenged' | 'unknown';
  lastHealthCheckAt?: string;
  lastFailureClass?: YouTubeFailureClass;
  lastFailureAt?: string;
  lastFailureMessage?: string;
  lastSuccessAt?: string;
  lastSuccessfulMode?: YouTubeExtractionMode;
  lastUsedAt?: string;
  lastValidatedAt?: string;
  lastValidatedVideoId?: string;
  consecutiveFailures?: number;
  disabledUntil?: string;
}

interface YouTubeCookieContext {
  args: string[];
  cookiesFilePath?: string;
  hasCookies: boolean;
  metadata?: YouTubeCookieMetadata;
  loadedFromRealtimeDb: boolean;
  cookieBreakerOpen?: boolean;
  disabledUntil?: string;
  source: 'browser_profile' | 'none';
}

export interface ValidateYouTubeCookiesResult {
  ok: boolean;
  message?: string;
  validationUrl: string;
  status: {
    hasCookies: boolean;
    cookieBreakerOpen: boolean;
    disabledUntil?: string | null;
    metadata: YouTubeCookieMetadata | null;
  };
}

export type YouTubeTrimRoutingStrategy = 'direct_url' | 'section_download';

export interface YouTubeTrimRoutingDecision {
  strategy: YouTubeTrimRoutingStrategy;
  reason: string;
  formatId?: string;
  protocol?: string;
  hasFragments: boolean;
  likelyDvr: boolean;
  fragmentCount?: number;
}

type YouTubeAccessDecisionState =
  | 'public_ok'
  | 'public_bot_blocked'
  | 'cookie_ok'
  | 'cookie_stale'
  | 'browser_required';

interface YouTubeAccessDecision {
  state: YouTubeAccessDecisionState;
  mode: YouTubeExtractionMode;
  reason: string;
  publicFailureClass?: YouTubeFailureClass;
  publicFailureMessage?: string;
  cookieFailureClass?: YouTubeFailureClass;
  cookieFailureMessage?: string;
  cookieBreakerOpen?: boolean;
  disabledUntil?: string;
  cookieMetadata?: YouTubeCookieMetadata;
  decidedAt: string;
}

export const YTDLP_HTTP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const YOUTUBE_ACCESS_DECISION_CACHE_TTL_MS = 10 * 60 * 1000;
const PROCESS_AUDIO_BROWSER_FALLBACK_PROFILE_LEASE_PATH = 'processAudioQueues/youtube/browserFallback/profileLease';
const PROCESS_AUDIO_BROWSER_FALLBACK_PROFILE_ARCHIVE_OBJECT = 'browser-fallback/profile/chromium-profile.tar.gz';
const PROCESS_AUDIO_BROWSER_FALLBACK_LEASE_TTL_MS = 10 * 60 * 1000;
const OBSERVED_OUTBOUND_IDENTITY_TTL_MS = 5 * 60 * 1000;
const youtubeAccessDecisionCache = new Map<string, { expiresAt: number; decision: YouTubeAccessDecision }>();
let observedOutboundIdentityCache:
  | {
      expiresAt: number;
      value: Omit<ObservedOutboundIdentity, 'cacheHit'>;
    }
  | undefined;

type BrowserFallbackEndpointKind = 'primary' | 'final_resort';
type BrowserFallbackInvocationKind = 'in_process' | 'external_http';

type BrowserFallbackInvocationResult<T> = {
  response: T;
  fallbackUrl: string;
  endpointKind: BrowserFallbackEndpointKind;
  invocationKind: BrowserFallbackInvocationKind;
};

function logSelectedYouTubeServingPath(
  log: ReturnType<typeof createLoggerWithContext>,
  fields: Record<string, unknown>
): void {
  log.info('Selected YouTube serving path', fields);
}

function isRunningInDocker(): boolean {
  try {
    return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv') || process.env.DOCKER === 'true';
  } catch {
    return false;
  }
}

function extractPercent(line: string): number | null {
  const percentMatch = line.match(/(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)%/);
  return percentMatch ? parseFloat(percentMatch[1]) : null;
}

function extractFragmentProgressFromLine(line: string): { current: number; total: number; percent: number } | null {
  const fragmentMatch = line.match(/\(frag\s+(\d+)\/(\d+)\)/i);
  if (!fragmentMatch) {
    return null;
  }

  const current = Number.parseInt(fragmentMatch[1], 10);
  const total = Number.parseInt(fragmentMatch[2], 10);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
    return null;
  }

  return {
    current,
    total,
    percent: Math.min(99, Math.max(0, (current / total) * 100)),
  };
}

function normalizeProtocol(protocol: string | undefined | null): string {
  return (protocol || '').trim().toLowerCase();
}

function isFragmentedProtocol(protocol: string | undefined | null): boolean {
  const normalized = normalizeProtocol(protocol);
  return (
    normalized.includes('m3u8') ||
    normalized.includes('dash') ||
    normalized.includes('http_dash_segments') ||
    normalized.includes('hls') ||
    normalized.includes('ism')
  );
}

/**
 * Extract time from ffmpeg progress output (e.g., "time=00:00:03.84")
 * Returns time in seconds, or null if not found
 */
function extractFfmpegTime(line: string): number | null {
  // Match time=HH:MM:SS.ms or time=MM:SS.ms format
  const timeMatch = line.match(/time=(-?\d{1,2}):(\d{2}):(\d{2})\.(\d{2})/);
  if (timeMatch) {
    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const seconds = parseInt(timeMatch[3], 10);
    const centiseconds = parseInt(timeMatch[4], 10);
    // Handle negative time (e.g., time=-00:00:01.97)
    const totalSeconds = Math.abs(hours) * 3600 + minutes * 60 + seconds + centiseconds / 100;
    return hours < 0 ? -totalSeconds : totalSeconds;
  }
  return null;
}

function formatTimeForDownloadSections(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function parseFragmentDurationFromUrl(fragmentUrl: string | undefined): number | undefined {
  if (!fragmentUrl) return undefined;
  const match = fragmentUrl.match(/\/dur\/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function getNowIsoString(): string {
  return new Date().toISOString();
}

function getYouTubeVideoId(url: string): string | undefined {
  const match = url.match(/[?&]v=([^&]+)/) ?? url.match(/youtu\.be\/([^?&]+)/);
  return match?.[1];
}

function getYtDlpConcurrentFragments(): string {
  return process.env.YTDLP_CONCURRENT_FRAGMENTS?.trim() || '1';
}

function getYtDlpDashConcurrentFragments(): string {
  return process.env.YTDLP_DASH_CONCURRENT_FRAGMENTS?.trim() || '4';
}

function getPreferredYtDlpJsRuntime(): string {
  return process.env.YTDLP_JS_RUNTIME?.trim() || 'deno';
}

function getYouTubePublicProviderMaxAttempts(): number {
  const raw = Number.parseInt(process.env.YOUTUBE_PUBLIC_PROVIDER_MAX_ATTEMPTS || '1', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function getYouTubeCookieProviderMaxAttempts(): number {
  const raw = Number.parseInt(process.env.YOUTUBE_COOKIE_PROVIDER_MAX_ATTEMPTS || '1', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function getYtDlpSleepRequestsSeconds(): string | undefined {
  const value = process.env.YTDLP_SLEEP_REQUESTS_SECONDS?.trim();
  return value || undefined;
}

function getYtDlpSleepIntervalSeconds(): string | undefined {
  const value = process.env.YTDLP_SLEEP_INTERVAL_SECONDS?.trim();
  return value || undefined;
}

function getYtDlpMaxSleepIntervalSeconds(): string | undefined {
  const value = process.env.YTDLP_MAX_SLEEP_INTERVAL_SECONDS?.trim();
  return value || undefined;
}

function classifyIpFamily(ip: string | null | undefined): 'ipv4' | 'ipv6' | 'unknown' | null {
  if (!ip) return null;
  if (ip.includes(':')) return 'ipv6';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return 'ipv4';
  return 'unknown';
}

async function fetchPublicIp(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': YTDLP_HTTP_USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const value = (await response.text()).trim();
    return value || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getObservedOutboundIdentity(): Promise<ObservedOutboundIdentity> {
  const now = Date.now();
  if (observedOutboundIdentityCache && observedOutboundIdentityCache.expiresAt > now) {
    return {
      ...observedOutboundIdentityCache.value,
      cacheHit: true,
    };
  }

  const [ipv4, ipv6] = await Promise.all([
    fetchPublicIp('https://api.ipify.org'),
    fetchPublicIp('https://api6.ipify.org'),
  ]);
  const value = {
    ipv4,
    ipv6,
    checkedAt: new Date().toISOString(),
  };
  observedOutboundIdentityCache = {
    expiresAt: now + OBSERVED_OUTBOUND_IDENTITY_TTL_MS,
    value,
  };

  return {
    ...value,
    cacheHit: false,
  };
}

export async function logObservedOutboundNetworkIdentity(
  log: ReturnType<typeof createLoggerWithContext>,
  phase: string
): Promise<ObservedOutboundIdentity> {
  const observed = await getObservedOutboundIdentity();
  log.info('Observed outbound network identity', {
    phase,
    observedIpv4: observed.ipv4,
    observedIpv6: observed.ipv6,
    observedIpv4Family: classifyIpFamily(observed.ipv4),
    observedIpv6Family: classifyIpFamily(observed.ipv6),
    checkedAt: observed.checkedAt,
    cacheHit: observed.cacheHit,
  });
  return observed;
}

export function extractMediaUrlBindingDetails(mediaUrl: string | undefined): MediaUrlBindingDetails {
  if (!mediaUrl) {
    return {
      host: null,
      boundIp: null,
      boundIpFamily: null,
    };
  }

  try {
    const parsed = new URL(mediaUrl);
    const boundIp = parsed.searchParams.get('ip');
    return {
      host: parsed.hostname || null,
      boundIp,
      boundIpFamily: classifyIpFamily(boundIp),
    };
  } catch {
    return {
      host: null,
      boundIp: null,
      boundIpFamily: null,
    };
  }
}

function shouldUseCookiesForPublicVideos(): boolean {
  if (getLocalBrowserProfileDir()) {
    return true;
  }
  const value = process.env.YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS?.trim()?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function getYtDlpExternalDownloader(): string | undefined {
  const value = process.env.YTDLP_EXTERNAL_DOWNLOADER?.trim();
  return value || undefined;
}

function getYtDlpExternalDownloaderArgs(): string | undefined {
  const value = process.env.YTDLP_EXTERNAL_DOWNLOADER_ARGS?.trim();
  return value || undefined;
}

function shouldAbortOnUnavailableFragmentsForDash(): boolean {
  const value = process.env.YTDLP_DASH_ABORT_ON_UNAVAILABLE_FRAGMENTS?.trim()?.toLowerCase();
  if (!value) return true;
  return value === '1' || value === 'true' || value === 'yes';
}

function getPreferredDirectAudioFormatSelector(): string {
  const configured = process.env.YTDLP_DIRECT_AUDIO_SELECTOR?.trim();
  return configured || 'ba[ext=m4a]/ba[ext=webm]/ba';
}

function getYtDlpM3u8FfmpegDownloaderArgs(): string {
  const configured = process.env.YTDLP_M3U8_FFMPEG_DOWNLOADER_ARGS?.trim();
  if (configured) return configured;
  return [
    '-reconnect 1',
    '-reconnect_streamed 1',
    '-reconnect_on_network_error 1',
    '-reconnect_on_http_error 4xx,5xx',
    '-reconnect_delay_max 5',
    '-http_persistent 1',
    '-http_multiple 1',
  ].join(' ');
}

function shouldForceFfmpegForM3u8(protocol: string | undefined | null): boolean {
  return normalizeProtocol(protocol).includes('m3u8');
}

function applyYtDlpExternalDownloaderArgs(args: string[]): void {
  const downloader = getYtDlpExternalDownloader();
  if (!downloader) return;
  args.push('--downloader', downloader);
  const downloaderArgs = getYtDlpExternalDownloaderArgs();
  if (downloaderArgs) {
    args.push('--downloader-args', `${downloader}:${downloaderArgs}`);
  }
}

function shouldApplyYtDlpExternalDownloader(options?: {
  protocol?: string | null;
  fragmentCount?: number | null;
}): boolean {
  if (!options) return true;
  if ((options.fragmentCount || 0) > 0) return false;
  if (isFragmentedProtocol(options.protocol)) return false;
  return true;
}

function maybeApplyYtDlpExternalDownloaderArgs(
  args: string[],
  log: ReturnType<typeof createLoggerWithContext>,
  options?: { protocol?: string | null; fragmentCount?: number | null; context?: string }
): void {
  if (shouldForceFfmpegForM3u8(options?.protocol)) {
    args.push('--downloader', 'm3u8:ffmpeg');
    args.push('--downloader-args', `ffmpeg_i:${getYtDlpM3u8FfmpegDownloaderArgs()}`);
    log.info('Forcing ffmpeg downloader for YouTube m3u8 download path', {
      protocol: options?.protocol || null,
      fragmentCount: options?.fragmentCount ?? null,
      context: options?.context || null,
      downloaderArgs: getYtDlpM3u8FfmpegDownloaderArgs(),
    });
    return;
  }

  const downloader = getYtDlpExternalDownloader();
  if (!downloader) return;
  if (!shouldApplyYtDlpExternalDownloader(options)) {
    log.info('Skipping yt-dlp external downloader for fragmented download path', {
      downloader,
      downloaderArgs: getYtDlpExternalDownloaderArgs() || null,
      protocol: options?.protocol || null,
      fragmentCount: options?.fragmentCount ?? null,
      context: options?.context || null,
    });
    return;
  }

  applyYtDlpExternalDownloaderArgs(args);
  log.info('Applying yt-dlp external downloader for direct download path', {
    downloader,
    downloaderArgs: getYtDlpExternalDownloaderArgs() || null,
    protocol: options?.protocol || null,
    fragmentCount: options?.fragmentCount ?? null,
    context: options?.context || null,
  });
}

export function shouldForceIpv4ForYouTube(): boolean {
  const value = process.env.YOUTUBE_FORCE_IPV4?.trim()?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function isDashProtocol(protocol: string | undefined | null): boolean {
  const normalized = normalizeProtocol(protocol);
  return normalized.includes('dash');
}

export function resolveYouTubeDownloadPolicy(
  protocol: string | undefined | null,
  fragmentCount: number
): YouTubeResolvedDownloadPolicy {
  const dashFragmentedDownload = isDashProtocol(protocol) && fragmentCount > 0;
  return {
    dashFragmentedDownload,
    dashConcurrency: dashFragmentedDownload ? getYtDlpDashConcurrentFragments() : getYtDlpConcurrentFragments(),
    abortOnUnavailableFragments: dashFragmentedDownload ? shouldAbortOnUnavailableFragmentsForDash() : false,
    useExternalDownloader: !dashFragmentedDownload,
  };
}

function applyPreferredIpFamilyArgs(args: string[]): void {
  if (shouldForceIpv4ForYouTube()) {
    args.push('-4');
  }
}

function isInProcessBrowserFallbackEnabled(): boolean {
  const explicit = process.env.PROCESS_AUDIO_IN_PROCESS_BROWSER_FALLBACK_ENABLED?.trim()?.toLowerCase();
  if (explicit === '0' || explicit === 'false' || explicit === 'no') return false;
  return !!(getLocalBrowserProfileDir() || process.env.BROWSER_FALLBACK_PROFILE_BUCKET?.trim() || process.env.FIREBASE_STORAGE_BUCKET?.trim());
}

function isBrowserFallbackEnabled(): boolean {
  const explicit = process.env.YOUTUBE_BROWSER_FALLBACK_ENABLED?.trim()?.toLowerCase();
  if (explicit === '0' || explicit === 'false' || explicit === 'no') return false;
  return isInProcessBrowserFallbackEnabled() || !!getFinalResortBrowserFallbackUrl();
}

function normalizeBrowserFallbackUrl(endpoint: string | undefined): string | undefined {
  const trimmed = endpoint?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : undefined;
}

function getFinalResortBrowserFallbackUrl(): string | undefined {
  return normalizeBrowserFallbackUrl(process.env.YOUTUBE_FINAL_BROWSER_FALLBACK_URL);
}

function getBrowserFallbackAudience(
  fallbackUrl: string | undefined = getFinalResortBrowserFallbackUrl()
): string | undefined {
  if (!fallbackUrl) return undefined;

  try {
    const parsed = new URL(fallbackUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

function getBrowserFallbackTargets(): Array<{ url: string; endpointKind: BrowserFallbackEndpointKind }> {
  const targets: Array<{ url: string; endpointKind: BrowserFallbackEndpointKind }> = [];
  const finalResort = getFinalResortBrowserFallbackUrl();

  if (finalResort) {
    targets.push({ url: finalResort, endpointKind: 'final_resort' });
  }

  return targets;
}

function getBrowserFallbackAuthMode(): string {
  return process.env.BROWSER_FALLBACK_AUTH_MODE?.trim().toLowerCase() || 'auto';
}

function getBrowserFallbackSharedSecret(): string | undefined {
  const value = process.env.BROWSER_FALLBACK_SHARED_SECRET?.trim();
  return value || undefined;
}

function getBrowserFallbackProfileBucketName(): string | undefined {
  return process.env.BROWSER_FALLBACK_PROFILE_BUCKET?.trim() || process.env.FIREBASE_STORAGE_BUCKET?.trim() || undefined;
}

function getLocalBrowserProfileDir(): string | undefined {
  const value = process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR?.trim();
  return value || undefined;
}

function getLocalBrowserProfileBrowser(): 'chrome' | 'chromium' {
  return process.env.PROCESS_AUDIO_BROWSER_PROFILE_BROWSER?.trim().toLowerCase() === 'chrome'
    ? 'chrome'
    : 'chromium';
}

function getBrowserRefreshUrl(): string | undefined {
  const value = process.env.PROCESS_AUDIO_BROWSER_REFRESH_URL?.trim();
  return value ? value.replace(/\/+$/, '') : undefined;
}

function getBrowserRefreshControlDir(): string | undefined {
  const value = process.env.PROCESS_AUDIO_BROWSER_REFRESH_CONTROL_DIR?.trim();
  return value || undefined;
}

function getBrowserRefreshWaitMs(): number {
  const raw = Number.parseInt(process.env.PROCESS_AUDIO_BROWSER_REFRESH_WAIT_MS || '6000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 6000;
}

function getLocalBrowserCookiesDbPath(): string | undefined {
  const profileDir = getLocalBrowserProfileDir();
  if (!profileDir) return undefined;
  return path.join(profileDir, 'Default', 'Cookies');
}

async function readBrowserCookieDbStats(): Promise<{ exists: boolean; mtimeMs: number | null; size: number | null }> {
  const cookiesDbPath = getLocalBrowserCookiesDbPath();
  if (!cookiesDbPath) {
    return { exists: false, mtimeMs: null, size: null };
  }

  try {
    const fileStats = await stat(cookiesDbPath);
    return {
      exists: true,
      mtimeMs: fileStats.mtimeMs,
      size: fileStats.size,
    };
  } catch {
    return { exists: false, mtimeMs: null, size: null };
  }
}

function getBrowserFallbackProfileArchiveObject(): string {
  return process.env.BROWSER_FALLBACK_PROFILE_ARCHIVE_OBJECT?.trim() || PROCESS_AUDIO_BROWSER_FALLBACK_PROFILE_ARCHIVE_OBJECT;
}

function getBrowserFallbackProfileLeaseTtlMs(): number {
  const raw = Number.parseInt(
    process.env.BROWSER_FALLBACK_PROFILE_LEASE_TTL_MS || `${PROCESS_AUDIO_BROWSER_FALLBACK_LEASE_TTL_MS}`,
    10
  );
  return Number.isFinite(raw) && raw > 0 ? raw : PROCESS_AUDIO_BROWSER_FALLBACK_LEASE_TTL_MS;
}

function getInProcessBrowserFallbackServiceRole(): string | null {
  return (
    process.env.PROCESS_AUDIO_BROWSER_FALLBACK_SERVICE_ROLE?.trim() ||
    process.env.BROWSER_FALLBACK_SERVICE_ROLE?.trim() ||
    'gcp_primary_browser_fallback'
  );
}

function getInProcessBrowserFallbackStrategy(): 'session_backed' | 'public_only' {
  return process.env.PROCESS_AUDIO_BROWSER_FALLBACK_STRATEGY?.trim()?.toLowerCase() === 'public_only'
    ? 'public_only'
    : 'session_backed';
}

function shouldUseGoogleIdToken(url: string, audience: string | undefined): boolean {
  if (!audience) return false;
  const authMode = getBrowserFallbackAuthMode();
  if (authMode === 'id_token') return true;
  if (authMode === 'shared_secret' || authMode === 'none') return false;

  try {
    return new URL(url).hostname.toLowerCase().endsWith('.run.app');
  } catch {
    return false;
  }
}

function getBrowserFallbackTimeoutMs(): number {
  const raw = Number.parseInt(process.env.YOUTUBE_BROWSER_FALLBACK_TIMEOUT_MS || '45000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 45000;
}

async function fetchWithIdToken(url: string, init: RequestInit): Promise<Response> {
  let audience: string | undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return await fetch(url, init);
    }
    audience = `${parsed.protocol}//${parsed.host}`;
  } catch {
    audience = getBrowserFallbackAudience();
  }

  const headers = new Headers(init.headers || {});
  const sharedSecret = getBrowserFallbackSharedSecret();
  if (sharedSecret) {
    headers.set('x-browser-fallback-secret', sharedSecret);
  }

  if (
    process.env.NODE_ENV === 'development' ||
    process.env.FUNCTIONS_EMULATOR === 'true' ||
    !shouldUseGoogleIdToken(url, audience)
  ) {
    return await fetch(url, {
      ...init,
      headers,
    });
  }

  if (!audience) {
    return await fetch(url, init);
  }

  const auth = new GoogleAuth();
  const client = await auth.getIdTokenClient(audience);
  const authHeaders = await client.getRequestHeaders(url);
  Object.entries(authHeaders).forEach(([key, value]) => {
    if (typeof value === 'string') {
      headers.set(key, value);
    }
  });

  return await fetch(url, {
    ...init,
    headers,
  });
}

async function fetchBrowserFallback(url: string, init: RequestInit): Promise<Response> {
  return await fetchWithIdToken(url, init);
}

async function fetchBrowserFallbackDownload(url: string, init: RequestInit): Promise<Response> {
  const audience = getBrowserFallbackAudience();
  if (audience) {
    try {
      const parsed = new URL(url);
      if (`${parsed.protocol}//${parsed.host}` === audience) {
        return await fetchWithIdToken(url, init);
      }
    } catch {
      // fall through to unsigned fetch
    }
  }

  return await fetch(url, init);
}

function getRetryDelayMs(): number {
  const raw = Number.parseInt(process.env.YOUTUBE_RETRY_DELAY_MS || '1500', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
}

function shouldEnableCookieHealthcheck(): boolean {
  const value = process.env.YTDLP_COOKIE_HEALTHCHECK_ENABLED?.trim()?.toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'no';
}

function applyYtDlpRequestPacingArgs(args: string[]): void {
  const sleepRequests = getYtDlpSleepRequestsSeconds();
  const sleepInterval = getYtDlpSleepIntervalSeconds();
  const maxSleepInterval = getYtDlpMaxSleepIntervalSeconds();

  if (sleepRequests) {
    args.push('--sleep-requests', sleepRequests);
  }
  if (sleepInterval) {
    args.push('--sleep-interval', sleepInterval);
  }
  if (sleepInterval && maxSleepInterval) {
    args.push('--max-sleep-interval', maxSleepInterval);
  }
}

function shouldApplyYtDlpRequestPacing(options?: { protocol?: string | null; fragmentCount?: number | null }): boolean {
  if (!options) return true;
  if ((options.fragmentCount || 0) > 0) return false;
  if (isFragmentedProtocol(options.protocol)) return false;
  return true;
}

function maybeApplyYtDlpRequestPacingArgs(
  args: string[],
  log: ReturnType<typeof createLoggerWithContext>,
  options?: { protocol?: string | null; fragmentCount?: number | null; context?: string }
): void {
  if (!shouldApplyYtDlpRequestPacing(options)) {
    log.info('Skipping yt-dlp request pacing for fragmented download path', {
      protocol: options?.protocol || null,
      fragmentCount: options?.fragmentCount ?? null,
      context: options?.context || null,
    });
    return;
  }

  applyYtDlpRequestPacingArgs(args);
}

function buildDecisionCacheKey(ctx: LogContext | undefined, url: string): string | undefined {
  if (!ctx?.requestId) return undefined;
  return `${ctx.requestId}:${url}`;
}

function setCachedAccessDecision(ctx: LogContext | undefined, url: string, decision: YouTubeAccessDecision): void {
  const key = buildDecisionCacheKey(ctx, url);
  if (!key) return;
  youtubeAccessDecisionCache.set(key, {
    expiresAt: Date.now() + YOUTUBE_ACCESS_DECISION_CACHE_TTL_MS,
    decision,
  });
}

function getCachedAccessDecision(ctx: LogContext | undefined, url: string): YouTubeAccessDecision | undefined {
  const key = buildDecisionCacheKey(ctx, url);
  if (!key) return undefined;
  const cached = youtubeAccessDecisionCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt < Date.now()) {
    youtubeAccessDecisionCache.delete(key);
    return undefined;
  }
  return cached.decision;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAttemptWithRetries<T>(
  maxAttempts: number,
  run: (attemptNumber: number) => Promise<T>
): Promise<T> {
  let lastError: unknown;
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    try {
      return await run(attemptNumber);
    } catch (error) {
      lastError = error;
      if (attemptNumber < maxAttempts) {
        await sleep(getRetryDelayMs());
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function shouldAttemptBrowserCookieRefresh(message: string, mode: YouTubeExtractionMode, ctx?: LogContext): boolean {
  if (!ctx) return false;
  if (ctx.youtubeCookieRefreshAttempted) return false;
  if (mode !== 'cookie_provider') return false;
  if (!getBrowserRefreshControlDir() && !getBrowserRefreshUrl()) return false;
  if (!getLocalBrowserProfileDir()) return false;

  const analysis = analyzeYouTubeFailure(message, mode);
  return analysis.sawLoginRequired || analysis.sawPageReload || analysis.failureClass === 'cookie_session_stale_or_challenged';
}

async function triggerBrowserYoutubeRefresh(log: ReturnType<typeof createLoggerWithContext>, ctx: LogContext): Promise<void> {
  const beforeStats = await readBrowserCookieDbStats();
  const controlDir = getBrowserRefreshControlDir();
  const refreshUrl = getBrowserRefreshUrl();
  if (!controlDir && !refreshUrl) {
    throw new Error('Neither PROCESS_AUDIO_BROWSER_REFRESH_CONTROL_DIR nor PROCESS_AUDIO_BROWSER_REFRESH_URL is configured.');
  }

  log.warn('Refreshing shared browser YouTube session after classified yt-dlp auth failure', {
    controlDir: controlDir || null,
    refreshUrl,
    browserProfileBrowser: getLocalBrowserProfileBrowser(),
    browserProfileDir: getLocalBrowserProfileDir() || null,
    cookieDbExists: beforeStats.exists,
    cookieDbMtimeMsBefore: beforeStats.mtimeMs,
    cookieDbSizeBefore: beforeStats.size,
  });

  if (controlDir) {
    const requestId = `refresh-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
    const requestPath = path.join(controlDir, `${requestId}.request.json`);
    const resultPath = path.join(controlDir, `${requestId}.result.json`);
    await writeFile(
      requestPath,
      JSON.stringify({
        reason: 'classified_yt_dlp_auth_failure',
        requestId: ctx.requestId || null,
        createdAt: new Date().toISOString(),
      })
    );

    const deadline = Date.now() + 20_000;
    try {
      while (Date.now() < deadline) {
        try {
          const responseText = await readFile(resultPath, 'utf8');
          const responseJson = JSON.parse(responseText) as { ok?: boolean; error?: string };
          if (!responseJson.ok) {
            throw new Error(responseJson.error || 'Browser refresh watcher reported failure.');
          }
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            throw error;
          }
        }

        await sleep(500);
      }

      try {
        await stat(resultPath);
      } catch {
        throw new Error(`Timed out waiting for shared browser refresh result in ${controlDir}`);
      }
    } finally {
      await Promise.all([
        unlink(requestPath).catch(() => undefined),
        unlink(resultPath).catch(() => undefined),
      ]);
    }
  } else {
    const refreshResponse = await fetch(refreshUrl!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reason: 'classified_yt_dlp_auth_failure',
        requestId: ctx.requestId || null,
      }),
    });
    if (!refreshResponse.ok) {
      const responseText = await refreshResponse.text().catch(() => '');
      throw new Error(
        `Failed to refresh YouTube in shared Chrome session: HTTP ${refreshResponse.status}${responseText ? ` body: ${responseText}` : ''}`
      );
    }
  }

  await sleep(getBrowserRefreshWaitMs());

  const afterStats = await readBrowserCookieDbStats();
  ctx.youtubeCookieRefreshAttempted = true;
  ctx.youtubeCookieRefreshSucceeded = true;
  log.info('Shared browser YouTube session refresh completed', {
    refreshUrl,
    cookieDbExists: afterStats.exists,
    cookieDbMtimeMsAfter: afterStats.mtimeMs,
    cookieDbSizeAfter: afterStats.size,
    cookieDbTouched: beforeStats.mtimeMs !== afterStats.mtimeMs || beforeStats.size !== afterStats.size,
  });
}

function buildAnnotatedYouTubeError(message: string, mode: YouTubeExtractionMode): Error {
  const failureClass = classifyYouTubeFailure(message, mode);
  return new Error(annotateYouTubeFailure(message, failureClass, mode));
}

function shouldUseBrowserFallbackForPublicFailure(message: string): boolean {
  return shouldEscalateToBrowserFallback(analyzeYouTubeFailure(message, 'public_provider'), isBrowserFallbackEnabled());
}

async function runCommandWithCapture(
  command: string,
  args: string[],
  errorPrefix: string,
  mode: YouTubeExtractionMode = 'public_provider',
  ctx?: LogContext
): Promise<{ stdout: string; stderr: string }> {
  const execute = (): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const proc = spawn(command, args);
      let stdout = '';
      let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('error', (err) => {
      reject(new Error(`${errorPrefix} spawn error: ${err}`));
    });
    proc.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        buildAnnotatedYouTubeError(
          `${errorPrefix} exited with code ${code}${signal ? ` (signal: ${signal})` : ''}. stderr: ${stderr.trim()}`,
          mode
        )
      );
    });
  });

  try {
    return await execute();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!shouldAttemptBrowserCookieRefresh(message, mode, ctx)) {
      throw error;
    }

    const log = createLoggerWithContext(ctx);
    try {
      await triggerBrowserYoutubeRefresh(log, ctx as LogContext);
    } catch (refreshError) {
      log.error('Shared browser YouTube session refresh failed', {
        refreshError: refreshError instanceof Error ? refreshError.message : String(refreshError),
        originalError: message,
      });
      throw error;
    }

    log.warn('Retrying yt-dlp command after shared browser YouTube session refresh', {
      command,
      errorPrefix,
      mode,
    });

    return await execute();
  }
}

async function runSystemCommand(command: string, args: string[], errorPrefix: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('error', (err) => {
      reject(new Error(`${errorPrefix} spawn error: ${err}`));
    });
    proc.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${errorPrefix} exited with code ${code}${signal ? ` (signal: ${signal})` : ''}. stderr: ${stderr.trim()}`
        )
      );
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function withBrowserProfileLease<T>(database: Database, ownerId: string, run: () => Promise<T>): Promise<T> {
  const leaseRef = database.ref(PROCESS_AUDIO_BROWSER_FALLBACK_PROFILE_LEASE_PATH);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const now = Date.now();
    const transaction = await leaseRef.transaction((current) => {
      const record = asRecord(current);
      const acquiredAt = typeof record?.acquiredAt === 'number' ? record.acquiredAt : 0;
      const requestId = typeof record?.requestId === 'string' ? record.requestId : null;
      const expired = !acquiredAt || now - acquiredAt > getBrowserFallbackProfileLeaseTtlMs();

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

    await sleep(200);
  }

  throw new Error('Timed out acquiring process-audio browser profile lease.');
}

function cleanupCookiesFile(cookiesFilePath: string | undefined, cleaned: { done: boolean }): void {
  if (!cookiesFilePath || cleaned.done) return;
  cleaned.done = true;
  unlink(cookiesFilePath).catch(() => {});
}

const COOKIE_SAFE_YOUTUBE_EXTRACTOR_ARGS = 'youtube:player_client=default,-web_creator';
const POT_ENABLED_YOUTUBE_EXTRACTOR_ARGS = 'youtube:player_client=default,mweb,-web_creator';
const DEFAULT_YOUTUBE_COOKIE_VALIDATION_URL = 'https://www.youtube.com/watch?v=BaW_jenozKc';
const DEFAULT_YTDLP_DOWNLOAD_STALL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_YTDLP_DOWNLOAD_STALL_POLL_INTERVAL_MS = 15 * 1000;

function getPoTokenProviderBaseUrl(): string | undefined {
  const value = process.env.YTDLP_POT_PROVIDER_BASE_URL?.trim();
  return value ? value.replace(/\/+$/, '') : undefined;
}

function getYouTubeCookieValidationUrl(): YouTubeUrl {
  const value = process.env.YTDLP_COOKIE_VALIDATION_URL?.trim();
  return (value || DEFAULT_YOUTUBE_COOKIE_VALIDATION_URL) as YouTubeUrl;
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getYtdlpDownloadStallTimeoutMs(): number {
  return parsePositiveIntegerEnv(process.env.YTDLP_DOWNLOAD_STALL_TIMEOUT_MS, DEFAULT_YTDLP_DOWNLOAD_STALL_TIMEOUT_MS);
}

function getYtdlpDownloadStallPollIntervalMs(): number {
  return parsePositiveIntegerEnv(
    process.env.YTDLP_DOWNLOAD_STALL_POLL_INTERVAL_MS,
    DEFAULT_YTDLP_DOWNLOAD_STALL_POLL_INTERVAL_MS
  );
}

function shouldDisableInnertubeForPoTokenProvider(): boolean {
  const value = process.env.YTDLP_POT_DISABLE_INNERTUBE?.trim()?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function ensureProductionPoTokenProviderConfigured(isDevelopment: boolean): void {
  if (isDevelopment) return;
  if (shouldUseCookiesForPublicVideos()) return;
  if (getPoTokenProviderBaseUrl()) return;
  throw new Error(
    'YTDLP_POT_PROVIDER_BASE_URL is required for production YouTube downloads. Deploy a bgutil PO-token provider and set this env var before retrying.'
  );
}

async function loadYouTubeCookieContext(
  _realtimeDB: Database,
  isDevelopment: boolean,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<YouTubeCookieContext> {
  const configuredProfileDir = getLocalBrowserProfileDir();
  if (configuredProfileDir) {
    const browser = getLocalBrowserProfileBrowser();
    const cookieDbStats = await readBrowserCookieDbStats();
    if (!cookieDbStats.exists) {
      log.warn('Configured browser profile does not currently contain a Chrome cookies database', {
        profileDir: configuredProfileDir,
        browser,
      });
      return {
        args: [],
        hasCookies: false,
        loadedFromRealtimeDb: false,
        source: 'none',
      };
    }

    log.info('Using cookies from configured host browser profile', {
      profileDir: configuredProfileDir,
      browser,
      cookiesDbSize: cookieDbStats.size,
      cookiesDbMtimeMs: cookieDbStats.mtimeMs,
    });
    return {
      args: ['--cookies-from-browser', `${browser}:${configuredProfileDir}`],
      hasCookies: true,
      loadedFromRealtimeDb: false,
      source: 'browser_profile',
    };
  }

  if (isDevelopment && !isRunningInDocker()) {
    log.info('Using cookies from Chrome browser (development mode)');
    return {
      args: ['--cookies-from-browser', 'chrome'],
      hasCookies: true,
      loadedFromRealtimeDb: false,
      source: 'browser_profile',
    };
  }

  log.warn('No browser-backed YouTube cookie source is configured');
  return {
    args: [],
    hasCookies: false,
    loadedFromRealtimeDb: false,
    source: 'none',
  };
}

async function updateCookieMetadata(
  _realtimeDB: Database,
  patch: Record<string, unknown>,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<void> {
  log.debug('Skipping legacy RTDB YouTube cookie metadata update; browser profile is source of truth', { patch });
}

async function recordCookieAttemptOutcome(
  realtimeDB: Database,
  mode: YouTubeExtractionMode,
  success: boolean,
  failureClass: YouTubeFailureClass | undefined,
  failureMessage: string | undefined,
  existingMetadata: YouTubeCookieMetadata | undefined,
  videoId: string | undefined,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<void> {
  void realtimeDB;
  void mode;
  void success;
  void failureClass;
  void failureMessage;
  void existingMetadata;
  void videoId;
  await updateCookieMetadata(realtimeDB, {}, log);
}

async function readYouTubeCookieStatus(realtimeDB: Database): Promise<ValidateYouTubeCookiesResult['status']> {
  void realtimeDB;
  const cookieDbStats = await readBrowserCookieDbStats();

  return {
    hasCookies: cookieDbStats.exists,
    cookieBreakerOpen: false,
    disabledUntil: null,
    metadata: null,
  };
}

function applyYouTubeExtractorArgs(
  args: string[],
  mode: YouTubeExtractionMode,
  log: ReturnType<typeof createLoggerWithContext>
): void {
  const providerBaseUrl = getPoTokenProviderBaseUrl();

  if (mode === 'cookie_provider') {
    if (!providerBaseUrl) {
      args.push('--extractor-args', COOKIE_SAFE_YOUTUBE_EXTRACTOR_ARGS);

      log.info('Applying yt-dlp extractor args for cookie-backed extraction', {
        mode,
        youtubeExtractorArgs: COOKIE_SAFE_YOUTUBE_EXTRACTOR_ARGS,
        poTokenProviderConfigured: false,
      });
      return;
    }

    args.push('--extractor-args', POT_ENABLED_YOUTUBE_EXTRACTOR_ARGS);

    const providerArgs = [`base_url=${providerBaseUrl}`];
    if (shouldDisableInnertubeForPoTokenProvider()) {
      providerArgs.push('disable_innertube=1');
    }
    args.push('--extractor-args', `youtubepot-bgutilhttp:${providerArgs.join(';')}`);

    log.info('Applying yt-dlp extractor args for cookie-backed extraction with PO token provider', {
      mode,
      youtubeExtractorArgs: POT_ENABLED_YOUTUBE_EXTRACTOR_ARGS,
      poTokenProviderBaseUrl: providerBaseUrl,
      poTokenProviderDisableInnertube: shouldDisableInnertubeForPoTokenProvider(),
    });
    return;
  }

  if (!providerBaseUrl) {
    log.debug('Applying yt-dlp extractor args without PO token provider', {
      mode,
      poTokenProviderConfigured: false,
    });
    return;
  }

  args.push('--extractor-args', POT_ENABLED_YOUTUBE_EXTRACTOR_ARGS);

  const providerArgs = [`base_url=${providerBaseUrl}`];
  if (shouldDisableInnertubeForPoTokenProvider()) {
    providerArgs.push('disable_innertube=1');
  }
  args.push('--extractor-args', `youtubepot-bgutilhttp:${providerArgs.join(';')}`);

  log.info('Applying yt-dlp extractor args with PO token provider', {
    mode,
    youtubeExtractorArgs: POT_ENABLED_YOUTUBE_EXTRACTOR_ARGS,
    poTokenProviderBaseUrl: providerBaseUrl,
    poTokenProviderDisableInnertube: shouldDisableInnertubeForPoTokenProvider(),
  });
}

type DownloadActivityProbe = {
  partialFiles: Array<{ path: string; size: number; mtimeMs: number }>;
  latestMtimeMs: number | null;
};

type YtDlpStateProbe = {
  currentFragmentIndex: number | null;
  rawState: string | null;
};

function extractFragmentProgressPercent(
  partialFiles: DownloadActivityProbe['partialFiles'],
  totalFragments: number | undefined
): number | null {
  if (!totalFragments || totalFragments <= 0) {
    return null;
  }

  let highestObservedFragment = 0;
  for (const file of partialFiles) {
    const match = path.basename(file.path).match(/Frag(\d+)/i);
    if (!match) continue;
    const fragmentNumber = Number.parseInt(match[1], 10);
    if (Number.isFinite(fragmentNumber)) {
      highestObservedFragment = Math.max(highestObservedFragment, fragmentNumber);
    }
  }

  if (highestObservedFragment <= 0) {
    return null;
  }

  return Math.min(99, (highestObservedFragment / totalFragments) * 100);
}

async function probeDownloadActivity(outputFilePath: string): Promise<DownloadActivityProbe> {
  const safeOutputFilePath = ensureSafeTempPath(outputFilePath);
  const dir = path.dirname(safeOutputFilePath);
  const baseName = path.basename(safeOutputFilePath);

  if (!fs.existsSync(dir)) {
    return { partialFiles: [], latestMtimeMs: null };
  }

  const candidates = fs
    .readdirSync(dir)
    .filter((fileName) => fileName.startsWith(baseName) && fileName.includes('.part'))
    .map((fileName) => ensureSafeTempPath(path.join(dir, fileName)));

  const partialFiles: Array<{ path: string; size: number; mtimeMs: number }> = [];
  let latestMtimeMs: number | null = null;

  for (const candidate of candidates) {
    try {
      const stats = await stat(candidate);
      partialFiles.push({ path: candidate, size: stats.size, mtimeMs: stats.mtimeMs });
      latestMtimeMs = latestMtimeMs === null ? stats.mtimeMs : Math.max(latestMtimeMs, stats.mtimeMs);
    } catch {
      // Ignore files that disappear during inspection.
    }
  }

  return { partialFiles, latestMtimeMs };
}

async function probePrimaryOutputPartialFile(outputFilePath: string): Promise<{ path: string; size: number; mtimeMs: number } | null> {
  const safeOutputFilePath = ensureSafeTempPath(outputFilePath);
  const dir = path.dirname(safeOutputFilePath);
  const baseName = path.basename(safeOutputFilePath);

  if (!fs.existsSync(dir)) {
    return null;
  }

  const candidates = fs
    .readdirSync(dir)
    .filter((fileName) => {
      if (!fileName.startsWith(baseName)) return false;
      if (fileName.includes('Frag')) return false;
      if (fileName.endsWith('.log')) return false;
      if (fileName.endsWith('.ytdl')) return false;
      return fileName.endsWith('.part') || path.basename(fileName, path.extname(fileName)) === baseName;
    })
    .map((fileName) => ensureSafeTempPath(path.join(dir, fileName)));

  let bestCandidate: { path: string; size: number; mtimeMs: number } | null = null;

  for (const candidate of candidates) {
    try {
      const stats = await stat(candidate);
      if (!bestCandidate || stats.size >= bestCandidate.size) {
        bestCandidate = { path: candidate, size: stats.size, mtimeMs: stats.mtimeMs };
      }
    } catch {
      // Ignore files that disappear during inspection.
    }
  }

  return bestCandidate;
}

async function probeYtDlpState(outputFilePath: string): Promise<YtDlpStateProbe> {
  const safeOutputFilePath = ensureSafeTempPath(outputFilePath);
  const dir = path.dirname(safeOutputFilePath);
  const baseName = path.basename(safeOutputFilePath);
  const statePath = ensureSafeTempPath(path.join(dir, `${baseName}.ytdl`));

  try {
    const rawState = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(rawState) as {
      downloader?: { current_fragment?: { index?: unknown } };
    };
    const index = parsed?.downloader?.current_fragment?.index;
    return {
      currentFragmentIndex: typeof index === 'number' && Number.isFinite(index) ? index : null,
      rawState: rawState.trim() || null,
    };
  } catch {
    return {
      currentFragmentIndex: null,
      rawState: null,
    };
  }
}

async function runCookieHealthcheck(
  ytdlpPath: string,
  url: YouTubeUrl,
  cookieContext: YouTubeCookieContext,
  log: ReturnType<typeof createLoggerWithContext>,
  ctx?: LogContext
): Promise<void> {
  if (!cookieContext.hasCookies || !shouldEnableCookieHealthcheck()) return;

  const args = ['-J', '--no-playlist', '--skip-download', '--no-js-runtimes', '--js-runtimes', getPreferredYtDlpJsRuntime()];
  applyPreferredIpFamilyArgs(args);
  applyYtDlpRequestPacingArgs(args);
  args.push(...cookieContext.args);
  applyYouTubeExtractorArgs(args, 'cookie_provider', log);
  args.push(url);

  log.info('Running YouTube cookie healthcheck', {
    url,
    command: `${ytdlpPath} ${args.join(' ')}`,
  });

  await runCommandWithCapture(ytdlpPath, args, 'yt-dlp cookie healthcheck', 'cookie_provider', ctx);
}

export async function validateConfiguredYouTubeCookies(
  ytdlpPath: string,
  realtimeDB: Database,
  isDevelopment: boolean,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<ValidateYouTubeCookiesResult> {
  const validationUrl = getYouTubeCookieValidationUrl();
  const cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);

  if (!cookieContext.hasCookies) {
    return {
      ok: false,
      message: cookieContext.cookieBreakerOpen
        ? 'Configured YouTube cookies are currently disabled by the cookie circuit breaker.'
        : 'No YouTube cookies are configured for process-audio.',
      validationUrl,
      status: await readYouTubeCookieStatus(realtimeDB),
    };
  }

  log.info('Validating uploaded YouTube cookies', {
    validationUrl,
    cookieBreakerOpen: cookieContext.cookieBreakerOpen ?? false,
    disabledUntil: cookieContext.disabledUntil ?? null,
    metadata: cookieContext.metadata,
  });

  try {
    await runCookieHealthcheck(ytdlpPath, validationUrl, cookieContext, log);
    await recordCookieAttemptOutcome(
      realtimeDB,
      'cookie_provider',
      true,
      undefined,
      undefined,
      cookieContext.metadata,
      getYouTubeVideoId(validationUrl),
      log
    );

    return {
      ok: true,
      validationUrl,
      status: await readYouTubeCookieStatus(realtimeDB),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureClass = classifyYouTubeFailure(message, 'cookie_provider');
    await recordCookieAttemptOutcome(
      realtimeDB,
      'cookie_provider',
      false,
      failureClass,
      message,
      cookieContext.metadata,
      getYouTubeVideoId(validationUrl),
      log
    );

    log.warn('Uploaded YouTube cookies failed validation', {
      validationUrl,
      failureClass,
      error: message,
      metadata: cookieContext.metadata,
    });

    return {
      ok: false,
      message,
      validationUrl,
      status: await readYouTubeCookieStatus(realtimeDB),
    };
  } finally {
    cleanupCookiesFile(cookieContext.cookiesFilePath, { done: false });
  }
}

function shouldPreferCookieProvider(cookieContext: YouTubeCookieContext | undefined): boolean {
  return shouldUseCookiesForPublicVideos() && !!cookieContext?.hasCookies;
}

async function callBrowserFallbackEndpoint<T>(
  fallbackUrl: string,
  endpointKind: BrowserFallbackEndpointKind,
  payload: BrowserFallbackRequest,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<BrowserFallbackInvocationResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getBrowserFallbackTimeoutMs());

  try {
    log.info('Invoking browser fallback endpoint', {
      endpointKind,
      fallbackUrl,
      action: payload.action,
      requestContext: payload.requestContext,
    });
    const response = await fetchBrowserFallback(fallbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = (await response.json().catch(async () => ({ message: await response.text() }))) as Partial<
        BrowserFallbackErrorResponse
      >;
      const errorMessage = body.message || `Browser fallback HTTP ${response.status}`;
      const error = new Error(errorMessage);
      (error as Error & { browserFallbackError?: Partial<BrowserFallbackErrorResponse> }).browserFallbackError = body;
      throw error;
    }

    return {
      response: (await response.json()) as T,
      fallbackUrl,
      endpointKind,
      invocationKind: 'external_http',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const browserFallbackError = (err as Error & { browserFallbackError?: Partial<BrowserFallbackErrorResponse> })
      .browserFallbackError;
    log.error('Browser fallback request failed', {
      error: message,
      endpointKind,
      fallbackUrl,
      payload,
      browserFallbackError,
    });
    const error = buildAnnotatedYouTubeError(`Browser fallback failed: ${message}`, 'browser_fallback') as Error & {
      browserFallbackError?: Partial<BrowserFallbackErrorResponse>;
    };
    error.browserFallbackError = browserFallbackError;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function callBrowserFallback<T>(
  payload: BrowserFallbackRequest,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<BrowserFallbackInvocationResult<T>> {
  const targets = getBrowserFallbackTargets();
  if (targets.length === 0) {
    throw new Error('No browser fallback endpoints are configured');
  }

  let lastError: unknown;
  for (const target of targets) {
    try {
      return await callBrowserFallbackEndpoint<T>(target.url, target.endpointKind, payload, log);
    } catch (error) {
      lastError = error;
      if (target.endpointKind === 'primary' && targets.length > 1) {
        log.warn('Primary browser fallback failed; attempting final-resort browser fallback', {
          primaryFallbackUrl: target.url,
          action: payload.action,
        });
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function invokeBrowserFallbackResolveAudioUrl(
  ytdlpPath: string,
  url: YouTubeUrl,
  realtimeDB: Database,
  payload: BrowserFallbackRequest,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<BrowserFallbackInvocationResult<BrowserFallbackResolveAudioUrlResponse>> {
  let primaryError: unknown;

  if (isInProcessBrowserFallbackEnabled()) {
    try {
      return {
        response: await resolveAudioUrlWithInProcessBrowserFallback(ytdlpPath, url, realtimeDB, log),
        fallbackUrl: 'in-process://process-audio',
        endpointKind: 'primary',
        invocationKind: 'in_process',
      };
    } catch (error) {
      primaryError = error;
      if (getBrowserFallbackTargets().length > 0) {
        log.warn('Primary in-process browser fallback failed; attempting external final-resort browser fallback', {
          youtubeUrl: url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  try {
    return await callBrowserFallback<BrowserFallbackResolveAudioUrlResponse>(payload, log);
  } catch (error) {
    throw primaryError instanceof Error ? primaryError : error;
  }
}

async function invokeBrowserFallbackDownloadSection(
  ytdlpPath: string,
  url: YouTubeUrl,
  outputFilePath: string,
  realtimeDB: Database,
  startTime: number,
  duration: number | undefined,
  payload: BrowserFallbackRequest,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<
  | (BrowserFallbackInvocationResult<BrowserFallbackDownloadSectionResponse> & { localFilePath?: string })
> {
  let primaryError: unknown;

  if (isInProcessBrowserFallbackEnabled()) {
    try {
      const local = await downloadSectionWithInProcessBrowserFallback(
        ytdlpPath,
        url,
        outputFilePath,
        realtimeDB,
        startTime,
        duration,
        log
      );
      return {
        response: local.response,
        localFilePath: local.localFilePath,
        fallbackUrl: 'in-process://process-audio',
        endpointKind: 'primary',
        invocationKind: 'in_process',
      };
    } catch (error) {
      primaryError = error;
      if (getBrowserFallbackTargets().length > 0) {
        log.warn('Primary in-process browser fallback section download failed; attempting external final-resort browser fallback', {
          youtubeUrl: url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  try {
    return await callBrowserFallback<BrowserFallbackDownloadSectionResponse>(payload, log);
  } catch (error) {
    throw primaryError instanceof Error ? primaryError : error;
  }
}

async function downloadBrowserFallbackSection(
  outputFilePath: string,
  fallbackResult: BrowserFallbackDownloadSectionResponse
): Promise<string> {
  const ext = fallbackResult.ext || 'm4a';
  const finalPath = ensureSafeTempPath(`${outputFilePath}.${ext.replace(/^\./, '')}`);
  const response = await fetchBrowserFallbackDownload(fallbackResult.downloadUrl, {
    headers: {
      'User-Agent': YTDLP_HTTP_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Browser fallback section download failed. HTTP ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(finalPath, bytes);
  return finalPath;
}

function isCompletedYouTubeLivestream(info: Pick<YouTubeJsonInfo, 'live_status' | 'was_live'> | undefined): boolean {
  if (!info) {
    return false;
  }

  return info.was_live === true || info.live_status === 'post_live';
}

function selectPreferredAudioFormat(
  formats: YouTubeFragmentFormat[],
  originalLanguage?: string,
  info?: Pick<YouTubeJsonInfo, 'live_status' | 'was_live'>
): YouTubeFragmentFormat | undefined {
  const completedLivestream = isCompletedYouTubeLivestream(info);
  const audioOnlyCandidates = formats.filter((f) => f && f.vcodec === 'none');
  const livestreamMuxedCandidates = completedLivestream
    ? formats.filter((f) => f && f.vcodec !== 'none' && (f.protocol || '').toLowerCase().includes('m3u8'))
    : [];
  const candidates = completedLivestream
    ? [...audioOnlyCandidates, ...livestreamMuxedCandidates]
    : audioOnlyCandidates;
  if (candidates.length === 0) return undefined;

  const normalize = (value: string | undefined): string => value?.trim().toLowerCase() || '';
  const targetLanguage = normalize(originalLanguage);
  const getCombinedDescriptor = (fmt: YouTubeFragmentFormat): string =>
    `${fmt.format_note || ''} ${fmt.format || ''}`.trim().toLowerCase();
  const getProtocol = (fmt: YouTubeFragmentFormat): string => normalize(fmt.protocol);
  const isOriginalAudioTrack = (fmt: YouTubeFragmentFormat): boolean => {
    const descriptor = getCombinedDescriptor(fmt);
    if (descriptor.includes('original')) return true;
    if (targetLanguage && normalize(fmt.language) === targetLanguage) return true;
    return false;
  };

  const originalCandidates = candidates.filter(isOriginalAudioTrack);
  const effectiveCandidates = originalCandidates.length > 0 ? originalCandidates : candidates;

  candidates.sort((a, b) => {
    const score = (fmt: YouTubeFragmentFormat): number => {
      let s = 0;
      const descriptor = getCombinedDescriptor(fmt);
      const language = normalize(fmt.language);
      const protocol = getProtocol(fmt);
      const isAudioOnly = fmt.vcodec === 'none';
      if (descriptor.includes('original')) s += 1000;
      if (descriptor.includes('default')) s += 300;
      if (targetLanguage && language === targetLanguage) s += 200;
      if (!completedLivestream && isAudioOnly) s += 400;
      if (completedLivestream && isAudioOnly) s += 2200;
      if (completedLivestream && isAudioOnly && protocol === 'https') s += 700;
      if (completedLivestream && !isAudioOnly && protocol.includes('m3u8')) s += 1200;
      if (completedLivestream && protocol.includes('dash')) s -= 1000;
      if (completedLivestream && protocol.includes('http_dash_segments')) s -= 4000;
      if (protocol === 'https') s += 120;
      if (protocol.includes('m3u8')) s += 100;
      if (fmt.ext === 'm4a') s += completedLivestream ? 20 : 100;
      if (fmt.format_id === '140') s += completedLivestream ? 250 : 50;
      if (descriptor.includes('drc')) s -= 25;
      if (typeof fmt.language_preference === 'number') s += fmt.language_preference * 10;
      if (typeof fmt.source_preference === 'number') s += fmt.source_preference;
      if (typeof fmt.preference === 'number') s += fmt.preference;
      if (typeof fmt.abr === 'number') s += Math.min(fmt.abr, 320);
      if (!completedLivestream && Array.isArray(fmt.fragments) && fmt.fragments.length > 0) s += 10;
      return s;
    };
    return score(b) - score(a);
  });

  return effectiveCandidates.sort((a, b) => {
    const score = (fmt: YouTubeFragmentFormat): number => {
      let s = 0;
      const descriptor = getCombinedDescriptor(fmt);
      const language = normalize(fmt.language);
      const protocol = getProtocol(fmt);
      const isAudioOnly = fmt.vcodec === 'none';
      if (descriptor.includes('original')) s += 1000;
      if (descriptor.includes('default')) s += 300;
      if (targetLanguage && language === targetLanguage) s += 200;
      if (!completedLivestream && isAudioOnly) s += 400;
      if (completedLivestream && isAudioOnly) s += 2200;
      if (completedLivestream && isAudioOnly && protocol === 'https') s += 700;
      if (completedLivestream && !isAudioOnly && protocol.includes('m3u8')) s += 1200;
      if (completedLivestream && protocol.includes('dash')) s -= 1000;
      if (completedLivestream && protocol.includes('http_dash_segments')) s -= 4000;
      if (protocol === 'https') s += 120;
      if (protocol.includes('m3u8')) s += 100;
      if (fmt.ext === 'm4a') s += completedLivestream ? 20 : 100;
      if (fmt.format_id === '140') s += completedLivestream ? 250 : 50;
      if (descriptor.includes('drc')) s -= 25;
      if (typeof fmt.language_preference === 'number') s += fmt.language_preference * 10;
      if (typeof fmt.source_preference === 'number') s += fmt.source_preference;
      if (typeof fmt.preference === 'number') s += fmt.preference;
      if (typeof fmt.abr === 'number') s += Math.min(fmt.abr, 320);
      if (!completedLivestream && Array.isArray(fmt.fragments) && fmt.fragments.length > 0) s += 10;
      return s;
    };
    return score(b) - score(a);
  })[0];
}

function buildInProcessBrowserFallbackResolution(
  credentialSource: 'chromium_profile' | 'none'
): NonNullable<BrowserFallbackResolveAudioUrlResponse['resolution']> {
  return {
    serviceRole: getInProcessBrowserFallbackServiceRole(),
    strategy: getInProcessBrowserFallbackStrategy(),
    credentialSource,
  };
}

async function hydrateInProcessBrowserProfile(
  realtimeDB: Database
): Promise<{ profileDir: string; browserProfileDir: string; cleanup: boolean }> {
  const localBrowserProfileDir = getLocalBrowserProfileDir();
  if (localBrowserProfileDir) {
    if (!fs.existsSync(localBrowserProfileDir)) {
      throw buildAnnotatedYouTubeError(
        `In-process browser fallback local profile directory ${localBrowserProfileDir} does not exist.`,
        'browser_fallback'
      );
    }

    return {
      profileDir: localBrowserProfileDir,
      browserProfileDir: localBrowserProfileDir,
      cleanup: false,
    };
  }

  const bucketName = getBrowserFallbackProfileBucketName();
  if (!bucketName) {
    throw buildAnnotatedYouTubeError(
      'In-process browser fallback is not configured because no local browser profile directory or browser profile bucket is set.',
      'browser_fallback'
    );
  }

  const bucket = firebaseAdmin.storage().bucket(bucketName);
  const archiveFile = bucket.file(getBrowserFallbackProfileArchiveObject());
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'process-audio-browser-profile-'));
  const browserProfileDir = path.join(profileDir, 'chromium-profile');
  const archivePath = path.join(profileDir, 'chromium-profile.tar.gz');
  const ownerId = `process-audio:${createHash('sha1').update(profileDir).digest('hex')}`;

  try {
    const [archiveExists] = await archiveFile.exists();
    if (!archiveExists) {
      throw buildAnnotatedYouTubeError(
        `In-process browser fallback profile archive ${getBrowserFallbackProfileArchiveObject()} is missing in bucket ${bucketName}.`,
        'browser_fallback'
      );
    }

    await withBrowserProfileLease(realtimeDB, ownerId, async () => {
      await archiveFile.download({ destination: archivePath });
    });

    fs.mkdirSync(browserProfileDir, { recursive: true });
    await runSystemCommand('tar', ['-xzf', archivePath, '-C', browserProfileDir], 'browser profile extract');

    return { profileDir, browserProfileDir, cleanup: true };
  } catch (error) {
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function resolveAudioUrlWithInProcessBrowserFallback(
  ytdlpPath: string,
  youtubeUrl: string,
  realtimeDB: Database,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<BrowserFallbackResolveAudioUrlResponse> {
  const resolution = buildInProcessBrowserFallbackResolution(
    getInProcessBrowserFallbackStrategy() === 'public_only' ? 'none' : 'chromium_profile'
  );

  const fullArgs =
    resolution.credentialSource === 'none'
      ? ['-J', '--no-playlist', '--skip-download', '--no-js-runtimes', '--js-runtimes', getPreferredYtDlpJsRuntime()]
      : ['-J', '--no-playlist', '--skip-download'];
  let hydratedProfile: { profileDir: string; browserProfileDir: string; cleanup: boolean } | null = null;

  try {
    await logObservedOutboundNetworkIdentity(log, 'before_in_process_browser_fallback_ytdlp');
    applyPreferredIpFamilyArgs(fullArgs);

    if (resolution.credentialSource === 'chromium_profile') {
      hydratedProfile = await hydrateInProcessBrowserProfile(realtimeDB);
      fullArgs.push(
        '--cookies-from-browser',
        `${getLocalBrowserProfileBrowser()}:${hydratedProfile.browserProfileDir}`
      );
    }

    applyYtDlpRequestPacingArgs(fullArgs);
    fullArgs.push(youtubeUrl);

    log.info('Executing in-process browser fallback yt-dlp extraction', {
      youtubeUrl,
      credentialSource: resolution.credentialSource,
      browserProfileBrowser: resolution.credentialSource === 'chromium_profile' ? getLocalBrowserProfileBrowser() : null,
      browserFallbackStrategy: resolution.strategy,
      browserFallbackServiceRole: resolution.serviceRole,
      browserFallbackInvocationKind: 'in_process',
      ytDlpJsRuntime: getPreferredYtDlpJsRuntime(),
      sleepRequestsSeconds: getYtDlpSleepRequestsSeconds() || null,
      sleepIntervalSeconds: getYtDlpSleepIntervalSeconds() || null,
      maxSleepIntervalSeconds: getYtDlpMaxSleepIntervalSeconds() || null,
    });

    const { stdout } = await runCommandWithCapture(
      ytdlpPath,
      fullArgs,
      'In-process browser fallback yt-dlp extraction',
      'browser_fallback'
    );
    const parsed = JSON.parse(stdout) as YouTubeJsonInfo;
    const selected = selectPreferredAudioFormat(parsed.formats || [], parsed.language, parsed);

    if (!selected?.url) {
      throw buildAnnotatedYouTubeError('yt-dlp did not return an audio-only format URL.', 'browser_fallback');
    }

    return {
      url: selected.url,
      format: selected.ext || selected.format_id || 'unknown',
      duration: parsed.duration ?? selected.duration,
      resolution,
    };
  } finally {
    if (hydratedProfile?.cleanup) {
      await rm(hydratedProfile.profileDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function downloadSectionWithInProcessBrowserFallback(
  ytdlpPath: string,
  youtubeUrl: string,
  outputFilePath: string,
  realtimeDB: Database,
  startTime: number,
  duration: number | undefined,
  log: ReturnType<typeof createLoggerWithContext>
): Promise<{
  localFilePath: string;
  response: BrowserFallbackDownloadSectionResponse;
}> {
  const resolved = await resolveAudioUrlWithInProcessBrowserFallback(ytdlpPath, youtubeUrl, realtimeDB, log);
  const effectiveDuration = duration ?? resolved.duration;

  if (!effectiveDuration || effectiveDuration <= 0) {
    throw buildAnnotatedYouTubeError(
      'In-process browser fallback could not determine a valid download duration.',
      'browser_fallback'
    );
  }

  const finalPath = ensureSafeTempPath(`${outputFilePath}.m4a`);
  const ffmpegArgs = ['-y'];
  if (/^https?:\/\//i.test(resolved.url)) {
    ffmpegArgs.push('-user_agent', YTDLP_HTTP_USER_AGENT);
  }
  ffmpegArgs.push(
    '-ss',
    `${startTime}`,
    '-i',
    resolved.url,
    '-t',
    `${effectiveDuration}`,
    '-vn',
    '-acodec',
    'copy',
    finalPath
  );
  await runSystemCommand(getFFmpegPath(), ffmpegArgs, 'In-process browser fallback ffmpeg trim');

  return {
    localFilePath: finalPath,
    response: {
      downloadUrl: `file://${finalPath}`,
      ext: 'm4a',
      resolution: resolved.resolution,
    },
  };
}

export const getYouTubeTrimRoutingDecision = async (
  ytdlpPath: string,
  url: YouTubeUrl,
  realtimeDB: Database,
  ctx?: LogContext
): Promise<YouTubeTrimRoutingDecision> => {
  const log = createLoggerWithContext(ctx);
  const isDevelopment = process.env.NODE_ENV === 'development';
  ensureProductionPoTokenProviderConfigured(isDevelopment);
  const cachedDecision = getCachedAccessDecision(ctx, url);
  if (cachedDecision?.mode === 'browser_fallback') {
    log.info('Using cached YouTube access decision for trim routing', cachedDecision);
    return {
      strategy: 'direct_url',
      reason: 'browser_fallback_required_from_cached_access_decision',
      hasFragments: false,
      likelyDvr: false,
    };
  }
  const baseArgs = ['-J', '--no-playlist', '-f', 'bestaudio/best', '--no-js-runtimes', '--js-runtimes', getPreferredYtDlpJsRuntime()];
  applyPreferredIpFamilyArgs(baseArgs);
  let cookieContext: YouTubeCookieContext | undefined;
  const cleaned = { done: false };

  const buildArgs = (mode: YouTubeExtractionMode, extraCookieArgs: string[] = []): string[] => {
    const args = [...baseArgs];
    applyYtDlpRequestPacingArgs(args);
    if (extraCookieArgs.length > 0) {
      args.push(...extraCookieArgs);
    }
    applyYouTubeExtractorArgs(args, mode, log);
    args.push(url);
    return args;
  };

  const classifyOutput = (stdout: string): YouTubeTrimRoutingDecision => {
    let parsed: YouTubeJsonInfo;
    try {
      parsed = JSON.parse(stdout) as YouTubeJsonInfo;
    } catch (err) {
      throw new Error(`Failed to parse yt-dlp JSON output for routing: ${err instanceof Error ? err.message : String(err)}`);
    }

    const formats = Array.isArray(parsed.formats) ? parsed.formats : [];
    const selected = selectPreferredAudioFormat(formats, parsed.language, parsed);
    if (!selected) {
      return {
        strategy: 'direct_url',
        reason: 'no_audio_format_selected',
        hasFragments: false,
        likelyDvr: false,
      };
    }

    const fragmentUrls = (selected.fragments ?? []).map((f) => f?.url).filter((u): u is string => !!u);
    const firstFragmentUrl = fragmentUrls[0] ?? '';
    const hasFragments = fragmentUrls.length > 0;
    const likelyDvr =
      hasFragments &&
      (firstFragmentUrl.includes('playlist_type/DVR') ||
        firstFragmentUrl.includes('/source/yt_live_broadcast') ||
        firstFragmentUrl.includes('/live/1/'));

    if (likelyDvr) {
      return {
        strategy: 'section_download',
        reason: 'dvr_fragmented_audio_detected',
        formatId: selected.format_id,
        protocol: selected.protocol,
        hasFragments: true,
        likelyDvr: true,
        fragmentCount: fragmentUrls.length,
      };
    }

    return {
      strategy: 'direct_url',
      reason: hasFragments ? 'fragmented_non_dvr_audio_detected' : 'non_fragmented_audio_detected',
      formatId: selected.format_id,
      protocol: selected.protocol,
      hasFragments,
      likelyDvr: false,
      fragmentCount: hasFragments ? fragmentUrls.length : undefined,
    };
  };

  const runAttempt = async (mode: YouTubeExtractionMode, extraCookieArgs: string[] = []): Promise<YouTubeTrimRoutingDecision> => {
    const args = buildArgs(mode, extraCookieArgs);
    log.info('Running YouTube trim routing preflight', {
      url,
      attempt: mode,
      usedCookies: mode === 'cookie_provider',
      command: `${ytdlpPath} ${args.join(' ')}`,
    });
    const { stdout, stderr } = await runCommandWithCapture(ytdlpPath, args, 'yt-dlp routing preflight', mode, ctx);
    if (stderr.trim()) {
      log.debug('yt-dlp routing preflight stderr', { attempt: mode, stderr: stderr.trim() });
    }
    return classifyOutput(stdout);
  };

  try {
    if (shouldUseCookiesForPublicVideos()) {
      cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
      if (cookieContext.cookieBreakerOpen) {
        if (isBrowserFallbackEnabled()) {
          setCachedAccessDecision(ctx, url, {
            state: 'cookie_stale',
            mode: 'browser_fallback',
            reason: 'routing_preflight_cookie_circuit_breaker_open',
            cookieBreakerOpen: true,
            disabledUntil: cookieContext.disabledUntil,
            cookieMetadata: cookieContext.metadata,
            decidedAt: getNowIsoString(),
          });
          return {
            strategy: 'direct_url',
            reason: 'browser_fallback_required_cookie_breaker_open',
            hasFragments: false,
            likelyDvr: false,
          };
        }

        throw buildAnnotatedYouTubeError(
          'Configured cookie-backed YouTube session is disabled by the cookie circuit breaker.',
          'cookie_provider'
        );
      }

      if (shouldPreferCookieProvider(cookieContext)) {
        const activeCookieContext = cookieContext;
        try {
          await runCookieHealthcheck(ytdlpPath, url, activeCookieContext, log, ctx);
          const result = await runAttemptWithRetries(getYouTubeCookieProviderMaxAttempts(), () =>
            runAttempt('cookie_provider', activeCookieContext.args)
          );
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            true,
            undefined,
            undefined,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          setCachedAccessDecision(ctx, url, {
            state: 'cookie_ok',
            mode: 'cookie_provider',
            reason: 'routing_preflight_cookie_preferred_success',
            cookieMetadata: activeCookieContext.metadata,
            decidedAt: getNowIsoString(),
          });
          return result;
        } catch (cookieError) {
          const cookieMessage = cookieError instanceof Error ? cookieError.message : String(cookieError);
          const cookieFailureClass = classifyYouTubeFailure(cookieMessage, 'cookie_provider');
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            false,
            cookieFailureClass,
            cookieMessage,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );

          if (isBrowserFallbackEnabled()) {
            setCachedAccessDecision(ctx, url, {
              state: 'browser_required',
              mode: 'browser_fallback',
              reason: 'routing_preflight_browser_fallback_after_cookie_preferred_failure',
              cookieFailureClass,
              cookieFailureMessage: cookieMessage,
              cookieBreakerOpen: activeCookieContext.cookieBreakerOpen,
              disabledUntil: activeCookieContext.disabledUntil,
              cookieMetadata: activeCookieContext.metadata,
              decidedAt: getNowIsoString(),
            });
            return {
              strategy: 'direct_url',
              reason: 'browser_fallback_required_after_cookie_preferred_failure',
              hasFragments: false,
              likelyDvr: false,
            };
          }

          throw buildAnnotatedYouTubeError(cookieMessage, 'cookie_provider');
        }
      }
    }

    try {
      const result = await runAttemptWithRetries(getYouTubePublicProviderMaxAttempts(), () => runAttempt('public_provider'));
      setCachedAccessDecision(ctx, url, {
        state: 'public_ok',
        mode: 'public_provider',
        reason: 'routing_preflight_public_success',
        decidedAt: getNowIsoString(),
      });
      return result;
    } catch (publicError) {
      const publicMessage = publicError instanceof Error ? publicError.message : String(publicError);
      const publicFailureClass = classifyYouTubeFailure(publicMessage, 'public_provider');
      const shouldUseBrowserFallback = shouldUseBrowserFallbackForPublicFailure(publicMessage);
      log.warn('Public YouTube routing preflight failed', {
        url,
        failureClass: publicFailureClass,
        error: publicMessage,
        shouldUseBrowserFallback,
      });

      cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
      if (
        shouldEscalateToCookieProvider(
          publicFailureClass,
          cookieContext.hasCookies,
          shouldUseCookiesForPublicVideos()
        )
      ) {
        const activeCookieContext = cookieContext;
        try {
          await runCookieHealthcheck(ytdlpPath, url, activeCookieContext, log, ctx);
          const result = await runAttemptWithRetries(getYouTubeCookieProviderMaxAttempts(), () =>
            runAttempt('cookie_provider', activeCookieContext.args)
          );
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            true,
            undefined,
            undefined,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          setCachedAccessDecision(ctx, url, {
            state: 'cookie_ok',
            mode: 'cookie_provider',
            reason: 'routing_preflight_cookie_success',
            publicFailureClass,
            publicFailureMessage: publicMessage,
            cookieMetadata: activeCookieContext.metadata,
            decidedAt: getNowIsoString(),
          });
          return result;
        } catch (cookieError) {
          const cookieMessage = cookieError instanceof Error ? cookieError.message : String(cookieError);
          const cookieFailureClass = classifyYouTubeFailure(cookieMessage, 'cookie_provider');
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            false,
            cookieFailureClass,
            cookieMessage,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          if (shouldUseBrowserFallback) {
            setCachedAccessDecision(ctx, url, {
              state: 'browser_required',
              mode: 'browser_fallback',
              reason: 'routing_preflight_browser_fallback_required',
              publicFailureClass,
              publicFailureMessage: publicMessage,
              cookieFailureClass,
              cookieFailureMessage: cookieMessage,
              cookieBreakerOpen: activeCookieContext.cookieBreakerOpen,
              disabledUntil: activeCookieContext.disabledUntil,
              cookieMetadata: activeCookieContext.metadata,
              decidedAt: getNowIsoString(),
            });
          }
          throw buildAnnotatedYouTubeError(
            `yt-dlp routing preflight failed after public and cookie attempts. public-provider error: ${publicMessage}; cookie-provider error: ${cookieMessage}`,
            'cookie_provider'
          );
        }
      }

      if (shouldUseBrowserFallback) {
        setCachedAccessDecision(ctx, url, {
          state: 'browser_required',
          mode: 'browser_fallback',
          reason: 'routing_preflight_browser_fallback_after_public_failure',
          publicFailureClass,
          publicFailureMessage: publicMessage,
          decidedAt: getNowIsoString(),
        });
        return {
          strategy: 'direct_url',
          reason: 'browser_fallback_required_after_public_failure',
          hasFragments: false,
          likelyDvr: false,
        };
      }

      throw buildAnnotatedYouTubeError(publicMessage, 'public_provider');
    }
  } finally {
    cleanupCookiesFile(cookieContext?.cookiesFilePath, cleaned);
  }
};

/**
 * Gets the direct audio stream URL from YouTube using yt-dlp.
 * This URL can be used directly with FFmpeg for precise seeking.
 *
 * This approach is MORE RELIABLE than --download-sections because:
 * 1. We control the FFmpeg command directly (no silent failures)
 * 2. FFmpeg input seeking on HTTP URLs uses range requests (efficient)
 * 3. If seeking fails, FFmpeg will error out (not silently download from time 0)
 *
 * @returns The direct audio stream URL and format info
 */
export const getYouTubeAudioUrl = async (
  ytdlpPath: string,
  url: YouTubeUrl,
  realtimeDB: Database,
  ctx?: LogContext
): Promise<YouTubeAudioUrlResult> => {
  const log = createLoggerWithContext(ctx);
  const isDevelopment = process.env.NODE_ENV === 'development';
  ensureProductionPoTokenProviderConfigured(isDevelopment);
  const cachedDecision = getCachedAccessDecision(ctx, url);

  log.info('Extracting YouTube audio stream URL', { url, isDevelopment });
  await logObservedOutboundNetworkIdentity(log, 'before_ytdlp_direct_url_extraction');

  // Build yt-dlp command to get direct URL plus request metadata.
  // We need the selected format's http_headers so ffmpeg can replay
  // the media request with the same header shape yt-dlp resolved.
  const baseArgs = [
    '-J',
    '-f',
    'bestaudio/best',
    '--no-playlist',
    '--no-js-runtimes',
    '--js-runtimes',
    getPreferredYtDlpJsRuntime(),
  ];
  applyPreferredIpFamilyArgs(baseArgs);
  applyYtDlpRequestPacingArgs(baseArgs);
  let cookieContext: YouTubeCookieContext | undefined;
  const cleaned = { done: false };

  const buildArgs = (mode: YouTubeExtractionMode, extraCookieArgs: string[] = []): string[] => {
    const args = [...baseArgs];
    if (extraCookieArgs.length > 0) {
      args.push(...extraCookieArgs);
    }
    applyYouTubeExtractorArgs(args, mode, log);
    args.push(url);
    return args;
  };

  const extractFromResult = (
    result: { stdout: string; stderr: string },
    attemptUsesCookies: boolean
  ): YouTubeAudioUrlResult => {
    let parsed: YouTubeJsonInfo;
    try {
      parsed = JSON.parse(result.stdout) as YouTubeJsonInfo;
    } catch (err) {
      log.error('Unexpected yt-dlp JSON output format', {
        stdout: result.stdout,
        stderr: result.stderr,
        usedCookies: attemptUsesCookies,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`Failed to parse yt-dlp JSON output: ${err instanceof Error ? err.message : String(err)}`);
    }

    const selected = selectPreferredAudioFormat(parsed.formats || [], parsed.language, parsed);
    const streamUrl = selected?.url;

    if (streamUrl && streamUrl.startsWith('http')) {
      const httpHeaders = selected?.http_headers && Object.keys(selected.http_headers).length > 0 ? selected.http_headers : undefined;
      const bindingDetails = extractMediaUrlBindingDetails(streamUrl);
      log.info('Successfully extracted YouTube audio URL', {
        format: selected?.ext || selected?.format_id || 'unknown',
        selectedFormatId: selected?.format_id || null,
        selectedProtocol: selected?.protocol || null,
        selectedLanguage: selected?.language || null,
        selectedFormatNote: selected?.format_note || null,
        selectedHasVideo: selected ? selected.vcodec !== 'none' : null,
        videoLanguage: parsed.language || null,
        liveStatus: parsed.live_status || null,
        wasLive: parsed.was_live === true,
        duration: parsed.duration ?? selected?.duration,
        urlLength: streamUrl.length,
        urlPreview: streamUrl.substring(0, 100) + '...',
        usedCookies: attemptUsesCookies,
        httpHeaderKeys: httpHeaders ? Object.keys(httpHeaders) : [],
        userAgentHeader: httpHeaders?.['User-Agent'] || null,
        mediaHost: bindingDetails.host,
        mediaBoundIp: bindingDetails.boundIp,
        mediaBoundIpFamily: bindingDetails.boundIpFamily,
      });
      return {
        url: streamUrl,
        format: selected?.ext || selected?.format_id || 'unknown',
        duration: parsed.duration ?? selected?.duration,
        httpHeaders,
      };
    }

    log.error('yt-dlp JSON output did not include a valid audio URL', {
      stderr: result.stderr,
      usedCookies: attemptUsesCookies,
      selectedFormatId: selected?.format_id || null,
      selectedProtocol: selected?.protocol || null,
      availableAudioFormats: (parsed.formats || [])
        .filter((format) => format?.vcodec === 'none')
        .map((format) => format?.format_id)
        .filter(Boolean),
    });
    throw new Error('yt-dlp did not return a valid audio URL');
  };

  const runExtractionAttempt = async (
    mode: YouTubeExtractionMode,
    attemptArgs: string[]
  ): Promise<YouTubeAudioUrlResult> => {
    log.debug('Executing yt-dlp to get audio URL', {
      command: `${ytdlpPath} ${attemptArgs.join(' ')}`,
      attempt: mode,
      usedCookies: mode === 'cookie_provider',
    });

    const result = await runCommandWithCapture(ytdlpPath, attemptArgs, 'yt-dlp direct URL extraction', mode, ctx);
    return extractFromResult(result, mode === 'cookie_provider');
  };

  const logAndReturnResolvedAudio = (
    result: YouTubeAudioUrlResult,
    fields: Record<string, unknown>
  ): YouTubeAudioUrlResult => {
    logSelectedYouTubeServingPath(log, {
      youtubeUrl: url,
      outputType: 'resolve_audio_url',
      ...fields,
    });
    return result;
  };

  try {
    if (cachedDecision?.mode === 'browser_fallback') {
      log.info('Using cached browser fallback decision for direct URL extraction', cachedDecision);
      const fallback = await invokeBrowserFallbackResolveAudioUrl(
        ytdlpPath,
        url,
        realtimeDB,
        {
          action: 'resolve_audio_url',
          youtubeUrl: url,
          requestContext: ctx,
        },
        log
      );

      return logAndReturnResolvedAudio(
        {
          url: fallback.response.url,
          format: fallback.response.format || 'unknown',
          duration: fallback.response.duration,
        },
        {
          selectedMode: 'browser_fallback',
          endpointKind: fallback.endpointKind,
          fallbackUrl: fallback.fallbackUrl,
          browserFallbackInvocationKind: fallback.invocationKind,
          credentialSource: fallback.response.resolution?.credentialSource || 'unknown',
          browserFallbackStrategy: fallback.response.resolution?.strategy || 'unknown',
          browserFallbackServiceRole: fallback.response.resolution?.serviceRole || null,
          decisionReason: cachedDecision.reason,
        }
      );
    }

    if (cachedDecision?.mode === 'cookie_provider') {
      log.info('Using cached cookie-backed decision for direct URL extraction', cachedDecision);
      cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
      if (cookieContext.cookieBreakerOpen) {
        throw buildAnnotatedYouTubeError(
          'Cached cookie-backed YouTube session is disabled by the cookie circuit breaker.',
          'cookie_provider'
        );
      }

      const cookieResult = await runExtractionAttempt('cookie_provider', buildArgs('cookie_provider', cookieContext.args));
      await recordCookieAttemptOutcome(
        realtimeDB,
        'cookie_provider',
        true,
        undefined,
        undefined,
        cookieContext.metadata,
        getYouTubeVideoId(url),
        log
      );
      return logAndReturnResolvedAudio(cookieResult, {
        selectedMode: 'cookie_provider',
        credentialSource: cookieContext.source,
        cookieMetadata: cookieContext.metadata,
        decisionReason: cachedDecision.reason,
      });
    }

    if (shouldUseCookiesForPublicVideos()) {
      cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
      if (cookieContext.cookieBreakerOpen) {
        throw buildAnnotatedYouTubeError(
          'Configured cookie-backed YouTube session is disabled by the cookie circuit breaker.',
          'cookie_provider'
        );
      }

      if (shouldPreferCookieProvider(cookieContext)) {
        const activeCookieContext = cookieContext;
        try {
          await runCookieHealthcheck(ytdlpPath, url, activeCookieContext, log, ctx);
          const cookieResult = await runAttemptWithRetries(getYouTubeCookieProviderMaxAttempts(), () =>
            runExtractionAttempt('cookie_provider', buildArgs('cookie_provider', activeCookieContext.args))
          );
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            true,
            undefined,
            undefined,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          setCachedAccessDecision(ctx, url, {
            state: 'cookie_ok',
            mode: 'cookie_provider',
            reason: 'direct_url_cookie_preferred_success',
            cookieMetadata: activeCookieContext.metadata,
            decidedAt: getNowIsoString(),
          });
          return logAndReturnResolvedAudio(cookieResult, {
            selectedMode: 'cookie_provider',
            credentialSource: activeCookieContext.source,
            cookieMetadata: activeCookieContext.metadata,
            decisionReason: 'direct_url_cookie_preferred_success',
          });
        } catch (cookieAttemptError) {
          const cookieMessage = cookieAttemptError instanceof Error ? cookieAttemptError.message : String(cookieAttemptError);
          const cookieFailureClass = classifyYouTubeFailure(cookieMessage, 'cookie_provider');
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            false,
            cookieFailureClass,
            cookieMessage,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );

          if (isBrowserFallbackEnabled()) {
            setCachedAccessDecision(ctx, url, {
              state: 'browser_required',
              mode: 'browser_fallback',
              reason: 'direct_url_browser_fallback_after_cookie_preferred_failure',
              cookieFailureClass,
              cookieFailureMessage: cookieMessage,
              cookieMetadata: activeCookieContext.metadata,
              cookieBreakerOpen: activeCookieContext.cookieBreakerOpen,
              disabledUntil: activeCookieContext.disabledUntil,
              decidedAt: getNowIsoString(),
            });
            const fallback = await invokeBrowserFallbackResolveAudioUrl(
              ytdlpPath,
              url,
              realtimeDB,
              {
                action: 'resolve_audio_url',
                youtubeUrl: url,
                requestContext: ctx,
              },
              log
            );

            return logAndReturnResolvedAudio(
              {
                url: fallback.response.url,
                format: fallback.response.format || 'unknown',
                duration: fallback.response.duration,
              },
              {
                selectedMode: 'browser_fallback',
                endpointKind: fallback.endpointKind,
                fallbackUrl: fallback.fallbackUrl,
                browserFallbackInvocationKind: fallback.invocationKind,
                credentialSource: fallback.response.resolution?.credentialSource || 'unknown',
                browserFallbackStrategy: fallback.response.resolution?.strategy || 'unknown',
                browserFallbackServiceRole: fallback.response.resolution?.serviceRole || null,
                decisionReason: 'direct_url_browser_fallback_after_cookie_preferred_failure',
                cookieFailureClass,
              }
            );
          }

          throw buildAnnotatedYouTubeError(cookieMessage, 'cookie_provider');
        }
      }
    }

    try {
      const publicResult = await runAttemptWithRetries(getYouTubePublicProviderMaxAttempts(), () =>
        runExtractionAttempt('public_provider', buildArgs('public_provider'))
      );
      setCachedAccessDecision(ctx, url, {
        state: 'public_ok',
        mode: 'public_provider',
        reason: 'direct_url_public_success',
        decidedAt: getNowIsoString(),
      });
      return logAndReturnResolvedAudio(publicResult, {
        selectedMode: 'public_provider',
        credentialSource: 'none',
        decisionReason: 'direct_url_public_success',
      });
    } catch (publicError) {
      const publicMessage = publicError instanceof Error ? publicError.message : String(publicError);
      const publicFailureClass = classifyYouTubeFailure(publicMessage, 'public_provider');
      const shouldUseBrowserFallback = shouldUseBrowserFallbackForPublicFailure(publicMessage);
      log.warn('Public YouTube direct URL extraction failed', {
        url,
        failureClass: publicFailureClass,
        error: publicMessage,
        shouldUseBrowserFallback,
      });

      cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
      if (
        shouldEscalateToCookieProvider(
          publicFailureClass,
          cookieContext.hasCookies,
          shouldUseCookiesForPublicVideos()
        )
      ) {
        const activeCookieContext = cookieContext;
        try {
          await runCookieHealthcheck(ytdlpPath, url, activeCookieContext, log, ctx);
          const cookieResult = await runAttemptWithRetries(getYouTubeCookieProviderMaxAttempts(), () =>
            runExtractionAttempt('cookie_provider', buildArgs('cookie_provider', activeCookieContext.args))
          );
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            true,
            undefined,
            undefined,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          setCachedAccessDecision(ctx, url, {
            state: 'cookie_ok',
            mode: 'cookie_provider',
            reason: 'direct_url_cookie_success',
            publicFailureClass,
            publicFailureMessage: publicMessage,
            cookieMetadata: activeCookieContext.metadata,
            decidedAt: getNowIsoString(),
          });
          return logAndReturnResolvedAudio(cookieResult, {
            selectedMode: 'cookie_provider',
            credentialSource: activeCookieContext.source,
            cookieMetadata: activeCookieContext.metadata,
            decisionReason: 'direct_url_cookie_success',
            publicFailureClass,
          });
        } catch (cookieAttemptError) {
          const cookieMessage = cookieAttemptError instanceof Error ? cookieAttemptError.message : String(cookieAttemptError);
          const cookieFailureClass = classifyYouTubeFailure(cookieMessage, 'cookie_provider');
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            false,
            cookieFailureClass,
            cookieMessage,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );

          if (shouldUseBrowserFallback) {
            setCachedAccessDecision(ctx, url, {
              state: 'browser_required',
              mode: 'browser_fallback',
              reason: 'direct_url_browser_fallback_after_cookie_failure',
              publicFailureClass,
              publicFailureMessage: publicMessage,
              cookieFailureClass,
              cookieFailureMessage: cookieMessage,
              cookieMetadata: activeCookieContext.metadata,
              cookieBreakerOpen: activeCookieContext.cookieBreakerOpen,
              disabledUntil: activeCookieContext.disabledUntil,
              decidedAt: getNowIsoString(),
            });
            const fallback = await invokeBrowserFallbackResolveAudioUrl(
              ytdlpPath,
              url,
              realtimeDB,
              {
                action: 'resolve_audio_url',
                youtubeUrl: url,
                requestContext: ctx,
              },
              log
            );

            return logAndReturnResolvedAudio(
              {
                url: fallback.response.url,
                format: fallback.response.format || 'unknown',
                duration: fallback.response.duration,
              },
              {
                selectedMode: 'browser_fallback',
                endpointKind: fallback.endpointKind,
                fallbackUrl: fallback.fallbackUrl,
                browserFallbackInvocationKind: fallback.invocationKind,
                credentialSource: fallback.response.resolution?.credentialSource || 'unknown',
                browserFallbackStrategy: fallback.response.resolution?.strategy || 'unknown',
                browserFallbackServiceRole: fallback.response.resolution?.serviceRole || null,
                decisionReason: 'direct_url_browser_fallback_after_cookie_failure',
                publicFailureClass,
                cookieFailureClass,
              }
            );
          }

          throw buildAnnotatedYouTubeError(
            `yt-dlp failed after public and cookie direct URL attempts. public-provider error: ${publicMessage}; cookie-provider error: ${cookieMessage}`,
            'cookie_provider'
          );
        }
      }

      if (shouldUseBrowserFallback) {
        setCachedAccessDecision(ctx, url, {
          state: 'browser_required',
          mode: 'browser_fallback',
          reason: 'direct_url_browser_fallback_after_public_failure',
          publicFailureClass,
          publicFailureMessage: publicMessage,
          decidedAt: getNowIsoString(),
        });
        const fallback = await invokeBrowserFallbackResolveAudioUrl(
          ytdlpPath,
          url,
          realtimeDB,
          {
            action: 'resolve_audio_url',
            youtubeUrl: url,
            requestContext: ctx,
          },
          log
        );

        return logAndReturnResolvedAudio(
          {
            url: fallback.response.url,
            format: fallback.response.format || 'unknown',
            duration: fallback.response.duration,
          },
          {
            selectedMode: 'browser_fallback',
            endpointKind: fallback.endpointKind,
            fallbackUrl: fallback.fallbackUrl,
            browserFallbackInvocationKind: fallback.invocationKind,
            credentialSource: fallback.response.resolution?.credentialSource || 'unknown',
            browserFallbackStrategy: fallback.response.resolution?.strategy || 'unknown',
            browserFallbackServiceRole: fallback.response.resolution?.serviceRole || null,
            decisionReason: 'direct_url_browser_fallback_after_public_failure',
            publicFailureClass,
          }
        );
      }

      throw buildAnnotatedYouTubeError(publicMessage, 'public_provider');
    }
  } finally {
    cleanupCookiesFile(cookieContext?.cookiesFilePath, cleaned);
  }
};

export const processYouTubeUrl = async (
  ytdlpPath: string,
  url: YouTubeUrl,
  cancelToken: CancelToken,
  passThrough: Writable,
  updateProgressCallback: (progress: number) => void,
  realtimeDB: Database,
  startTime?: number,
  duration?: number,
  ctx?: LogContext
): Promise<ChildProcessWithoutNullStreams> => {
  const log = createLoggerWithContext(ctx);
  const isDevelopment = process.env.NODE_ENV === 'development';
  ensureProductionPoTokenProviderConfigured(isDevelopment);

  log.info('Starting YouTube download (stream to stdout)', { url, isDevelopment, startTime, duration });

  if (cancelToken.isCancellationRequested) {
    throw new Error('getYouTubeStream operation was cancelled');
  }
  let totalBytes = 0;
  let previousPercent = -1;
  let cookieContext: YouTubeCookieContext | undefined;
  const cleaned = { done: false };

  const resolveSelectedFormatId = async (): Promise<{
    formatId: string;
    extractionMode: YouTubeExtractionMode;
    protocol: string | null;
    fragmentCount: number;
  }> =>
    resolvePreferredAudioFormatId(ytdlpPath, url, realtimeDB, isDevelopment, log, ctx, 'streaming', (context) => {
      cookieContext = context;
    });

  const { formatId, extractionMode, protocol, fragmentCount } = await resolveSelectedFormatId();

  // Pipes output to stdout - downloads FULL stream, seeking handled by our FFmpeg
  const args = ['-f', formatId, '-N', getYtDlpConcurrentFragments(), '--no-playlist', '-o', '-'];
  applyPreferredIpFamilyArgs(args);
  maybeApplyYtDlpRequestPacingArgs(args, log, {
    protocol,
    fragmentCount,
    context: 'streaming_download',
  });
  if (cookieContext?.args.length) {
    args.push(...cookieContext.args);
  }
  applyYouTubeExtractorArgs(args, extractionMode, log);

  // Add JS runtime
  args.push('--no-js-runtimes', '--js-runtimes', getPreferredYtDlpJsRuntime());
  log.debug('Using configured JavaScript runtime for yt-dlp', { runtime: getPreferredYtDlpJsRuntime() });

  args.push(url);

  const command = `${ytdlpPath} ${args.join(' ')}`;
  log.debug('Executing yt-dlp streaming command', { command, formatId, extractionMode });
  const ytdlp = spawn(ytdlpPath, args);

  ytdlp.on('error', (err) => {
    cleanupCookiesFile(cookieContext?.cookiesFilePath, cleaned);
    log.error('yt-dlp spawn error', { error: err });
    passThrough.emit('error', new Error(`getYoutubeStream error ${err}`));
  });

  ytdlp.on('close', (code) => {
    cleanupCookiesFile(cookieContext?.cookiesFilePath, cleaned);
    if (code === 0) {
      log.debug('yt-dlp completed successfully', { totalMB: (totalBytes / (1024 * 1024)).toFixed(2) });
    } else {
      log.error('yt-dlp exited with error code', { code });
      passThrough.emit(
        'error',
        new Error('Spawn closed with non-zero error code. Please check logs for more information.')
      );
    }
  });

  ytdlp.stdout.on('end', () => {
    log.debug('yt-dlp stdout ended', { totalMB: (totalBytes / (1024 * 1024)).toFixed(2) });
  });

  ytdlp.stderr?.on('error', (err) => {
    log.error('yt-dlp stderr error', { error: err });
    passThrough.emit('error', new Error(`getYoutubeStream error: ${err}`));
  });

  ytdlp.stderr?.on('data', (data) => {
    if (cancelToken.isCancellationRequested) {
      passThrough.emit('error', new Error('getYouTubeStream operation was cancelled'));
      return;
    }
    const stderrStr = data.toString();

    // Log verbose output when using --download-sections for debugging
    if (startTime !== undefined && startTime !== null) {
      // Only log verbose lines that might be useful (not all of them to avoid spam)
      if (
        stderrStr.includes('ffmpeg') ||
        stderrStr.includes('ERROR') ||
        stderrStr.includes('WARNING') ||
        stderrStr.includes('Downloading')
      ) {
        log.debug('yt-dlp verbose output', { stderr: stderrStr.trim() });
      }
    }

    if (stderrStr.includes('download')) {
      const percent = extractPercent(stderrStr);
      if (percent !== null) {
        // Only update if percent has changed by an integer value (at least 1%)
        const percentInt = Math.floor(percent);
        if (percentInt !== previousPercent) {
          previousPercent = percentInt;
          updateProgressCallback(percent);
        }
      }
    }
    // Check for fatal errors - some errors might be non-fatal warnings
    if (stderrStr.includes('ERROR')) {
      // Some errors might occur after successful download (e.g., cleanup errors)
      // Only treat as fatal if it's a critical error
      const errorLower = stderrStr.toLowerCase();
      const isFatalError =
        errorLower.includes('aborting') ||
        errorLower.includes('failed') ||
        errorLower.includes('cannot') ||
        (errorLower.includes('ffmpeg exited') && !errorLower.includes('code 0'));

      if (isFatalError) {
        log.error('yt-dlp fatal error detected', { stderr: stderrStr.trim() });
        passThrough.emit('error', new Error(stderrStr.trim()));
        return;
      } else {
        // Non-fatal error/warning - log but don't fail
        log.warn('yt-dlp non-fatal error/warning', { stderr: stderrStr.trim() });
      }
    }
  });

  ytdlp.stdout?.on('data', (data) => {
    totalBytes += data.length;
  });

  // Handle EPIPE errors gracefully - they occur when the destination closes the pipe
  // Set up error handlers BEFORE piping to catch all errors
  ytdlp.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      log.debug('yt-dlp stdout EPIPE - destination may have closed pipe', { code: err.code });
      // EPIPE is expected when the destination (ffmpeg) closes stdin - don't treat as fatal
    } else {
      log.error('yt-dlp stdout error', { error: err, code: err.code });
      passThrough.emit('error', err);
    }
  });

  // Handle EPIPE on passThrough as well
  passThrough.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      log.debug('PassThrough EPIPE - ffmpeg may have closed stdin', { code: err.code });
      // Don't emit error for EPIPE - it's expected behavior when seeking
    } else {
      log.error('PassThrough error', { error: err, code: err.code });
    }
  });

  // Use end: false to prevent automatic closing - let the destination control when to end
  ytdlp.stdout.pipe(passThrough, { end: false });

  return ytdlp;
};

async function resolvePreferredAudioFormatId(
  ytdlpPath: string,
  url: YouTubeUrl,
  realtimeDB: Database,
  isDevelopment: boolean,
  log: ReturnType<typeof createLoggerWithContext>,
  ctx: LogContext | undefined,
  purpose: 'streaming' | 'download',
  onCookieContext?: (cookieContext: YouTubeCookieContext | undefined) => void
): Promise<{
  formatId: string;
  extractionMode: YouTubeExtractionMode;
  protocol: string | null;
  fragmentCount: number;
  durationSeconds: number | null;
}> {
  const baseArgs = [
    '-J',
    '-f',
    'bestaudio/best',
    '--no-playlist',
    '--skip-download',
    '--no-js-runtimes',
    '--js-runtimes',
    getPreferredYtDlpJsRuntime(),
  ];
  applyPreferredIpFamilyArgs(baseArgs);
  applyYtDlpRequestPacingArgs(baseArgs);

  const buildArgs = (mode: YouTubeExtractionMode, extraCookieArgs: string[] = []): string[] => {
    const args = [...baseArgs];
    if (extraCookieArgs.length > 0) {
      args.push(...extraCookieArgs);
    }
    applyYouTubeExtractorArgs(args, mode, log);
    args.push(url);
    return args;
  };

  const parseSelectedFormat = (
    stdout: string
  ): { formatId: string; protocol: string | null; fragmentCount: number; durationSeconds: number | null } => {
    const parsed = JSON.parse(stdout) as YouTubeJsonInfo;
    const selected = selectPreferredAudioFormat(parsed.formats || [], parsed.language, parsed);
    if (!selected?.format_id) {
      throw new Error(`yt-dlp did not return a preferred audio format for ${purpose}`);
    }
    const fragmentCount = Array.isArray(selected.fragments) ? selected.fragments.length : 0;
    const durationSeconds =
      typeof parsed.duration === 'number' && Number.isFinite(parsed.duration)
        ? parsed.duration
        : typeof selected.duration === 'number' && Number.isFinite(selected.duration)
        ? selected.duration
        : null;
    log.info(`Selected preferred YouTube audio format for ${purpose}`, {
      formatId: selected.format_id,
      selectedProtocol: selected.protocol || null,
      selectedLanguage: selected.language || null,
      selectedFormatNote: selected.format_note || null,
      selectedHasVideo: selected.vcodec !== 'none',
      selectedFragmentCount: fragmentCount,
      videoLanguage: parsed.language || null,
      liveStatus: parsed.live_status || null,
      wasLive: parsed.was_live === true,
      durationSeconds,
    });
    return {
      formatId: selected.format_id,
      protocol: selected.protocol || null,
      fragmentCount,
      durationSeconds,
    };
  };

  if (shouldUseCookiesForPublicVideos()) {
    const cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
    onCookieContext?.(cookieContext);
    const mode: YouTubeExtractionMode = cookieContext.hasCookies ? 'cookie_provider' : 'public_provider';
    const { stdout } = await runCommandWithCapture(
      ytdlpPath,
      buildArgs(mode, cookieContext.args),
      `yt-dlp ${purpose} format selection`,
      mode,
      ctx
    );
    return { ...parseSelectedFormat(stdout), extractionMode: mode };
  }

  onCookieContext?.(undefined);
  const { stdout } = await runCommandWithCapture(
    ytdlpPath,
    buildArgs('public_provider'),
    `yt-dlp ${purpose} format selection`,
    'public_provider',
    ctx
  );
  return { ...parseSelectedFormat(stdout), extractionMode: 'public_provider' };
}

export const downloadYouTubeAudioToFile = async (
  ytdlpPath: string,
  url: YouTubeUrl,
  outputFilePath: string,
  cancelToken: CancelToken,
  updateProgressCallback: (progress: number) => void,
  realtimeDB: Database,
  ctx?: LogContext
): Promise<string> => {
  const log = createLoggerWithContext(ctx);
  const isDevelopment = process.env.NODE_ENV === 'development';
  ensureProductionPoTokenProviderConfigured(isDevelopment);

  log.info('Starting YouTube download to local file', { url, outputFilePath });

  if (cancelToken.isCancellationRequested) {
    throw new Error('downloadYouTubeAudioToFile operation was cancelled');
  }

  let previousPercent = -1;
  let cookieContext: YouTubeCookieContext | undefined;
  const cleaned = { done: false };
  const directAudioFormatSelector = getPreferredDirectAudioFormatSelector();

  type DownloadAttemptConfig = {
    formatSpec: string;
    logFormatId: string;
    protocol: string | null;
    fragmentCount: number;
    durationSeconds: number | null;
    dashConcurrency: string | null;
    abortOnUnavailableFragments: boolean;
    useConcurrentFragments: boolean;
    useRequestPacing: boolean;
    useExternalDownloader: boolean;
    noPart: boolean;
    noContinue: boolean;
    extractAudio: boolean;
    attemptStrategy: 'direct_audio' | 'resolved_fallback';
  };

  const buildArgs = (
    mode: YouTubeExtractionMode,
    config: DownloadAttemptConfig,
    extraCookieArgs: string[] = []
  ): string[] => {
    const args = ['-f', config.formatSpec, '--no-playlist', '-o', `${outputFilePath}.%(ext)s`];
    if (config.useConcurrentFragments) {
      args.push('-N', config.dashConcurrency || getYtDlpConcurrentFragments());
    }
    if (config.abortOnUnavailableFragments) {
      args.push('--abort-on-unavailable-fragments');
    }
    if (config.noPart) {
      args.push('--no-part');
    }
    if (config.noContinue) {
      args.push('--no-continue');
    }
    if (config.extractAudio) {
      args.push('-x');
    }
    applyPreferredIpFamilyArgs(args);
    if (config.useRequestPacing) {
      maybeApplyYtDlpRequestPacingArgs(args, log, {
        protocol: config.protocol,
        fragmentCount: config.fragmentCount,
        context: 'file_download',
      });
    }
    if (extraCookieArgs.length > 0) {
      args.push(...extraCookieArgs);
    }
    if (config.useExternalDownloader) {
      maybeApplyYtDlpExternalDownloaderArgs(args, log, {
        protocol: config.protocol,
        fragmentCount: config.fragmentCount,
        context: 'file_download',
      });
    }
    args.push('--no-js-runtimes', '--js-runtimes', getPreferredYtDlpJsRuntime());
    applyYouTubeExtractorArgs(args, mode, log);
    args.push(url);
    return args;
  };

  const resolveDownloadedFilePath = (): string => {
    const safeOutputFilePath = ensureSafeTempPath(outputFilePath);
    const dir = path.dirname(safeOutputFilePath);
    const baseName = path.basename(safeOutputFilePath);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const actualFile = files.find((fileName) => {
      const fileBase = path.basename(fileName, path.extname(fileName));
      return fileBase === baseName || fileName.startsWith(baseName);
    });

    if (actualFile) {
      return ensureSafeTempPath(path.join(dir, actualFile));
    }

    if (fs.existsSync(safeOutputFilePath)) {
      return safeOutputFilePath;
    }

    throw new Error(`yt-dlp did not create an output file for ${baseName}`);
  };

  const execute = async (
    mode: YouTubeExtractionMode,
    config: DownloadAttemptConfig,
    extraCookieArgs: string[] = []
  ): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const args = buildArgs(mode, config, extraCookieArgs);
      const command = `${ytdlpPath} ${args.join(' ')}`;
      const stallTimeoutMs = getYtdlpDownloadStallTimeoutMs();
      const stallPollIntervalMs = Math.min(getYtdlpDownloadStallPollIntervalMs(), stallTimeoutMs);
      log.info('Executing yt-dlp file download command', {
        command,
        formatId: config.logFormatId,
        extractionMode: mode,
        attemptStrategy: config.attemptStrategy,
        protocol: config.protocol,
        fragmentCount: config.fragmentCount,
        dashConcurrency: config.dashConcurrency,
        abortOnUnavailableFragments: config.abortOnUnavailableFragments,
        outputTemplate: `${outputFilePath}.%(ext)s`,
        stallTimeoutMs,
        stallPollIntervalMs,
      });

      const ytdlp = spawn(ytdlpPath, args);
      let stderrBuffer = '';
      let stdoutBuffer = '';
      let settled = false;
      let lastActivityAt = Date.now();
      let lastActivityReason = 'spawned';
      let lastObservedPartialFiles: DownloadActivityProbe['partialFiles'] = [];
      let lastEstimatedPercent = -1;
      let lastMeasuredOutputSizeBytes = 0;
      let lastMeasuredOutputPercent = -1;
      let stallPollTimer: NodeJS.Timeout | undefined;

      const rejectWithError = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (stallPollTimer) {
          clearInterval(stallPollTimer);
        }
        reject(error);
      };

      const resolveWithValue = (value: string): void => {
        if (settled) return;
        settled = true;
        if (stallPollTimer) {
          clearInterval(stallPollTimer);
        }
        resolve(value);
      };

      const markActivity = (reason: string): void => {
        lastActivityAt = Date.now();
        lastActivityReason = reason;
      };

      const applyProgressUpdate = (progress: number, source: 'percent' | 'ffmpeg_time' | 'fragment_estimate' | 'file_growth'): void => {
        const boundedProgress = Math.max(0, Math.min(99, progress));
        const percentInt = Math.floor(boundedProgress);
        if (percentInt <= previousPercent) {
          return;
        }

        previousPercent = percentInt;
        if (source === 'fragment_estimate' || source === 'file_growth') {
          lastEstimatedPercent = Math.max(lastEstimatedPercent, percentInt);
        }
        updateProgressCallback(boundedProgress);
      };

      const estimatePercentFromOutputSize = (currentSizeBytes: number): number | null => {
        if (lastMeasuredOutputSizeBytes <= 0 || lastMeasuredOutputPercent <= 0) {
          return null;
        }

        const estimatedTotalBytes = lastMeasuredOutputSizeBytes / (lastMeasuredOutputPercent / 100);
        if (!Number.isFinite(estimatedTotalBytes) || estimatedTotalBytes <= 0) {
          return null;
        }

        return Math.min(99, (currentSizeBytes / estimatedTotalBytes) * 100);
      };

      ytdlp.on('error', (err) => {
        rejectWithError(new Error(`yt-dlp file download spawn error: ${err}`));
      });

      ytdlp.on('close', (code, signal) => {
        if (stallPollTimer) {
          clearInterval(stallPollTimer);
        }
        if (settled) {
          return;
        }
        if (code === 0) {
          try {
            resolveWithValue(resolveDownloadedFilePath());
          } catch (error) {
            rejectWithError(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }

        rejectWithError(
          buildAnnotatedYouTubeError(
            `yt-dlp file download exited with code ${code}${signal ? ` (signal: ${signal})` : ''}. stderr: ${stderrBuffer.trim()} stdout: ${stdoutBuffer.trim()}`,
            mode
          )
        );
      });

      const handleProgressChunk = (chunk: string, source: 'stderr' | 'stdout'): void => {
        markActivity(source);

        if (source === 'stderr') {
          if (stderrBuffer.length < 50_000) {
            stderrBuffer += chunk;
          }
        } else if (stdoutBuffer.length < 50_000) {
          stdoutBuffer += chunk;
        }

        let progressPercent: number | null = null;
        let progressSource: 'percent' | 'ffmpeg_time' | 'fragment_estimate' = 'percent';
        const fragmentProgress = extractFragmentProgressFromLine(chunk);
        const ffmpegTimeSeconds = extractFfmpegTime(chunk);
        if (fragmentProgress && fragmentProgress.total > 0) {
          progressPercent = fragmentProgress.percent;
          progressSource = 'fragment_estimate';
        } else if (ffmpegTimeSeconds !== null && ffmpegTimeSeconds >= 0 && config.durationSeconds && config.durationSeconds > 0) {
          progressPercent = Math.min(99, (ffmpegTimeSeconds / config.durationSeconds) * 100);
          progressSource = 'ffmpeg_time';
        } else if (config.fragmentCount <= 0) {
          progressPercent = extractPercent(chunk);
        }

        if (progressPercent === null) {
          return;
        }

        applyProgressUpdate(progressPercent, progressSource);
        void probePrimaryOutputPartialFile(outputFilePath)
          .then((outputPart) => {
            if (!outputPart || previousPercent <= 0) {
              return;
            }
            lastMeasuredOutputSizeBytes = outputPart.size;
            lastMeasuredOutputPercent = previousPercent;
          })
          .catch(() => {
            // Ignore missing partial file while calibrating progress from downloader output.
          });
      };

      ytdlp.stderr?.on('data', (data) => {
        if (cancelToken.isCancellationRequested) {
          ytdlp.kill('SIGTERM');
          rejectWithError(new Error('Download operation was cancelled'));
          return;
        }

        handleProgressChunk(data.toString(), 'stderr');
      });

      ytdlp.stdout?.on('data', (data) => {
        if (cancelToken.isCancellationRequested) {
          ytdlp.kill('SIGTERM');
          rejectWithError(new Error('Download operation was cancelled'));
          return;
        }

        handleProgressChunk(data.toString(), 'stdout');
      });

      stallPollTimer = setInterval(() => {
        if (settled || cancelToken.isCancellationRequested) {
          return;
        }

        void (async () => {
          const probe = await probeDownloadActivity(outputFilePath);
          const estimatedPercent = extractFragmentProgressPercent(probe.partialFiles, config.fragmentCount);
          if (estimatedPercent !== null) {
            const percentInt = Math.floor(estimatedPercent);
            if (percentInt > previousPercent && percentInt > lastEstimatedPercent) {
              applyProgressUpdate(estimatedPercent, 'fragment_estimate');
              log.info('Estimated yt-dlp download progress from fragment files', {
                extractionMode: mode,
                protocol: config.protocol,
                fragmentCount: config.fragmentCount,
                attemptStrategy: config.attemptStrategy,
                estimatedPercent,
              });
            }
          } else if (probe.partialFiles.length > 0 && previousPercent < 1) {
            applyProgressUpdate(1, 'file_growth');
            log.info('Marked yt-dlp download as active from partial-file growth', {
              extractionMode: mode,
              protocol: config.protocol,
              fragmentCount: config.fragmentCount,
              attemptStrategy: config.attemptStrategy,
            });
          }

          const outputPart = await probePrimaryOutputPartialFile(outputFilePath);
          if (outputPart && outputPart.size > 0) {
            const derivedPercent = estimatePercentFromOutputSize(outputPart.size);
            if (derivedPercent !== null) {
              applyProgressUpdate(derivedPercent, 'file_growth');
            } else if (previousPercent < 1) {
              applyProgressUpdate(1, 'file_growth');
            }
            if (outputPart.mtimeMs > lastActivityAt) {
              markActivity('output_file_growth');
            }
          }

          const latestObservedMtimeMs = probe.latestMtimeMs;
          if (latestObservedMtimeMs !== null && latestObservedMtimeMs > lastActivityAt) {
            lastObservedPartialFiles = probe.partialFiles;
            markActivity('partial_file_growth');
            return;
          }

          if (probe.partialFiles.length > 0) {
            lastObservedPartialFiles = probe.partialFiles;
          }

          const stallDurationMs = Date.now() - lastActivityAt;
          if (stallDurationMs < stallTimeoutMs) {
            return;
          }

          const summarizedFiles = lastObservedPartialFiles.map((file) => ({
            path: file.path,
            size: file.size,
            mtimeMs: file.mtimeMs,
          }));
          const ytdlpState = await probeYtDlpState(outputFilePath);

          log.error('yt-dlp download stalled; terminating process', {
            extractionMode: mode,
            attemptStrategy: config.attemptStrategy,
            outputTemplate: `${outputFilePath}.%(ext)s`,
            stallTimeoutMs,
            stallDurationMs,
            lastActivityReason,
            lastObservedPartialFiles: summarizedFiles,
            ytdlpCurrentFragmentIndex: ytdlpState.currentFragmentIndex,
            ytdlpRawState: ytdlpState.rawState,
          });
          ytdlp.kill('SIGTERM');
          rejectWithError(
            buildAnnotatedYouTubeError(
              `yt-dlp download stalled after ${Math.round(stallDurationMs / 1000)}s without progress. Last activity=${lastActivityReason}. Partial files=${JSON.stringify(
                summarizedFiles
              )}. ytdlState=${JSON.stringify(ytdlpState)}. stderr: ${stderrBuffer.trim()} stdout: ${stdoutBuffer.trim()}`,
              mode
            )
          );
        })().catch((pollError) => {
          log.warn('Failed to inspect yt-dlp partial-file progress during stall detection', {
            extractionMode: mode,
            error: pollError instanceof Error ? pollError.message : String(pollError),
          });
        });
      }, stallPollIntervalMs);
    });

  const buildResolvedFallbackAttempt = (resolved: {
    formatId: string;
    extractionMode: YouTubeExtractionMode;
    protocol: string | null;
    fragmentCount: number;
    durationSeconds: number | null;
  }): DownloadAttemptConfig => {
    const downloadPolicy = resolveYouTubeDownloadPolicy(resolved.protocol, resolved.fragmentCount);
    return {
      formatSpec: resolved.formatId,
      logFormatId: resolved.formatId,
      protocol: resolved.protocol,
      fragmentCount: resolved.fragmentCount,
      durationSeconds: resolved.durationSeconds,
      dashConcurrency: downloadPolicy.dashConcurrency,
      abortOnUnavailableFragments: downloadPolicy.abortOnUnavailableFragments,
      useConcurrentFragments: true,
      useRequestPacing: true,
      useExternalDownloader: downloadPolicy.useExternalDownloader,
      noPart: false,
      noContinue: false,
      extractAudio: false,
      attemptStrategy: 'resolved_fallback',
    };
  };

  const getInitialDownloadAttempt = async (): Promise<{
    mode: YouTubeExtractionMode;
    extraCookieArgs: string[];
    config: DownloadAttemptConfig;
    resolvedFallbackAttempt?: DownloadAttemptConfig;
  }> => {
    if (!shouldUseCookiesForPublicVideos()) {
      return { mode: 'public_provider', extraCookieArgs: [], config: directAudioAttempt };
    }

    cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
    const mode: YouTubeExtractionMode =
      shouldPreferCookieProvider(cookieContext) && !cookieContext.cookieBreakerOpen ? 'cookie_provider' : 'public_provider';
    const extraCookieArgs = mode === 'cookie_provider' ? cookieContext.args : [];

    const resolvedSelection = await resolvePreferredAudioFormatId(
      ytdlpPath,
      url,
      realtimeDB,
      isDevelopment,
      log,
      ctx,
      'download',
      (context) => {
        cookieContext = context;
      }
    );
    const resolvedFallbackAttempt = buildResolvedFallbackAttempt(resolvedSelection);

    if (resolveYouTubeDownloadPolicy(resolvedSelection.protocol, resolvedSelection.fragmentCount).dashFragmentedDownload) {
      log.info('Skipping direct-audio YouTube download attempt for DASH/fragmented selection', {
        url,
        formatId: resolvedSelection.formatId,
        protocol: resolvedSelection.protocol,
        fragmentCount: resolvedSelection.fragmentCount,
        extractionMode: resolvedSelection.extractionMode,
      });
      return {
        mode: resolvedSelection.extractionMode,
        extraCookieArgs: cookieContext?.args || extraCookieArgs,
        config: resolvedFallbackAttempt,
        resolvedFallbackAttempt,
      };
    }

    return {
      mode,
      extraCookieArgs,
      config: directAudioAttempt,
      resolvedFallbackAttempt,
    };
  };

  const directAudioAttempt: DownloadAttemptConfig = {
    formatSpec: directAudioFormatSelector,
    logFormatId: directAudioFormatSelector,
    protocol: 'https',
    fragmentCount: 0,
    durationSeconds: null,
    dashConcurrency: null,
    abortOnUnavailableFragments: false,
    useConcurrentFragments: false,
    useRequestPacing: false,
    useExternalDownloader: false,
    noPart: true,
    noContinue: true,
    extractAudio: true,
    attemptStrategy: 'direct_audio',
  };

  const runAttemptWithOptionalBrowserRefresh = async (
    mode: YouTubeExtractionMode,
    config: DownloadAttemptConfig,
    extraCookieArgs: string[]
  ): Promise<string> => {
    try {
      return await execute(mode, config, extraCookieArgs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!shouldAttemptBrowserCookieRefresh(message, mode, ctx)) {
        throw error;
      }

      try {
        await triggerBrowserYoutubeRefresh(log, ctx as LogContext);
      } catch (refreshError) {
        log.error('Shared browser YouTube session refresh failed before local file download retry', {
          refreshError: refreshError instanceof Error ? refreshError.message : String(refreshError),
          originalError: message,
          attemptStrategy: config.attemptStrategy,
        });
        throw error;
      }

      log.warn('Retrying yt-dlp file download after shared browser YouTube session refresh', {
        extractionMode: mode,
        formatId: config.logFormatId,
        attemptStrategy: config.attemptStrategy,
      });

      return await execute(mode, config, extraCookieArgs);
    }
  };

  try {
    const initialAttempt = await getInitialDownloadAttempt();
    if (initialAttempt.config.attemptStrategy !== 'direct_audio') {
      return await runAttemptWithOptionalBrowserRefresh(initialAttempt.mode, initialAttempt.config, initialAttempt.extraCookieArgs);
    }

    try {
      return await runAttemptWithOptionalBrowserRefresh(initialAttempt.mode, initialAttempt.config, initialAttempt.extraCookieArgs);
    } catch (directAudioError) {
      const directAudioMessage = directAudioError instanceof Error ? directAudioError.message : String(directAudioError);
      log.warn('Primary direct-audio YouTube download failed; falling back to resolved format selection', {
        url,
        directAudioFormatSelector,
        error: directAudioMessage,
      });

      let extractionMode = initialAttempt.mode;
      let resolvedFallbackAttempt = initialAttempt.resolvedFallbackAttempt;

      if (!resolvedFallbackAttempt) {
        const resolvedSelection = await resolvePreferredAudioFormatId(
          ytdlpPath,
          url,
          realtimeDB,
          isDevelopment,
          log,
          ctx,
          'download',
          (context) => {
            cookieContext = context;
          }
        );
        extractionMode = resolvedSelection.extractionMode;
        resolvedFallbackAttempt = buildResolvedFallbackAttempt(resolvedSelection);
      }

      return await runAttemptWithOptionalBrowserRefresh(
        extractionMode,
        resolvedFallbackAttempt,
        cookieContext?.args || []
      );
    }
  } finally {
    cleanupCookiesFile(cookieContext?.cookiesFilePath, cleaned);
  }
};

async function getYouTubeAudioFragments(
  ytdlpPath: string,
  url: YouTubeUrl,
  realtimeDB: Database,
  isDevelopment: boolean,
  log: ReturnType<typeof createLoggerWithContext>,
  ctx?: LogContext
): Promise<YouTubeAudioFragmentsResult> {
  ensureProductionPoTokenProviderConfigured(isDevelopment);
  const baseArgs = ['-J', '--no-playlist', '-f', 'bestaudio/best', '--no-js-runtimes', '--js-runtimes', getPreferredYtDlpJsRuntime()];
  applyPreferredIpFamilyArgs(baseArgs);
  let cookieContext: YouTubeCookieContext | undefined;
  const cleaned = { done: false };

  const buildArgs = (mode: YouTubeExtractionMode, extraCookieArgs: string[] = []): string[] => {
    const args = [...baseArgs];
    applyYtDlpRequestPacingArgs(args);
    if (extraCookieArgs.length > 0) {
      args.push(...extraCookieArgs);
    }
    applyYouTubeExtractorArgs(args, mode, log);
    args.push(url);
    return args;
  };

  const parseJson = (stdout: string): YouTubeAudioFragmentsResult => {
    let parsed: YouTubeJsonInfo;
    try {
      parsed = JSON.parse(stdout) as YouTubeJsonInfo;
    } catch (err) {
      throw new Error(`Failed to parse yt-dlp JSON output: ${err instanceof Error ? err.message : String(err)}`);
    }

    const formats = Array.isArray(parsed.formats) ? parsed.formats : [];
    const selected = selectPreferredAudioFormat(formats, parsed.language, parsed);
    if (!selected) {
      throw new Error('No audio format was returned by yt-dlp');
    }

    const fragmentUrls = (selected.fragments ?? []).map((f) => f?.url).filter((u): u is string => !!u);
    if (fragmentUrls.length === 0) {
      throw new Error('No audio format with fragment list was returned by yt-dlp');
    }

    const totalDuration =
      (typeof parsed.duration === 'number' && Number.isFinite(parsed.duration) ? parsed.duration : undefined) ??
      (typeof selected.duration === 'number' && Number.isFinite(selected.duration) ? selected.duration : undefined);
    const urlFragmentDuration = parseFragmentDurationFromUrl(fragmentUrls[0]);
    const averageFragmentDuration =
      totalDuration && fragmentUrls.length > 0 ? totalDuration / fragmentUrls.length : undefined;
    const fragmentDurationSeconds = urlFragmentDuration ?? averageFragmentDuration ?? 5;

    return {
      duration: totalDuration,
      formatId: selected.format_id ?? 'unknown',
      ext: selected.ext ?? 'm4a',
      fragmentUrls,
      fragmentDurationSeconds,
    };
  };

  const tryAttempt = async (mode: YouTubeExtractionMode, extraCookieArgs: string[] = []): Promise<YouTubeAudioFragmentsResult> => {
    const args = buildArgs(mode, extraCookieArgs);
    log.info('Extracting YouTube fragment metadata for targeted section download', {
      url,
      attempt: mode,
      usedCookies: mode === 'cookie_provider',
      command: `${ytdlpPath} ${args.join(' ')}`,
    });
    const { stdout, stderr } = await runCommandWithCapture(
      ytdlpPath,
      args,
      'yt-dlp fragment metadata extraction',
      mode,
      ctx
    );
    if (stderr.trim()) {
      log.debug('yt-dlp fragment metadata stderr', { attempt: mode, stderr: stderr.trim() });
    }
    return parseJson(stdout);
  };

  try {
    if (shouldUseCookiesForPublicVideos()) {
      cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
      if (cookieContext.cookieBreakerOpen) {
        throw buildAnnotatedYouTubeError(
          'Configured cookie-backed YouTube session is disabled by the cookie circuit breaker.',
          'cookie_provider'
        );
      }

      if (shouldPreferCookieProvider(cookieContext)) {
        const activeCookieContext = cookieContext;
        try {
          await runCookieHealthcheck(ytdlpPath, url, activeCookieContext, log, ctx);
          const result = await runAttemptWithRetries(getYouTubeCookieProviderMaxAttempts(), () =>
            tryAttempt('cookie_provider', activeCookieContext.args)
          );
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            true,
            undefined,
            undefined,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          return result;
        } catch (cookieError) {
          const cookieMessage = cookieError instanceof Error ? cookieError.message : String(cookieError);
          const cookieFailureClass = classifyYouTubeFailure(cookieMessage, 'cookie_provider');
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            false,
            cookieFailureClass,
            cookieMessage,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          throw buildAnnotatedYouTubeError(cookieMessage, 'cookie_provider');
        }
      }
    }

    try {
      return await tryAttempt('public_provider');
    } catch (publicError) {
      const publicMessage = publicError instanceof Error ? publicError.message : String(publicError);
      const publicFailureClass = classifyYouTubeFailure(publicMessage, 'public_provider');
      log.warn('Public YouTube fragment metadata extraction failed', {
        url,
        failureClass: publicFailureClass,
        error: publicMessage,
      });

      cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
      if (
        shouldEscalateToCookieProvider(
          publicFailureClass,
          cookieContext.hasCookies,
          shouldUseCookiesForPublicVideos()
        )
      ) {
        const activeCookieContext = cookieContext;
        try {
          await runCookieHealthcheck(ytdlpPath, url, activeCookieContext, log, ctx);
          const result = await runAttemptWithRetries(getYouTubeCookieProviderMaxAttempts(), () =>
            tryAttempt('cookie_provider', activeCookieContext.args)
          );
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            true,
            undefined,
            undefined,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          return result;
        } catch (cookieError) {
          const cookieMessage = cookieError instanceof Error ? cookieError.message : String(cookieError);
          const cookieFailureClass = classifyYouTubeFailure(cookieMessage, 'cookie_provider');
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            false,
            cookieFailureClass,
            cookieMessage,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          throw buildAnnotatedYouTubeError(
            `yt-dlp fragment metadata extraction failed after public and cookie attempts. public-provider error: ${publicMessage}; cookie-provider error: ${cookieMessage}`,
            'cookie_provider'
          );
        }
      }

      throw buildAnnotatedYouTubeError(publicMessage, 'public_provider');
    }
  } finally {
    cleanupCookiesFile(cookieContext?.cookiesFilePath, cleaned);
  }
}

async function downloadYouTubeSectionFromFragments(
  ytdlpPath: string,
  url: YouTubeUrl,
  outputFilePath: string,
  cancelToken: CancelToken,
  updateProgressCallback: (progress: number) => void,
  realtimeDB: Database,
  startTime: number,
  duration: number | undefined,
  ctx?: LogContext
): Promise<string> {
  const log = createLoggerWithContext(ctx);
  const isDevelopment = process.env.NODE_ENV === 'development';
  const ffmpegPath = getFFmpegPath();
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'yt-frag-'));

  try {
    const info = await getYouTubeAudioFragments(ytdlpPath, url, realtimeDB, isDevelopment, log, ctx);
    const fragmentCount = info.fragmentUrls.length;
    const fragmentDuration = info.fragmentDurationSeconds;
    const requestedEndForBoundedDownload = duration !== undefined ? startTime + duration : undefined;
    const safetyPaddingFragments = 2;
    const firstIndex = Math.max(0, Math.floor(startTime / fragmentDuration) - safetyPaddingFragments);
    const lastIndex =
      duration !== undefined
        ? Math.min(
            fragmentCount - 1,
            Math.ceil((requestedEndForBoundedDownload as number) / fragmentDuration) + safetyPaddingFragments
          )
        : fragmentCount - 1;

    if (firstIndex > lastIndex) {
      throw new Error(
        `Invalid fragment window for requested range: firstIndex=${firstIndex}, lastIndex=${lastIndex}, startTime=${startTime}, duration=${duration}`
      );
    }

    log.info('Using targeted YouTube fragment window download', {
      url,
      startTime,
      duration,
      fragmentCount,
      fragmentDurationSeconds: fragmentDuration,
      selectedFirstIndex: firstIndex,
      selectedLastIndex: lastIndex,
      selectedFragmentTotal: lastIndex - firstIndex + 1,
      formatId: info.formatId,
      ext: info.ext,
    });

    const fragmentFiles: string[] = [];
    const totalSelected = lastIndex - firstIndex + 1;
    for (let index = firstIndex; index <= lastIndex; index += 1) {
      if (cancelToken.isCancellationRequested) {
        throw new Error('Targeted fragment download cancelled');
      }
      const fragmentUrl = info.fragmentUrls[index];
      const outputName = `frag-${String(index).padStart(6, '0')}.m4a`;
      const outputPath = path.join(workDir, outputName);

      const response = await fetch(fragmentUrl, {
        headers: {
          'User-Agent': YTDLP_HTTP_USER_AGENT,
          Accept: '*/*',
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to download fragment sq=${index}. HTTP ${response.status} ${response.statusText}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(outputPath, bytes);
      fragmentFiles.push(outputPath);

      const completed = index - firstIndex + 1;
      updateProgressCallback(Math.min(95, Math.round((completed / totalSelected) * 95)));
    }

    const fragmentWindowStart = firstIndex * fragmentDuration;
    const localStart = Math.max(0, startTime - fragmentWindowStart);
    const finalOutputPath = ensureSafeTempPath(`${outputFilePath}.m4a`);

    const ffmpegArgs = ['-y'];
    for (const fragmentFile of fragmentFiles) {
      ffmpegArgs.push('-i', fragmentFile);
    }

    // Concatenate downloaded audio fragments in decode domain (stable PTS), then trim precisely.
    const concatFilterInputs = fragmentFiles.map((_, i) => `[${i}:a]`).join('');
    const concatFilter = `${concatFilterInputs}concat=n=${fragmentFiles.length}:v=0:a=1[a]`;
    ffmpegArgs.push('-filter_complex', concatFilter, '-map', '[a]', '-ss', localStart.toFixed(3));
    if (duration !== undefined) {
      ffmpegArgs.push('-t', duration.toFixed(3));
    }
    ffmpegArgs.push('-vn', '-c:a', 'aac', '-b:a', '128k', finalOutputPath);
    await runCommandWithCapture(ffmpegPath, ffmpegArgs, 'ffmpeg fragment concat trim');

    let finalDuration = 0;
    try {
      const probe = await runCommandWithCapture(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', finalOutputPath],
        'ffprobe final fragment section'
      );
      const parsed = Number.parseFloat(probe.stdout.trim());
      finalDuration = Number.isFinite(parsed) ? parsed : 0;
    } catch (probeError) {
      throw new Error(
        `Failed to verify targeted fragment output duration: ${
          probeError instanceof Error ? probeError.message : String(probeError)
        }`
      );
    }

    if (finalDuration < 1) {
      throw new Error(`Targeted fragment output duration is too small (${finalDuration.toFixed(3)}s)`);
    }
    if (duration !== undefined && Math.abs(finalDuration - duration) > 3) {
      throw new Error(
        `Targeted fragment output duration mismatch. expected~${duration.toFixed(3)}s actual=${finalDuration.toFixed(3)}s`
      );
    }

    updateProgressCallback(100);
    log.info('Targeted fragment section download completed', {
      finalOutputPath,
      fragmentWindowStart,
      localStart,
      duration,
      finalDuration,
      selectedFragmentTotal: totalSelected,
    });
    return finalOutputPath;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Downloads only the needed section from YouTube.
 * Strategy order:
 * 1) Targeted fragment-window download + precise local trim (preferred for live DVR manifests)
 * 2) Fallback to yt-dlp --download-sections --force-keyframes-at-cuts
 *
 * @returns Path to the downloaded section file (original format, not MP3)
 */
export const downloadYouTubeSection = async (
  ytdlpPath: string,
  url: YouTubeUrl,
  outputFilePath: string,
  cancelToken: CancelToken,
  updateProgressCallback: (progress: number) => void,
  realtimeDB: Database,
  startTime: number,
  duration: number | undefined,
  ctx?: LogContext
): Promise<string> => {
  const log = createLoggerWithContext(ctx);
  const isDevelopment = process.env.NODE_ENV === 'development';
  ensureProductionPoTokenProviderConfigured(isDevelopment);
  const cachedDecision = getCachedAccessDecision(ctx, url);

  if (cachedDecision?.mode === 'browser_fallback') {
    log.info('Using cached browser fallback decision for section download', cachedDecision);
    const fallback = await invokeBrowserFallbackDownloadSection(
      ytdlpPath,
      url,
      outputFilePath,
      realtimeDB,
      startTime,
      duration,
      {
        action: 'download_section',
        youtubeUrl: url,
        startTime,
        duration,
        requestContext: ctx,
      },
      log
    );
    logSelectedYouTubeServingPath(log, {
      youtubeUrl: url,
      outputType: 'download_section',
      selectedMode: 'browser_fallback',
      endpointKind: fallback.endpointKind,
      fallbackUrl: fallback.fallbackUrl,
      browserFallbackInvocationKind: fallback.invocationKind,
      credentialSource: fallback.response.resolution?.credentialSource || 'unknown',
      browserFallbackStrategy: fallback.response.resolution?.strategy || 'unknown',
      browserFallbackServiceRole: fallback.response.resolution?.serviceRole || null,
      decisionReason: cachedDecision.reason,
    });
    return fallback.localFilePath || (await downloadBrowserFallbackSection(outputFilePath, fallback.response));
  }

  // Preferred strategy for post-live DVR manifests: download only the required fragment window,
  // then do a precise local trim. This avoids ffmpeg seeking the full DASH master manifest.
  try {
    return await downloadYouTubeSectionFromFragments(
      ytdlpPath,
      url,
      outputFilePath,
      cancelToken,
      updateProgressCallback,
      realtimeDB,
      startTime,
      duration,
      ctx
    );
  } catch (fragmentError) {
    log.warn('Targeted fragment strategy failed; falling back to yt-dlp --download-sections', {
      error: fragmentError instanceof Error ? fragmentError.message : String(fragmentError),
      fallback: 'yt-dlp --download-sections --force-keyframes-at-cuts',
    });
  }

  log.info('Downloading YouTube section with precise cuts', {
    url,
    outputFilePath,
    startTime,
    duration,
    isDevelopment,
    note: 'Using --force-keyframes-at-cuts for EXACT timing - yt-dlp re-encodes at cut points',
  });

  if (cancelToken.isCancellationRequested) {
    throw new Error('Download operation was cancelled');
  }

  const startTimeStr = formatTimeForDownloadSections(startTime);
  const endTimeStr = duration !== undefined ? formatTimeForDownloadSections(startTime + duration) : 'inf';
  const sectionRange = `*${startTimeStr}-${endTimeStr}`;

  // Build yt-dlp command to download PRECISELY the requested section:
  // 1. --download-sections: Download only the specified time range
  // 2. --force-keyframes-at-cuts: CRITICAL - Re-encode at cut points for EXACT timing
  //    Without this, yt-dlp uses stream copy (-c copy) which cuts at keyframe boundaries,
  //    resulting in imprecise cuts (extra content before/after requested range).
  //    With this, yt-dlp re-encodes at the cut points, giving us frame-accurate cuts.
  // 3. -o: Output to file - yt-dlp adds extension based on format
  // This approach:
  // - Downloads only the section we need (efficient bandwidth)
  // - Gets EXACT cuts at requested start/end times (no extra content)
  // - yt-dlp handles re-encoding for precise cuts; our ffmpeg applies filters
  const baseArgs = [
    '-f',
    'bestaudio/best', // Get best audio format
    '-N',
    getYtDlpConcurrentFragments(),
    '--no-playlist',
    '--download-sections',
    sectionRange,
    '--force-keyframes-at-cuts', // CRITICAL: Re-encode for precise cuts (not stream copy)
    '-o',
    `${outputFilePath}.%(ext)s`, // Let yt-dlp add extension based on format (webm, m4a, etc.)
  ];
  applyPreferredIpFamilyArgs(baseArgs);
  maybeApplyYtDlpRequestPacingArgs(baseArgs, log, {
    protocol: 'section_download_fragmented',
    fragmentCount: 1,
    context: 'section_download',
  });

  // yt-dlp needs ffmpeg for --download-sections and --force-keyframes-at-cuts
  const ffmpegPath = getFFmpegPath();
  const ffmpegDir = path.dirname(ffmpegPath);
  baseArgs.push('--ffmpeg-location', ffmpegDir);
  baseArgs.push('--verbose'); // Add verbose logging to see ffmpeg commands and detailed errors

  // yt-dlp now expects an external JS runtime for full YouTube support.
  // We default to Node.js here to avoid adding Deno to the container footprint.
  baseArgs.push('--no-js-runtimes', '--js-runtimes', getPreferredYtDlpJsRuntime());
  log.debug('Using configured JavaScript runtime for yt-dlp', { runtime: getPreferredYtDlpJsRuntime() });

  let cookieContext: YouTubeCookieContext | undefined;

  const buildAttemptArgs = (mode: YouTubeExtractionMode, extraCookieArgs: string[] = []): string[] => {
    const args = [...baseArgs];
    if (extraCookieArgs.length > 0) {
      args.push(...extraCookieArgs);
    }
    maybeApplyYtDlpExternalDownloaderArgs(args, log, {
      protocol: 'section_download_fragmented',
      fragmentCount: 1,
      context: 'section_download',
    });
    applyYouTubeExtractorArgs(args, mode, log);
    args.push(url);
    return args;
  };

  const runSectionDownloadAttempt = async (
    mode: YouTubeExtractionMode,
    attemptArgs: string[]
  ): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      let previousPercent = -1;
      let stderrBuffer = '';
      let settled = false;
      let lastActivityAt = Date.now();
      let lastActivityReason = 'spawned';
      let lastObservedPartialFiles: DownloadActivityProbe['partialFiles'] = [];
      let stallPollTimer: NodeJS.Timeout | undefined;
      const stallTimeoutMs = getYtdlpDownloadStallTimeoutMs();
      const stallPollIntervalMs = Math.min(getYtdlpDownloadStallPollIntervalMs(), stallTimeoutMs);

      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (stallPollTimer) {
          clearInterval(stallPollTimer);
        }
        reject(error);
      };

      const resolveOnce = (filePath: string): void => {
        if (settled) return;
        settled = true;
        if (stallPollTimer) {
          clearInterval(stallPollTimer);
        }
        resolve(filePath);
      };

      const markActivity = (reason: string): void => {
        lastActivityAt = Date.now();
        lastActivityReason = reason;
      };

      const command = `${ytdlpPath} ${attemptArgs.join(' ')}`;
      log.info('Executing yt-dlp section download with precise cuts', {
        command,
        sectionRange,
        outputFilePath,
        attempt: mode,
        usedCookies: mode === 'cookie_provider',
        stallTimeoutMs,
        stallPollIntervalMs,
        note: 'Using --force-keyframes-at-cuts for frame-accurate cuts at exact start/end times',
      });

      const ytdlp = spawn(ytdlpPath, attemptArgs);

      ytdlp.on('error', (err) => {
        log.error('yt-dlp spawn error', { error: err, attempt: mode, usedCookies: mode === 'cookie_provider' });
        rejectOnce(new Error(`yt-dlp spawn error: ${err}`));
      });

      ytdlp.on('close', (code, signal) => {
        if (settled) return;
        const safeOutputFilePath = ensureSafeTempPath(outputFilePath);
        const dir = path.dirname(safeOutputFilePath);
        const baseName = path.basename(safeOutputFilePath);
        let files: string[] = [];
        try {
          files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        } catch {
          // Ignore readdir errors
        }

        if (code === 0) {
          // yt-dlp adds extension based on format, so find the actual file
          // The output template was `${outputFilePath}.%(ext)s`, so yt-dlp will create a file
          // with the base name plus the actual extension (e.g., .webm, .m4a)
          const actualFile = files.find((f) => {
            const fileBase = path.basename(f, path.extname(f));
            return fileBase === baseName || f.startsWith(baseName);
          });

          if (actualFile) {
            const actualPath = ensureSafeTempPath(path.join(dir, actualFile));
            log.info('yt-dlp section download completed with precise cuts', {
              outputFilePath: actualPath,
              format: path.extname(actualFile),
              requestedStart: startTime,
              requestedDuration: duration,
              attempt: mode,
              usedCookies: mode === 'cookie_provider',
              note: 'File contains EXACT time range - no additional seeking needed',
            });
            resolveOnce(actualPath);
          } else {
            // Fallback: check if file exists without extension
            if (fs.existsSync(safeOutputFilePath)) {
              log.info('yt-dlp section download completed successfully', {
                outputFilePath: safeOutputFilePath,
                attempt: mode,
                usedCookies: mode === 'cookie_provider',
              });
              resolveOnce(safeOutputFilePath);
            } else {
              rejectOnce(new Error(`Output file was not created. Expected file starting with: ${baseName}`));
            }
          }
        } else {
          log.error('yt-dlp exited with error code', {
            code,
            signal,
            attempt: mode,
            usedCookies: mode === 'cookie_provider',
            stderr: stderrBuffer,
          });
          rejectOnce(
            new Error(
              annotateYouTubeFailure(
                `yt-dlp exited with code ${code}${signal ? ` (signal: ${signal})` : ''} on ${mode}. stderr: ${stderrBuffer}`,
                classifyYouTubeFailure(stderrBuffer || String(code), mode),
                mode
              )
            )
          );
        }
      });

      ytdlp.stderr?.on('data', (data) => {
        if (cancelToken.isCancellationRequested) {
          ytdlp.kill('SIGTERM');
          rejectOnce(new Error('Download operation was cancelled'));
          return;
        }

        const stderrStr = data.toString();
        markActivity('stderr');
        if (stderrBuffer.length < 50_000) {
          stderrBuffer += stderrStr;
        }

        // If ffmpeg inside yt-dlp fails DNS resolution, probe DNS from Node to isolate root cause
        if (stderrStr.includes('Failed to resolve hostname')) {
          const hostMatch = stderrStr.match(/Failed to resolve hostname\s+([^\s:]+)\s*:/);
          const failedHost = hostMatch?.[1];
          if (failedHost) {
            dns
              .lookup(failedHost)
              .then((result) => {
                log.info('Node DNS resolved hostname that ffmpeg could not', {
                  hostname: failedHost,
                  address: result.address,
                  family: result.family,
                  attempt: mode,
                  usedCookies: mode === 'cookie_provider',
                });
              })
              .catch((err) => {
                log.error('Node DNS also failed for hostname', {
                  hostname: failedHost,
                  error: err instanceof Error ? err.message : String(err),
                  attempt: mode,
                  usedCookies: mode === 'cookie_provider',
                });
              });
          }
        }

        // Log ffmpeg command line when yt-dlp shows it (for --download-sections)
        if (stderrStr.includes('ffmpeg command line:')) {
          const ffmpegCmdMatch = stderrStr.match(/ffmpeg command line: (.+)/);
          if (ffmpegCmdMatch) {
            const ffmpegCmd = ffmpegCmdMatch[1];
            log.info('yt-dlp ffmpeg command detected', {
              command: ffmpegCmd,
              attempt: mode,
              usedCookies: mode === 'cookie_provider',
            });
          }
        }

        // Parse progress - handle both yt-dlp percentage format AND ffmpeg time format
        // For --download-sections, ffmpeg reports time=HH:MM:SS.ms instead of percentage
        let percent: number | null = null;

        // Try ffmpeg time format first (used with --download-sections)
        const ffmpegTime = extractFfmpegTime(stderrStr);
        if (ffmpegTime !== null && ffmpegTime >= 0 && duration) {
          // Calculate percentage based on time and requested duration
          percent = Math.min(100, (ffmpegTime / duration) * 100);
        } else if (stderrStr.includes('download')) {
          // Fallback to yt-dlp percentage format (used for regular downloads)
          percent = extractPercent(stderrStr);
        }

        if (percent !== null) {
          const percentInt = Math.floor(percent);
          if (percentInt !== previousPercent) {
            previousPercent = percentInt;
            updateProgressCallback(percent);
          }
        }

        // Check for errors - capture detailed error info
        if (stderrStr.includes('ERROR')) {
          const errorLower = stderrStr.toLowerCase();
          const isFatalError =
            errorLower.includes('aborting') ||
            errorLower.includes('failed') ||
            errorLower.includes('cannot') ||
            (errorLower.includes('ffmpeg exited') && !errorLower.includes('code 0'));

          if (isFatalError) {
            log.error('yt-dlp fatal error detected', {
              stderr: stderrStr.trim(),
              attempt: mode,
              usedCookies: mode === 'cookie_provider',
            });
            rejectOnce(buildAnnotatedYouTubeError(`yt-dlp error (${mode}): ${stderrStr.trim()}`, mode));
          }
        }
      });

      stallPollTimer = setInterval(() => {
        if (settled || cancelToken.isCancellationRequested) {
          return;
        }

        void (async () => {
          const probe = await probeDownloadActivity(outputFilePath);
          const latestObservedMtimeMs = probe.latestMtimeMs;
          if (latestObservedMtimeMs !== null && latestObservedMtimeMs > lastActivityAt) {
            lastObservedPartialFiles = probe.partialFiles;
            markActivity('partial_file_growth');
            return;
          }

          if (probe.partialFiles.length > 0) {
            lastObservedPartialFiles = probe.partialFiles;
          }

          const stallDurationMs = Date.now() - lastActivityAt;
          if (stallDurationMs < stallTimeoutMs) {
            return;
          }

          const summarizedFiles = lastObservedPartialFiles.map((file) => ({
            path: file.path,
            size: file.size,
            mtimeMs: file.mtimeMs,
          }));
          const ytdlpState = await probeYtDlpState(outputFilePath);

          log.error('yt-dlp section download stalled; terminating process', {
            attempt: mode,
            outputTemplate: `${outputFilePath}.%(ext)s`,
            stallTimeoutMs,
            stallDurationMs,
            lastActivityReason,
            lastObservedPartialFiles: summarizedFiles,
            ytdlpCurrentFragmentIndex: ytdlpState.currentFragmentIndex,
            ytdlpRawState: ytdlpState.rawState,
          });

          ytdlp.kill('SIGTERM');
          rejectOnce(
            buildAnnotatedYouTubeError(
              `yt-dlp section download stalled after ${Math.round(stallDurationMs / 1000)}s without progress. Last activity=${lastActivityReason}. Partial files=${JSON.stringify(
                summarizedFiles
              )}. ytdlState=${JSON.stringify(ytdlpState)}. stderr: ${stderrBuffer.trim()}`,
              mode
            )
          );
        })().catch((pollError) => {
          log.warn('Failed to inspect yt-dlp section partial-file progress during stall detection', {
            attempt: mode,
            error: pollError instanceof Error ? pollError.message : String(pollError),
          });
        });
      }, stallPollIntervalMs);
    });

  const cleaned = { done: false };
  try {
    if (shouldUseCookiesForPublicVideos()) {
      cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
      if (cookieContext.cookieBreakerOpen) {
        throw buildAnnotatedYouTubeError(
          'Configured cookie-backed YouTube session is disabled by the cookie circuit breaker.',
          'cookie_provider'
        );
      }

      if (shouldPreferCookieProvider(cookieContext)) {
        const activeCookieContext = cookieContext;
        try {
          await runCookieHealthcheck(ytdlpPath, url, activeCookieContext, log, ctx);
          const cookieResult = await runAttemptWithRetries(getYouTubeCookieProviderMaxAttempts(), () =>
            runSectionDownloadAttempt('cookie_provider', buildAttemptArgs('cookie_provider', activeCookieContext.args))
          );
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            true,
            undefined,
            undefined,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          setCachedAccessDecision(ctx, url, {
            state: 'cookie_ok',
            mode: 'cookie_provider',
            reason: 'section_download_cookie_preferred_success',
            cookieMetadata: activeCookieContext.metadata,
            decidedAt: getNowIsoString(),
          });
          logSelectedYouTubeServingPath(log, {
            youtubeUrl: url,
            outputType: 'download_section',
            selectedMode: 'cookie_provider',
            credentialSource: activeCookieContext.source,
            cookieMetadata: activeCookieContext.metadata,
            decisionReason: 'section_download_cookie_preferred_success',
          });
          return cookieResult;
        } catch (cookieError) {
          const cookieMessage = cookieError instanceof Error ? cookieError.message : String(cookieError);
          const cookieFailureClass = classifyYouTubeFailure(cookieMessage, 'cookie_provider');
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            false,
            cookieFailureClass,
            cookieMessage,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );

          if (isBrowserFallbackEnabled()) {
            setCachedAccessDecision(ctx, url, {
              state: 'browser_required',
              mode: 'browser_fallback',
              reason: 'section_download_browser_fallback_after_cookie_preferred_failure',
              cookieFailureClass,
              cookieFailureMessage: cookieMessage,
              cookieMetadata: activeCookieContext.metadata,
              cookieBreakerOpen: activeCookieContext.cookieBreakerOpen,
              disabledUntil: activeCookieContext.disabledUntil,
              decidedAt: getNowIsoString(),
            });
            const fallback = await invokeBrowserFallbackDownloadSection(
              ytdlpPath,
              url,
              outputFilePath,
              realtimeDB,
              startTime,
              duration,
              {
                action: 'download_section',
                youtubeUrl: url,
                startTime,
                duration,
                requestContext: ctx,
              },
              log
            );
            logSelectedYouTubeServingPath(log, {
              youtubeUrl: url,
              outputType: 'download_section',
              selectedMode: 'browser_fallback',
              endpointKind: fallback.endpointKind,
              fallbackUrl: fallback.fallbackUrl,
              browserFallbackInvocationKind: fallback.invocationKind,
              credentialSource: fallback.response.resolution?.credentialSource || 'unknown',
              browserFallbackStrategy: fallback.response.resolution?.strategy || 'unknown',
              browserFallbackServiceRole: fallback.response.resolution?.serviceRole || null,
              decisionReason: 'section_download_browser_fallback_after_cookie_preferred_failure',
              cookieFailureClass,
            });
            return fallback.localFilePath || (await downloadBrowserFallbackSection(outputFilePath, fallback.response));
          }

          throw buildAnnotatedYouTubeError(cookieMessage, 'cookie_provider');
        }
      }
    }

    try {
      const publicResult = await runAttemptWithRetries(getYouTubePublicProviderMaxAttempts(), () =>
        runSectionDownloadAttempt('public_provider', buildAttemptArgs('public_provider'))
      );
      setCachedAccessDecision(ctx, url, {
        state: 'public_ok',
        mode: 'public_provider',
        reason: 'section_download_public_success',
        decidedAt: getNowIsoString(),
      });
      logSelectedYouTubeServingPath(log, {
        youtubeUrl: url,
        outputType: 'download_section',
        selectedMode: 'public_provider',
        credentialSource: 'none',
        decisionReason: 'section_download_public_success',
      });
      return publicResult;
    } catch (publicError) {
      const publicMessage = publicError instanceof Error ? publicError.message : String(publicError);
      const publicFailureClass = classifyYouTubeFailure(publicMessage, 'public_provider');
      const shouldUseBrowserFallback = shouldUseBrowserFallbackForPublicFailure(publicMessage);

      cookieContext = await loadYouTubeCookieContext(realtimeDB, isDevelopment, log);
      if (
        shouldEscalateToCookieProvider(
          publicFailureClass,
          cookieContext.hasCookies,
          shouldUseCookiesForPublicVideos()
        )
      ) {
        const activeCookieContext = cookieContext;
        try {
          await runCookieHealthcheck(ytdlpPath, url, activeCookieContext, log, ctx);
          const cookieResult = await runAttemptWithRetries(getYouTubeCookieProviderMaxAttempts(), () =>
            runSectionDownloadAttempt('cookie_provider', buildAttemptArgs('cookie_provider', activeCookieContext.args))
          );
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            true,
            undefined,
            undefined,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );
          setCachedAccessDecision(ctx, url, {
            state: 'cookie_ok',
            mode: 'cookie_provider',
            reason: 'section_download_cookie_success',
            publicFailureClass,
            publicFailureMessage: publicMessage,
            cookieMetadata: activeCookieContext.metadata,
            decidedAt: getNowIsoString(),
          });
          logSelectedYouTubeServingPath(log, {
            youtubeUrl: url,
            outputType: 'download_section',
            selectedMode: 'cookie_provider',
            credentialSource: activeCookieContext.source,
            cookieMetadata: activeCookieContext.metadata,
            decisionReason: 'section_download_cookie_success',
            publicFailureClass,
          });
          return cookieResult;
        } catch (cookieError) {
          const cookieMessage = cookieError instanceof Error ? cookieError.message : String(cookieError);
          const cookieFailureClass = classifyYouTubeFailure(cookieMessage, 'cookie_provider');
          await recordCookieAttemptOutcome(
            realtimeDB,
            'cookie_provider',
            false,
            cookieFailureClass,
            cookieMessage,
            activeCookieContext.metadata,
            getYouTubeVideoId(url),
            log
          );

          if (shouldUseBrowserFallback) {
            setCachedAccessDecision(ctx, url, {
              state: 'browser_required',
              mode: 'browser_fallback',
              reason: 'section_download_browser_fallback_after_cookie_failure',
              publicFailureClass,
              publicFailureMessage: publicMessage,
              cookieFailureClass,
              cookieFailureMessage: cookieMessage,
              cookieMetadata: activeCookieContext.metadata,
              cookieBreakerOpen: activeCookieContext.cookieBreakerOpen,
              disabledUntil: activeCookieContext.disabledUntil,
              decidedAt: getNowIsoString(),
            });
            const fallback = await invokeBrowserFallbackDownloadSection(
              ytdlpPath,
              url,
              outputFilePath,
              realtimeDB,
              startTime,
              duration,
              {
                action: 'download_section',
                youtubeUrl: url,
                startTime,
                duration,
                requestContext: ctx,
              },
              log
            );
            logSelectedYouTubeServingPath(log, {
              youtubeUrl: url,
              outputType: 'download_section',
              selectedMode: 'browser_fallback',
              endpointKind: fallback.endpointKind,
              fallbackUrl: fallback.fallbackUrl,
              browserFallbackInvocationKind: fallback.invocationKind,
              credentialSource: fallback.response.resolution?.credentialSource || 'unknown',
              browserFallbackStrategy: fallback.response.resolution?.strategy || 'unknown',
              browserFallbackServiceRole: fallback.response.resolution?.serviceRole || null,
              decisionReason: 'section_download_browser_fallback_after_cookie_failure',
              publicFailureClass,
              cookieFailureClass,
            });
            return fallback.localFilePath || (await downloadBrowserFallbackSection(outputFilePath, fallback.response));
          }

          throw buildAnnotatedYouTubeError(
            `yt-dlp section download failed after public and cookie attempts. public-provider error: ${publicMessage}; cookie-provider error: ${cookieMessage}`,
            'cookie_provider'
          );
        }
      }

      if (shouldUseBrowserFallback) {
        setCachedAccessDecision(ctx, url, {
          state: 'browser_required',
          mode: 'browser_fallback',
          reason: 'section_download_browser_fallback_after_public_failure',
          publicFailureClass,
          publicFailureMessage: publicMessage,
          decidedAt: getNowIsoString(),
        });
        const fallback = await invokeBrowserFallbackDownloadSection(
          ytdlpPath,
          url,
          outputFilePath,
          realtimeDB,
          startTime,
          duration,
          {
            action: 'download_section',
            youtubeUrl: url,
            startTime,
            duration,
            requestContext: ctx,
          },
          log
        );
        logSelectedYouTubeServingPath(log, {
          youtubeUrl: url,
          outputType: 'download_section',
          selectedMode: 'browser_fallback',
          endpointKind: fallback.endpointKind,
          fallbackUrl: fallback.fallbackUrl,
          browserFallbackInvocationKind: fallback.invocationKind,
          credentialSource: fallback.response.resolution?.credentialSource || 'unknown',
          browserFallbackStrategy: fallback.response.resolution?.strategy || 'unknown',
          browserFallbackServiceRole: fallback.response.resolution?.serviceRole || null,
          decisionReason: 'section_download_browser_fallback_after_public_failure',
          publicFailureClass,
        });
        return fallback.localFilePath || (await downloadBrowserFallbackSection(outputFilePath, fallback.response));
      }

      throw buildAnnotatedYouTubeError(publicMessage, 'public_provider');
    }
  } finally {
    cleanupCookiesFile(cookieContext?.cookiesFilePath, cleaned);
  }
};
