#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertCheckoutCommit, assertCheckoutSource } from './temporal-deploy-source.mjs';
import {
  firebaseAdmin,
  flagsForControl,
  firebaseEnvironmentSources,
  upsertFunctionFlags,
  CONTROL_PATH,
  validateReleaseConfig,
} from './temporal-release-lib.mjs';
import { assertStagingSearchEnvironmentRelease } from './temporal-staging-search-env.mjs';
import { providerRuntimeEnvironment } from './provider-runtime-environment.mjs';
const args = process.argv.slice(2);
const project = args[args.indexOf('--project') + 1];
const file = args.includes('--control-file') ? args[args.indexOf('--control-file') + 1] : undefined;
if (!['urm-app', 'urm-app-staging'].includes(project) || (!args.includes('--from-control') && !file))
  throw new Error('Usage: temporal-function-env.mjs --project PROJECT --from-control|--control-file PATH [--apply]');
const root = resolve(new URL('..', import.meta.url).pathname);
const control = file
  ? JSON.parse(await readFile(file, 'utf8'))
  : (await firebaseAdmin(project).firestore.doc(CONTROL_PATH).get()).data();
const flags = { ...flagsForControl(control), ...providerRuntimeEnvironment(project) };
const commit = args.includes('--commit')
  ? args[args.indexOf('--commit') + 1]
  : process.env.GITHUB_SHA ||
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
const actualCheckout = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assertCheckoutCommit(actualCheckout, commit);
flags.TEMPORAL_RELEASE_COMMIT = commit;
const manifest = JSON.parse(await readFile(resolve(root, 'firebase.json'), 'utf8'));
const includeStagingSearch = args.includes('--include-staging-search');
let searchRelease;
if (includeStagingSearch) {
  const releasePath = args.includes('--release') ? args[args.indexOf('--release') + 1] : undefined;
  if (!releasePath) throw new Error('Search environment opt-in requires --release PATH');
  searchRelease = validateReleaseConfig(JSON.parse(await readFile(releasePath, 'utf8')));
  assertStagingSearchEnvironmentRelease({ project, release: searchRelease, control, commit });
}
assertCheckoutSource(root, commit, { project, control, release: searchRelease, includeStagingSearch });
const sources = firebaseEnvironmentSources(manifest, project, { includeStagingSearch });
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
