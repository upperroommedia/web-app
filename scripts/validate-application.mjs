// The application validation sequence is identical locally and in GitHub Actions.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export function applicationStages(root = ROOT) {
  const node = (...args) => ['node', ...args];
  const pnpm = (...args) => ['pnpm', ...args];
  const stage = (id, name, commands, env = {}) => ({ id, name, commands, env });
  return [
    stage('install', 'Install locked workspace', [pnpm('install', '--frozen-lockfile')]),
    stage('build-backend', 'Build worker and split Firebase deployment sources', [
      pnpm('run', 'build:temporal'),
      pnpm('run', 'build-functions-codebases'),
    ]),
    stage(
      'functions-startup',
      'Validate locked npm Functions startup, lifecycle and loading boundaries',
      [
        node('--test', 'scripts/materialize-catalog-for-firebase.test.mjs'),
        node('scripts/functions-npm-locks.mjs', 'check'),
        node('--test', 'scripts/kit-npm-lock-contract.test.mjs'),
        node('scripts/kit-npm-locks.mjs', 'check'),
        pnpm('run', 'check:function-startup-loads'),
        node('--test', 'scripts/tests/functions-isolated-startup.test.mjs'),
      ],
      {
        FIREBASE_PROJECT_ID: 'demo-temporal-ci',
        FIREBASE_CONFIG:
          '{"projectId":"demo-temporal-ci","storageBucket":"demo-temporal-ci.appspot.com","databaseURL":"https://demo-temporal-ci-default-rtdb.firebaseio.com"}',
      }
    ),
    stage(
      'kits-native',
      'Validate every kit on genuine Linux native production startup',
      [node('--test', 'scripts/tests/kits-isolated-startup.test.mjs')],
      { KIT_STARTUP_REQUIRE_LINUX_X64: 'true' }
    ),
    stage('media-contracts', 'Validate isolated media fixture contracts before application regressions', [
      node(
        '--test',
        'packages/shared/firebase/emulatorPorts.test.mjs',
        'packages/shared/firebase/demoEmulatorMode.test.mjs'
      ),
      node(
        '--test',
        'scripts/tests/validate-application.test.mjs',
        'scripts/tests/local-validation-launcher.test.mjs',
        'scripts/tests/test-temporal-worker.test.mjs',
        'scripts/tests/local-test-server-owner.test.mjs',
        'scripts/tests/media-auth-fixture.test.mjs'
      ),
      node('--test', 'scripts/tests/authenticated-player-browser.test.mjs'),
      pnpm('--dir', 'apps/web', 'run', 'test:media:types'),
    ]),
    stage('build-web', 'Build the canonical production demo web application', [
      node('scripts/tests/authenticated-player-browser.mjs', '--build-production'),
    ]),
    stage('media-browser', 'Verify authenticated player, trimming and upload navigation', [
      pnpm('--dir', 'apps/web', 'exec', 'playwright', 'install', '--with-deps', 'chromium'),
      node('scripts/tests/authenticated-player-browser.mjs'),
    ]),
    stage('functions', 'Validate application regressions, admission, rules and SDK compatibility', [
      pnpm('--dir', 'functions', 'test'),
    ]),
    stage('worker', 'Validate workflows, replay, cancellation and native media', [
      pnpm('--dir', 'apps/temporal-worker', 'run', 'test:ci'),
    ]),
    stage('integration', 'Validate real upload and publishing admission, dispatch and crash recovery', [
      pnpm('run', 'test:temporal:integration'),
    ]),
    stage('media', 'Validate media admission, dependencies and retention', [pnpm('run', 'test:temporal:media')]),
    stage('frontend', 'Validate browser recovery and state projections', [
      pnpm('--dir', 'apps/web', 'run', 'test:frontend:unit'),
    ]),
    stage('audio-deployment', 'Validate audio deployment context, release exclusion and environment isolation', [
      node('--test', 'scripts/process-audio-deployment.test.mjs', 'scripts/test-process-audio-hetzner-isolation.mjs'),
    ]),
    stage('contracts', 'Validate release, bootstrap and migration contracts', [
      pnpm('run', 'test:temporal:contracts'),
      node('--test', 'scripts/temporal-recover-initial-compatibility.test.mjs'),
      node('--test', 'scripts/provider-http-inventory.test.mjs'),
    ]),
    stage(
      'recovery-sdk',
      'Validate release and recovery through the real Firestore SDK',
      [
        pnpm(
          '--dir',
          'functions',
          'exec',
          'firebase',
          'emulators:exec',
          '--project',
          'demo-release-runtime',
          '--only',
          'auth,firestore,database,storage',
          '--config',
          '../firebase.test.json',
          'node ../scripts/tests/temporal-release-runtime.firestore.test.mjs'
        ),
        pnpm(
          '--dir',
          'functions',
          'exec',
          'firebase',
          'emulators:exec',
          '--project',
          'demo-bundle-recovery',
          '--only',
          'auth,firestore,database,storage',
          '--config',
          '../firebase.test.json',
          'node ../scripts/tests/temporal-bundle-bootstrap-recovery.firestore.test.mjs'
        ),
        pnpm(
          '--dir',
          'functions',
          'exec',
          'firebase',
          'emulators:exec',
          '--project',
          'demo-pinned-search-audit',
          '--only',
          'auth,firestore,database,storage',
          '--config',
          '../firebase.test.json',
          'node --test ../scripts/integration/temporal-pinned-search-audit.firestore.integration.mjs'
        ),
        pnpm(
          '--dir',
          'functions',
          'exec',
          'firebase',
          'emulators:exec',
          '--project',
          'demo-owned-smoke-stage',
          '--only',
          'auth,firestore,database,storage',
          '--config',
          '../firebase.test.json',
          'node ../scripts/tests/temporal-owned-smoke-index-stage.firestore.test.mjs'
        ),
        pnpm(
          '--dir',
          'functions',
          'exec',
          'firebase',
          'emulators:exec',
          '--project',
          'demo-owned-smoke-email',
          '--only',
          'auth,firestore,database,storage',
          '--config',
          '../firebase.test.json',
          'node ../scripts/tests/temporal-owned-smoke-email-stage.firestore.test.mjs'
        ),
      ],
      { RELEASE_RUNTIME_TEST_ROOT: root, BUNDLE_RECOVERY_TEST_RUNTIME_ROOT: root }
    ),
    stage('native-audio', 'Validate native audio admission, queueing, monitoring and OAuth transport', [
      pnpm('--dir', 'apps/process-audio', 'run', 'test:legacy-ingress'),
      pnpm('--dir', 'apps/process-audio', 'run', 'test:queue'),
      pnpm('--dir', 'apps/process-audio', 'run', 'test:sdk-upgrades'),
    ]),
    stage('kits', 'Validate email and search kits', [
      pnpm('--dir', 'function-kits/firestore-send-email', 'test'),
      pnpm('--dir', 'function-kits/firestore-algolia-search', 'test'),
    ]),
    stage(
      'email-capture',
      'Validate native email capture without a provider connection',
      [
        pnpm(
          '--dir',
          'functions',
          'exec',
          'firebase',
          'emulators:exec',
          '--project',
          'demo-email-capture',
          '--only',
          'auth,firestore,database,storage',
          '--config',
          '../firebase.test.json',
          'NODE_OPTIONS=--experimental-vm-modules pnpm --dir ../function-kits/firestore-send-email exec jest --runInBand --watchman=false --forceExit test/temporal/capture.firestore.test.ts'
        ),
      ],
      { URM_EMAIL_CAPTURE_EMULATOR_TEST: 'true', URM_EMAIL_CAPTURE_TEST_CONFIG: resolve(root, 'firebase.test.json') }
    ),
    stage('cold-navigation', 'Verify production cold navigation on desktop and mobile', [
      node('scripts/tests/authenticated-player-browser.mjs', '--cold-navigation'),
    ]),
  ];
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function alive(child) {
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
async function settle(child) {
  if (!child?.pid || !alive(child)) return;
  process.kill(-child.pid, 'SIGTERM');
  for (let n = 0; n < 450 && alive(child); n++) await delay(100);
  if (alive(child)) {
    process.kill(-child.pid, 'SIGKILL');
    for (let n = 0; n < 50 && alive(child); n++) await delay(100);
    throw new Error('Owned validation process required forced cleanup');
  }
}
export async function runStages(
  stages,
  {
    root = ROOT,
    env = process.env,
    summaryPath = env.URM_VALIDATION_SUMMARY_PATH || resolve(root, 'output/validation/application-summary.json'),
    source = {},
    tools = {},
  } = {}
) {
  assert.equal(new Set(stages.map((s) => s.id)).size, stages.length, 'Stage identifiers must be unique');
  const summary = {
    schemaVersion: 1,
    passed: false,
    source,
    tools,
    startedAt: new Date().toISOString(),
    stages: stages.map(({ id, name }) => ({ id, name, status: 'not-run', commands: [] })),
  };
  let active, failure, cancelled, cancellationCleanup;
  const cancel = (signal) => {
    cancelled ??= new Error(`Validation interrupted by ${signal}`);
    failure ??= cancelled;
    if (active)
      cancellationCleanup ??= settle(active).catch((error) => {
        failure = failure ? new AggregateError([failure, error], 'Validation cleanup failed') : error;
      });
  };
  const onTerm = () => cancel('SIGTERM'),
    onInt = () => cancel('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  try {
    for (let index = 0; index < stages.length; index++) {
      if (cancelled) throw cancelled;
      const stage = stages[index],
        row = summary.stages[index],
        started = Date.now();
      row.status = 'running';
      console.log(`\n${env.GITHUB_ACTIONS ? '::group::' : ''}${stage.name}`);
      try {
        for (const [command, ...args] of stage.commands) {
          if (cancelled) throw cancelled;
          const begun = Date.now();
          active = spawn(command, args, { cwd: root, env: { ...env, ...stage.env }, stdio: 'inherit', detached: true });
          const result = await new Promise((resolveResult) => {
            active.once('error', (error) => resolveResult({ error: error.message }));
            active.once('close', (code, signal) => resolveResult({ code, signal }));
          });
          row.commands.push({ ...result, elapsedMs: Date.now() - begun });
          await cancellationCleanup;
          if (active.pid && alive(active)) {
            await settle(active);
            throw new Error('Validation command left an owned descendant running');
          }
          active = undefined;
          if (cancelled) throw cancelled;
          if (result.error || result.code !== 0)
            throw new Error(`Stage ${stage.id} command failed (${result.error ?? result.code ?? result.signal})`);
        }
        row.status = 'passed';
      } catch (error) {
        row.status = 'failed';
        row.error = error.message;
        throw error;
      } finally {
        row.elapsedMs = Date.now() - started;
        if (env.GITHUB_ACTIONS) console.log('::endgroup::');
      }
    }
    summary.passed = true;
  } catch (error) {
    failure =
      failure && failure !== error ? new AggregateError([error, failure], 'Validation and cleanup failed') : error;
  } finally {
    try {
      await settle(active);
      await cancellationCleanup;
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Validation and cleanup failed') : error;
    }
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    if (cancelled || failure) summary.passed = false;
    summary.finishedAt = new Date().toISOString();
    if (failure) summary.error = failure.message;
    await mkdir(dirname(summaryPath), { recursive: true });
    await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n');
    if (env.GITHUB_OUTPUT)
      await appendFile(
        env.GITHUB_OUTPUT,
        `media_failed=${summary.stages.some((s) => s.id === 'media-browser' && s.status === 'failed')}\n`
      );
  }
  if (failure) throw failure;
  return summary;
}
function inspect(command, args, root = ROOT, trim = true) {
  const r = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `Required tool failed: ${command}`);
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return trim ? output.trim() : output;
}
export function preflight(root = ROOT) {
  assert.equal(process.platform, 'linux', 'Full application validation requires Linux');
  assert.equal(process.arch, 'x64', 'Full application validation requires Linux x64');
  assert.equal(process.versions.node.split('.')[0], '22', 'Node22 is required');
  const tools = {
    node: process.version,
    pnpm: inspect('pnpm', ['--version'], root),
    java: inspect('java', ['-version'], root),
    git: inspect('git', ['--version'], root),
    python: inspect('python3', ['--version'], root),
    ffmpeg: inspect('ffmpeg', ['-version'], root).split('\n')[0],
    rsync: inspect('rsync', ['--version'], root).split('\n')[0],
    gcloud: inspect('gcloud', ['--version'], root),
  };
  assert.equal(inspect('node', ['--version'], root), process.version, 'PATH node must match the Node22 runner');
  assert.equal(tools.pnpm, '12.11.2', 'pnpm12.11.2 is required');
  assert.match(tools.java, /(?:version\s+"21[.\"]|openjdk\s+21[.\s])/, 'Java21 is required');
  const source = {
    commit: inspect('git', ['rev-parse', 'HEAD'], root),
    tree: inspect('git', ['rev-parse', 'HEAD^{tree}'], root),
    trackedDiffSha256: createHash('sha256')
      .update(inspect('git', ['diff', '--binary', 'HEAD'], root, false))
      .digest('hex'),
  };
  return { source, tools };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const summaryPath =
    process.env.URM_VALIDATION_SUMMARY_PATH || resolve(ROOT, 'output/validation/application-summary.json');
  let ready = false;
  const pending = {
    schemaVersion: 1,
    passed: false,
    phase: 'preflight',
    startedAt: new Date().toISOString(),
    stages: applicationStages().map(({ id, name }) => ({ id, name, status: 'not-run', commands: [] })),
  };
  try {
    // Invalidate an earlier pass before checking this invocation's tools or arguments.
    await mkdir(dirname(summaryPath), { recursive: true });
    await writeFile(summaryPath, JSON.stringify(pending, null, 2) + '\n');
    assert.equal(process.argv.length, 2, 'The shared runner always executes the complete validation sequence');
    const identity = preflight();
    ready = true;
    await runStages(applicationStages(), { ...identity, summaryPath });
  } catch (error) {
    if (!ready) {
      pending.error = error.message;
      pending.finishedAt = new Date().toISOString();
      try {
        await writeFile(summaryPath, JSON.stringify(pending, null, 2) + '\n');
      } catch (writeError) {
        console.error(writeError);
      }
    }
    console.error(error);
    process.exitCode = 1;
  }
}
