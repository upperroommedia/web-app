const fs = require('node:fs');
const path = require('node:path');

const {
  getYouTubeAudioUrl,
  getYouTubeTrimRoutingDecision,
  downloadYouTubeAudioToFile,
  downloadYouTubeSection,
} = require('../dist/processYouTubeUrl');
const { createContext } = require('../dist/context');
const { CancelToken } = require('../dist/CancelToken');

process.env.NODE_ENV = 'production';

const fakeYtdlpPath = path.resolve(__dirname, 'fake-ytdlp.sh');
const artifactsDir = path.join(process.cwd(), '.tmp', 'youtube-loop');
const fakeBrowserProfileDir = path.join(artifactsDir, 'browser-profile');
fs.mkdirSync(artifactsDir, { recursive: true });
fs.chmodSync(fakeYtdlpPath, 0o755);

function ensureFakeBrowserCookiesDb() {
  const cookiesDbPath = path.join(fakeBrowserProfileDir, 'Default', 'Cookies');
  fs.mkdirSync(path.dirname(cookiesDbPath), { recursive: true });
  if (!fs.existsSync(cookiesDbPath)) {
    fs.writeFileSync(cookiesDbPath, Buffer.from('fake-chrome-cookies-db'));
  }
  return fakeBrowserProfileDir;
}

function createMockRealtimeDb(initialData) {
  const store = { ...initialData };
  return {
    _store: store,
    ref(key) {
      return {
        async get() {
          return {
            exists: () => Object.prototype.hasOwnProperty.call(store, key),
            val: () => store[key],
          };
        },
        async update(patch) {
          store[key] = { ...(store[key] || {}), ...patch };
        },
        async set(value) {
          store[key] = value;
        },
        async remove() {
          delete store[key];
        },
        async transaction(updateFn) {
          const next = updateFn(store[key]);
          if (typeof next === 'undefined') {
            return {
              committed: false,
              snapshot: {
                val: () => store[key],
              },
            };
          }
          store[key] = next;
          return {
            committed: true,
            snapshot: {
              val: () => store[key],
            },
          };
        },
      };
    },
  };
}

function encodeCookies() {
  return Buffer.from(
    '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSAPISID\tfake\n',
    'utf8'
  ).toString('base64');
}

