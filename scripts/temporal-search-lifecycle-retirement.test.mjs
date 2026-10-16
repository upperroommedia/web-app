import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRetirementManifest,
  validateRetirementInventory,
  assertRetirementAuthority,
  retireSearchLifecycleTasks,
} from './temporal-search-lifecycle-retirement.mjs';
import { nativeSnapshotProof } from './temporal-release-runtime.mjs';

// Entirely synthetic cloud seams. These tests cannot touch Firebase, Cloud Tasks, or providers.
const prefix = 'projects/urm-app-staging/locations/us-central1/queues/';
const instances = ['images', 'lists', 'sermons', 'speakers', 'users'];
const release = {
  projectId: 'urm-app-staging',
  environment: 'staging',
  mode: 'durable-upgrade',
  domains: ['publishing', 'search'],
  releaseId: 'fixture-release',
  compatibilityCommit: 'a'.repeat(40),
  uiCommit: 'a'.repeat(40),
};
const operationId = 'aefc8c23-65f6-461b-a561-c8860ab70501';
function fixture() {
  let tick = 0;
  const rows = new Map(),
    writes = [],
    deletions = [],
    tasks = new Map();
  const stamp = (n) => ({ seconds: 100, nanoseconds: n, toDate: () => new Date(100000) });
  const put = (path, data) => {
    const previous = rows.get(path);
    rows.set(path, { data: structuredClone(data), create: previous?.create ?? ++tick, update: ++tick });
  };
  const snapshot = (path) => {
    const value = rows.get(path);
    return {
      exists: !!value,
      data: () => value && structuredClone(value.data),
      createTime: value && stamp(value.create),
      updateTime: value && stamp(value.update),
    };
  };
  const db = {
    doc: (path) => ({ path, get: async () => snapshot(path) }),
    runTransaction: async (run) => {
      const pending = [];
      await run({
        get: async (ref) => snapshot(ref.path),
        create: (ref, data) => {
          assert(!rows.has(ref.path));
          pending.push(['create', ref.path, data]);
        },
        update: (ref, data) => {
          assert(rows.has(ref.path));
          pending.push(['update', ref.path, data]);
        },
        delete: (ref) => pending.push(['delete', ref.path]),
      });
      for (const [kind, path, data] of pending) {
        writes.push([kind, path]);
        if (kind === 'delete') rows.delete(path);
        else put(path, kind === 'update' ? { ...rows.get(path).data, ...data } : data);
      }
    },
  };
  const control = {
    schemaVersion: 1,
    releaseId: release.releaseId,
    revision: 39,
    admission: 'paused',
    domains: Object.fromEntries(
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((d) => [
        d,
        { owner: 'temporal', admission: release.domains.includes(d) ? 'paused' : 'open' },
      ])
    ),
  };
  const state = { ...release, controlRevision: 39, phase: 'compatibility-ready' };
  put('_control/temporalRelease', control);
  put('_control/temporalReleaseState', state);
  const protectedDocuments = [],
    parents = [],
    queuedSearchJobPaths = [];
  const protect = (path, data) => {
    put(path, data);
    protectedDocuments.push({ path, data, native: nativeSnapshotProof(snapshot(path)) });
  };
  for (const instance of instances) {
    const jobId = `job-${instance}`,
      entity = { type: 'maintenance', id: instance };
    const jobPath = `durableJobs/${jobId}`,
      intentPath = `durableJobIntents/${jobId}`,
      entityPath = `durableJobEntities/${instance}`;
    protect(jobPath, {
      jobId,
      projectId: release.projectId,
      kind: 'search.backfill',
      state: 'succeeded',
      generation: 2,
      entity,
    });
    protect(intentPath, {
      jobId,
      projectId: release.projectId,
      kind: 'search.backfill',
      generation: 2,
      entity,
      payload: { instanceId: instance + '-index' },
    });
    protect(entityPath, { projectId: release.projectId, activeJobId: jobId, generation: 2, entity, scope: 'search' });
    parents.push({ instanceId: instance + '-index', jobPath, intentPath, entityPath });
  }
  for (let i = 0; i < 8; i++) {
    const jobId = `job-queued-${i}`,
      path = `durableJobs/${jobId}`;
    protect(path, { jobId, projectId: release.projectId, kind: 'search.sync', state: 'queued', generation: 2 });
    queuedSearchJobPaths.push(path);
  }
  const manifest = {
    schemaVersion: 1,
    projectId: release.projectId,
    releaseId: release.releaseId,
    revision: 39,
    runtimeCommit: release.compatibilityCommit,
    descriptorSHA256: 'b'.repeat(64),
    exclusionsSHA256: 'c'.repeat(64),
    parents,
    queuedSearchJobPaths,
    exclusions: Array.from({ length: 16 }, (_, i) => prefix + 'historical/tasks/' + i),
    protectedDocuments,
    tasks: instances.map((instance, i) => {
      const name = `${prefix}kit-${instance}-index-executeFullIndexOperation/tasks/${i}`;
      const url = `https://kit-${instance}-index-executefullindexoperation-fixture-uc.a.run.app`;
      const request = {
        url,
        httpMethod: 'POST',
        body: 'eyJkYXRhIjp7fX0=',
        oidcToken: {
          serviceAccountEmail: 'firebase-fn-123@urm-app-staging.iam.gserviceaccount.com',
          audience: url,
        },
      };
      const task = {
        name,
        view: 'FULL',
        createTime: '2026-10-16T23:20:00Z',
        scheduleTime: '2026-10-16T23:20:01Z',
        dispatchDeadline: '600s',
        httpRequest: { ...request, url: url + '/' },
      };
      const response = { ...structuredClone(task), view: 'BASIC' };
      delete response.httpRequest.body;
      tasks.set(name, structuredClone(task));
      return {
        name,
        task,
        deploymentLogSHA256: 'd'.repeat(64),
        requestLine: 2,
        responseLine: 4,
        createRequest: { task: { httpRequest: request } },
        createResponse: response,
      };
    }),
  };
  let inventoryOverride;
  const inventory = async () => {
    const result = {
      allQueuePages: true,
      responseView: 'FULL',
      queues: [
        ...instances.flatMap((i) =>
          ['kit', 'ext'].map((k) => ({
            queue: { name: `${prefix}${k}-${i}-index-executeFullIndexOperation`, state: 'PAUSED' },
            allPages: true,
            responseView: 'FULL',
            tasks: [],
          }))
        ),
        ...['addintrooutrotaskhandler', 'processaudiofiletask', 'processaudioyoutubetask'].map((n) => ({
          queue: { name: prefix + n, state: 'RUNNING' },
          allPages: true,
          responseView: 'FULL',
          tasks: [],
        })),
      ],
    };
    for (const task of tasks.values())
      result.queues.find((q) => task.name.startsWith(q.queue.name + '/')).tasks.push(structuredClone(task));
    inventoryOverride?.(result);
    return result;
  };
  const input = {
    db,
    release,
    manifest,
    operationId,
    evidence: { operatorCommit: 'e'.repeat(40), operatorClosureDigest: 'f'.repeat(64) },
    inventory,
    getTask: async (name) => (tasks.has(name) ? structuredClone(tasks.get(name)) : null),
    deleteTask: async (name) => {
      deletions.push(name);
      tasks.delete(name);
    },
    assertSource: async () => {},
    assertProtectedSet: async () => {},
    now: () => 1000,
  };
  return {
    input,
    put,
    rows,
    writes,
    tasks,
    deletions,
    control,
    state,
    manifest,
    inventory,
    inventoryOverride: (fn) => {
      inventoryOverride = fn;
    },
  };
}

