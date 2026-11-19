import { applicationStages } from './validate-application.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { compileFunction } from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import {
  authorizeDeployment,
  acquireDeploymentLock,
  assertHetznerYoutubeDeployCommand,
} from './temporal-deploy-guard.mjs';
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

test('Temporal YouTube activation requires the exact controlled staging deployment', () => {
  const valid = {
    project: 'urm-app-staging',
    release: { projectId: 'urm-app-staging' },
    phase: 'ownership-changed',
    child: ['bash', 'scripts/deploy-process-audio-hetzner.sh', 'staging'],
  };
  assert.doesNotThrow(() => assertHetznerYoutubeDeployCommand(valid));
  for (const mutation of [
    { project: 'urm-app' },
    { phase: 'ui-frozen' },
    { release: undefined },
    { child: ['bash', 'scripts/deploy-process-audio-hetzner.sh', 'all'] },
  ])
    assert.throws(() => assertHetznerYoutubeDeployCommand({ ...valid, ...mutation }), /controlled staging/);
});

test('Temporal YouTube deployment lock requires Temporal-owned paused media', async () => {
  const release = {
    releaseId: 'release',
    mode: 'durable-upgrade',
    compatibilityCommit: 'a'.repeat(40),
    uiCommit: 'b'.repeat(40),
    domains: ['media'],
  };
  const state = { ...release, phase: 'ownership-changed', controlRevision: 1 };
  const media = { owner: 'legacy', admission: 'paused' };
  const control = { releaseId: release.releaseId, admission: 'paused', revision: 1, domains: { media } };
  const writes = [];
  let slotExists = false;
  let receiptExists = false;
  const db = {
    doc: (path) => ({ path }),
    runTransaction: (run) =>
      run({
        get: async ({ path }) => ({
          exists:
            {
              'temporalYouTubeRenderHosts/staging': slotExists,
              '_control/temporalHetznerYouTubeActivation-release': receiptExists,
              '_control/temporalReleaseOperation': false,
            }[path] ?? true,
          data: () => (path === '_control/temporalReleaseState' ? state : control),
        }),
        create: (ref, data) => writes.push({ ref, data }),
      }),
  };
  const activation = {
    operationId: 'operation',
    commit: release.compatibilityCommit,
    release,
    phase: state.phase,
    hetznerYoutubeRender: true,
  };
  await assert.rejects(acquireDeploymentLock(db, activation), /Temporal media ownership/);
  media.owner = 'temporal';
  media.admission = 'open';
  await assert.rejects(acquireDeploymentLock(db, activation), /paused media admission/);
  assert.equal(writes.length, 0);
  media.admission = 'paused';
  slotExists = true;
  await assert.rejects(acquireDeploymentLock(db, activation), /host slot must be empty/);
  assert.equal(writes.length, 0);
  slotExists = false;
  receiptExists = true;
  await assert.rejects(acquireDeploymentLock(db, activation), /already has evidence/);
  assert.equal(writes.length, 0);
  receiptExists = false;
  assert.equal(await acquireDeploymentLock(db, activation), true);
  assert.equal(writes[0].data.hetznerYoutubeRender, true);
  assert.equal(writes[0].data.action, 'controlled-backend-deploy');
});