async function runCase(testCase) {
  process.env.FAKE_YTDLP_SCENARIO = testCase.scenario;
  process.env.YOUTUBE_BROWSER_FALLBACK_URL = testCase.browserFallback ? 'http://browser-fallback:8090/fallback' : '';
  process.env.YOUTUBE_BROWSER_FALLBACK_ENABLED = testCase.browserFallback ? 'true' : 'false';
  process.env.YOUTUBE_COOKIE_CIRCUIT_BREAKER_MINUTES = '30';
  if (typeof testCase.useCookiesForPublicVideos === 'boolean') {
    process.env.YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS = testCase.useCookiesForPublicVideos ? 'true' : 'false';
  } else {
    delete process.env.YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS;
  }
  process.env.YTDLP_DOWNLOAD_STALL_TIMEOUT_MS = String(testCase.stallTimeoutMs || 600000);
  process.env.YTDLP_DOWNLOAD_STALL_POLL_INTERVAL_MS = String(testCase.stallPollIntervalMs || 15000);
  if (testCase.browserProfileCookies) {
    process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR = ensureFakeBrowserCookiesDb();
    process.env.PROCESS_AUDIO_BROWSER_PROFILE_BROWSER = 'chromium';
  } else {
    delete process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR;
    delete process.env.PROCESS_AUDIO_BROWSER_PROFILE_BROWSER;
  }
  const logFile = path.join(artifactsDir, `${testCase.name}.attempts.jsonl`);
  process.env.FAKE_YTDLP_LOG_FILE = logFile;
  fs.rmSync(logFile, { force: true });

  const realtimeDb = createMockRealtimeDb(testCase.realtimeDb || {});
  const ctx = createContext(`local-${testCase.name}`, 'process-audio.trim');
  const url = 'https://www.youtube.com/watch?v=testvideo';
  const artifact = {
    name: testCase.name,
    scenario: testCase.scenario,
    browserFallback: testCase.browserFallback,
    status: 'pending',
  };

  try {
    let result;
    if (testCase.kind === 'direct') {
      result = await getYouTubeAudioUrl(fakeYtdlpPath, url, realtimeDb, ctx);
    } else if (testCase.kind === 'routing') {
      result = await getYouTubeTrimRoutingDecision(fakeYtdlpPath, url, realtimeDb, ctx);
    } else if (testCase.kind === 'section') {
      const outputBase = path.join(artifactsDir, `${testCase.name}.section`);
      result = await downloadYouTubeSection(
        fakeYtdlpPath,
        url,
        outputBase,
        new CancelToken(),
        () => {},
        realtimeDb,
        0,
        20,
        ctx
      );
    } else if (testCase.kind === 'download') {
      const outputBase = path.join(artifactsDir, `${testCase.name}.download`);
      const progressUpdates = [];
      result = await downloadYouTubeAudioToFile(
        fakeYtdlpPath,
        url,
        outputBase,
        new CancelToken(),
        (progress) => progressUpdates.push(progress),
        realtimeDb,
        ctx
      );
      artifact.progressUpdates = progressUpdates;
    } else {
      throw new Error(`Unsupported case kind: ${testCase.kind}`);
    }

    artifact.status = 'ok';
    artifact.result = result;
    artifact.cookieMeta = realtimeDb._store['yt-dlp-cookies-meta'] || null;
    artifact.attempts = fs.existsSync(logFile)
      ? fs
          .readFileSync(logFile, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];

    if (testCase.expectError) {
      throw new Error(`Expected failure but case succeeded: ${testCase.name}`);
    }
    if (testCase.assert) {
      testCase.assert(result, artifact.cookieMeta, artifact);
    }
  } catch (error) {
    artifact.status = 'error';
    artifact.error = error instanceof Error ? error.message : String(error);
    artifact.youtubeAcquisitionEvidence = error?.youtubeAcquisitionEvidence || null;
    artifact.cookieMeta = realtimeDb._store['yt-dlp-cookies-meta'] || null;
    artifact.attempts = fs.existsSync(logFile)
      ? fs
          .readFileSync(logFile, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    if (!testCase.expectError) {
      throw error;
    }
    if (testCase.assertError) {
      testCase.assertError(artifact.error, artifact.cookieMeta, artifact);
    }
  } finally {
    delete process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR;
    delete process.env.PROCESS_AUDIO_BROWSER_PROFILE_BROWSER;
    delete process.env.YTDLP_DOWNLOAD_STALL_TIMEOUT_MS;
    delete process.env.YTDLP_DOWNLOAD_STALL_POLL_INTERVAL_MS;
    delete process.env.FAKE_YTDLP_LOG_FILE;
    const artifactPath = path.join(artifactsDir, `${testCase.name}.json`);
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
  }
}

const cases = [
  {
    name: 'public-success-direct',
    kind: 'direct',
    scenario: 'public_success',
    browserFallback: false,
    realtimeDb: {},
    assert(result) {
      if (!result.url.includes('https://example.com/fake-audio.m4a')) {
        throw new Error('public-success-direct did not return the expected direct URL');
      }
    },
  },
  {
    name: 'public-download-explicit-cookie-free',
    kind: 'download',
    scenario: 'public_success',
    browserFallback: false,
    useCookiesForPublicVideos: false,
    browserProfileCookies: true,
    realtimeDb: {},
    assert(result, _cookieMeta, artifact) {
      if (!fs.existsSync(result)) {
        throw new Error('public-download-explicit-cookie-free did not create the output file');
      }
      if (!artifact?.attempts?.length) {
        throw new Error('public-download-explicit-cookie-free did not invoke yt-dlp');
      }
      if (artifact.attempts.some((attempt) => attempt.hasCookies)) {
        throw new Error('public-download-explicit-cookie-free unexpectedly used browser cookies');
      }

      const argv = artifact.attempts.flatMap((attempt) => attempt.args || []);
      if (argv.some((arg) => String(arg).includes('po_token='))) {
        throw new Error('public-download-explicit-cookie-free unexpectedly injected a browser PO token');
      }
      if (!argv.some((arg) => String(arg).includes('player_client=default,mweb,-web_creator'))) {
        throw new Error('public-download-explicit-cookie-free did not use the mweb PO-token client');
      }
      if (!argv.some((arg) => String(arg).includes('youtubepot-bgutilhttp:base_url='))) {
        throw new Error('public-download-explicit-cookie-free did not configure the bgutil PO-token provider');
      }
    },
  },
  {
    name: 'public-download-guest-then-authenticated',
    kind: 'download',
    scenario: 'public_bot_cookie_ok',
    browserFallback: false,
    useCookiesForPublicVideos: false,
    browserProfileCookies: true,
    realtimeDb: {},
    assert(result, _cookieMeta, artifact) {
      if (!fs.existsSync(result)) {
        throw new Error('public-download-guest-then-authenticated did not create the output file');
      }

      const attempts = artifact?.attempts || [];
      const firstAuthenticatedAttempt = attempts.findIndex((attempt) => attempt.hasCookies);
      if (firstAuthenticatedAttempt <= 0) {
        throw new Error('public-download-guest-then-authenticated did not attempt guest access before browser cookies');
      }
      if (attempts.slice(0, firstAuthenticatedAttempt).some((attempt) => attempt.hasCookies)) {
        throw new Error('public-download-guest-then-authenticated used cookies during the guest phase');
      }
      if (attempts.slice(firstAuthenticatedAttempt).some((attempt) => !attempt.hasCookies)) {
        throw new Error('public-download-guest-then-authenticated returned to guest mode after authenticated fallback');
      }

      const authenticatedArgv = attempts.slice(firstAuthenticatedAttempt).flatMap((attempt) => attempt.args || []);
      if (!authenticatedArgv.some((arg) => String(arg).includes('player_client=default,mweb,-web_creator'))) {
        throw new Error('public-download-guest-then-authenticated did not use mweb with browser cookies');
      }
      if (!authenticatedArgv.some((arg) => String(arg).includes('youtubepot-bgutilhttp:base_url='))) {
        throw new Error('public-download-guest-then-authenticated did not keep the bgutil PO-token provider');
      }
    },
  },
  {
    name: 'cookie-stale-error',
    kind: 'direct',
    scenario: 'public_bot_cookie_stale',
    browserFallback: false,
    browserProfileCookies: true,
    expectError: true,
    realtimeDb: {
      'yt-dlp-cookies': encodeCookies(),
      'yt-dlp-cookies-meta': {
        rotatedAt: new Date().toISOString(),
        exportMethod: 'manual-private-window',
        profileType: 'incognito',
      },
    },
    assertError(error) {
      if (!String(error).includes('stale or challenged')) {
        throw new Error('cookie-stale-error did not surface the stale cookie failure');
      }
    },
  },
  {
    name: 'public-download-guest-and-auth-session-denied',
    kind: 'download',
    scenario: 'public_bot_cookie_stale',
    browserFallback: false,
    useCookiesForPublicVideos: false,
    browserProfileCookies: true,
    expectError: true,
    realtimeDb: {},
    assertError(error, _cookieMeta, artifact) {
      const evidence = artifact?.youtubeAcquisitionEvidence;
      const attemptedModes = JSON.stringify(evidence?.attemptedModes || []);
      if (attemptedModes !== JSON.stringify(['public_provider', 'cookie_provider'])) {
        throw new Error(
          `public-download-guest-and-auth-session-denied had unexpected attempt evidence: ${attemptedModes}`
        );
      }
      if (evidence?.guestFailureClass !== 'public_path_bot_blocked') {
        throw new Error('public-download-guest-and-auth-session-denied did not classify the guest denial');
      }
      if (evidence?.authenticatedFailureClass !== 'cookie_session_stale_or_challenged') {
        throw new Error(
          'public-download-guest-and-auth-session-denied did not classify the authenticated session denial'
        );
      }
      if (evidence?.requiresAuthenticationRecovery !== true) {
        throw new Error('public-download-guest-and-auth-session-denied did not request authentication recovery');
      }
      if (String(error).includes('SOURCE_UPLOAD_REQUIRED')) {
        throw new Error('public-download-guest-and-auth-session-denied was incorrectly made terminal');
      }
    },
  },
  {
    name: 'browser-fallback-direct',
    kind: 'direct',
    scenario: 'public_bot_cookie_stale',
    browserFallback: true,
    browserProfileCookies: true,
    realtimeDb: {
      'yt-dlp-cookies': encodeCookies(),
      'yt-dlp-cookies-meta': {
        rotatedAt: new Date().toISOString(),
      },
    },
    assert(result, _cookieMeta, artifact) {
      if (!String(result.url).includes('.m4a')) {
        throw new Error('browser-fallback-direct did not return an audio URL');
      }
      if (!artifact?.attempts?.[0]?.hasCookies) {
        throw new Error('browser-fallback-direct did not start with the cookie-backed attempt');
      }
      if (!artifact?.attempts?.[1] || artifact.attempts[1].args.includes('--extractor-args')) {
        throw new Error('browser-fallback-direct did not perform the in-process browser fallback extraction');
      }
    },
  },
  {
    name: 'browser-fallback-section',
    kind: 'section',
    scenario: 'public_bot_cookie_stale',
    browserFallback: true,
    browserProfileCookies: true,
    realtimeDb: {
      'yt-dlp-cookies': encodeCookies(),
      'yt-dlp-cookies-meta': {
        disabledUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        consecutiveFailures: 2,
      },
    },
    assert(result) {
      if (!fs.existsSync(result)) {
        throw new Error('browser-fallback-section did not write the fallback download to disk');
      }
    },
  },
  {
    name: 'cookie-preferred-direct',
    kind: 'direct',
    scenario: 'public_bot_cookie_ok',
    browserFallback: false,
    useCookiesForPublicVideos: true,
    browserProfileCookies: true,
    realtimeDb: {
      'yt-dlp-cookies': encodeCookies(),
      'yt-dlp-cookies-meta': {
        rotatedAt: new Date().toISOString(),
      },
    },
    assert(result, cookieMeta, artifact) {
      if (!String(result.url).includes('https://example.com/fake-audio.m4a')) {
        throw new Error('cookie-preferred-direct did not return the expected direct URL');
      }
      if (!artifact?.attempts?.[0]?.hasCookies) {
        throw new Error('cookie-preferred-direct did not start with the cookie-backed attempt');
      }
    },
  },
  {
    name: 'cookie-preferred-routing',
    kind: 'routing',
    scenario: 'public_bot_cookie_ok',
    browserFallback: false,
    useCookiesForPublicVideos: true,
    browserProfileCookies: true,
    realtimeDb: {
      'yt-dlp-cookies': encodeCookies(),
      'yt-dlp-cookies-meta': {
        rotatedAt: new Date().toISOString(),
      },
    },
    assert(result, cookieMeta, artifact) {
      if (!['direct_url', 'section_download'].includes(result.strategy)) {
        throw new Error('cookie-preferred-routing did not return a routing decision');
      }
      if (!artifact?.attempts?.[0]?.hasCookies) {
        throw new Error('cookie-preferred-routing did not start with the cookie-backed attempt');
      }
    },
  },
  {
    name: 'download-stall-detected',
    kind: 'download',
    scenario: 'download_stall_after_partial',
    browserFallback: false,
    useCookiesForPublicVideos: true,
    browserProfileCookies: true,
    stallTimeoutMs: 1000,
    stallPollIntervalMs: 100,
    expectError: true,
    realtimeDb: {
      'yt-dlp-cookies': encodeCookies(),
      'yt-dlp-cookies-meta': {
        rotatedAt: new Date().toISOString(),
      },
    },
    assertError(error) {
      if (!String(error).includes('download stalled')) {
        throw new Error('download-stall-detected did not surface the stall timeout');
      }
    },
  },
  {
    name: 'post-live-rescue-download',
    kind: 'download',
    scenario: 'post_live_rescue_success',
    browserFallback: false,
    useCookiesForPublicVideos: true,
    browserProfileCookies: true,
    realtimeDb: {
      'yt-dlp-cookies': encodeCookies(),
      'yt-dlp-cookies-meta': {
        rotatedAt: new Date().toISOString(),
      },
    },
    assert(result, _cookieMeta, artifact) {
      if (!fs.existsSync(result)) {
        throw new Error('post-live-rescue-download did not create the output file');
      }
      if (!artifact?.attempts?.[0]?.hasFormatSelector) {
        throw new Error('post-live-rescue-download did not start with the normal format selector');
      }
      if (artifact?.attempts?.[1]?.hasFormatSelector) {
        throw new Error('post-live-rescue-download did not retry without the audio-only preselector');
      }
      if (!artifact?.attempts?.[1]?.args?.includes('--live-from-start')) {
        throw new Error('post-live-rescue-download did not use the post-live rescue probe');
      }
      const downloadAttempt = artifact?.attempts?.find((attempt) => !attempt.isJson && attempt.args?.includes('-o'));
      const formatIndex = downloadAttempt?.args?.indexOf('-f') ?? -1;
      if (!downloadAttempt || downloadAttempt.args?.[formatIndex + 1] !== '96') {
        throw new Error('post-live-rescue-download did not download the rescued HLS format directly');
      }
    },
  },
  {
    name: 'cookie-preferred-section',
    kind: 'section',
    scenario: 'public_bot_cookie_ok',
    browserFallback: false,
    useCookiesForPublicVideos: true,
    browserProfileCookies: true,
    realtimeDb: {
      'yt-dlp-cookies': encodeCookies(),
      'yt-dlp-cookies-meta': {
        rotatedAt: new Date().toISOString(),
      },
    },
    assert(result, cookieMeta, artifact) {
      if (!fs.existsSync(result)) {
        throw new Error('cookie-preferred-section did not create the output file');
      }
      if (!artifact?.attempts?.[0]?.hasCookies) {
        throw new Error('cookie-preferred-section did not start with the cookie-backed attempt');
      }
    },
  },
];

async function main() {
  const summary = [];
  for (const testCase of cases) {
    process.stdout.write(`[youtube-loop] ${testCase.name}\n`);
    await runCase(testCase);
    summary.push({ name: testCase.name, status: 'ok' });
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
