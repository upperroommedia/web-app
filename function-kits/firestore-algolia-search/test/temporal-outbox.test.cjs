const { test } = require('node:test');
const assert = require('node:assert/strict');
const { enqueueSearchIntent } = require('../lib/temporal-outbox');
function memoryDb() {
  const records = new Map([
    [
      '_control/temporalRelease',
      {
        schemaVersion: 1,
        revision: 1,
        admission: 'open',
        domains: { search: { owner: 'temporal', admission: 'open' } },
      },
    ],
  ]);
  return {
    records,
    doc(path) {
      return { path };
    },
    collection(name) {
      return {
        doc(id) {
          const path = `${name}/${id}`;
          return { path };
        },
      };
    },
    async runTransaction(handler) {
      let wrote = false;
      const writes = [];
      const result = await handler({
        get: async (ref) => {
          assert.equal(wrote, false, 'all transaction reads precede writes');
          const data = records.get(ref.path);
          return { exists: !!data, data: () => data };
        },
        create(ref, data) {
          wrote = true;
          assert.equal(records.has(ref.path), false);
          writes.push([ref.path, data]);
        },
        set(ref, data) {
          wrote = true;
          writes.push([ref.path, data]);
        },
      });
      for (const [path, data] of writes) records.set(path, data);
      return result;
    },
  };
}
test('duplicate delivery admits one durable job and increments the entity once', async () => {
  const db = memoryDb();
  const input = {
    projectId: 'project',
    instanceId: 'sermons-index',
    requestId: 'event-1',
    documentPath: 'sermons/one',
    previousObjectId: 'old-id',
  };
  await enqueueSearchIntent(db, input);
  await enqueueSearchIntent(db, input);
  assert.equal(db.records.size, 5);
  const [job] = [...db.records].filter(([key]) => key.startsWith('durableJobs/')).map(([, value]) => value);
  assert.equal(job.generation, 1);
  assert.equal(job.requestedBy, 'system:search');
  const [outbox] = [...db.records].filter(([key]) => key.startsWith('durableJobOutbox/')).map(([, value]) => value);
  assert.equal(outbox.nextAttemptAt, 0);
  assert.equal(outbox.leaseExpiresAt, 0);
  assert.equal(outbox.dispatch.workflowType, 'SearchDocument');
  assert.equal(outbox.dispatch.taskQueue, 'urm-search');
  assert.equal(JSON.stringify(outbox).includes('old-id'), false, 'history gets references only');
});
test('backfill dispatch uses bounded reference argument and no source credentials', async () => {
  const db = memoryDb();
  await enqueueSearchIntent(db, { projectId: 'project', instanceId: 'images', requestId: 'backfill-1' });
  const [outbox] = [...db.records].filter(([key]) => key.startsWith('durableJobOutbox/')).map(([, value]) => value);
  assert.equal(outbox.dispatch.workflowType, 'SearchBackfill');
  assert.deepEqual(outbox.dispatch.startArgs, { ref: outbox.dispatch.ref });
});
test('paused, missing and legacy-owned controls reject fresh Temporal admission atomically', async () => {
  for (const control of [
    undefined,
    {
      schemaVersion: 1,
      revision: 1,
      admission: 'paused',
      domains: { search: { owner: 'temporal', admission: 'open' } },
    },
    { schemaVersion: 1, revision: 1, admission: 'open', domains: { search: { owner: 'legacy', admission: 'open' } } },
  ]) {
    const db = memoryDb();
    if (control) db.records.set('_control/temporalRelease', control);
    else db.records.delete('_control/temporalRelease');
    await assert.rejects(enqueueSearchIntent(db, { projectId: 'project', instanceId: 'images', requestId: 'fresh' }));
    assert.equal(
      [...db.records.keys()].some((key) => key.startsWith('durableJobs/')),
      false
    );
  }
});
test('duplicate admitted event remains readable during a release pause', async () => {
  const db = memoryDb(),
    input = { projectId: 'project', instanceId: 'images', requestId: 'accepted' };
  await enqueueSearchIntent(db, input);
  const control = db.records.get('_control/temporalRelease');
  control.admission = 'paused';
  await enqueueSearchIntent(db, input);
  assert.equal([...db.records.keys()].filter((key) => key.startsWith('durableJobs/')).length, 1);
});

const stagedDocument = () => ({projectId:'urm-app-staging', appId:'2VZFOFLFHE', instanceId:'sermons-index', requestId:'staging-paused-event', documentPath:'sermons/current-document', documentEventContinuation:true});
function pauseSearch(db) {
  const control = db.records.get('_control/temporalRelease');
  control.admission = 'paused';
  control.domains.search.admission = 'paused';
  return control;
}
test('trusted replacement-app staging document events durably converge during global/search pause', async () => {
  const db = memoryDb(); pauseSearch(db);
  await enqueueSearchIntent(db,stagedDocument());
  const job = [...db.records].find(([path])=>path.startsWith('durableJobs/'))[1];
  assert.equal(job.kind,'search.sync');
  assert.equal(job.projectId,'urm-app-staging');
  const intent = db.records.get('durableJobIntents/'+job.jobId);
  assert.deepEqual(intent.payload,{instanceId:'sermons-index',documentPath:'sermons/current-document'});
  assert.equal(JSON.stringify(intent).includes('documentEventContinuation'),false);
  const outbox = db.records.get('durableJobOutbox/'+job.jobId);
  assert.equal(outbox.dispatch.workflowType,'SearchDocument');
  assert.equal(outbox.state,'pending');
  await enqueueSearchIntent(db,stagedDocument());
  assert.equal([...db.records.keys()].filter(path=>path.startsWith('durableJobs/')).length,1);
});
test('paused continuation is denied for unmarked/full-backfill/foreign target or malformed source authority', async () => {
  for (const patch of [
    {documentEventContinuation:undefined}, {documentEventContinuation:false}, {documentPath:undefined},
    {projectId:'urm-app'}, {projectId:'other'}, {appId:'8OY'}, {appId:undefined},
    {instanceId:'kit-sermons-index'}, {instanceId:'other'}, {documentPath:'users/one'},
    {documentPath:'sermons/'}, {documentPath:'/sermons/one'}, {documentPath:'sermons/one/subcollection/two'},
    {documentPath:'sermons/..'}, {documentPath:'sermons/.'},
  ]) {
    const db = memoryDb(); pauseSearch(db);
    await assert.rejects(enqueueSearchIntent(db,{...stagedDocument(),...patch}));
    assert.equal([...db.records.keys()].some(path=>path.startsWith('durableJobs/')),false);
  }
  for (const mutate of [control=>control.domains.search.owner='legacy', control=>control.projectId='urm-app', control=>control.admission='unknown', control=>control.domains.search.admission='unknown']) {
    const db = memoryDb(); mutate(pauseSearch(db));
    await assert.rejects(enqueueSearchIntent(db,stagedDocument()));
    assert.equal([...db.records.keys()].some(path=>path.startsWith('durableJobs/')),false);
  }
});
test('trusted document continuation does not broaden production pause behavior', async () => {
  const db=memoryDb(); pauseSearch(db);
  await assert.rejects(enqueueSearchIntent(db,{...stagedDocument(),projectId:'urm-app',appId:'8OYPRODUCTION'}));
  const control=db.records.get('_control/temporalRelease'); control.admission='open';control.domains.search.admission='open';
  await enqueueSearchIntent(db,{...stagedDocument(),projectId:'urm-app',appId:'8OYPRODUCTION'});
  assert.equal([...db.records.keys()].filter(path=>path.startsWith('durableJobs/')).length,1);
});
