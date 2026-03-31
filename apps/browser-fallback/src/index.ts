import express from 'express';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { randomUUID } from 'node:crypto';
import type { Bucket } from '@google-cloud/storage';
import type { Database } from 'firebase-admin/database';
import type {
  BrowserFallbackDownloadSectionResponse,
  BrowserFallbackErrorCode,
  BrowserFallbackErrorResponse,
  BrowserFallbackRequest,
  BrowserFallbackResolveAudioUrlResponse,
  BrowserFallbackSessionState,
} from '@upperroom/contracts/browserFallback';
import firebaseAdmin from './firebaseAdmin';
import {
  buildBrowserFallbackSessionStatus,
  checkpointBrowserProfile,
  hydrateBrowserProfile,
} from './profileStore';

const app = express();
app.use(express.json({ limit: '2mb' }));

const fakeMode = ['1', 'true', 'yes'].includes(process.env.BROWSER_FALLBACK_FAKE_MODE?.trim().toLowerCase() || '');
const ytdlpPath = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
const ffmpegPath = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
const ytDlpJsRuntime = process.env.YTDLP_JS_RUNTIME?.trim() || 'deno';
const artifactPrefix = process.env.BROWSER_FALLBACK_ARTIFACT_PREFIX || 'browser-fallback/artifacts';
const signedUrlTtlMs = Number.parseInt(process.env.BROWSER_FALLBACK_SIGNED_URL_TTL_SECONDS || '900', 10) * 1000;
const healthcheckYoutubeUrl = process.env.BROWSER_FALLBACK_HEALTHCHECK_YOUTUBE_URL?.trim() || '';
const sharedSecret = process.env.BROWSER_FALLBACK_SHARED_SECRET?.trim() || '';
const userAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

type WorkerState = {
  browser: Browser;
  context: BrowserContext;
  metadata: {
    sessionState: BrowserFallbackSessionState;
    profileUpdatedAt: string | null;
    profileGeneration: string | null;
  };
} | null;

let workerStatePromise: Promise<WorkerState> | null = null;
let bucketInstance: Bucket | null = null;
let databaseInstance: Database | null = null;

function buildErrorResponse(
  code: BrowserFallbackErrorCode,
  message: string,
  sessionState: BrowserFallbackSessionState,
  retryable: boolean
): BrowserFallbackErrorResponse {
  return { code, message, sessionState, retryable };
}

function requestHasSharedSecret(req: express.Request): boolean {
  if (!sharedSecret) {
    return true;
  }
  return req.get('x-browser-fallback-secret')?.trim() === sharedSecret;
}

function getBucket(): Bucket {
  if (bucketInstance) return bucketInstance;
  bucketInstance = firebaseAdmin
    .storage()
    .bucket(process.env.BROWSER_FALLBACK_PROFILE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET);
  return bucketInstance;
}

function getDatabase(): Database {
  if (databaseInstance) return databaseInstance;
  databaseInstance = firebaseAdmin.database();
  return databaseInstance;
}

function isAuthCookie(name: string): boolean {
  return ['SID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'].includes(name);
}

function classifyWorkerFailure(message: string): { code: BrowserFallbackErrorCode; sessionState: BrowserFallbackSessionState; retryable: boolean } {
  const lower = message.toLowerCase();
  if (lower.includes('page needs to be reloaded')) {
    return { code: 'session_unhealthy', sessionState: 'authenticated', retryable: false };
  }
  if (
    lower.includes("sign in to confirm you're not a bot") ||
    lower.includes('sign in to confirm you’re not a bot') ||
    lower.includes('login_required') ||
    lower.includes('auth_required')
  ) {
    return { code: 'auth_required', sessionState: 'auth_required', retryable: false };
  }
  if (lower.includes('playwright') || lower.includes('browser') || lower.includes('chromium')) {
    return { code: 'browser_launch_failed', sessionState: 'unknown', retryable: true };
  }
  return { code: 'temporary_upstream_failure', sessionState: 'authenticated', retryable: true };
}

async function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
    });
  });
}