test('finite retirement deletes exactly the five proven names and preserves control, queued jobs, and historical exclusions', async () => {
  const f = fixture(),
    before = structuredClone([...f.rows]);
  const result = await retireSearchLifecycleTasks(f.input);
  assert.equal(result.retired.length, 5);
  assert.deepEqual(
    f.deletions,
    f.manifest.tasks.map((t) => t.name)
  );
  assert.equal(f.rows.has('_control/temporalReleaseOperation'), false);
  for (const [path, value] of before) assert.deepEqual(f.rows.get(path), value);
  assert(
    f.writes.every(
      ([, path]) =>
        path === '_control/temporalReleaseOperation' || path.startsWith('_control/temporalSearchLifecycleRetirement-')
    )
  );
  assert.equal(result.providerWrites, 0);
});

test('all phase, mode, admission, ownership, and immutable source changes fail authority', () => {
  const f = fixture();
  assertRetirementAuthority(f.control, f.state, release, 39);
  for (const change of [
    (c, s) => {
      s.phase = 'ui-frozen';
    },
    (c, s) => {
      s.controlRevision++;
    },
    (c, s) => {
      s.compatibilityCommit = '9'.repeat(40);
    },
    (c, s) => {
      s.releaseId = 'other';
    },
    (c) => {
      c.admission = 'open';
    },
    (c) => {
      c.domains.search.admission = 'open';
    },
    (c) => {
      c.domains.images.owner = 'legacy';
    },
    (c) => {
      c.revision++;
    },
  ]) {
    const c = structuredClone(f.control),
      s = structuredClone(f.state);
    change(c, s);
    assert.throws(() => assertRetirementAuthority(c, s, release, 39));
  }
  assert.throws(() => assertRetirementAuthority(f.control, f.state, { ...release, mode: 'initial-cutover' }, 39));
  assert.throws(() => assertRetirementAuthority(f.control, f.state, { ...release, projectId: 'urm-app' }, 39));
});

