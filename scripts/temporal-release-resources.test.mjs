import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createReleaseFirebaseResources, runWithCleanup } from './temporal-release-resources.mjs';
const project = 'urm-app-staging',
  url = 'https://urm-app-staging-default-rtdb.firebaseio.com';
function fixture({ existing = false, failures = [] } = {}) {
  const events = [],
    apps = [{ name: 'unrelated', options: { projectId: 'urm-app' } }];
  if (existing) apps.push({ name: `temporal-release-${project}`, options: { projectId: project, databaseURL: url } });
  const step = (name) => async () => {
    events.push(name);
    if (failures.includes(name)) throw new Error(name);
  };
  const sdk = {
    getApps: () => apps,
    applicationDefault: () => {
      events.push('credential');
      return {};
    },
    initializeApp: (options, name) => {
      const app = { options, name };
      apps.push(app);
      return app;
    },
    getFirestore: () => {
      events.push('firestore');
      return { terminate: step('terminate') };
    },
    getDatabase: () => {
      events.push('database');
      return { goOffline: step('offline') };
    },
    deleteApp: async (app) => {
      await step('delete')();
      apps.splice(apps.indexOf(app), 1);
    },
    serverTimestamp: () => 1,
  };
  return { sdk, events, apps, acquire: () => createReleaseFirebaseResources(project, url, sdk) };
}
test('owned SDK clients close only after action/lock completion, in order, idempotently', async () => {
  const f = fixture(),
    resources = f.acquire();
  resources.firestore;
  resources.database;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const result = runWithCleanup(
    async () => {
      f.events.push('action');
      await pending;
      f.events.push('lock-finally');
      return 3;
    },
    () => resources.close()
  );
  await Promise.resolve();
  assert.equal(f.events.includes('offline'), false);
  release();
  assert.equal(await result, 3);
  await resources.close();
  assert.deepEqual(f.events, [
    'credential',
    'firestore',
    'database',
    'action',
    'lock-finally',
    'offline',
    'terminate',
    'delete',
  ]);
  assert.deepEqual(
    f.apps.map((app) => app.name),
    ['unrelated']
  );
});
test('reused validated apps and unrelated apps stay caller-owned', async () => {
  const f = fixture({ existing: true }),
    resources = f.acquire();
  resources.firestore;
  resources.database;
  await resources.close();
  assert.deepEqual(f.events, ['firestore', 'database']);
  assert.equal(f.apps.length, 2);
  for (const field of ['projectId', 'databaseURL']) {
    const g = fixture({ existing: true });
    g.apps[1].options[field] = 'foreign';
    assert.throws(g.acquire, /identity/);
    assert.deepEqual(g.events, []);
  }
});
test('cleanup never opens unused services and rejects replaced/mutated app identity', async () => {
  const f = fixture();
  const resources = createReleaseFirebaseResources(project, undefined, f.sdk);
  assert.equal(resources.database, undefined);
  await resources.close();
  assert.deepEqual(f.events, ['credential', 'delete']);
  for (const mutate of [
    (f) => (f.apps[1].options.projectId = 'urm-app'),
    (f) => f.apps.splice(1, 1, { ...f.apps[1] }),
  ]) {
    const g = fixture(),
      r = g.acquire();
    r.firestore;
    r.database;
    mutate(g);
    await assert.rejects(r.close(), /identity/);
    assert.equal(g.events.includes('offline'), false);
    assert.equal(g.events.includes('delete'), false);
  }
});
for (const failure of ['offline', 'terminate', 'delete'])
  test(`all cleanup stages are attempted after ${failure} failure`, async () => {
    const f = fixture({ failures: [failure] }),
      r = f.acquire();
    r.firestore;
    r.database;
    await assert.rejects(
      r.close(),
      (error) => error.code === 'RELEASE_SDK_CLEANUP_FAILED' && error.cleanupFailures[0].error.message === failure
    );
    assert.deepEqual(f.events.slice(-3), ['offline', 'terminate', 'delete']);
  });
test('client acquisition errors still close the owned app without opening other services', async () => {
  for (const service of ['getFirestore', 'getDatabase']) {
    const f = fixture(),
      original = new Error(service);
    f.sdk[service] = () => {
      throw original;
    };
    const r = f.acquire();
    await assert.rejects(
      runWithCleanup(
        async () => {
          r.firestore;
          r.database;
        },
        () => r.close()
      ),
      (error) => error === original
    );
    assert.equal(f.apps.length, 1);
    assert.equal(f.events.at(-1), 'delete');
    assert.equal(f.events.includes('database'), false);
    assert.equal(f.events.includes('offline'), false);
    assert.equal(f.events.includes('terminate'), service === 'getDatabase');
  }
});
test('original action failure wins over cleanup/reporting failures; successful cleanup failures remain nonzero', async () => {
  const original = new Error('original'),
    secondary = new Error('secondary'),
    observed = [];
  await assert.rejects(
    runWithCleanup(
      () => {
        throw original;
      },
      () => {
        throw secondary;
      },
      (error) => observed.push(error)
    ),
    (error) => error === original
  );
  assert.deepEqual(observed, [secondary]);
  await assert.rejects(
    runWithCleanup(
      () => {
        throw original;
      },
      () => {
        throw secondary;
      },
      () => {
        throw new Error('report');
      }
    ),
    (error) => error === original
  );
  await assert.rejects(
    runWithCleanup(
      async () => 1,
      () => {
        throw secondary;
      }
    ),
    (error) => error === secondary
  );
});
for (const scenario of [
  'success',
  'claim-failure',
  'action-failure',
  'lock-failure',
  'action-failure-lock-failure',
  'sdk-failure',
  'action-failure-sdk-failure',
  'existing-nonzero',
])
  test(`actual controller naturally exits with mocked RTDB socket: ${scenario}`, () => {
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-vm-modules',
        new URL('./tests/fixtures/temporal-release-lifecycle.mjs', import.meta.url).pathname,
        scenario,
      ],
      { encoding: 'utf8', timeout: 7000 }
    );
    assert.equal(child.error, undefined, child.stderr);
    assert.equal(child.signal, null, child.stderr);
    assert(child.stdout.trim(), child.stderr);
    const receipt = JSON.parse(child.stdout.trim());
    assert.equal(child.status, scenario === 'success' ? 0 : scenario === 'existing-nonzero' ? 9 : 7, child.stderr);
    assert.equal(receipt.remainingApps, 0);
    assert(receipt.events.includes('database-offline'));
    assert(receipt.events.includes('firestore-terminate'));
    assert(receipt.events.includes('app-delete'));
    assert.equal(receipt.lockAbsent, !scenario.includes('lock-failure'));
    if (scenario.startsWith('action-failure')) assert.equal(receipt.failure, 'ORIGINAL_ACTION_FAILURE');
    if (scenario === 'claim-failure') assert.equal(receipt.failure, 'ORIGINAL_CLAIM_FAILURE');
    if (scenario === 'success') {
      assert.equal(receipt.phase, 'paused-for-recovery');
      assert(receipt.events.indexOf('lock-delete') < receipt.events.indexOf('database-offline'));
    }
  });