function toNetscapeCookies(cookies: Awaited<ReturnType<BrowserContext['cookies']>>): string {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const cookie of cookies) {
    const domain = cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`;
    const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = cookie.secure ? 'TRUE' : 'FALSE';
    const expires = cookie.expires && cookie.expires > 0 ? Math.trunc(cookie.expires).toString() : '0';
    lines.push([domain, includeSubdomains, cookie.path || '/', secure, expires, cookie.name, cookie.value].join('\t'));
  }
  return lines.join('\n');
}

async function ensureBrowserState(): Promise<WorkerState> {
  if (fakeMode) {
    return null;
  }
  if (!workerStatePromise) {
    workerStatePromise = (async () => {
      const { metadata, storageStatePath } = await hydrateBrowserProfile({
        bucket: getBucket(),
        database: getDatabase(),
      });
      const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
      const context = await browser.newContext({
        userAgent,
        storageState: storageStatePath || undefined,
      });
      return { browser, context, metadata };
    })().catch(async (error) => {
      workerStatePromise = null;
      throw error;
    });
  }
  return await workerStatePromise;
}

async function exportCookiesFile(context: BrowserContext): Promise<{ cookiesFilePath: string; sessionState: BrowserFallbackSessionState }> {
  const cookies = await context.cookies(['https://www.youtube.com', 'https://accounts.google.com']);
  const authCookies = cookies.filter((cookie) => isAuthCookie(cookie.name));
  if (authCookies.length === 0) {
    return { cookiesFilePath: '', sessionState: 'auth_required' };
  }
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'browser-fallback-cookies-'));
  const cookiesFilePath = path.join(tmpDir, 'cookies.txt');
  await writeFile(cookiesFilePath, `${toNetscapeCookies(cookies)}\n`, 'utf8');
  return { cookiesFilePath, sessionState: 'authenticated' };
}

type AudioFormat = { url?: string; format_id?: string; ext?: string; vcodec?: string; abr?: number; duration?: number };
type YtDlpJson = { duration?: number; formats?: AudioFormat[] };

function selectPreferredAudioFormat(formats: AudioFormat[]): AudioFormat | undefined {
  const candidates = formats.filter((format) => format.vcodec === 'none' && format.url);
  return candidates.sort((left, right) => (right.abr || 0) - (left.abr || 0))[0];
}

async function resolveAudioUrlWithCookies(youtubeUrl: string, cookiesFilePath: string): Promise<BrowserFallbackResolveAudioUrlResponse> {
  const args = [
    '-J',
    '--no-playlist',
    '--skip-download',
    '--no-js-runtimes',
    '--js-runtimes',
    ytDlpJsRuntime,
    '--cookies',
    cookiesFilePath,
    '--extractor-args',
    'youtube:player_client=default,-web_creator',
    youtubeUrl,
  ];
  const { stdout } = await runCommand(ytdlpPath, args);
  const parsed = JSON.parse(stdout) as YtDlpJson;
  const selected = selectPreferredAudioFormat(parsed.formats || []);
  if (!selected?.url) {
    throw new Error('yt-dlp did not return an audio-only format URL.');
  }
  return {
    url: selected.url,
    format: selected.ext || selected.format_id || 'unknown',
    duration: parsed.duration ?? selected.duration,
  };
}

async function trimSectionToFile(args: {
  audioUrl: string;
  startTime: number;
  duration: number;
  outputFilePath: string;
}): Promise<void> {
  await runCommand(ffmpegPath, [
    '-y',
    '-user_agent',
    userAgent,
    '-ss',
    `${args.startTime}`,
    '-i',
    args.audioUrl,
    '-t',
    `${args.duration}`,
    '-vn',
    '-acodec',
    'copy',
    args.outputFilePath,
  ]);
}

async function uploadArtifactAndSign(outputFilePath: string): Promise<string> {
  const objectName = `${artifactPrefix}/${Date.now()}-${path.basename(outputFilePath)}`;
  const file = getBucket().file(objectName);
  await file.save(await readFile(outputFilePath), {
    resumable: false,
    contentType: 'audio/mp4',
  });
  const [signedUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + signedUrlTtlMs,
  });
  return signedUrl;
}

async function checkpointContext(state: WorkerState, sessionState: BrowserFallbackSessionState): Promise<void> {
  if (!state) return;
  const storageState = (await state.context.storageState()) as Record<string, unknown>;
  state.metadata = await checkpointBrowserProfile({
    bucket: getBucket(),
    database: getDatabase(),
    storageState,
    sessionState,
  });
}

async function withCookies<T>(run: (cookiesFilePath: string, sessionState: BrowserFallbackSessionState) => Promise<T>): Promise<T> {
  const state = await ensureBrowserState();
  if (!state) {
    return await run('', 'fake_mode');
  }
  const { cookiesFilePath, sessionState } = await exportCookiesFile(state.context);
  if (!cookiesFilePath) {
    throw Object.assign(new Error('Browser profile is not authenticated.'), {
      browserFailure: buildErrorResponse('auth_required', 'Browser profile is not authenticated.', sessionState, false),
    });
  }
  try {
    const result = await run(cookiesFilePath, sessionState);
    await checkpointContext(state, sessionState);
    return result;
  } finally {
    await rm(path.dirname(cookiesFilePath), { recursive: true, force: true });
  }
}

async function getLiveSessionStatus(): Promise<{
  ok: boolean;
  sessionState: BrowserFallbackSessionState;
  profileUpdatedAt: string | null;
  profileGeneration: string | null;
  healthcheckConfigured: boolean;
  lastCheckedAt: string | null;
  lastErrorCode: BrowserFallbackErrorCode | null;
  lastErrorMessage: string | null;
}> {
  const state = await ensureBrowserState();
  if (!state) {
    return {
      ok: true,
      sessionState: 'fake_mode',
      profileUpdatedAt: new Date().toISOString(),
      profileGeneration: 'fake-mode',
      healthcheckConfigured: false,
      lastCheckedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    };
  }

  const { cookiesFilePath, sessionState } = await exportCookiesFile(state.context);
  if (sessionState !== state.metadata.sessionState) {
    state.metadata = await checkpointBrowserProfile({
      bucket: getBucket(),
      database: getDatabase(),
      storageState: (await state.context.storageState()) as Record<string, unknown>,
      sessionState,
    });
  }

  if (!cookiesFilePath) {
    return {
      ok: false,
      sessionState,
      profileUpdatedAt: state.metadata.profileUpdatedAt,
      profileGeneration: state.metadata.profileGeneration,
      healthcheckConfigured: !!healthcheckYoutubeUrl,
      lastCheckedAt: null,
      lastErrorCode: 'auth_required',
      lastErrorMessage: 'Browser profile is not authenticated.',
    };
  }

  try {
    if (!healthcheckYoutubeUrl) {
      return {
        ok: sessionState === 'authenticated',
        sessionState,
        profileUpdatedAt: state.metadata.profileUpdatedAt,
        profileGeneration: state.metadata.profileGeneration,
        healthcheckConfigured: false,
        lastCheckedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      };
    }

    const checkedAt = new Date().toISOString();
    await resolveAudioUrlWithCookies(healthcheckYoutubeUrl, cookiesFilePath);
    await checkpointContext(state, sessionState);
    return {
      ok: true,
      sessionState,
      profileUpdatedAt: state.metadata.profileUpdatedAt,
      profileGeneration: state.metadata.profileGeneration,
      healthcheckConfigured: true,
      lastCheckedAt: checkedAt,
      lastErrorCode: null,
      lastErrorMessage: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const classified = classifyWorkerFailure(message);
    await checkpointContext(state, sessionState);
    return {
      ok: false,
      sessionState: classified.sessionState === 'auth_required' ? 'auth_required' : sessionState,
      profileUpdatedAt: state.metadata.profileUpdatedAt,
      profileGeneration: state.metadata.profileGeneration,
      healthcheckConfigured: !!healthcheckYoutubeUrl,
      lastCheckedAt: new Date().toISOString(),
      lastErrorCode: classified.code,
      lastErrorMessage: message,
    };
  } finally {
    await rm(path.dirname(cookiesFilePath), { recursive: true, force: true });
  }
}

app.get('/healthz', async (_req, res) => {
  const status = await buildBrowserFallbackSessionStatus(fakeMode ? null : getBucket(), fakeMode);
  res.status(200).json(status);
});

app.get('/session-status', async (_req, res) => {
  const baseStatus = await buildBrowserFallbackSessionStatus(fakeMode ? null : getBucket(), fakeMode);
  if (fakeMode || !baseStatus.configured) {
    res.status(200).json(baseStatus);
    return;
  }

  try {
    const liveStatus = await getLiveSessionStatus();
    res.status(200).json({
      ...baseStatus,
      ok: liveStatus.ok,
      sessionState: liveStatus.sessionState,
      profileUpdatedAt: liveStatus.profileUpdatedAt,
      profileGeneration: liveStatus.profileGeneration,
      healthcheckConfigured: liveStatus.healthcheckConfigured,
      lastCheckedAt: liveStatus.lastCheckedAt,
      lastErrorCode: liveStatus.lastErrorCode,
      lastErrorMessage: liveStatus.lastErrorMessage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const classified = classifyWorkerFailure(message);
    res.status(classified.retryable ? 502 : 200).json({
      ...baseStatus,
      sessionState: classified.sessionState,
      ok: false,
      lastCheckedAt: new Date().toISOString(),
      lastErrorCode: classified.code,
      lastErrorMessage: message,
    });
  }
});

app.get('/artifacts/mock-section.m4a', (_req, res) => {
  res.setHeader('Content-Type', 'audio/mp4');
  res.send(Buffer.from('BROWSER-FALLBACK-FAKE-M4A'));
});

app.post('/fallback', async (req, res) => {
  const payload = req.body as BrowserFallbackRequest;

  try {
    if (!requestHasSharedSecret(req)) {
      res.status(401).json(buildErrorResponse('auth_required', 'Missing or invalid browser fallback secret.', 'unknown', false));
      return;
    }

    if (payload?.action === 'resolve_audio_url') {
      if (fakeMode) {
        const response: BrowserFallbackResolveAudioUrlResponse = {
          url: 'https://example.com/browser-fallback-audio.m4a',
          format: 'm4a',
          duration: 20,
        };
        res.status(200).json(response);
        return;
      }

      const response = await withCookies(async (cookiesFilePath) => await resolveAudioUrlWithCookies(payload.youtubeUrl, cookiesFilePath));
      res.status(200).json(response);
      return;
    }

    if (payload?.action === 'download_section') {
      if (fakeMode) {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const response: BrowserFallbackDownloadSectionResponse = {
          downloadUrl: `${baseUrl}/artifacts/mock-section.m4a`,
          ext: 'm4a',
        };
        res.status(200).json(response);
        return;
      }

      const response = await withCookies(async (cookiesFilePath) => {
        const resolved = await resolveAudioUrlWithCookies(payload.youtubeUrl, cookiesFilePath);
        const effectiveDuration = payload.duration ?? resolved.duration;
        if (!effectiveDuration || effectiveDuration <= 0) {
          throw new Error('Browser fallback could not determine a valid download duration.');
        }
        const outputDir = await mkdtemp(path.join(os.tmpdir(), 'browser-fallback-artifact-'));
        const outputFilePath = path.join(outputDir, `${randomUUID()}.m4a`);
        try {
          await trimSectionToFile({
            audioUrl: resolved.url,
            startTime: payload.startTime,
            duration: effectiveDuration,
            outputFilePath,
          });
          const downloadUrl = await uploadArtifactAndSign(outputFilePath);
          return {
            downloadUrl,
            ext: 'm4a',
          } satisfies BrowserFallbackDownloadSectionResponse;
        } finally {
          await rm(outputDir, { recursive: true, force: true });
        }
      });

      res.status(200).json(response);
      return;
    }

    const unsupportedAction =
      payload && typeof payload === 'object' && 'action' in (payload as Record<string, unknown>)
        ? String((payload as Record<string, unknown>).action)
        : 'unknown';
    res
      .status(400)
      .json(buildErrorResponse('temporary_upstream_failure', `Unsupported action: ${unsupportedAction}`, 'unknown', false));
  } catch (error) {
    const browserFailure = (error as { browserFailure?: BrowserFallbackErrorResponse }).browserFailure;
    if (browserFailure) {
      res.status(409).json(browserFailure);
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const classified = classifyWorkerFailure(message);
    const status = buildErrorResponse(classified.code, message, classified.sessionState, classified.retryable);
    res.status(classified.retryable ? 502 : 409).json(status);
  }
});

const port = Number.parseInt(process.env.PORT || '8080', 10);
app.listen(port, '0.0.0.0', () => {
  console.log(`browser-fallback listening on ${port}`);
});
