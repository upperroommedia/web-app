import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireDeploymentLock,
  releaseDeploymentLock,
  authorizeDeployment,
  assertCheckoutCommit,
  runGuardedCommand,
  DEPLOY_LOCK_PATH,
  DEPLOY_STATE_PATH,
} from './temporal-deploy-guard.mjs';
import { CONTROL_PATH } from './temporal-release-lib.mjs';
function database(initial = {}) {
  const docs = new Map(Object.entries(initial));
  return {
    docs,
    doc: (path) => path,
    runTransaction: async (action) => {
      const changes = [];
      const result = await action({
        get: async (path) => ({ exists: docs.has(path), data: () => docs.get(path) }),
        create: (path, value) => {
          assert.equal(docs.has(path), false);
          changes.push(() => docs.set(path, value));
        },
        delete: (path) => changes.push(() => docs.delete(path)),
      });
      changes.forEach((change) => change());
      return result;
    },
  };
}
const sha = 'a'.repeat(40),
  release = {
    releaseId: 'release',
    compatibilityCommit: sha,
    uiCommit: sha,
    mode: 'initial-cutover',
    domains: ['media'],
  };
const control = { releaseId: 'release', revision: 4, admission: 'paused' };
const state = { ...release, phase: 'ui-frozen', controlRevision: 4 };

