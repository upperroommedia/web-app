#!/usr/bin/env node

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Storage } = require('@google-cloud/storage');

const DEFAULT_PROFILE_ARCHIVE_OBJECT = 'browser-fallback/profile/chromium-profile.tar.gz';
const DEFAULT_VALIDATION_URL = 'https://www.youtube.com/watch?v=BaW_jenozKc';

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;

    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    const key = rawKey.trim();
    if (!key) continue;

    if (typeof inlineValue === 'string') {
      parsed[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      index += 1;
      continue;
    }

    parsed[key] = 'true';
  }

  return parsed;
}

function resolveOption(parsed, key, envKeys, fallback = '') {
  const direct = parsed[key];
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }

  for (const envKey of envKeys) {
    const envValue = process.env[envKey];
    if (typeof envValue === 'string' && envValue.trim()) {
      return envValue.trim();
    }
  }

  return fallback;
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
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
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
    });
  });
}

function validateCookiesText(decodedCookies) {
  if (!decodedCookies.trim()) {
    throw new Error('Exported cookies.txt is empty.');
  }

  const cookieLines = decodedCookies
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  const hasTabSeparatedCookies = cookieLines.some((line) => line.split('\t').length >= 7);
  const mentionsYouTube = /(^|[\s\t])(\.?youtube\.com|\.?google\.com)([\s\t]|$)/iu.test(decodedCookies);

  if (!hasTabSeparatedCookies || !mentionsYouTube) {
    throw new Error('Exported cookies.txt does not look like a Netscape YouTube/Google cookies file.');
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const localArchivePath = resolveOption(parsed, 'archive', [
    'BROWSER_FALLBACK_PROFILE_ARCHIVE_PATH',
    'BROWSER_FALLBACK_LOCAL_PROFILE_ARCHIVE_PATH',
  ]);
  const outputPath = resolveOption(parsed, 'output', ['BROWSER_FALLBACK_COOKIE_OUTPUT_PATH'], '');
  const validationUrl = resolveOption(
    parsed,
    'url',
    ['BROWSER_FALLBACK_HEALTHCHECK_YOUTUBE_URL', 'YTDLP_COOKIE_VALIDATION_URL'],
    DEFAULT_VALIDATION_URL
  );
  const ytdlpPath = resolveOption(parsed, 'ytdlp', ['YTDLP_PATH'], 'yt-dlp');
  const profileBucketName = resolveOption(parsed, 'bucket', ['BROWSER_FALLBACK_PROFILE_BUCKET', 'FIREBASE_STORAGE_BUCKET']);
  const profileArchiveObject = resolveOption(
    parsed,
    'archive-object',
    ['BROWSER_FALLBACK_PROFILE_ARCHIVE_OBJECT'],
    DEFAULT_PROFILE_ARCHIVE_OBJECT
  );

  if (!outputPath) {
    throw new Error('Set --output or BROWSER_FALLBACK_COOKIE_OUTPUT_PATH before exporting cookies.');
  }

  if (!localArchivePath && !profileBucketName) {
    throw new Error(
      'Set --archive / BROWSER_FALLBACK_PROFILE_ARCHIVE_PATH or set BROWSER_FALLBACK_PROFILE_BUCKET / FIREBASE_STORAGE_BUCKET.'
    );
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-fallback-export-'));
  const browserProfileDir = path.join(tmpDir, 'chromium-profile');
  const downloadedArchivePath = path.join(tmpDir, 'chromium-profile.tar.gz');
  const resolvedOutputPath = path.resolve(outputPath);

  try {
    await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await fs.rm(resolvedOutputPath, { force: true });
    await fs.mkdir(browserProfileDir, { recursive: true });

    let archivePath = localArchivePath;
    if (!archivePath) {
      const storage = new Storage();
      await storage.bucket(profileBucketName).file(profileArchiveObject).download({
        destination: downloadedArchivePath,
      });
      archivePath = downloadedArchivePath;
    }

    await runCommand('tar', ['-xzf', archivePath, '-C', browserProfileDir]);
    await runCommand(ytdlpPath, [
      '--ignore-config',
      '--skip-download',
      '--no-playlist',
      '--cookies-from-browser',
      `chromium:${browserProfileDir}`,
      '--cookies',
      resolvedOutputPath,
      validationUrl,
    ]);

    const exportedCookies = await fs.readFile(resolvedOutputPath, 'utf8');
    validateCookiesText(exportedCookies);

    process.stdout.write(`Exported yt-dlp cookies to ${resolvedOutputPath}\n`);
    process.stdout.write(`Validated export with ${validationUrl}\n`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
