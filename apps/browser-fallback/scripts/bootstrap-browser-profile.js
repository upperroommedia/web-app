#!/usr/bin/env node

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { chromium } = require('playwright');
const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');

const profileBucketName = process.env.BROWSER_FALLBACK_PROFILE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET;
const profileObject = process.env.BROWSER_FALLBACK_PROFILE_OBJECT || 'browser-fallback/profile/storage-state.json';
const profileMetaObject = process.env.BROWSER_FALLBACK_PROFILE_META_OBJECT || 'browser-fallback/profile/latest.json';
const authCookieNames = new Set(['SID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID']);

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

  const file = bucket.file(profileObject);
  await file.save(await fs.readFile(statePath), {
    resumable: false,
    contentType: 'application/json',
  });

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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
