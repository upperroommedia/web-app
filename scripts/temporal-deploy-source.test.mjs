import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { assertCheckoutSource } from './temporal-deploy-source.mjs';
import { materializedPackageContents } from './materialize-catalog-for-firebase.mjs';
import {
  firebaseEnvironmentSources,
  flagsForControl,
  upsertFunctionFlags,
  RELEASE_DOMAINS,
} from './temporal-release-lib.mjs';
import { selectLegacyDeployConfig, selectKitDeployConfig } from './create-kit-deploy-config.mjs';
const manifest = {
  functions: [
    { source: 'functions-core', codebase: 'core' },
    { source: 'function-kits/email', kit: 'firestore-send-email' },
    { source: 'function-kits/search', kit: 'firestore-algolia-search' },
  ],
};
const workspace = 'catalog:\n  example: 1.2.3\n';
const packageSource =
  JSON.stringify(
    { name: 'functions-core', dependencies: { example: 'catalog:' }, scripts: { build: 'tsc' } },
    null,
    2
  ) + '\n';
async function fixture(action, { firebase = manifest, sourceFiles = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'temporal-source-provenance-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    await mkdir(join(root, 'functions-core'));
    await mkdir(join(root, 'functions/src'), { recursive: true });
    await writeFile(join(root, '.gitignore'), 'firebase.legacy.json\nfirebase.kits.json\n/gha-creds-*.json\n');
    await writeFile(join(root, 'firebase.json'), JSON.stringify(firebase));
    await writeFile(join(root, 'pnpm-workspace.yaml'), workspace);
    await writeFile(join(root, 'functions-core/package.json'), packageSource);
    await writeFile(
      join(root, 'functions/src/sentryBuildInfo.ts'),
      'export const sentryBuildGitSha = null as const;\n'
    );
    await writeFile(join(root, 'functions/src/handler.ts'), 'export const original = true;\n');
    for (const [file, contents] of Object.entries(sourceFiles)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), contents);
    }
    git(['init']);
    git(['add', '.']);
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture',
    ]);
    await action(root, git(['rev-parse', 'HEAD']), git);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('Clean pinned source accepts exact catalog/Sentry generation and deterministic ignored Firebase config only', async () => {
  await fixture(async (root, commit) => {
    assert.equal(assertCheckoutSource(root, commit), commit);
    execFileSync(
      process.execPath,
      [new URL('./materialize-catalog-for-firebase.mjs', import.meta.url).pathname, 'functions-core/package.json'],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    assert.equal(
      await readFile(join(root, 'functions-core/package.json'), 'utf8'),
      materializedPackageContents(packageSource, workspace)
    );
    await writeFile(
      join(root, 'functions/src/sentryBuildInfo.ts'),
      `export const sentryBuildGitSha = '${commit}' as const;\n`
    );
    await writeFile(
      join(root, 'firebase.legacy.json'),
      JSON.stringify(selectLegacyDeployConfig(manifest), null, 2) + '\n'
    );
    await writeFile(
      join(root, 'firebase.kits.json'),
      JSON.stringify(selectKitDeployConfig(manifest, { withoutSearch: true }), null, 2) + '\n'
    );
    assert.equal(assertCheckoutSource(root, commit), commit);
    const changed = JSON.parse(await readFile(join(root, 'functions-core/package.json'), 'utf8'));
    changed.scripts.build = 'run-arbitrary-source';
    await writeFile(join(root, 'functions-core/package.json'), JSON.stringify(changed, null, 2) + '\n');
    assert.throws(() => assertCheckoutSource(root, commit), /source differs/);
  });
});
test('Dirty backend, catalog, staged source, untracked source and deleted/symlink source cannot claim pinned commit', async () => {
  for (const change of ['backend', 'catalog', 'staged', 'untracked', 'deleted', 'symlink']) {
    await fixture(async (root, commit, git) => {
      const path = join(root, 'functions/src/handler.ts');
      if (change === 'backend' || change === 'staged') await writeFile(path, 'export const dirty = true;\n');
      if (change === 'catalog') await writeFile(join(root, 'pnpm-workspace.yaml'), 'catalog:\n  example: 9.9.9\n');
      if (change === 'staged') git(['add', '.']);
      if (change === 'untracked')
        await writeFile(join(root, 'functions/src/injected.ts'), 'export const injected = true;');
      if (change === 'deleted' || change === 'symlink') await rm(path);
      if (change === 'symlink') await symlink('/etc/hosts', path);
      assert.throws(() => assertCheckoutSource(root, commit));
    });
  }
});
test('Wrong Sentry SHA, added code, and altered generated deployment config are rejected', async () => {
  for (const change of ['sha', 'code', 'config'])
    await fixture(async (root, commit) => {
      if (change === 'sha')
        await writeFile(
          join(root, 'functions/src/sentryBuildInfo.ts'),
          `export const sentryBuildGitSha = '${'f'.repeat(40)}' as const;\n`
        );
      if (change === 'code')
        await writeFile(
          join(root, 'functions/src/sentryBuildInfo.ts'),
          `export const sentryBuildGitSha = '${commit}' as const;\nthrow new Error('injected');\n`
        );
      if (change === 'config')
        await writeFile(
          join(root, 'firebase.legacy.json'),
          JSON.stringify({ ...selectLegacyDeployConfig(manifest), hosting: { public: 'other' } }, null, 2) + '\n'
        );
      assert.throws(() => assertCheckoutSource(root, commit));
    });
});

test('Actual Firebase source surface permits exact current-project control generation and root OIDC artifact, rejects env tampering/cross-project flags', async () => {
  const actualManifest = JSON.parse(await readFile(new URL('../firebase.json', import.meta.url), 'utf8'));
  const generatedControl = {
    schemaVersion: 1,
    revision: 4,
    releaseId: 'reviewed',
    admission: 'paused',
    domains: Object.fromEntries(RELEASE_DOMAINS.map((domain) => [domain, { owner: 'temporal', admission: 'paused' }])),
  };
  for (const project of ['urm-app-staging', 'urm-app']) {
    const sources = firebaseEnvironmentSources(actualManifest, project);
    assert.ok(sources.length >= 6);
    assert.ok(sources.every((source) => source !== '.' && !source.startsWith('../')));
    const sourceFiles = Object.fromEntries(
      sources.map((source) => [
        `${source}/.env.${project}`,
        '# Reviewed provider settings\nEXISTING_PROVIDER_SETTING=retained\n',
      ])
    );
    // Use the actual committed instance baselines where the repository tracks them;
    // ignored codebase env files use harmless fixture provider settings.
    for (const file of Object.keys(sourceFiles)) {
      try {
        sourceFiles[file] = execFileSync('git', ['show', `HEAD:${file}`], {
          cwd: new URL('..', import.meta.url).pathname,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {}
    }
    await fixture(
      async (root, commit, git) => {
        await writeFile(join(root, 'gha-creds-fixture.json'), '{"type":"external_account"}');
        for (const [file, original] of Object.entries(sourceFiles))
          await writeFile(
            join(root, file),
            upsertFunctionFlags(original, { ...flagsForControl(generatedControl), TEMPORAL_RELEASE_COMMIT: commit })
          );
        const options = { project, control: generatedControl };
        const legacyControl = {
          ...generatedControl,
          domains: Object.fromEntries(
            RELEASE_DOMAINS.map((domain) => [domain, { owner: 'legacy', admission: 'paused' }])
          ),
        };
        for (const [file, original] of Object.entries(sourceFiles))
          await writeFile(
            join(root, file),
            upsertFunctionFlags(original, { ...flagsForControl(legacyControl), TEMPORAL_RELEASE_COMMIT: commit })
          );
        assert.equal(assertCheckoutSource(root, commit, { project, control: legacyControl }), commit);
        assert.throws(() => assertCheckoutSource(root, commit, options), /source differs/);
        // Operator explicitly verifies prior output, restores only these reviewed tracked paths,
        // then the postownership command regenerates them under current private control.
        git(['restore', '--source', commit, '--worktree', '--', ...Object.keys(sourceFiles)]);
        assert.equal(assertCheckoutSource(root, commit, options), commit);
        for (const [file, original] of Object.entries(sourceFiles))
          await writeFile(
            join(root, file),
            upsertFunctionFlags(original, { ...flagsForControl(generatedControl), TEMPORAL_RELEASE_COMMIT: commit })
          );

        assert.equal(assertCheckoutSource(root, commit, options), commit);
        assert.throws(() =>
          assertCheckoutSource(root, commit, {
            project: project === 'urm-app' ? 'urm-app-staging' : 'urm-app',
            control: generatedControl,
          })
        );
        const first = Object.keys(sourceFiles)[0],
          generated = await readFile(join(root, first), 'utf8');
        for (const changed of [
          generated.replace('EXISTING_PROVIDER_SETTING=retained', 'EXISTING_PROVIDER_SETTING=injected'),
          generated.replace('TASK_ORCHESTRATOR_MEDIA=temporal', 'TASK_ORCHESTRATOR_MEDIA=legacy'),
          generated.replace(commit, 'f'.repeat(40)),
        ]) {
          await writeFile(join(root, first), changed);
          assert.throws(() => assertCheckoutSource(root, commit, options), /source differs/);
        }
        await writeFile(join(root, first), generated);
        await writeFile(join(root, 'other-credential.json'), '{}');
        assert.throws(() => assertCheckoutSource(root, commit, options), /Untracked deployment source/);
      },
      { firebase: actualManifest, sourceFiles }
    );
  }
});
test('Google OIDC root artifact is narrowly excluded from source and every applicable Docker context', async () => {
  for (const file of ['.gitignore', '.dockerignore', 'apps/temporal-worker/Dockerfile.dockerignore'])
    assert.match(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), /^\/gha-creds-\*\.json$/m);
});