test('Temporal YouTube activation keeps the exact staging image and fences rollback after a recreate attempt', () => {
  const deploy = readFileSync(join(root, 'scripts/deploy-process-audio-hetzner.sh'), 'utf8');
  const activation = deploy.split("<<'REMOTE_TEMPORAL_YOUTUBE_EOF'\n")[1].split('\nREMOTE_TEMPORAL_YOUTUBE_EOF')[0];
  const releaseCommit = 'a'.repeat(40);
  const brokerDigest = 'b'.repeat(64);
  const brokerPathConfig = 'PROCESS_AUDIO_RENDER_BROWSER_POT_CONTROL_DIR=/tmp/temporal-youtube-po\n';
  const fixture = mkdtempSync(join(tmpdir(), 'urm-audio-activation-test-'));
  try {
    const base = join(fixture, 'remote');
    const envFile = join(base, 'env/process-audio-staging.env');
    const activationAttempt = join(base, 'state/deploy-rollback/deployment/temporal-youtube-activation-attempted');
    const records = {
      '.deploy-lock/deployment-id': 'deployment',
      '.deploy-lock/target-env': 'staging',
      'state/deploy-rollback/deployment/ready': '',
      'state/deploy-candidates/candidate/source-release-sha': releaseCommit,
      'state/deploy-candidates/candidate/image-id': 'actual-image',
      'env/process-audio-staging.env': 'PROCESS_AUDIO_TEMPORAL_YOUTUBE_RENDER=verify\n' + brokerPathConfig,
    };
    for (const [file, value] of Object.entries(records)) {
      const path = join(base, file);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, value);
    }
    const bin = join(fixture, 'bin');
    mkdirSync(bin);
    mkdirSync(join(base, 'state/staging/tmp/temporal-youtube-po'), { recursive: true });
    const scripts = {
      ps: 'printf "/usr/bin/python3 /usr/local/libexec/process-audio-staging-render-po --source-digest=%s\\n" "$FIXTURE_BROKER_DIGEST"',
      sha256sum: 'printf "%s  %s\\n" "$FIXTURE_BROKER_DIGEST" "$1"',
      stat: 'case "$2" in %u:%g:%a) echo 1000:1000:700;; %d:%i) echo 8:10;; *) exit 1;; esac',
      systemctl: [
        'case "$1 ${3:-}" in',
        '  "is-active process-audio-staging-render-po.service") [[ "$FIXTURE_OUTCOME" != broker-inactive ]] ;;',
        '  "show --property=MainPID") echo 42 ;;',
        '  "show --property=InvocationID")',
        '    if [[ "$FIXTURE_OUTCOME" == broker-replaced || "$FIXTURE_OUTCOME" == broker-drift && -f state/deploy-rollback/deployment/temporal-youtube-activation-attempted ]]; then',
        '      echo 22222222222222222222222222222222',
        '    else echo 11111111111111111111111111111111; fi ;;',
        '  *) exit 1 ;;',
        'esac',
      ].join('\n'),
    };
    for (const [file, script] of Object.entries(scripts))
      writeFileSync(join(bin, file), '#!/usr/bin/env bash\n' + script + '\n', { mode: 0o700 });
    writeFileSync(
      join(bin, 'docker'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'case "$1 $2" in',
        '  "compose ps") echo exact-container ;;',
        '  "inspect --format")',
        '    if [[ "$3" == "{{.Id}}" ]]; then echo exact-container; else echo actual-image; fi ;;',
        '  "exec -i")',
        '    cat >/dev/null',
        '    runtime="${@: -2:1}"',
        '    invocation="${@: -3:1}"',
        '    if [[ "${!#}" == reconcile ]]; then [[ -f confirmed-receipt && "$runtime" == "184c16b7-9bd0-4eac-b24e-1ec55a12e9de" && "$(cat confirmed-receipt)" == "$invocation" ]];',
        '    elif [[ -z "$runtime" ]]; then [[ "$FIXTURE_OUTCOME" != authority-denied ]];',
        '    else [[ "$runtime" == "184c16b7-9bd0-4eac-b24e-1ec55a12e9de" && "$FIXTURE_OUTCOME" != unknown-receipt ]] && printf "%s\\n" "$invocation" > confirmed-receipt; fi ;;',
        '  "compose up")',
        '    [[ "$*" == "compose up -d --no-deps --no-build --force-recreate process-audio-staging" ]]',
        '    [[ -f state/deploy-rollback/deployment/temporal-youtube-activation-attempted ]]',
        '    [[ "$FIXTURE_OUTCOME" != read-only && "$FIXTURE_OUTCOME" != unknown-recreate ]] ;;',
        '  "exec exact-container")',
        '    if [[ "$3" == sh ]]; then [[ "$FIXTURE_OUTCOME" != mailbox-env-drift ]] || exit 1; [[ "$FIXTURE_OUTCOME" == mount-drift ]] && echo 8:11 || echo 8:10; exit 0; fi',
        '    if [[ "$*" == *"/invalid/render/invalid" ]]; then echo 400; exit 0; fi',
        '    mode="$(sed -n s/^PROCESS_AUDIO_TEMPORAL_YOUTUBE_RENDER=//p env/process-audio-staging.env)"',
        '    runtime="184c16b7-9bd0-4eac-b24e-1ec55a12e9de"',
        '    if [[ "$FIXTURE_OUTCOME" == runtime-drift && -f confirmed-receipt ]]; then runtime="994c16b7-9bd0-4eac-b24e-1ec55a12e9de"; fi',
        '    printf \'{"ok":true,"temporalYouTubeRenderMode":"%s","sentryEnabled":true,"sentryEnvironment":"staging","sentryRelease":"process-audio-hetzner@staging-%s","temporalYouTubeRuntimeId":"%s"}\\n\' "$mode" "$FIXTURE_COMMIT" "$runtime" ;;',
        '  *) exit 99 ;;',
        'esac',
      ].join('\n'),
      { mode: 0o700 }
    );
    const activate = (outcome, mode = 'activate') =>
      execFileSync(
        'bash',
        ['-s', '--', base, 'deployment', 'candidate', releaseCommit, 'guard', 'release', mode, brokerDigest],
        {
          input: activation,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            FIXTURE_OUTCOME: outcome,
            FIXTURE_COMMIT: releaseCommit,
            FIXTURE_BROKER_DIGEST: brokerDigest,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
    for (const refusal of ['authority-denied', 'broker-inactive', 'mount-drift', 'mailbox-env-drift']) {
      assert.throws(() => activate(refusal));
      assert.equal(existsSync(activationAttempt), false);
    }
    assert.throws(() => activate('broker-drift'));
    assert.equal(existsSync(activationAttempt), true);
    assert.equal(existsSync(join(base, 'confirmed-receipt')), false);
    writeFileSync(envFile, records['env/process-audio-staging.env']);
    rmSync(activationAttempt);
    assert.equal(existsSync(activationAttempt), false);
    assert.equal(readFileSync(envFile, 'utf8'), records['env/process-audio-staging.env']);
    assert.throws(() => activate('unknown-recreate'));
    assert.equal(existsSync(activationAttempt), true);
    assert.equal(readFileSync(envFile, 'utf8'), 'PROCESS_AUDIO_TEMPORAL_YOUTUBE_RENDER=enabled\n' + brokerPathConfig);

    const rollback = deploy.split("<<'REMOTE_ROLLBACK_EOF'\n")[1].split('\nREMOTE_ROLLBACK_EOF')[0];
    assert.throws(
      () => execFileSync('bash', ['-s', '--', base, 'auto', 'deployment'], { input: rollback, stdio: 'pipe' }),
      /Automatic rollback refused: Temporal YouTube activation may have live work/
    );
    writeFileSync(envFile, records['env/process-audio-staging.env']);
    rmSync(activationAttempt);
    assert.throws(() => activate('unknown-receipt'));
    assert.equal(existsSync(activationAttempt), true);
    assert.throws(() => activate('read-only', 'reconcile'));
    writeFileSync(envFile, records['env/process-audio-staging.env']);
    rmSync(activationAttempt);
    assert.throws(() => activate('runtime-drift'));
    assert.equal(existsSync(activationAttempt), true);
    assert.equal(existsSync(join(base, 'confirmed-receipt')), true);
    assert.throws(() => activate('runtime-drift', 'reconcile'));
    rmSync(join(base, 'confirmed-receipt'));
    writeFileSync(envFile, records['env/process-audio-staging.env']);
    rmSync(activationAttempt);
    assert.match(activate('success').toString(), /native workflow smoke remains required/);
    assert.match(activate('read-only', 'reconcile').toString(), /verified after SSH disconnect/);
    assert.throws(() => activate('broker-replaced', 'reconcile'));
    assert.equal(readFileSync(envFile, 'utf8'), 'PROCESS_AUDIO_TEMPORAL_YOUTUBE_RENDER=enabled\n' + brokerPathConfig);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
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
  const validationCommand = 'node scripts/validate-application.mjs';
  assert.equal(workflow.split(validationCommand).length - 1, 1);
  const deployment = applicationStages().find((stage) => stage.id === 'audio-deployment');
  assert.deepEqual(deployment.commands, [
    ['node', '--test', 'scripts/process-audio-deployment.test.mjs', 'scripts/test-process-audio-hetzner-isolation.mjs'],
  ]);
  assert.ok(workflow.indexOf('google-github-actions/setup-gcloud@') < workflow.indexOf(validationCommand));
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

for (const mode of [
  'known',
  'committed-response-lost',
  'missing',
  'foreign',
  'rewritten',
  'lost-authority',
  'rejected',
  'preexisting',
  'reconcile-known',
  'reconcile-missing',
  'reconcile-foreign',
  'reconcile-rewritten',
  'reconcile-lost-authority',
])
  test(`original staging activation receipt / ${mode}`, async () => {
    const deploy = readFileSync(join(root, 'scripts/deploy-process-audio-hetzner.sh'), 'utf8');
    const nodeSource = deploy
      .split('confirm_deploy_authority() {')[1]
      .split("<<'NODE_EOF'\n")[1]
      .split('\nNODE_EOF')[0];
    const [operationId, releaseId, runtimeId] = [
      '184c16b7-9bd0-4eac-b24e-1ec55a12e9de',
      '3e716023-3878-47eb-8d37-1d03b81a7dad',
      'bbc8b3aa-0964-4ab1-a6d1-92dd89291f81',
    ];
    const commit = 'a'.repeat(40),
      receiptPath = `_control/temporalHetznerYouTubeActivation-${releaseId}`,
      stamp = { isEqual: (other) => stamp === other };
    const control = {
      releaseId,
      revision: 5,
      admission: 'paused',
      domains: { media: { owner: 'temporal', admission: 'paused' } },
    };
    const rows = new Map([
      [
        '_control/temporalReleaseOperation',
        { operationId, releaseId, action: 'controlled-backend-deploy', commit, hetznerYoutubeRender: true },
      ],
      [
        '_control/temporalReleaseState',
        { releaseId, phase: 'ownership-changed', compatibilityCommit: commit, controlRevision: 5 },
      ],
      ['_control/temporalRelease', control],
    ]);
    if (mode === 'preexisting') rows.set(receiptPath, { runtimeId });
    const reconcile = mode.startsWith('reconcile-');
    if (reconcile && mode !== 'reconcile-missing') {
      rows.set(receiptPath, {
        schemaVersion: 2,
        brokerDigest: 'e'.repeat(64),
        brokerInvocation: 'f'.repeat(32),
        releaseId,
        commit,
        operationId,
        deploymentId: 'fixture-deploy',
        candidateId: 'b'.repeat(64),
        imageId: `sha256:${'c'.repeat(64)}`,
        containerId: 'd'.repeat(64),
        runtimeId: mode === 'reconcile-foreign' ? 'foreign' : runtimeId,
        controlRevision: 5,
        mode: 'enabled',
      });
    }
    if (mode === 'reconcile-lost-authority') control.admission = 'open';

    const fakeProcess = {
      argv: [
        'node',
        '-',
        operationId,
        releaseId,
        commit,
        'fixture-deploy',
        'b'.repeat(64),
        `sha256:${'c'.repeat(64)}`,
        'd'.repeat(64),
        'e'.repeat(64),
        'f'.repeat(32),
        runtimeId,
        reconcile ? 'reconcile' : 'activate',
      ],
      env: { FIREBASE_PROJECT_ID: 'urm-app-staging' },
    };
    const options = [];
    let writes = 0;
    const db = {
      doc: (path) => path,
      runTransaction: async (fn, opts) => {
        options.push(JSON.stringify(opts));
        let proposed;
        await fn({
          getAll: async (...paths) =>
            paths.map((path) => {
              const value = rows.get(path);
              return {
                exists: rows.has(path),
                get: (name) => name.split('.').reduce((value, key) => value?.[key], value),
                data: () => value,
                createTime: stamp,
                updateTime: path === receiptPath && mode.endsWith('rewritten') ? {} : stamp,
              };
            }),
          create: (path, value) => {
            assert.equal(path, receiptPath);
            writes++;
            proposed = value;
          },
        });
        if (!proposed) return;
        if (mode !== 'missing') rows.set(receiptPath, structuredClone(proposed));
        if (mode === 'foreign') rows.set(receiptPath, { ...proposed, runtimeId: 'foreign' });
        if (mode === 'lost-authority') control.admission = 'open';
        if (mode === 'rejected') throw Object.assign(new Error('Definitive error from commit'), { code: 7 });
        if (!['known', 'rewritten'].includes(mode))
          throw Object.assign(new Error('Lost commit response'), { code: 14 });
      },
    };
    const run = compileFunction(nodeSource.replace(/^confirm\(\)\.catch/m, 'return confirm().catch'), [
      'require',
      'process',
      'console',
    ]);
    await run(
      (module) =>
        ({
          'node:util': { isDeepStrictEqual },
          'firebase-admin/app': { initializeApp: () => ({}), applicationDefault: () => ({}) },
          'firebase-admin/firestore': { getFirestore: () => db },
        }[module]),
      fakeProcess,
      { error: () => {} }
    );
    assert.equal(
      fakeProcess.exitCode,
      ['known', 'committed-response-lost', 'reconcile-known'].includes(mode) ? undefined : 1
    );
    assert.equal(writes, reconcile || mode === 'preexisting' ? 0 : 1);
    assert.deepEqual(
      options,
      reconcile
        ? ['{"readOnly":true}']
        : ['{"maxAttempts":1}', ...(['preexisting', 'rejected'].includes(mode) ? [] : ['{"readOnly":true}'])]
    );
  });

test('only the ambiguous SSH status permits one observation without another activation', () => {
  const deploy = readFileSync(join(root, 'scripts/deploy-process-audio-hetzner.sh'), 'utf8');
  const invoke = deploy.match(
    /activate_staging_temporal_youtube \|\| \{[\s\S]*?activate_staging_temporal_youtube reconcile\n\s*\}/
  )?.[0];
  assert.ok(invoke);
  for (const [status, commands] of [
    [0, 'activate'],
    [255, 'activate,reconcile'],
    [9, 'activate'],
  ]) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `
      commands=()
      activation_code=$1
      # Capture the child result without hiding the actual command sequence.
      trap 'IFS=,; printf "%s\\n" "\${commands[*]}"' EXIT
      activate_staging_temporal_youtube() {
        commands+=("\${1:-activate}")
        if [[ "\${1:-activate}" == activate ]]; then return "$activation_code"; fi
      }
      ${invoke}
    `,
        'fixture',
        String(status),
      ],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, status === 9 ? 9 : 0);
    assert.equal(result.stdout.trim(), commands);
  }
});

test('guarded staging installs a sealed-only broker in its existing scratch mount', () => {
  const deploy = readFileSync(join(root, 'scripts/deploy-process-audio-hetzner.sh'), 'utf8');
  const setup = join(root, 'scripts/setup-process-audio-hetzner-host-browser-auth.sh');
  const remote = '/opt/fixture-hetzner';
  const env = { ...process.env, PROCESS_AUDIO_HETZNER_REMOTE_DIR: remote };
  const broker = execFileSync('bash', [setup, '--render-staging-broker'], { encoding: 'utf8', env });
  assert.ok(broker.includes(`CONTROL_DIR = "${remote}/state/staging/tmp/temporal-youtube-po"`));
  assert.ok(broker.includes(`PROFILE_DIR = "${remote}/state/shared-browser-profile/.config/google-chrome"`));
  assert.match(broker, /^SEALED_ONLY = True$/m);
  assert.match(broker, /else:\n\s+request_names = /);
  assert.match(broker, /notify\.sendto\(b"READY=1"/);
  assert.throws(() =>
    execFileSync('bash', [setup, '--render-staging-broker'], {
      stdio: 'pipe',
      env: { ...env, PROCESS_AUDIO_HETZNER_REMOTE_DIR: '/opt/../wrong' },
    })
  );

  const install = deploy.split("<<'REMOTE_RENDER_BROKER_EOF'\n")[1].split('\nREMOTE_RENDER_BROKER_EOF')[0];
  assert.match(install, /"\$\(cat "\$lock_dir\/target-env"\)" == staging/);
  assert.match(install, /ReadWritePaths=\$mailbox/);
  assert.match(install, /User=ytauth\nGroup=ytauth/);
  assert.match(install, /InaccessiblePaths=\$remote_dir\/state\/browser-refresh-control/);
  assert.doesNotMatch(install, /systemctl [^\n]*(?:browser-auth\.target|process-audio-browser-pot\.service)/);
  const release = deploy.slice(deploy.lastIndexOf('  begin_remote_transaction'));
  assert.match(
    release,
    /activate_remote_release\n  if \[\[ -n "\$TEMPORAL_HETZNER_DEPLOY_OPERATION_ID" \]\]; then\n    prepare_staging_render_broker/
  );
  assert.ok(release.indexOf('prepare_staging_render_broker') < release.indexOf('deploy_remote_worker staging'));
  const compose = readFileSync(join(root, 'ops/process-audio-hetzner/compose.yaml'), 'utf8');
  assert.match(compose, /- \.\/state\/staging\/tmp:\/tmp/);
  assert.match(compose, /- \.\/state\/production\/tmp:\/tmp/);
});