test('Actual checkout SHA is mandatory, including genuine merge checkout identity', () => {
  assert.equal(assertCheckoutCommit(sha, sha), sha);
  const merge = 'b'.repeat(40);
  assert.equal(assertCheckoutCommit(merge, merge), merge);
  assert.throws(() => assertCheckoutCommit(merge, sha), /actual immutable checkout/);
  assert.throws(() => assertCheckoutCommit(sha, 'staging'));
});
test('Active release phases block automatic mutation without acquiring or replacing authority', async () => {
  for (const phase of ['freezing-ui', 'ui-frozen', 'ownership-changed', 'open', 'paused-for-recovery', 'unknown']) {
    const db = database({ [CONTROL_PATH]: control, [DEPLOY_STATE_PATH]: { ...state, phase } });
    await assert.rejects(acquireDeploymentLock(db, { operationId: 'auto', commit: sha }), /active controlled release/);
    assert.equal(db.docs.has(DEPLOY_LOCK_PATH), false);
  }
  assert.throws(() => authorizeDeployment(control, undefined), /mismatch/);
  assert.throws(() => authorizeDeployment({ releaseId: 'other' }, { ...state, phase: 'complete' }), /mismatch/);
});
test('Automatic mutation locks serialize parallel jobs and never steal stale or operator locks', async () => {
  const db = database();
  assert.equal(await acquireDeploymentLock(db, { operationId: 'first', commit: sha }), true);
  db.docs.get(DEPLOY_LOCK_PATH).createdAt = 1;
  assert.equal(await acquireDeploymentLock(db, { operationId: 'second', commit: sha }), false);
  assert.equal(db.docs.get(DEPLOY_LOCK_PATH).operationId, 'first');
  await assert.rejects(releaseDeploymentLock(db, 'second'), /identity changed/);
  await releaseDeploymentLock(db, 'first');
  assert.equal(await acquireDeploymentLock(db, { operationId: 'second', commit: sha }), true);
  db.docs.set(DEPLOY_LOCK_PATH, { operationId: 'operator', action: 'freeze-ui', createdAt: 1 });
  await assert.rejects(acquireDeploymentLock(db, { operationId: 'auto', commit: sha }), /crash recovery lock/);
});
test('Controlled compatibility/postownership deploy requires exact immutable checkpoint and paused revision', async () => {
  for (const phase of ['ui-frozen', 'ownership-changed']) {
    const db = database({ [CONTROL_PATH]: control, [DEPLOY_STATE_PATH]: { ...state, phase } });
    assert.equal(await acquireDeploymentLock(db, { operationId: phase, commit: sha, release, phase }), true);
    assert.equal(db.docs.get(DEPLOY_LOCK_PATH).action, 'controlled-backend-deploy');
    await releaseDeploymentLock(db, phase);
  }
  for (const changed of [
    { compatibilityCommit: 'b'.repeat(40) },
    { uiCommit: 'b'.repeat(40) },
    { controlRevision: 5 },
    { domains: ['images'] },
    { phase: 'open' },
  ])
    assert.throws(
      () => authorizeDeployment(control, { ...state, ...changed }, release, 'ui-frozen'),
      /immutable release/
    );
  assert.throws(() => authorizeDeployment({ ...control, admission: 'open' }, state, release, 'ui-frozen'));
});
test('Successful child closes before cleanup; failures and signals retain authority and remove listeners', async () => {
  for (const mode of ['success', 'failure', 'signal', 'spawn-error']) {
    const signals = new EventEmitter(),
      child = new EventEmitter();
    child.pid = 321;
    const killed = [];
    const promise = runGuardedCommand('example', [], {
      signalSource: signals,
      spawnCommand: () => child,
      kill: (pid, signal) => killed.push([pid, signal]),
    });
    if (mode === 'signal') signals.emit('SIGTERM');
    if (mode === 'spawn-error') child.emit('error', new Error('spawn failed'));
    else child.emit('close', mode === 'failure' ? 1 : 0, null);
    if (mode === 'success') await promise;
    else await assert.rejects(promise);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    if (mode === 'signal') assert.deepEqual(killed, [[-321, 'SIGTERM']]);
  }
});
test('Both push/dispatch workflows guard every backend mutation and materialize env within the deployment lock', async () => {
  for (const environment of ['staging', 'main']) {
    const source = await readFile(
      new URL(`../.github/workflows/${environment}-selective-deploy.yml`, import.meta.url),
      'utf8'
    );
    assert.match(source, /workflow_dispatch:/);
    assert.match(source, /gcloud functions list --project/);
    assert.match(
      source,
      /rg -Fxq \"projects\/\$FIREBASE_PROJECT\/locations\/us-central1\/functions\/addintrooutrotaskhandler\"/
    );
    assert.equal(source.includes('no function matches'), false);
    let count = 0;
    for (const step of source.split(/\n      - /)) {
      if (
        !/run:/.test(step) ||
        !/firebase deploy|firebase functions:delete|firebase-deploy-with-quota-retry\.sh deploy|gcloud storage buckets update/.test(
          step
        )
      )
        continue;
      count++;
      assert.match(
        step,
        /run: (?:\|\n          )?node scripts\/temporal-deploy-guard\.mjs --project "\$FIREBASE_PROJECT"/
      );
      if (/firebase-deploy-with-quota-retry\.sh deploy/.test(step)) assert.match(step, /--materialize-function-env --/);
    }
    assert.equal(count, environment === 'staging' ? 11 : 10);
    if (environment === 'staging') {
      assert.match(source, /staging_search_release:/);
      assert.match(source, /--install --only-search/);
      assert.match(source, /--phase ownership-changed --include-staging-search --materialize-function-env/);
      assert.match(source, /--install --without-search/);
    }
    for (const job of source.split(/\n  (?=[a-z][\w-]*:\n)/)) {
      const mutation = job.indexOf('run: node scripts/temporal-deploy-guard.mjs');
      if (mutation >= 0)
        assert.ok(
          job.indexOf('uses: ./.github/actions/setup-backend-deploy') >= 0 &&
            job.indexOf('uses: ./.github/actions/setup-backend-deploy') < mutation
        );
    }
    assert.equal(source.includes('run: node scripts/temporal-function-env.mjs'), false);
  }
});

test('Function env CLI refuses a relabelled checkout before materializing source files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'temporal-deploy-source-'));
  try {
    const path = join(directory, 'control.json');
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        releaseId: 'test',
        admission: 'paused',
        domains: Object.fromEntries(
          ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((domain) => [
            domain,
            { owner: 'legacy', admission: 'paused' },
          ])
        ),
      })
    );
    for (const args of [['--commit', 'f'.repeat(40)], []]) {
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [
              new URL('./temporal-function-env.mjs', import.meta.url).pathname,
              '--project',
              'urm-app-staging',
              '--control-file',
              path,
              ...args,
            ],
            { encoding: 'utf8', env: { ...process.env, GITHUB_SHA: 'f'.repeat(40) }, stdio: ['ignore', 'pipe', 'pipe'] }
          ),
        (error) => /actual immutable checkout SHA/.test(error.stderr)
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
