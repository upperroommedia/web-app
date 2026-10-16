const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const firestore = require('firebase-admin/firestore');
const originalLoad = Module._load;
Object.assign(process.env, {
  FIREBASE_KIT_INSTANCE_ID: 'sermons-index',
  GCLOUD_PROJECT: 'test-project',
  COLLECTION_PATH: 'sermons',
  ALGOLIA_APP_ID: 'test-app',
  ALGOLIA_API_KEY: 'test-key',
  ALGOLIA_INDEX_NAME: 'sermons',
  LOCATION: 'us-central1',
  DATABASE_ID: '(default)',
  DO_FULL_INDEXING: 'true',
});
const locks = new Map();
const docs = new Map();
const records = new Map();
const enqueued = [];
let failWrite = false;
let failIdentityCommit = false;
let providerFailure;
const loggedErrors = [];
let whileSaving;
function snap(path, data = docs.get(path), version = 1) {
  return {
    exists: data !== undefined,
    id: path.split('/').at(-1),
    ref: { path },
    get: (field) => data?.[field],
    data: () => data,
    updateTime: firestore.Timestamp.fromMillis(version),
  };
}
function lockRef(id) {
  return {
    id,
    get: async () => ({ data: () => locks.get(id) }),
    set: async (value) => {
      if (failIdentityCommit && Object.hasOwn(value, 'lastObjectId')) throw new Error('Identity metadata write failed');
      locks.set(id, { ...locks.get(id), ...value });
    },
  };
}
const db = {
  doc: (path) => ({ get: async () => snap(path) }),
  collection: (path) => (path === '_algoliaSyncLocks' ? { doc: lockRef } : query(path)),
  collectionGroup: (path) => query(path),
  runTransaction: async (handler) =>
    handler({
      get: (ref) => ref.get(),
      set: (ref, data) => {
        ref.set(data);
      },
    }),
};
function query(path) {
  let cursor;
  let limit;
  return {
    orderBy() {
      return this;
    },
    limit(value) {
      limit = value;
      return this;
    },
    startAfter(value) {
      cursor = value;
      return this;
    },
    async get() {
      const results = [...docs.entries()]
        .filter(([name]) => name.startsWith(`${path}/`) && (!cursor || name.split('/').at(-1) > cursor))
        .sort()
        .slice(0, limit)
        .map(([name, data]) => snap(name, data));
      return { docs: results, size: results.length };
    },
  };
}
const client = {
  async saveObjects({ objects, waitForTasks }) {
    assert.equal(waitForTasks, true);
    if (providerFailure) throw providerFailure;
    if (failWrite) throw new Error('Algolia unavailable');
    for (const record of objects) records.set(record.objectID, record);
    if (whileSaving) await whileSaving();
  },
  async deleteObjects({ objectIDs, waitForTasks }) {
    assert.equal(waitForTasks, true);
    for (const id of objectIDs) records.delete(id);
  },
};
Module._load = function (name, ...args) {
  if (name === 'firebase-functions') {
    const actual = originalLoad.call(this, name, ...args);
    return { ...actual, logger: { ...actual.logger, error: (...values) => loggedErrors.push(values) } };
  }
  if (name === 'algoliasearch') return { algoliasearch: () => client };
  if (name === 'firebase-admin/firestore') return { ...firestore, getFirestore: () => db };
  if (name === 'firebase-admin/functions')
    return {
      getFunctions: () => ({ taskQueue: (name) => ({ enqueue: async (data) => enqueued.push({ name, data }) }) }),
    };
  return originalLoad.call(this, name, ...args);
};
const kit = require('../lib/index');
Module._load = originalLoad;
async function event(before, after) {
  await kit.executeIndexOperation.run({ data: { before, after } });
}
function reset() {
  locks.clear();
  docs.clear();
  records.clear();
  enqueued.length = 0;
  loggedErrors.length = 0;
  providerFailure = undefined;
  failWrite = false;
  failIdentityCommit = false;
  whileSaving = undefined;
  process.env.ALT_OBJECT_ID = '';
}

