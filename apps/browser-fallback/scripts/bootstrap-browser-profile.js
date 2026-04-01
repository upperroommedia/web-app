#!/usr/bin/env node

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawn } = require('node:child_process');
const { stdin: input, stdout: output } = require('node:process');
const { chromium } = require('playwright');
const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');

const profileBucketName = process.env.BROWSER_FALLBACK_PROFILE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET;
const profileObject = process.env.BROWSER_FALLBACK_PROFILE_OBJECT || 'browser-fallback/profile/storage-state.json';
const profileArchiveObject =
  process.env.BROWSER_FALLBACK_PROFILE_ARCHIVE_OBJECT || 'browser-fallback/profile/chromium-profile.tar.gz';
const profileMetaObject = process.env.BROWSER_FALLBACK_PROFILE_META_OBJECT || 'browser-fallback/profile/latest.json';
const localStatePath = process.env.BROWSER_FALLBACK_LOCAL_STATE_PATH?.trim() || '';
const localProfileArchivePath = process.env.BROWSER_FALLBACK_LOCAL_PROFILE_ARCHIVE_PATH?.trim() || '';
const authCookieNames = new Set(['SID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID']);

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

async function main() {
  if (!profileBucketName) {
    throw new Error('Set BROWSER_FALLBACK_PROFILE_BUCKET or FIREBASE_STORAGE_BUCKET before bootstrapping.');
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
  }

  const storage = new Storage();
  const bucket = storage.bucket(profileBucketName);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-fallback-bootstrap-'));
  const statePath = path.join(os.tmpdir(), `browser-fallback-storage-state-${Date.now()}.json`);
  const archivePath = path.join(os.tmpdir(), `browser-fallback-profile-${Date.now()}.tar.gz`);
  const context = await chromium.launchPersistentContext(tmpDir, {
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/robots.txt', { waitUntil: 'domcontentloaded' });

  const rl = readline.createInterface({ input, output });
  output.write('\nLog into the dedicated YouTube account in the opened browser, then return here.\n');
  await rl.question('Press Enter after the session is fully authenticated and stable...');
  await rl.close();

  const storageState = await context.storageState({ path: statePath });
  const authCookies = (storageState.cookies || []).filter((cookie) => authCookieNames.has(cookie.name));
  if (authCookies.length === 0) {
    await context.close();
    throw new Error('The captured browser session does not contain YouTube auth cookies. Log in fully before pressing Enter.');
  }

  await context.close();
  await runCommand('tar', ['-czf', archivePath, '-C', tmpDir, '.']);

  const file = bucket.file(profileObject);
  await file.save(await fs.readFile(statePath), {
    resumable: false,
    contentType: 'application/json',
  });
  const archiveFile = bucket.file(profileArchiveObject);
  await archiveFile.save(await fs.readFile(archivePath), {
    resumable: false,
    contentType: 'application/gzip',
  });

  let savedLocalStatePath = statePath;
  if (localStatePath) {
    await fs.mkdir(path.dirname(localStatePath), { recursive: true });
    await fs.copyFile(statePath, localStatePath);
    savedLocalStatePath = localStatePath;
  }
  let savedLocalProfileArchivePath = archivePath;
  if (localProfileArchivePath) {
    await fs.mkdir(path.dirname(localProfileArchivePath), { recursive: true });
    await fs.copyFile(archivePath, localProfileArchivePath);
    savedLocalProfileArchivePath = localProfileArchivePath;
  }

  const metadata = {
    sessionState: 'authenticated',
    profileUpdatedAt: new Date().toISOString(),
    profileGeneration: file.metadata?.generation || null,
  };

  await bucket.file(profileMetaObject).save(JSON.stringify(metadata, null, 2), {
    resumable: false,
    contentType: 'application/json',
  });

  output.write(`Uploaded portable browser fallback storage state to gs://${profileBucketName}/${profileObject}\n`);
  output.write(`Uploaded portable browser fallback Chromium profile archive to gs://${profileBucketName}/${profileArchiveObject}\n`);
  output.write(`Saved local browser fallback storage state to ${savedLocalStatePath}\n`);
  output.write(`Saved local browser fallback Chromium profile archive to ${savedLocalProfileArchivePath}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