test('incomplete inventories, running search queues, foreign tasks, and observed attempts refuse deletion', async () => {
  for (const change of [
    (x) => {
      x.allQueuePages = false;
    },
    (x) => {
      x.queues[0].allPages = false;
    },
    (x) => {
      x.queues[0].queue.state = 'RUNNING';
    },
    (x) => {
      x.queues.pop();
    },
    (x) => {
      x.queues[0].tasks[0].dispatchCount = 1;
    },
    (x) => {
      x.queues[0].tasks[0].firstAttempt = {};
    },
    (x) => {
      x.queues[0].tasks[0].httpRequest.body = 'e30=';
    },
    (x) => {
      x.queues[0].tasks[0].name += '-foreign';
    },
  ]) {
    const f = fixture(),
      x = await f.inventory();
    change(x);
    assert.throws(() => validateRetirementInventory(x, f.manifest));
  }
});

test('historical names, duplicate instances, absent create response, and altered OIDC cannot become delete candidates', () => {
  for (const change of [
    (m) => {
      m.exclusions.push(m.tasks[0].name);
    },
    (m) => {
      m.tasks[1] = m.tasks[0];
    },
    (m) => {
      delete m.tasks[0].createResponse;
    },
    (m) => {
      m.tasks[0].createRequest.task.httpRequest.oidcToken.audience = 'https://other';
    },
    (m) => {
      m.tasks[0].task.responseCount = 1;
    },
    (m) => {
      m.protectedDocuments.pop();
    },
    (m) => {
      m.tasks[0].task.httpRequest.url = 'https://attacker.example';
    },
  ]) {
    const f = fixture();
    change(f.manifest);
    assert.throws(() => validateRetirementManifest(f.manifest, release));
  }
});

test('a preexisting operation cannot be borrowed and no delete occurs', async () => {
  const f = fixture();
  f.put('_control/temporalReleaseOperation', { operationId: 'other' });
  await assert.rejects(retireSearchLifecycleTasks(f.input), /OPERATION_HELD/);
  assert.equal(f.deletions.length, 0);
});