test('live handler replaces removed fields and delayed deletes retain recreated documents', async () => {
  reset();
  docs.set('sermons/a', { title: 'Latest' });
  records.set('a', { title: 'Old', removed: 'Stale' });
  await event(snap('sermons/a', { title: 'Old' }), snap('sermons/a', { title: 'Outdated' }));
  assert.deepEqual(records.get('a'), { title: 'Latest', objectID: 'a', path: 'sermons/a' });
  await event(snap('sermons/a', { title: 'Old' }), snap('sermons/a', undefined));
  assert.equal(records.get('a').title, 'Latest');
  docs.delete('sermons/a');
  await event(snap('sermons/a', { title: 'Latest' }), snap('sermons/a'));
  assert.equal(records.has('a'), false);
});
test('alternate ID migration removes previous records and deletion uses stored identity', async () => {
  reset();
  process.env.ALT_OBJECT_ID = 'slug';
  docs.set('sermons/a', { slug: 'new', title: 'Latest' });
  records.set('old', { title: 'Old' });
  await event(snap('sermons/a', { slug: 'old' }), snap('sermons/a'));
  assert.equal(records.has('old'), false);
  assert.equal(records.get('new').title, 'Latest');
  docs.delete('sermons/a');
  await event(snap('sermons/a', undefined), snap('sermons/a'));
  assert.equal(records.has('new'), false);
});
test('indexing failure propagates and releases lease for subsequent retries', async () => {
  reset();
  docs.set('sermons/a', { title: 'Title' });
  failWrite = true;
  await assert.rejects(event(snap('sermons/a', undefined), snap('sermons/a')), /retry required/);
  assert.equal([...locks.values()][0].leaseUntil, 0);
  failWrite = false;
  await event(snap('sermons/a', undefined), snap('sermons/a'));
  assert.equal(records.get('a').title, 'Title');
});
test('write-ahead identity removes an orphan after provider save succeeds but metadata fails', async () => {
  for (const nextSource of [{ slug: 'final' }, undefined]) {
    reset();
    process.env.ALT_OBJECT_ID = 'slug';
    docs.set('sermons/a', { slug: 'initial' });
    await event(snap('sermons/a', undefined), snap('sermons/a'));
    docs.set('sermons/a', { slug: 'uncommitted' });
    failIdentityCommit = true;
    await assert.rejects(event(snap('sermons/a', { slug: 'initial' }), snap('sermons/a')), /retry required/);
    assert.equal(records.has('uncommitted'), true);
    assert.equal([...locks.values()][0].lastObjectId, 'initial');
    assert.equal([...locks.values()][0].pendingObjectId, 'uncommitted');
    failIdentityCommit = false;
    if (nextSource) docs.set('sermons/a', nextSource);
    else docs.delete('sermons/a');
    // Replaying the original event cannot supply the uncommitted identity itself.
    await event(snap('sermons/a', { slug: 'initial' }), snap('sermons/a'));
    assert.equal(records.has('uncommitted'), false);
    assert.equal(records.has('initial'), false);
    assert.equal(records.has('final'), !!nextSource);
    assert.equal([...locks.values()][0].pendingObjectId, null);
  }
});
test('overlapping execution is rejected until the current Algolia task finishes', async () => {
  reset();
  docs.set('sermons/a', { title: 'Title' });
  let start;
  let finish;
  const started = new Promise((resolve) => {
    start = resolve;
  });
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  whileSaving = async () => {
    start();
    await done;
  };
  const first = event(snap('sermons/a', undefined), snap('sermons/a'));
  await started;
  await assert.rejects(event(snap('sermons/a', undefined), snap('sermons/a')), /retry required/);
  finish();
  await first;
});
test('full indexing paginates by ID even when the cursor document has been deleted', async () => {
  reset();
  for (let id = 0; id < 26; id++) docs.set(`sermons/${String(id).padStart(2, '0')}`, { title: `Sermon ${id}` });
  await kit.executeFullIndexOperation.run({ data: {} });
  assert.equal(records.size, 25);
  assert.deepEqual(enqueued[0], {
    name: 'locations/us-central1/functions/executeFullIndexOperation',
    data: { docId: '24', successCount: 25 },
  });
  docs.delete('sermons/24');
  await kit.executeFullIndexOperation.run({ data: enqueued[0].data });
  assert.equal(records.get('25').title, 'Sermon 25');
});
test('full indexing does not hide failed records or advance cursor on failure', async () => {
  reset();
  docs.set('sermons/a', { title: 'Title' });
  failWrite = true;
  await assert.rejects(kit.executeFullIndexOperation.run({ data: {} }), /retry required/);
  assert.equal(enqueued.length, 0);
});
test('declared lifecycle task bodies satisfy the real HTTP task wrapper protocol', async () => {
  const { declaredLifecycleHooks } = require('firebase-functions/lifecycle');
  const previous = process.env.FUNCTIONS_EMULATOR;
  process.env.FUNCTIONS_EMULATOR = 'true'; // Bypass token validation only; exercise real body decoding.
  try {
    for (const name of ['afterFirstDeploy', 'afterRedeploy']) {
      reset();
      docs.set('sermons/a', { title: 'Lifecycle record' });
      const task = declaredLifecycleHooks[name].task;
      assert.equal(task.function, 'executeFullIndexOperation');
      const headers = { 'content-type': 'application/json' };
      const request = {
        method: 'POST',
        body: structuredClone(task.body),
        headers,
        header: (name) => headers[name.toLowerCase()],
        get: (name) => headers[name.toLowerCase()],
      };
      let status, responseBody;
      const response = {
        status(value) {
          status = value;
          return this;
        },
        end() {},
        send(body) {
          responseBody = body;
        },
      };
      await kit.executeFullIndexOperation(request, response);
      assert.equal(status, 204, JSON.stringify(responseBody));
      assert.equal(records.get('a').title, 'Lifecycle record');
    }
  } finally {
    if (previous === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = previous;
  }
});
test('provider credentials and transport stacks never escape either exported handler boundary', async () => {
  for (const [operation, invoke] of [
    ['live-index', () => event(snap('sermons/a', undefined), snap('sermons/a'))],
    ['full-index', () => kit.executeFullIndexOperation.run({ data: {} })],
  ]) {
    reset();
    docs.set('sermons/a', { title: 'Title' });
    const secret = 'private-algolia-key-regression';
    providerFailure = Object.assign(new Error(`Transport request failed with x-algolia-api-key: ${secret}`), {
      status: 503,
      transporterStackTrace: [{ request: { headers: { 'x-algolia-api-key': secret } } }],
    });
    providerFailure.stack += `\ntransport credentials ${secret}`;
    await assert.rejects(invoke(), (error) => {
      assert.equal(error.message, 'Algolia indexing failed; retry required');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.stack, new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
      return true;
    });
    assert.equal(loggedErrors.length, 1);
    assert.doesNotMatch(JSON.stringify(loggedErrors), new RegExp(secret));
    assert.deepEqual(loggedErrors[0][1], { operation, errorType: 'Error', status: 503 });
  }
});
test('deployed trigger path preserves CLI-resolved parameter expression', () => {
  const document = kit.executeIndexOperation.__endpoint.eventTrigger.eventFilterPathPatterns.document;
  assert.equal(document.toCEL(), '{{ params.COLLECTION_PATH }}/{documentId}');
  assert.equal(kit.executeIndexOperation.__endpoint.eventTrigger.retry, true);
  assert.deepEqual(kit.executeIndexOperation.__endpoint.secretEnvironmentVariables, [{ key: 'ALGOLIA_API_KEY' }]);
});
test('replacement staging live and full ingress refuse legacy ownership before any effects', async () => {
  reset();
  const saved = { ...process.env };
  try {
    process.env.GCLOUD_PROJECT = 'urm-app-staging';
    process.env.ALGOLIA_APP_ID = '2VZFOFLFHE';
    process.env.TASK_ORCHESTRATOR_SEARCH = 'legacy';
    process.env.STAGING_TEMPORAL_SEARCH_ONLY = 'true';
    process.env.DO_FULL_INDEXING = 'false';
    docs.set('sermons/a', { title: 'Held' });
    await assert.rejects(event(snap('sermons/a', undefined), snap('sermons/a')), /held until Temporal/);
    await assert.rejects(kit.executeFullIndexOperation.run({ data: {} }), /retry required/);
    assert.equal(records.size, 0);
    assert.equal(locks.size, 0);
    assert.equal(enqueued.length, 0);
    // Removing the explicit parameter cannot bypass the replacement-app fence.
    delete process.env.STAGING_TEMPORAL_SEARCH_ONLY;
    await assert.rejects(event(snap('sermons/a', undefined), snap('sermons/a')), /held until Temporal/);
    assert.equal(records.size, 0);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});

test('legacy continuation cannot write over an unresolved Temporal task receipt', async () => {
  reset();
  const { createHash } = require('node:crypto');
  const lockId = createHash('sha256').update('sermons-index:sermons/a').digest('hex');
  const retained = {
    owner: null,
    leaseUntil: 0,
    pendingObjectId: 'a',
    pendingAlgoliaTask: { schemaVersion: 1, taskID: 713 },
  };
  locks.set(lockId, retained);
  docs.set('sermons/a', { title: 'New canonical title' });
  records.set('a', { title: 'Provider write awaiting confirmation' });
  await assert.rejects(event(snap('sermons/a', { title: 'Previous' }), snap('sermons/a')), /retry required/);
  assert.deepEqual(locks.get(lockId), retained);
  assert.deepEqual(records.get('a'), { title: 'Provider write awaiting confirmation' });
  // The same caller/context can write once the outstanding task fact is settled.
  locks.set(lockId, { ...retained, pendingAlgoliaTask: null });
  await event(snap('sermons/a', { title: 'Previous' }), snap('sermons/a'));
  assert.equal(records.get('a').title, 'New canonical title');
});
