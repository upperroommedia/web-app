#!/usr/bin/env node
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { deployedKitSources, validateKitNpmLock } from './kit-npm-lock-contract.mjs';
const [action] = process.argv.slice(2);
if (!['generate', 'check'].includes(action) || process.versions.node.split('.')[0] !== '22')
  throw Error('Usage (Node22): kit-npm-locks.mjs generate|check');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sources = [
  ...deployedKitSources(JSON.parse(await readFile(join(root, 'firebase.json'), 'utf8'))),
  'scripts/tests/fixtures/functions-framework',
];
const cache = await mkdtemp(join(tmpdir(), 'urm-kit-lock-cache-'));
try {
  for (const source of sources) {
    const bytes = await readFile(join(root, source, 'package.json'), 'utf8'),
      manifest = JSON.parse(bytes),
      lockPath = join(root, source, 'package-lock.json');
    if (action === 'check') {
      validateKitNpmLock(manifest, JSON.parse(await readFile(lockPath, 'utf8')));
      console.log(`Validated ${source} npm/native platform lock`);
      continue;
    }
    const directory = await mkdtemp(join(tmpdir(), 'urm-kit-clean-lock-'));
    try {
      await writeFile(join(directory, 'package.json'), bytes);
      await writeFile(join(directory, 'empty-user.npmrc'), '');
      await writeFile(join(directory, 'empty-global.npmrc'), '');
      execFileSync(
        'npm',
        [
          'install',
          '--package-lock-only',
          '--include=optional',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--registry=https://registry.npmjs.org',
          '--cache',
          cache,
        ],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            TMPDIR: directory,
            NPM_CONFIG_USERCONFIG: join(directory, 'empty-user.npmrc'),
            NPM_CONFIG_GLOBALCONFIG: join(directory, 'empty-global.npmrc'),
          },
          stdio: 'pipe',
          timeout: 180000,
          maxBuffer: 4 * 1024 * 1024,
        }
      );
      const lockBytes = await readFile(join(directory, 'package-lock.json'), 'utf8');
      validateKitNpmLock(manifest, JSON.parse(lockBytes));
      await writeFile(lockPath, lockBytes);
      console.log(`Generated clean full-platform npm lock: ${source}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
} finally {
  await rm(cache, { recursive: true, force: true });
}
