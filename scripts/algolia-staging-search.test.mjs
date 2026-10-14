import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STAGING_SEARCH_TARGET, STAGING_SEARCH_INSTANCES, stagingSearchSettingsPlan } from './algolia-staging-search-schema.mjs';
import { configureStagingSearch } from './configure-algolia-staging-search.mjs';
const target = { projectId: STAGING_SEARCH_TARGET.projectId, appId: STAGING_SEARCH_TARGET.appId, indexNames: STAGING_SEARCH_INSTANCES.map(row => row.indexName) };
test('canonical schema, deployment projection mirror and five staging env files agree', () => {
  const source = readFileSync(new URL('../packages/contracts/staging-search.json', import.meta.url), 'utf8');
  assert.equal(source, readFileSync(new URL('../function-kits/firestore-algolia-search/src/staging-search.json', import.meta.url), 'utf8'));
  for (const row of STAGING_SEARCH_INSTANCES) {
    const text = readFileSync(new URL(`../function-kits/firestore-algolia-search/config-${row.instanceId}/.env.urm-app-staging`, import.meta.url), 'utf8');
    const env = Object.fromEntries(text.trim().split('\n').map(line => { const [name, ...value] = line.split('='); return [name, value.join('=')]; }));
    assert.equal(env.ALGOLIA_APP_ID, target.appId);
    assert.equal(env.DO_FULL_INDEXING, 'false');
    assert.equal(env.STAGING_TEMPORAL_SEARCH_ONLY, 'true');
    assert.deepEqual(env.FIELDS.split(','), row.fields);
    assert.equal(env.ALGOLIA_INDEX_NAME, row.indexName);
    assert.equal(env.COLLECTION_PATH, row.collectionPath);
  }
});
test('dry-run needs no key or client, contains five primaries and exactly six UI replicas', async () => {
  const receipt = await configureStagingSearch({ ...target, createClient: () => { throw new Error('must not initialize'); } });
  assert.equal(receipt.mode, 'dry-run');
  assert.equal(receipt.verifiedAt, undefined);
  assert.equal(receipt.updates.length, 11);
  assert.equal(receipt.tasks.length, 0);
  const lists = receipt.updates.find(row => row.indexName === 'lists').indexSettings;
  assert.deepEqual(lists.replicas, ['lists_sort_name_asc', 'lists_sort_name_desc']);
  assert.deepEqual(lists.attributesForFaceting, ['filterOnly(type)', 'filterOnly(isMoreSermonsList)']);
  assert.deepEqual(receipt.updates.find(row => row.indexName === 'users').indexSettings.attributesToRetrieve, ['objectID']);
  assert.ok(!JSON.stringify(receipt).includes('lists_sort_count'));
  const sermons = receipt.updates.find(row => row.indexName === 'sermons').indexSettings;
  assert.ok(sermons.attributesForFaceting.includes('filterOnly(uploaderId)'));
  assert.ok(sermons.attributesForFaceting.includes('speakers.name'));
});
test('all target changes fail before constructing a provider client', async () => {
  for (const patch of [{ projectId: 'urm-app' }, { appId: 'PRYE69L8IB' }, { indexNames: ['sermons'] }, { indexNames: [...target.indexNames, 'lists'] }, { indexNames: [...target.indexNames, 'other'] }]) {
    await assert.rejects(configureStagingSearch({ ...target, ...patch, apply: true, createClient: () => { assert.fail('provider called'); } }));
  }
});
test('apply waits each task before next settings mutation and can be repeated', async () => {
  const calls = []; let task = 0; let waiting = false;
  const client = {
    getSettings: async () => ({}),
    searchSingleIndex: async input => { assert.equal(input.searchParams.hitsPerPage, 0); assert.deepEqual(input.searchParams.attributesToRetrieve, []); return {nbHits: 0}; },
    setSettings: async ({ indexName }) => { assert.equal(waiting, false); calls.push(['set', indexName]); waiting = true; return { taskID: ++task }; },
    waitForTask: async ({ indexName }) => { assert.equal(waiting, true); calls.push(['wait', indexName]); waiting = false; },
  };
  for (let run = 0; run < 2; run++) {
    const receipt = await configureStagingSearch({ ...target, apply: true, createClient: () => client });
    assert.equal(receipt.tasks.length, 11);
    assert.ok(receipt.tasks.every(row => row.completed));
  }
  assert.equal(calls.length, 44);
});
test('unexpected replicas and transport errors fail without mutations or credential output', async () => {
  let writes = 0;
  await assert.rejects(configureStagingSearch({ ...target, apply: true, createClient: () => ({ getSettings: async () => ({ replicas: ['lists_sort_count_asc'] }), setSettings: async () => { writes++; } }) }), /Staging Algolia settings failed/);
  assert.equal(writes, 0);
  const secret = 'PRIVATE-SECRET-HEADER';
  await assert.rejects(configureStagingSearch({ ...target, apply: true, createClient: () => { throw new Error(secret); } }), error => !String(error).includes(secret));
});

test('nonempty users index is rejected before settings mutations without fetching account records', async () => {
  let writes = 0;
  await assert.rejects(configureStagingSearch({ ...target, apply: true, createClient: () => ({
    getSettings: async () => ({}),
    searchSingleIndex: async ({indexName, searchParams}) => { assert.equal(indexName, 'users'); assert.equal(searchParams.hitsPerPage, 0); return {nbHits: 1}; },
    setSettings: async () => { writes++; },
  }) }), /Staging Algolia settings failed/);
  assert.equal(writes, 0);
});


test('verifiedAt is sampled only after every task completes and absent on failed completion', async () => {
  const verifiedAt = '2026-10-14T06:30:00.000Z';
  const plan = stagingSearchSettingsPlan(target);
  let completed = 0;
  let clockReads = 0;
  const now = () => { clockReads++; assert.equal(completed, plan.length); return Date.parse(verifiedAt); };
  const client = {
    getSettings: async () => ({}),
    searchSingleIndex: async () => ({nbHits: 0}),
    setSettings: async () => ({taskID: completed + 1}),
    waitForTask: async () => { completed++; },
  };
  const receipt = await configureStagingSearch({...target, apply: true, createClient: () => client, now});
  assert.equal(receipt.verifiedAt, verifiedAt);
  assert.equal(clockReads, 1);
  completed = 0;
  const noClock = () => { assert.fail('completion timestamp sampled without completion'); };
  const dryRun = await configureStagingSearch({...target, now: noClock});
  assert.equal(dryRun.verifiedAt, undefined);
  client.waitForTask = async () => { if (++completed === plan.length) throw new Error('final task failed'); };
  let failedReceipt;
  await assert.rejects(async () => { failedReceipt = await configureStagingSearch({...target, apply: true, createClient: () => client, now: noClock}); }, /Staging Algolia settings failed/);
  assert.equal(completed, plan.length);
  assert.equal(failedReceipt, undefined);
});
