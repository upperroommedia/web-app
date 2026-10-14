const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Timestamp, GeoPoint, getFirestore} = require('firebase-admin/firestore');
const {initializeApp} = require('firebase-admin/app');
const {extract, processData, objectId} = require('../lib/records');
const {converge} = require('../lib/sync');
const config = {fields: '', altObjectId: '', transformFunction: '', location: 'us-central1', projectId: 'test-project'};
function snapshot(data, version = 1) {
  return {exists: !!data, id: 'document-1', ref: {path: 'sermons/document-1'}, data: () => data,
    get: field => field.split('.').reduce((value, key) => value?.[key], data), updateTime: Timestamp.fromMillis(version)};
}
test('preserves IDs and serializes Firestore timestamps, geo data, references and nested arrays', async () => {
  const reference = getFirestore(initializeApp({projectId: 'test-project'}, 'record-tests')).doc('speakers/one');
  const record = await extract(snapshot({title: 'Title', timestamp: Timestamp.fromMillis(123), place: new GeoPoint(1, 2), reference, values: [{time: Timestamp.fromMillis(456)}], nil: null}), config);
  assert.deepEqual(record, {title: 'Title', timestamp: 123, _geoloc: {lat: 1, lng: 2}, reference: 'speakers/one', values: [{time: 456}], objectID: 'document-1', path: 'sermons/document-1'});
});
test('uses configured fields, nested paths, and removes missing and null values', async () => {
  assert.deepEqual(await extract(snapshot({private: 'secret', title: 'Title', nested: {name: 'Name'}, removed: null}), {...config, fields: 'title, nested.name missing removed'}), {title: 'Title', 'nested.name': 'Name', objectID: 'document-1', path: 'sermons/document-1'});
  assert.deepEqual(processData({absent: undefined, nil: null, zero: 0, no: false}), {zero: 0, no: false});
});
test('alternate object IDs and path IDs remain compatible', () => {
  assert.equal(objectId(snapshot({key: 'alternate'}), 'key'), 'alternate');
  assert.equal(objectId(snapshot({}), '(path)'), 'sermons/document-1');
  assert.throws(() => objectId(snapshot({}), 'missing'), /Invalid Algolia objectID/);
});
test('rejects oversized records so the trigger retries and reports an error', async () => {
  await assert.rejects(extract(snapshot({text: 'a'.repeat(102400)}), config), /too large/);
});
test('transform retains stable object ID and path, and failures propagate', async () => {
  const original = global.fetch;
  try {
    global.fetch = async () => ({ok: true, json: async () => ({result: {title: 'Transformed', objectID: 'invalid', path: 'invalid'}})});
    assert.deepEqual(await extract(snapshot({title: 'Original'}), {...config, transformFunction: 'transform'}), {title: 'Transformed', objectID: 'document-1', path: 'sermons/document-1'});
    global.fetch = async () => ({ok: false, status: 503});
    await assert.rejects(extract(snapshot({}), {...config, transformFunction: 'transform'}), /503/);
    global.fetch = async () => ({ok: true, json: async () => ({error: 'invalid'})});
    await assert.rejects(extract(snapshot({}), {...config, transformFunction: 'transform'}), /no record/);
  } finally {global.fetch = original;}
});
test('stale event converges to latest source rather than old event data', async () => {
  const writes = [];
  await converge(async () => snapshot({title: 'Latest'}, 3), async doc => writes.push(doc.data()));
  assert.deepEqual(writes, [{title: 'Latest'}]);
});
test('concurrent modification during indexing is reconciled before success', async () => {
  let current = snapshot({title: 'First'}, 1);
  const writes = [];
  await converge(async () => current, async doc => {writes.push(doc.data()); current = snapshot({title: 'Latest'}, 2);});
  assert.deepEqual(writes, [{title: 'First'}, {title: 'Latest'}]);
});
test('delete followed by recreation converges to recreated record', async () => {
  let current = snapshot(null);
  const writes = [];
  await converge(async () => current, async doc => {writes.push(doc.exists); current = snapshot({title: 'Recreated'}, 2);});
  assert.deepEqual(writes, [false, true]);
});
test('Algolia failures and continuously changing documents reject for retry', async () => {
  await assert.rejects(converge(async () => snapshot({}), async () => {throw new Error('Algolia unavailable');}), /unavailable/);
  let version = 0;
  await assert.rejects(converge(async () => snapshot({}, ++version), async () => {}, 2), /kept changing/);
});
test('staging projection excludes unknown nested fields and preserves UI array/object shapes', async () => {
  const schema = require('../src/staging-search.json').instances.find(row => row.collectionPath === 'sermons');
  const record = await extract(snapshot({title: 'Safe', uploaderId: 'owner', uploaderEmail: 'private@example.test',
    status: {subsplash: 'UPLOADED', soundCloud: 'ERROR', audioStatus: 'PROCESSED', message: 'private stack'},
    speakers: [{id: 'speaker', name: 'Name', email: 'private@example.test', description: 'not needed'}],
    images: [{id: 'image', downloadLink: 'https://image.test', privateToken: 'private'}],
    publishActivity: {listOperation: 'publish', updatedAtMillis: 5, listIds: ['not needed']}, topics: ['allowed', {secret: 'not a string'}], seriesName: {secret: 'not a string'}, privateAccount: {secret: 'hidden'},
  }), {...config, projectId: 'urm-app-staging', fields: schema.fields.join(',')});
  assert.equal(record.uploaderId, 'owner');
  assert.equal(record.uploaderEmail, undefined);
  assert.deepEqual(record.status, {subsplash: 'UPLOADED', soundCloud: 'ERROR', audioStatus: 'PROCESSED'});
  assert.deepEqual(record.speakers, [{id: 'speaker', name: 'Name'}]);
  assert.deepEqual(record.images, [{id: 'image', downloadLink: 'https://image.test'}]);
  assert.deepEqual(record.publishActivity, {listOperation: 'publish', updatedAtMillis: 5});
  assert.equal(record.privateAccount, undefined);
  assert.deepEqual(record.topics, ['allowed']);
  assert.equal(record.seriesName, undefined);
});
test('staging refuses whole-document, unknown fields, alternate identity, transforms and users projections', async () => {
  const schema = require('../src/staging-search.json').instances.find(row => row.collectionPath === 'sermons');
  const stage = {...config, projectId: 'urm-app-staging', fields: schema.fields.join(',')};
  for (const patch of [{fields: ''}, {fields: stage.fields + ',private'}, {altObjectId: 'title'}, {transformFunction: 'unreviewed'}]) {
    await assert.rejects(extract(snapshot({title: 'Safe'}), {...stage, ...patch}), /exact reviewed/);
  }
  const user = {...snapshot({email: 'private@example.test'}), ref: {path: 'users/document-1'}};
  await assert.rejects(extract(user, {...stage, fields: '__empty_private_index__'}), /empty\/private/);
  // Production keeps its existing full-document policy until a separately reviewed migration.
  assert.equal((await extract(snapshot({private: 'legacy'}), {...config, projectId: 'urm-app'})).private, 'legacy');
});