test('a changed queued search document prevents deletion even when task metadata still matches', async () => {
  const f = fixture();
  f.put(f.manifest.protectedDocuments[6].path, { changed: true });
  await assert.rejects(retireSearchLifecycleTasks(f.input), /NATIVE_AUTHORITY_CHANGED/);
  assert.equal(f.deletions.length, 0);
});

test('commit then lost DELETE acknowledgement retains ownership and resumes only by actual GET404', async () => {
  const f = fixture(),
    normalDelete = f.input.deleteTask;
  f.input.deleteTask = async (name) => {
    await normalDelete(name);
    throw Error('LOST_RESPONSE');
  };
  await assert.rejects(retireSearchLifecycleTasks(f.input), /LOST_RESPONSE/);
  assert(f.rows.has('_control/temporalReleaseOperation'));
  assert.equal(f.deletions.length, 1);
  f.input.deleteTask = normalDelete;
  await retireSearchLifecycleTasks({ ...f.input, resume: true });
  assert.equal(f.deletions.length, 5);
  assert.equal(new Set(f.deletions).size, 5);
});

test('issued DELETE with task still present never retries or releases the operation', async () => {
  const f = fixture();
  f.input.deleteTask = async () => {
    throw Error('TIMEOUT_BEFORE_ACK');
  };
  await assert.rejects(retireSearchLifecycleTasks(f.input), /TIMEOUT_BEFORE_ACK/);
  let retried = 0;
  f.input.deleteTask = async () => {
    retried++;
  };
  await assert.rejects(retireSearchLifecycleTasks({ ...f.input, resume: true }), /ISSUED_DELETE_STILL_PRESENT/);
  assert.equal(retried, 0);
  assert(f.rows.has('_control/temporalReleaseOperation'));
});

test('resume cannot change the manifest or operator identity', async () => {
  const f = fixture();
  f.input.deleteTask = async () => {
    throw Error('TIMEOUT');
  };
  await assert.rejects(retireSearchLifecycleTasks(f.input));
  await assert.rejects(
    retireSearchLifecycleTasks({ ...f.input, resume: true, evidence: { different: true } }),
    /RESUME_IDENTITY_CHANGED/
  );
  f.manifest.tasks[0].deploymentLogSHA256 = '9'.repeat(64);
  await assert.rejects(retireSearchLifecycleTasks({ ...f.input, resume: true }), /RESUME_IDENTITY_CHANGED/);
});

test('unexpected task arriving after the last DELETE prevents final audit/unlock', async () => {
  const f = fixture(),
    normalDelete = f.input.deleteTask;
  f.input.deleteTask = async (name) => {
    await normalDelete(name);
    if (f.deletions.length === 5) {
      const task = structuredClone(f.manifest.tasks[0].task);
      task.name += '99';
      f.tasks.set(task.name, task);
    }
  };
  await assert.rejects(retireSearchLifecycleTasks(f.input), /UNEXPECTED_TASK/);
  assert(f.rows.has('_control/temporalReleaseOperation'));
});

test('authority changes after DELETE prevent completing receipts or unlocking', async () => {
  const f = fixture(),
    normalDelete = f.input.deleteTask;
  f.input.deleteTask = async (name) => {
    await normalDelete(name);
    f.put('_control/temporalRelease', { ...f.control, revision: 40 });
  };
  await assert.rejects(retireSearchLifecycleTasks(f.input), /AUTHORITY_CHANGED/);
  assert.equal(f.deletions.length, 1);
  assert(f.rows.has('_control/temporalReleaseOperation'));
});

test('completed operation cannot run again or silently claim another completion', async () => {
  const f = fixture();
  await retireSearchLifecycleTasks(f.input);
  await assert.rejects(retireSearchLifecycleTasks(f.input), /ALREADY_COMPLETED/);
  assert.equal(f.deletions.length, 5);
});
