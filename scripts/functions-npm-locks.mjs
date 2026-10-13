#!/usr/bin/env node
// Explicit CLI-only lock generation; normal deploys only check tracked locks.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  defaultTargets,
  materializedPackageContents,
  validateNpmDeploymentLock,
} from './materialize-catalog-for-firebase.mjs';
const [action] = process.argv.slice(2);
if (!['generate', 'check'].includes(action)) throw new Error('Usage: functions-npm-locks.mjs generate|check');
if (process.versions.node.split('.')[0] !== '22')
  throw new Error('Node22 is required for deployment lock generation/checks');
const root = resolve(new URL('..', import.meta.url).pathname),
  workspace = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
for (const target of defaultTargets) {
  const contents = materializedPackageContents(await readFile(join(root, target), 'utf8'), workspace),
    manifest = JSON.parse(contents);
  const lockPath = join(root, dirname(target), 'package-lock.json');
  if (action === 'check') {
    validateNpmDeploymentLock(manifest, JSON.parse(await readFile(lockPath, 'utf8')), workspace);
    console.log(`Validated ${dirname(target)} npm deployment lock`);
    continue;
  }
  const temp = await mkdtemp(join(tmpdir(), 'urm-function-npm-lock-'));
  try {
    await writeFile(join(temp, 'package.json'), contents);
    await writeFile(join(temp, 'empty-user.npmrc'), '');
    await writeFile(join(temp, 'empty-global.npmrc'), '');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
    execFileSync(
      'npm',
      [
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry=https://registry.npmjs.org',
      ],
      {
        cwd: temp,
        env: {
          ...env,
          NPM_CONFIG_USERCONFIG: join(temp, 'empty-user.npmrc'),
          NPM_CONFIG_GLOBALCONFIG: join(temp, 'empty-global.npmrc'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
    const bytes = await readFile(join(temp, 'package-lock.json'), 'utf8');
    validateNpmDeploymentLock(manifest, JSON.parse(bytes), workspace);
    await writeFile(lockPath, bytes);
    console.log(`Generated ${dirname(target)} npm deployment lock through npm CLI`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
