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
const sectionIndex = args.indexOf('--download-sections');
const isSectionDownload = sectionIndex !== -1;
const outputIndex = args.indexOf('-o');
const outputTemplate = outputIndex !== -1 ? args[outputIndex + 1] : undefined;
const logFile = process.env.FAKE_YTDLP_LOG_FILE;

if (logFile) {
  fs.appendFileSync(
    logFile,
    `${JSON.stringify({ args, hasCookies, isJson, isHealthcheck, isDirectUrl, isSectionDownload })}\n`
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

function ensureLocalM4aFixture() {
  const fixturePath = path.join(__dirname, '..', '.tmp', 'youtube-loop', 'browser-fallback-input.m4a');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });

  if (!fs.existsSync(fixturePath)) {
    const result = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=44100:cl=mono',
        '-t',
        '2',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        fixturePath,
      ],
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
    process.exit(0);
    break;

  case 'public_bot_cookie_stale':
    if (!hasCookies) {
      fail(
        "WARNING: [youtube] No title found in player responses; falling back to title from initial data. Other metadata may also be missing\nERROR: [youtube] testvideo: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication."
      );
    }

    if (isJson && isHealthcheck && !hasExtractorArgs) {
      succeedJson(buildAudioJsonWithUrl(`file://${ensureLocalM4aFixture()}`));
    }

    if (isHealthcheck || isJson || isDirectUrl || isSectionDownload) {
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

  default:
    fail(`ERROR: Unsupported FAKE_YTDLP_SCENARIO: ${scenario}`);
}
