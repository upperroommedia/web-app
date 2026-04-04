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
  return Buffer.from('# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSAPISID\tfake\n', 'utf8').toString('base64');
}

async function runCase(testCase) {
  process.env.FAKE_YTDLP_SCENARIO = testCase.scenario;
  process.env.YOUTUBE_BROWSER_FALLBACK_URL = testCase.browserFallback ? 'http://browser-fallback:8090/fallback' : '';
  process.env.YOUTUBE_BROWSER_FALLBACK_ENABLED = testCase.browserFallback ? 'true' : 'false';
  process.env.YOUTUBE_COOKIE_CIRCUIT_BREAKER_MINUTES = '30';
  process.env.YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS = testCase.useCookiesForPublicVideos ? 'true' : 'false';
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
      testCase.assertError(artifact.error, artifact.cookieMeta);
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
