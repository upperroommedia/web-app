const fs = require('node:fs');
const path = require('node:path');

const {
  getYouTubeAudioUrl,
  getYouTubeTrimRoutingDecision,
  downloadYouTubeAudioToFile,
  downloadYouTubeSection,
  runGuestYouTubeMediaByteCanary,
  runAuthenticatedYouTubeMediaByteCanary,
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
  if (testCase.authCanaryUrl) {
    process.env.PROCESS_AUDIO_YOUTUBE_AUTH_CANARY_URL = testCase.authCanaryUrl;
  } else {
    delete process.env.PROCESS_AUDIO_YOUTUBE_AUTH_CANARY_URL;
  }
  if (testCase.guestCanaryUrl) {
    process.env.PROCESS_AUDIO_YOUTUBE_GUEST_CANARY_URL = testCase.guestCanaryUrl;
  } else {
    delete process.env.PROCESS_AUDIO_YOUTUBE_GUEST_CANARY_URL;
  }
  if (typeof testCase.useCookiesForPublicVideos === 'boolean') {
    process.env.YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS = testCase.useCookiesForPublicVideos ? 'true' : 'false';
  } else {
    delete process.env.YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS;
  }
  process.env.YTDLP_DOWNLOAD_STALL_TIMEOUT_MS = String(testCase.stallTimeoutMs || 600000);
  process.env.YTDLP_DOWNLOAD_STALL_POLL_INTERVAL_MS = String(testCase.stallPollIntervalMs || 15000);
  if (testCase.authCanaryTimeoutMs) {
    process.env.PROCESS_AUDIO_YOUTUBE_AUTH_CANARY_TIMEOUT_MS = String(testCase.authCanaryTimeoutMs);
  } else {
    delete process.env.PROCESS_AUDIO_YOUTUBE_AUTH_CANARY_TIMEOUT_MS;
  }
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
    } else if (testCase.kind === 'authCanary') {
      result = await runAuthenticatedYouTubeMediaByteCanary(fakeYtdlpPath, realtimeDb, ctx);
    } else if (testCase.kind === 'guestCanary') {
      result = await runGuestYouTubeMediaByteCanary(fakeYtdlpPath, realtimeDb, ctx);
    } else {
      throw new Error(`Unsupported case kind: ${testCase.kind}`);
    }

    artifact.status = 'ok';
    artifact.result = result;
    artifact.youtubeSuccessfulAcquisitionAuthority = ctx.youtubeSuccessfulAcquisitionAuthority || null;
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
    artifact.youtubeSuccessfulAcquisitionAuthority = ctx.youtubeSuccessfulAcquisitionAuthority || null;
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
    delete process.env.PROCESS_AUDIO_YOUTUBE_AUTH_CANARY_URL;
    delete process.env.PROCESS_AUDIO_YOUTUBE_GUEST_CANARY_URL;
    delete process.env.PROCESS_AUDIO_YOUTUBE_AUTH_CANARY_TIMEOUT_MS;
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
      if (artifact.youtubeSuccessfulAcquisitionAuthority !== 'public_provider') {
        throw new Error('public-download-explicit-cookie-free did not record public-provider acquisition authority');
      }
    },
  },
  {
    name: 'public-download-default-cookie-free',
    kind: 'download',
    scenario: 'public_success',
    browserFallback: false,
    browserProfileCookies: true,
    realtimeDb: {},
    assert(result, _cookieMeta, artifact) {
      if (!fs.existsSync(result)) {
        throw new Error('public-download-default-cookie-free did not create the output file');
      }
      if (!artifact?.attempts?.length) {
        throw new Error('public-download-default-cookie-free did not invoke yt-dlp');
      }
      if (artifact.attempts.some((attempt) => attempt.hasCookies)) {
        throw new Error('public-download-default-cookie-free used cookies without an explicit opt-in');
      }
    },
  },
  {
    name: 'authenticated-media-byte-canary-success',
    kind: 'authCanary',
    scenario: 'public_bot_cookie_ok',
    browserFallback: false,
    browserProfileCookies: true,
    authCanaryUrl: 'https://www.youtube.com/watch?v=testvideo',
    realtimeDb: {},
    assert(result, _cookieMeta, artifact) {
      if (
        result.scope !== 'authenticated' ||
        result.succeeded !== true ||
        result.bytesDownloaded !== Buffer.byteLength('FAKE-M4A') ||
        result.failureClass !== null ||
        !Number.isFinite(Date.parse(result.checkedAt))
      ) {
        throw new Error(
          `authenticated-media-byte-canary-success returned an invalid report: ${JSON.stringify(result)}`
        );
      }
      const attempt = artifact?.attempts?.find((candidate) => candidate.isSectionDownload);
      if (!attempt?.hasCookies) {
        throw new Error('authenticated-media-byte-canary-success did not use the configured authenticated session');
      }
      const sectionIndex = attempt.args.indexOf('--download-sections');
      if (sectionIndex < 0 || attempt.args[sectionIndex + 1] !== '*0:00-0:03') {
        throw new Error('authenticated-media-byte-canary-success was not limited to the three-second opening section');
      }
      if (!attempt.args.some((arg) => String(arg).includes('youtubepot-bgutilhttp:base_url='))) {
        throw new Error('authenticated-media-byte-canary-success did not use the configured PO-token provider');
      }
      const outputIndex = attempt.args.indexOf('-o');
      const outputTemplate = outputIndex >= 0 ? attempt.args[outputIndex + 1] : null;
      if (!outputTemplate || fs.existsSync(path.dirname(outputTemplate))) {
        throw new Error('authenticated-media-byte-canary-success did not clean its temporary workspace');
      }
    },
  },
  {
    name: 'guest-media-byte-canary-strict-cookie-free',
    kind: 'guestCanary',
    scenario: 'public_success',
    browserFallback: true,
    browserProfileCookies: true,
    guestCanaryUrl: 'https://www.youtube.com/watch?v=testvideo',
    realtimeDb: {},
    assert(result, _cookieMeta, artifact) {
      if (
        result.scope !== 'guest' ||
        result.succeeded !== true ||
        result.bytesDownloaded !== Buffer.byteLength('FAKE-M4A') ||
        result.failureClass !== null
      ) {
        throw new Error(
          `guest-media-byte-canary-strict-cookie-free returned an invalid report: ${JSON.stringify(result)}`
        );
      }
      if (!artifact?.attempts?.length || artifact.attempts.some((attempt) => attempt.hasCookies)) {
        throw new Error('guest-media-byte-canary-strict-cookie-free used authenticated arguments');
      }
      const argv = artifact.attempts.flatMap((attempt) => attempt.args || []);
      if (!argv.includes('--ignore-config') || argv.includes('--cookies') || argv.includes('--cookies-from-browser')) {
        throw new Error('guest-media-byte-canary-strict-cookie-free was not structurally isolated from cookie config');
      }
      if (
        !argv.includes('--download-sections') ||
        !argv.includes('*0:00-0:03') ||
        !argv.some((arg) => String(arg).includes('youtubepot-bgutilhttp:base_url='))
      ) {
        throw new Error('guest-media-byte-canary-strict-cookie-free was not provider-backed and three-second bounded');
      }
      const outputIndex = argv.indexOf('-o');
      if (outputIndex < 0 || fs.existsSync(path.dirname(argv[outputIndex + 1]))) {
        throw new Error('guest-media-byte-canary-strict-cookie-free did not clean its workspace');
      }
    },
  },
  {
    name: 'guest-media-byte-canary-never-escalates',
    kind: 'guestCanary',
    scenario: 'public_bot_cookie_ok',
    browserFallback: true,
    browserProfileCookies: true,
    guestCanaryUrl: 'https://www.youtube.com/watch?v=testvideo',
    realtimeDb: {},
    assert(result, _cookieMeta, artifact) {
      if (result.scope !== 'guest' || result.succeeded !== false || result.failureClass !== 'public_path_bot_blocked') {
        throw new Error(
          `guest-media-byte-canary-never-escalates returned an invalid report: ${JSON.stringify(result)}`
        );
      }
      if (artifact.attempts.length !== 1 || artifact.attempts[0].hasCookies) {
        throw new Error('guest-media-byte-canary-never-escalates used an authenticated or fallback attempt');
      }
    },
  },
  {
    name: 'guest-media-byte-canary-timeout',
    kind: 'guestCanary',
    scenario: 'authenticated_canary_stall',
    browserFallback: true,
    browserProfileCookies: true,
    guestCanaryUrl: 'https://www.youtube.com/watch?v=testvideo',
    authCanaryTimeoutMs: 200,
    realtimeDb: {},
    assert(result) {
      if (
        result.scope !== 'guest' ||
        result.succeeded !== false ||
        result.bytesDownloaded !== 0 ||
        result.failureClass !== 'guest_media_canary_timeout'
      ) {
        throw new Error(`guest-media-byte-canary-timeout returned an invalid report: ${JSON.stringify(result)}`);
      }
    },
  },
  {
    name: 'authenticated-media-byte-canary-session-unavailable',
    kind: 'authCanary',
    scenario: 'public_bot_cookie_ok',
    browserFallback: false,
    browserProfileCookies: false,
    authCanaryUrl: 'https://www.youtube.com/watch?v=testvideo',
    realtimeDb: {},
    assert(result, _cookieMeta, artifact) {
      if (
        result.scope !== 'authenticated' ||
        result.succeeded !== false ||
        result.bytesDownloaded !== 0 ||
        result.failureClass !== 'cookie_session_unavailable' ||
        !Number.isFinite(Date.parse(result.checkedAt))
      ) {
        throw new Error(
          `authenticated-media-byte-canary-session-unavailable returned an invalid report: ${JSON.stringify(result)}`
        );
      }
      if ((artifact?.attempts || []).length !== 0) {
        throw new Error('authenticated-media-byte-canary-session-unavailable invoked yt-dlp without a session');
      }
    },
  },
  {
    name: 'authenticated-media-byte-canary-timeout',
    kind: 'authCanary',
    scenario: 'authenticated_canary_stall',
    browserFallback: false,
    browserProfileCookies: true,
    authCanaryUrl: 'https://www.youtube.com/watch?v=testvideo',
    authCanaryTimeoutMs: 200,
    realtimeDb: {},
    assert(result, _cookieMeta, artifact) {
      if (
        result.scope !== 'authenticated' ||
        result.succeeded !== false ||
        result.bytesDownloaded !== 0 ||
        result.failureClass !== 'authenticated_media_canary_timeout'
      ) {
        throw new Error(
          `authenticated-media-byte-canary-timeout returned an invalid report: ${JSON.stringify(result)}`
        );
      }
      const attempt = artifact?.attempts?.find((candidate) => candidate.isSectionDownload);
      const outputIndex = attempt?.args?.indexOf('-o') ?? -1;
      const outputTemplate = outputIndex >= 0 ? attempt.args[outputIndex + 1] : null;
      if (!outputTemplate || fs.existsSync(path.dirname(outputTemplate))) {
        throw new Error('authenticated-media-byte-canary-timeout did not clean its temporary workspace');
      }
    },
  },
  {
    name: 'authenticated-media-byte-canary-browser-fallback',
    kind: 'authCanary',
    scenario: 'public_bot_cookie_stale',
    browserFallback: true,
    browserProfileCookies: true,
    authCanaryUrl: 'https://www.youtube.com/watch?v=testvideo',
    realtimeDb: {},
    assert(result, _cookieMeta, artifact) {
      if (
        result.scope !== 'authenticated' ||
        result.succeeded !== true ||
        result.bytesDownloaded <= 0 ||
        result.failureClass !== null
      ) {
        throw new Error(
          `authenticated-media-byte-canary-browser-fallback returned an invalid report: ${JSON.stringify(result)}`
        );
      }
      const attempts = artifact?.attempts || [];
      const cookieAttempt = attempts.findIndex((attempt) => attempt.hasCookies && attempt.isSectionDownload);
      const browserAttempt = attempts.findIndex(
        (attempt, index) => index > cookieAttempt && attempt.isJson && !attempt.hasExtractorArgs
      );
      if (cookieAttempt < 0 || browserAttempt <= cookieAttempt) {
        throw new Error('authenticated-media-byte-canary-browser-fallback did not preserve cookie-browser order');
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
      if (artifact.youtubeSuccessfulAcquisitionAuthority !== 'cookie_provider') {
        throw new Error(
          'public-download-guest-then-authenticated did not record cookie-provider acquisition authority'
        );
      }
    },
  },
  {
    name: 'public-download-auth-session-unavailable',
    kind: 'download',
    scenario: 'public_bot_cookie_ok',
    browserFallback: false,
    useCookiesForPublicVideos: false,
    browserProfileCookies: false,
    expectError: true,
    realtimeDb: {},
    assertError(error, _cookieMeta, artifact) {
      const evidence = artifact?.youtubeAcquisitionEvidence;
      const attemptedModes = JSON.stringify(evidence?.attemptedModes || []);
      if (attemptedModes !== JSON.stringify(['public_provider', 'cookie_provider'])) {
        throw new Error(`public-download-auth-session-unavailable had unexpected attempt evidence: ${attemptedModes}`);
      }
      if (evidence?.guestFailureClass !== 'public_path_bot_blocked') {
        throw new Error('public-download-auth-session-unavailable did not classify the guest denial');
      }
      if (evidence?.authenticatedFailureClass !== 'cookie_session_unavailable') {
        throw new Error('public-download-auth-session-unavailable did not classify the missing authenticated session');
      }
      if (evidence?.requiresAuthenticationRecovery !== true) {
        throw new Error('public-download-auth-session-unavailable did not request authentication recovery');
      }
      if (artifact.youtubeSuccessfulAcquisitionAuthority !== null) {
        throw new Error('public-download-auth-session-unavailable recorded authority without a successful artifact');
      }
      if (String(error).includes('SOURCE_UPLOAD_REQUIRED')) {
        throw new Error('public-download-auth-session-unavailable was incorrectly made terminal');
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
    name: 'public-download-browser-fallback-success',
    kind: 'download',
    scenario: 'public_bot_cookie_stale',
    browserFallback: true,
    useCookiesForPublicVideos: false,
    browserProfileCookies: true,
    realtimeDb: {},
    assert(result, _cookieMeta, artifact) {
      if (!fs.existsSync(result) || fs.statSync(result).size <= 0) {
        throw new Error('public-download-browser-fallback-success did not create a nonempty output file');
      }
      if (artifact.youtubeSuccessfulAcquisitionAuthority !== 'browser_fallback') {
        throw new Error('public-download-browser-fallback-success did not record browser-fallback authority');
      }

      const attempts = artifact?.attempts || [];
      const firstAuthenticatedAttempt = attempts.findIndex((attempt) => attempt.hasCookies);
      const browserAttempt = attempts.findIndex(
        (attempt, index) => index > firstAuthenticatedAttempt && attempt.isJson && !attempt.hasExtractorArgs
      );
      if (firstAuthenticatedAttempt <= 0 || browserAttempt <= firstAuthenticatedAttempt) {
        throw new Error('public-download-browser-fallback-success did not preserve guest-cookie-browser order');
      }
    },
  },
  {
    name: 'public-download-all-authorities-fail',
    kind: 'download',
    scenario: 'public_bot_cookie_and_browser_stale',
    browserFallback: true,
    useCookiesForPublicVideos: false,
    browserProfileCookies: true,
    expectError: true,
    realtimeDb: {},
    assertError(_error, _cookieMeta, artifact) {
      const evidence = artifact?.youtubeAcquisitionEvidence;
      const attemptedModes = JSON.stringify(evidence?.attemptedModes || []);
      if (attemptedModes !== JSON.stringify(['public_provider', 'cookie_provider', 'browser_fallback'])) {
        throw new Error(`public-download-all-authorities-fail had unexpected attempt evidence: ${attemptedModes}`);
      }
      if (evidence?.guestFailureClass !== 'public_path_bot_blocked') {
        throw new Error('public-download-all-authorities-fail did not classify the guest denial');
      }
      if (evidence?.authenticatedFailureClass !== 'cookie_session_stale_or_challenged') {
        throw new Error('public-download-all-authorities-fail did not classify the cookie-session denial');
      }
      if (evidence?.browserFallbackFailureClass !== 'browser_fallback_failed') {
        throw new Error('public-download-all-authorities-fail did not classify the browser fallback failure');
      }
      if (evidence?.requiresAuthenticationRecovery !== true) {
        throw new Error('public-download-all-authorities-fail did not request bounded authentication recovery');
      }
      if (artifact.youtubeSuccessfulAcquisitionAuthority !== null) {
        throw new Error('public-download-all-authorities-fail recorded authority without a successful artifact');
      }
    },
  },
  {
    name: 'public-download-account-required-browser-fallback-success',
    kind: 'download',
    scenario: 'public_account_cookie_stale_browser_ok',
    browserFallback: true,
    useCookiesForPublicVideos: false,
    browserProfileCookies: true,
    realtimeDb: {},
    assert(result, _cookieMeta, artifact) {
      if (
        !fs.existsSync(result) ||
        fs.statSync(result).size <= 0 ||
        artifact.youtubeSuccessfulAcquisitionAuthority !== 'browser_fallback'
      ) {
        throw new Error('public-download-account-required-browser-fallback-success did not produce browser bytes');
      }
      const attempts = artifact?.attempts || [];
      const cookieAttempt = attempts.findIndex((attempt) => attempt.hasCookies);
      const browserAttempt = attempts.findIndex(
        (attempt, index) => index > cookieAttempt && attempt.isJson && !attempt.hasExtractorArgs
      );
      if (attempts[0]?.hasCookies || cookieAttempt <= 0 || browserAttempt <= cookieAttempt) {
        throw new Error(
          'public-download-account-required-browser-fallback-success did not preserve guest-cookie-browser order'
        );
      }
    },
  },
  {
    name: 'public-download-browser-confirms-entitlement-denial',
    kind: 'download',
    scenario: 'public_bot_cookie_browser_account_required',
    browserFallback: true,
    useCookiesForPublicVideos: false,
    browserProfileCookies: true,
    expectError: true,
    realtimeDb: {},
    assertError(_error, _cookieMeta, artifact) {
      const evidence = artifact?.youtubeAcquisitionEvidence;
      const attemptedModes = JSON.stringify(evidence?.attemptedModes || []);
      if (attemptedModes !== JSON.stringify(['public_provider', 'cookie_provider', 'browser_fallback'])) {
        throw new Error(
          `public-download-browser-confirms-entitlement-denial had unexpected attempt evidence: ${attemptedModes}`
        );
      }
      if (evidence?.browserFallbackFailureClass !== 'account_required_content') {
        throw new Error('public-download-browser-confirms-entitlement-denial lost the entitlement classification');
      }
      if (evidence?.terminalFailureClass !== undefined) {
        throw new Error('public-download-browser-confirms-entitlement-denial trusted an unproven session as terminal');
      }
      if (evidence?.requiresAuthenticationRecovery !== true) {
        throw new Error('public-download-browser-confirms-entitlement-denial did not preserve session recovery');
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
      const attempts = artifact?.attempts || [];
      const firstAuthenticatedAttempt = attempts.findIndex((attempt) => attempt.hasCookies);
      const browserAttempt = attempts.findIndex(
        (attempt, index) => index > firstAuthenticatedAttempt && attempt.isJson && !attempt.hasExtractorArgs
      );
      if (attempts[0]?.hasCookies || firstAuthenticatedAttempt <= 0 || browserAttempt <= firstAuthenticatedAttempt) {
        throw new Error('browser-fallback-direct did not preserve guest-cookie-browser order');
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
