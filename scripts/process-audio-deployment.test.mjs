import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { authorizeDeployment, acquireDeploymentLock } from './temporal-deploy-guard.mjs';
const root = resolve(new URL('..', import.meta.url).pathname);

test('actual Hetzner context includes Docker dependency manifests, source, and workspace patches', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'urm-audio-context-test-'));
  try {
    const repo = join(fixture, 'repo'),
      output = join(fixture, 'context');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    cpSync(
      join(root, 'scripts/prepare-process-audio-hetzner-context.sh'),
      join(repo, 'scripts/prepare-process-audio-hetzner-context.sh')
    );
    for (const file of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'turbo.json',
      'patches/dependency.patch',
      ...['apps/process-audio', 'packages/contracts', 'packages/shared', 'packages/orchestration'].flatMap((dir) => [
        `${dir}/package.json`,
        `${dir}/src/entry.ts`,
        `${dir}/dist/old.js`,
        `${dir}/node_modules/unwanted`,
      ]),
    ]) {
      mkdirSync(join(repo, file, '..'), { recursive: true });
      writeFileSync(join(repo, file), file);
    }
    execFileSync('bash', [join(repo, 'scripts/prepare-process-audio-hetzner-context.sh'), output], { stdio: 'pipe' });
    for (const dir of ['apps/process-audio', 'packages/contracts', 'packages/shared', 'packages/orchestration']) {
      assert.equal(readFileSync(join(output, dir, 'src/entry.ts'), 'utf8'), `${dir}/src/entry.ts`);
      assert.ok(existsSync(join(output, dir, 'package.json')));
      assert.equal(existsSync(join(output, dir, 'dist')), false);
      assert.equal(existsSync(join(output, dir, 'node_modules')), false);
    }
    assert.equal(readFileSync(join(output, 'patches/dependency.patch'), 'utf8'), 'patches/dependency.patch');
    assert.match(readFileSync(join(output, '.dockerignore'), 'utf8'), /^\/gha-creds-\*\.json$/m);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

for (const branch of ['main', 'staging'])
  for (const target of ['deploy', 'hetzner-deploy']) {
    test(`${branch} audio ${target} authenticates and installs before guarding the actual deployment`, () => {
      const workflow = readFileSync(join(root, `.github/workflows/${branch}-process-audio-${target}.yml`), 'utf8');
      const guard =
        'node scripts/temporal-deploy-guard.mjs --project "$GCP_PROJECT" -- bash scripts/deploy-process-audio';
      const position = workflow.indexOf(guard);
      assert.ok(position > workflow.indexOf('google-github-actions/auth@'));
      assert.ok(
        position > workflow.indexOf('pnpm install --frozen-lockfile --filter functions --prod --ignore-scripts')
      );
      assert.match(workflow, /node-version-file: package\.json/);
      assert.match(workflow, /uses: pnpm\/action-setup@/);
      assert.equal(
        workflow.includes('--release '),
        false,
        'automatic audio deploys cannot opt into controlled releases'
      );
      assert.equal(
        (workflow.match(/run: (?:\.\/|bash )scripts\/deploy-process-audio/g) ?? []).length,
        0,
        'no direct run bypass'
      );
      for (const path of ['packages/orchestration/**', 'patches/**', 'scripts/temporal-deploy-guard.mjs'])
        assert.ok(workflow.includes(`- '${path}'`));
      if (target === 'deploy') {
        const pattern = workflow.match(/if contains_path '(\^\(.*packages\/orchestration.*)'/)[1];
        for (const file of [
          'packages/orchestration/src/job-store.ts',
          'patches/test.patch',
          'scripts/temporal-deploy-guard.mjs',
        ])
          assert.equal(
            execFileSync('bash', ['-c', 'printf "%s\\n" "$1" | grep -Eq "$2"', 'fixture', file, pattern], {
              stdio: 'pipe',
            }).length,
            0
          );
      }
    });
  }

