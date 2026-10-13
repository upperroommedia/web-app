import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultTargets, materializedPackageContents } from './materialize-catalog-for-firebase.mjs';
import { selectKitDeployConfig, selectLegacyDeployConfig } from './create-kit-deploy-config.mjs';
import { firebaseEnvironmentSources, flagsForControl, upsertFunctionFlags } from './temporal-release-lib.mjs';

export function assertCheckoutCommit(actual, claimed) {
  if (!/^[a-f0-9]{40}$/.test(actual ?? '') || claimed !== actual)
    throw new Error('Deployment commit must equal the actual immutable checkout SHA');
  return actual;
}
export function assertCheckoutSource(root, commit, { project, control } = {}) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assertCheckoutCommit(git(['rev-parse', 'HEAD']).trim(), commit);
  const original = (file) => git(['show', `${commit}:${file}`]);
  const changed = git(['diff', '--name-only', '-z', commit, '--']).split('\0').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  if (git(['diff', '--cached', '--name-only', '-z', commit, '--']))
    throw new Error('Staged deployment source requires review/commit before preparation');
  if (untracked.length) throw new Error('Untracked deployment source requires review/commit before deployment');
  const input = JSON.parse(original('firebase.json'));
  const environmentFiles = project
    ? firebaseEnvironmentSources(input, project).map((source) => `${source}/.env.${project}`)
    : [];
  for (const file of changed) {
    const path = resolve(root, file);
    if (!existsSync(path) || !lstatSync(path).isFile())
      throw new Error('Deployment source deletion/symlink requires review/commit');
    const actual = readFileSync(path, 'utf8');
    let expected;
    if (defaultTargets.includes(file))
      expected = materializedPackageContents(original(file), original('pnpm-workspace.yaml'));
    else if (file === 'functions/src/sentryBuildInfo.ts')
      expected = `export const sentryBuildGitSha = '${commit}' as const;\n`;
    else if (environmentFiles.includes(file) && control)
      expected = upsertFunctionFlags(original(file), { ...flagsForControl(control), TEMPORAL_RELEASE_COMMIT: commit });
    if (expected === undefined || actual !== expected)
      throw new Error(`Deployment source differs from pinned commit: ${file}`);
  }
  const generated = {
    'firebase.legacy.json': [selectLegacyDeployConfig(input)],
    'firebase.kits.json': [selectKitDeployConfig(input), selectKitDeployConfig(input, { withoutSearch: true })],
  };
  for (const [file, allowed] of Object.entries(generated)) {
    const path = resolve(root, file);
    if (!existsSync(path)) continue;
    if (
      !lstatSync(path).isFile() ||
      !allowed.some((config) => readFileSync(path, 'utf8') === `${JSON.stringify(config, null, 2)}\n`)
    )
      throw new Error(`Generated deployment config differs from pinned Firebase manifest: ${file}`);
  }
  return commit;
}
