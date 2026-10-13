#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  firebaseAdmin,
  flagsForControl,
  firebaseEnvironmentSources,
  upsertFunctionFlags,
  CONTROL_PATH,
} from './temporal-release-lib.mjs';
const args = process.argv.slice(2);
const project = args[args.indexOf('--project') + 1];
const file = args.includes('--control-file') ? args[args.indexOf('--control-file') + 1] : undefined;
if (!['urm-app', 'urm-app-staging'].includes(project) || (!args.includes('--from-control') && !file))
  throw new Error('Usage: temporal-function-env.mjs --project PROJECT --from-control|--control-file PATH [--apply]');
const root = resolve(new URL('..', import.meta.url).pathname);
const control = file
  ? JSON.parse(await readFile(file, 'utf8'))
  : (await firebaseAdmin(project).firestore.doc(CONTROL_PATH).get()).data();
const flags = flagsForControl(control);
const commit = args.includes('--commit')
  ? args[args.indexOf('--commit') + 1]
  : process.env.GITHUB_SHA ||
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Function deployment commit must be an immutable full SHA');
flags.TEMPORAL_RELEASE_COMMIT = commit;
const manifest = JSON.parse(await readFile(resolve(root, 'firebase.json'), 'utf8'));
const sources = firebaseEnvironmentSources(manifest, project);
for (const source of sources) {
  const directory = resolve(root, source);
  const pathFromRoot = relative(root, directory);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`))
    throw new Error('Firebase environment sources must stay inside the reviewed repository');
  const path = resolve(directory, `.env.${project}`);
  let content = '';
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (args.includes('--apply')) await writeFile(path, upsertFunctionFlags(content, flags), { mode: 0o600 });
}
console.log(
  `${args.includes('--apply') ? 'Wrote' : 'Validated'} Firebase ownership env files for ${
    sources.length
  } function source/instance directories at control revision${control.revision}.`
);
