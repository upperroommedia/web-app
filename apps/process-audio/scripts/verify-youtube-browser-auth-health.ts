import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getYouTubeBrowserAuthHealth } from '../src/processYouTubeUrl';

const originalEnv = {
  profileDir: process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR,
  refreshControlDir: process.env.PROCESS_AUDIO_BROWSER_REFRESH_CONTROL_DIR,
};

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yt-browser-health-'));
  try {
    const profileDir = path.join(root, 'profile');
    const cookiesDir = path.join(profileDir, 'Default');
    const refreshControlDir = path.join(root, 'refresh-control');
    await mkdir(cookiesDir, { recursive: true });
    await mkdir(refreshControlDir, { recursive: true });
    await writeFile(path.join(cookiesDir, 'Cookies'), 'fake-cookie-db');

    process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR = profileDir;
    process.env.PROCESS_AUDIO_BROWSER_REFRESH_CONTROL_DIR = refreshControlDir;

    const health = await getYouTubeBrowserAuthHealth();

    assert.equal(health.profileDirConfigured, true);
    assert.equal(health.cookiesDb.exists, true);
    assert.equal(health.cookiesDb.size, 'fake-cookie-db'.length);
    assert.equal(health.refreshControlDir.configured, true);
    assert.equal(health.refreshControlDir.exists, true);
    assert.equal(health.refreshControlDir.writable, true);

    process.stdout.write('youtube browser auth health verification passed\n');
  } finally {
    if (originalEnv.profileDir === undefined) {
      delete process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR;
    } else {
      process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR = originalEnv.profileDir;
    }
    if (originalEnv.refreshControlDir === undefined) {
      delete process.env.PROCESS_AUDIO_BROWSER_REFRESH_CONTROL_DIR;
    } else {
      process.env.PROCESS_AUDIO_BROWSER_REFRESH_CONTROL_DIR = originalEnv.refreshControlDir;
    }
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