test('automatic runtime deployment is rejected before creating a lock during every active release phase', async () => {
  for (const phase of [
    'ui-frozen',
    'compatibility-ready',
    'legacy-drained',
    'provider-usage-ready',
    'ownership-changed',
    'backend-ready',
    'bundles-ready',
    'smoke-passed',
  ]) {
    let created = false;
    const control = { releaseId: 'release' },
      state = { releaseId: 'release', phase };
    const db = {
      doc: (path) => ({ path }),
      runTransaction: (run) =>
        run({
          get: async (ref) => ({
            exists: ref.path !== '_control/temporalReleaseOperation',
            data: () => (ref.path === '_control/temporalReleaseState' ? state : control),
          }),
          create: () => {
            created = true;
          },
        }),
    };
    await assert.rejects(
      acquireDeploymentLock(db, { operationId: 'audio', commit: 'a'.repeat(40) }),
      /active controlled release/
    );
    assert.equal(created, false);
  }
  assert.doesNotThrow(() => authorizeDeployment(undefined, undefined));
  assert.doesNotThrow(() => authorizeDeployment({ releaseId: 'release' }, { releaseId: 'release', phase: 'complete' }));
});

test('audio upload ignore rules exclude root OIDC files while retaining workspace patches', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'urm-audio-upload-test-'));
  try {
    cpSync(join(root, 'apps/process-audio/.gcloudignore'), join(fixture, '.gcloudignore'));
    mkdirSync(join(fixture, 'patches'));
    writeFileSync(join(fixture, 'gha-creds-synthetic-test.json'), 'synthetic fixture, no credentials');
    writeFileSync(join(fixture, 'patches/dependency.patch'), 'required patch');
    writeFileSync(join(fixture, 'package.json'), '{}');
    const names = execFileSync('gcloud', ['meta', 'list-files-for-upload'], {
      cwd: fixture,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n');
    assert.equal(names.includes('gha-creds-synthetic-test.json'), false);
    assert.ok(names.includes('patches/dependency.patch'));
    assert.ok(names.includes('package.json'));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('application CI runs both audio deployment suites for workflow and host changes', () => {
  const workflow = readFileSync(join(root, '.github/workflows/temporal-application-validation.yml'), 'utf8');
  assert.ok(workflow.includes("- '.github/workflows/*process-audio*deploy.yml'"));
  assert.ok(workflow.includes("- 'ops/process-audio-hetzner/**'"));
  assert.ok(
    workflow.includes(
      'node --test scripts/process-audio-deployment.test.mjs scripts/test-process-audio-hetzner-isolation.mjs'
    )
  );
  assert.ok(
    workflow.indexOf('google-github-actions/setup-gcloud@') <
      workflow.indexOf('node --test scripts/process-audio-deployment.test.mjs')
  );
});

test('actual deployment allowlist parsers accept exact Google service identities and reject broad or malformed trust', () => {
  const cases = [
    { value: ['251680231116-compute@developer.gserviceaccount.com'], valid: true },
    { value: ['queue@urm-app.iam.gserviceaccount.com', 'native@urm-app-staging.iam.gserviceaccount.com'], valid: true },
    { value: ['user@gmail.com'], valid: false },
    { value: ['*@urm-app.iam.gserviceaccount.com'], valid: false },
    { value: [], valid: false },
    { value: 'queue@urm-app.iam.gserviceaccount.com', valid: false },
    { value: [null], valid: false },
    { value: ['queue@urm-app.iamXgserviceaccountXcom'], valid: false },
  ];
  for (const [file, marker] of [
    ['scripts/deploy-process-audio.sh', 'CHECK_NATIVE_AUTH'],
    ['scripts/deploy-process-audio-hetzner.sh', 'CHECK_NATIVE_CALLERS'],
  ]) {
    const source = readFileSync(join(root, file), 'utf8');
    const parser = source.split(`<<'${marker}'\n`)[1]?.split(`\n${marker}`)[0];
    assert.ok(parser, `${file} actual parser is exercised`);
    for (const item of cases) {
      let succeeded = true;
      try {
        execFileSync('python3', ['-c', parser], {
          stdio: 'pipe',
          env: {
            ...process.env,
            PROCESS_AUDIO_ALLOWED_CALLER_EMAILS: JSON.stringify(item.value),
            PROCESS_AUDIO_TASK_SERVICE_ACCOUNT_EMAIL: Array.isArray(item.value) ? String(item.value[0]) : 'not-allowed',
            PROCESS_AUDIO_OIDC_AUDIENCES: JSON.stringify([
              'https://owned.example',
              'https://owned.example/process-audio',
            ]),
          },
        });
      } catch {
        succeeded = false;
      }
      assert.equal(succeeded, item.valid, `${file}: ${JSON.stringify(item.value)}`);
    }
  }
});
