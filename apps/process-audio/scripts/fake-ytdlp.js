#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const scenario = process.env.FAKE_YTDLP_SCENARIO || 'public_success';
const hasCookies = args.includes('--cookies') || args.includes('--cookies-from-browser');
const hasExtractorArgs = args.includes('--extractor-args');
const isJson = args.includes('-J');
const isHealthcheck = args.includes('--skip-download');
const isDirectUrl = args.includes('-g');
const hasFormatSelector = args.includes('-f');
const sectionIndex = args.indexOf('--download-sections');
const isSectionDownload = sectionIndex !== -1;
const outputIndex = args.indexOf('-o');
const outputTemplate = outputIndex !== -1 ? args[outputIndex + 1] : undefined;
const logFile = process.env.FAKE_YTDLP_LOG_FILE;

if (logFile) {
  fs.appendFileSync(
    logFile,
    `${JSON.stringify({
      args,
      hasCookies,
      isJson,
      isHealthcheck,
      isDirectUrl,
      isSectionDownload,
      hasFormatSelector,
    })}\n`
  );
}

function writeStdout(value) {
  process.stdout.write(value);
}

function writeStderr(value) {
  process.stderr.write(value);
}

function fail(message) {
  writeStderr(message.endsWith('\n') ? message : `${message}\n`);
  process.exit(1);
}

function succeedJson(payload) {
  writeStdout(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

function succeedDirectUrl() {
  writeStdout('20\n');
  writeStdout('m4a\n');
  writeStdout('https://example.com/fake-audio.m4a\n');
  process.exit(0);
}

function succeedSectionDownload() {
  const target = (outputTemplate || '/tmp/fake-output.%(ext)s').replace(/%\((?:ext)\)s/g, 'm4a');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from('FAKE-M4A'));
  writeStderr('[download] 100% of 20.00KiB in 00:00\n');
  process.exit(0);
}

function stallAfterPartialDownload() {
  const target = (outputTemplate || '/tmp/fake-output.%(ext)s').replace(/%\((?:ext)\)s/g, 'm4a');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(`${target}.part`, Buffer.alloc(1024 * 1024, 1));
  fs.writeFileSync(`${target}.part-Frag131.part`, Buffer.alloc(32 * 1024, 2));
  writeStderr('\r[download]  12.5% of ~  81.35MiB at  822.13KiB/s ETA 01:28 (frag 130/1040)');

  const keepAlive = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => {
    clearInterval(keepAlive);
    process.exit(143);
  });
}

function buildAudioJson() {
  return buildAudioJsonWithUrl('https://example.com/fake-audio.m4a');
}

function buildAudioJsonWithUrl(url) {
  return {
    duration: 20,
    formats: [
      {
        format_id: '140',
        ext: 'm4a',
        vcodec: 'none',
        abr: 128,
        protocol: 'https',
        url,
        http_headers: {
          'User-Agent': 'fake-ytdlp-test-agent',
        },
      },
    ],
  };
}

function buildPostLiveMuxedJson() {
  return {
    duration: 3650,
    live_status: 'post_live',
    was_live: true,
    formats: [
      {
        format_id: '140',
        ext: 'm4a',
        vcodec: 'none',
        abr: 128,
        protocol: 'http_dash_segments',
        fragments: [{ url: 'https://example.com/dash-frag-1.m4s' }],
      },
      {
        format_id: '96',
        ext: 'mp4',
        vcodec: 'avc1.4d401f',
        abr: 96,
        protocol: 'm3u8_native',
        url: 'https://example.com/post-live.m3u8',
        fragments: [{ url: 'https://example.com/live-frag-1.ts' }, { url: 'https://example.com/live-frag-2.ts' }],
      },
    ],
  };
}

function ensureLocalM4aFixture() {
  const fixturePath = path.join(__dirname, '..', '.tmp', 'youtube-loop', 'browser-fallback-input.m4a');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });

  if (!fs.existsSync(fixturePath)) {
    const result = spawnSync(
      'ffmpeg',
      ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '2', '-c:a', 'aac', '-b:a', '128k', fixturePath],
      { stdio: 'ignore' }
    );

    if (result.status !== 0) {
      fail('ERROR: Unable to generate local browser fallback audio fixture.');
    }
  }

  return fixturePath;
}

switch (scenario) {
  case 'public_success':
    if (isJson) {
      succeedJson(buildAudioJson());
    }
    if (isDirectUrl) {
      succeedDirectUrl();
    }
    if (isSectionDownload) {
      succeedSectionDownload();
    }
    if (outputTemplate) {
      succeedSectionDownload();
    }
    process.exit(0);
    break;

  case 'public_bot_cookie_stale':
  case 'public_bot_cookie_and_browser_stale':
  case 'public_bot_cookie_browser_account_required':
  case 'public_account_cookie_stale_browser_ok':
    if (!hasCookies) {
      if (scenario === 'public_account_cookie_stale_browser_ok') {
        fail('ERROR: [youtube] testvideo: This video is private.');
      }
      fail(
        'WARNING: [youtube] No title found in player responses; falling back to title from initial data. Other metadata may also be missing\nERROR: [youtube] testvideo: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.'
      );
    }

    if (scenario === 'public_bot_cookie_browser_account_required' && isJson && isHealthcheck && !hasExtractorArgs) {
      fail('ERROR: [youtube] testvideo: This video is private.');
    }

    if (
      scenario !== 'public_bot_cookie_and_browser_stale' &&
      scenario !== 'public_bot_cookie_browser_account_required' &&
      isJson &&
      isHealthcheck &&
      !hasExtractorArgs
    ) {
      succeedJson(buildAudioJsonWithUrl(`file://${ensureLocalM4aFixture()}`));
    }

    if (isHealthcheck || isJson || isDirectUrl || isSectionDownload || outputTemplate) {
      fail('ERROR: [youtube] testvideo: The page needs to be reloaded.');
    }
    process.exit(1);
    break;

  case 'public_bot_cookie_ok':
    if (!hasCookies) {
      fail('ERROR: [youtube] testvideo: Sign in to confirm you’re not a bot.');
    }

    if (isJson) {
      succeedJson(buildAudioJson());
    }
    if (isDirectUrl) {
      succeedDirectUrl();
    }
    if (isSectionDownload) {
      succeedSectionDownload();
    }
    if (outputTemplate) {
      succeedSectionDownload();
    }
    process.exit(0);
    break;

  case 'post_live_rescue_success':
    if (isJson && hasFormatSelector) {
      fail('ERROR: [youtube] testvideo: This live event has ended.');
    }
    if (isJson) {
      succeedJson(buildPostLiveMuxedJson());
    }
    if (outputTemplate) {
      succeedSectionDownload();
    }
    if (isDirectUrl) {
      succeedDirectUrl();
    }
    process.exit(0);
    break;

  case 'provider_unhealthy':
    fail('ERROR: [youtube] [pot] PO Token Providers: none');
    break;

  case 'download_stall_after_partial':
    if (isJson) {
      succeedJson(buildAudioJson());
    }
    if (isSectionDownload) {
      succeedSectionDownload();
    }
    if (isDirectUrl) {
      succeedDirectUrl();
    }
    stallAfterPartialDownload();
    break;

  case 'authenticated_canary_stall':
    if (isSectionDownload) {
      stallAfterPartialDownload();
      break;
    }
    fail('ERROR: canary stall scenario requires a section download');
    break;

  default:
    fail(`ERROR: Unsupported FAKE_YTDLP_SCENARIO: ${scenario}`);
}
