import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRetirementArgs, verifyCreateTaskLog, cloudTasksTransport } from './temporal-retire-search-lifecycle.mjs';
import { hash } from './temporal-release-runtime.mjs';

test('arguments require explicit pinned inspect/apply modes and forbid accidental mixed invocation', () => {
  const common = [
    '--release',
    '/release',
    '--runtime-root',
    '/runtime',
    '--operator-commit',
    'a'.repeat(40),
    '--output',
    '/exclusive',
  ];
  assert(
    parseRetirementArgs([
      ...common,
      '--candidate',
      '/candidate',
      '--exclusions',
      '/exclusions',
      '--parents',
      '/parents',
      '--revision',
      '39',
    ])
  );
  const apply = [
    ...common,
    '--apply',
    '--manifest',
    '/manifest',
    '--manifest-sha256',
    'b'.repeat(64),
    '--operation-id',
    '8ec8cb3b-60e3-46e4-8578-d7011e652d10',
  ];
  assert(parseRetirementArgs(apply));
  assert(parseRetirementArgs([...apply, '--resume']));
  for (const args of [
    common,
    [...apply, '--revision', '39'],
    [...apply, '--output', '/again'],
    [...common, '--resume'],
    [...apply, '--unknown'],
  ]) {
    assert.throws(() => parseRetirementArgs(args), /ARGUMENTS/);
  }
});

test('provenance must be the exact hashed successful CLI request/status/response pair', () => {
  const queue = 'projects/urm-app-staging/locations/us-central1/queues/kit-images-index-executeFullIndexOperation';
  const request = { task: { httpRequest: { body: 'eyJkYXRhIjp7fX0=' } } },
    response = { name: queue + '/tasks/123' };
  const endpoint = `https://cloudtasks.googleapis.com/v2/${queue}/tasks`;
  const bytes = Buffer.from(
    `[time] >>> [apiv2][body] POST ${endpoint} ${JSON.stringify(
      request
    )}\n[time] <<< [apiv2][status] POST ${endpoint} 200\n[time] <<< [apiv2][body] POST ${endpoint} ${JSON.stringify(
      response
    )}\n`
  );
  const row = { name: response.name, sourceSha256: hash(bytes), requestLine: 1, responseLine: 3, request, response };
  assert.deepEqual(verifyCreateTaskLog(row, bytes), { request, response });
  assert.throws(() => verifyCreateTaskLog({ ...row, sourceSha256: '0'.repeat(64) }, bytes), /LOG_HASH/);
  assert.throws(() => verifyCreateTaskLog({ ...row, responseLine: 2 }, bytes));
  const failed = Buffer.from(bytes.toString().replace(' 200\n', ' 403\n'));
  assert.throws(() => verifyCreateTaskLog({ ...row, sourceSha256: hash(failed) }, failed), /LOG_PAIR/);
});

test('FULL inventory traverses every queue/task page; repeated pagination tokens are refused', async () => {
  const root = 'projects/urm-app-staging/locations/us-central1/queues',
    queue = root + '/fixture',
    requests = [];
  const pages = [
    { queues: [{ name: queue }], nextPageToken: 'second' },
    { queues: [] },
    { tasks: [{ name: 'one' }], nextPageToken: 'next' },
    { tasks: [{ name: 'two' }] },
  ];
  const api = cloudTasksTransport({
    credential: { getAccessToken: async () => ({ access_token: 'synthetic' }) },
    fetchImpl: async (url, options) => {
      requests.push([url, options]);
      return { ok: true, status: 200, json: async () => pages.shift() };
    },
  });
  const result = await api.inventory();
  assert.equal(result.queues[0].tasks.length, 2);
  assert.equal(requests.length, 4);
  assert(requests[1][0].endsWith('&pageToken=second'));
  assert(requests[2][0].includes('responseView=FULL'));
  assert(requests.every(([, options]) => options.redirect === 'error'));
  const bad = cloudTasksTransport({
    credential: { getAccessToken: async () => ({ access_token: 'synthetic' }) },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ queues: [], nextPageToken: 'same' }) }),
  });
  await assert.rejects(bad.inventory(), /PAGINATION/);
});

test('DELETE errors are never retried; only actual task GET404 is absence, not a queue404 or a GET403', async () => {
  let requests = 0;
  const credential = { getAccessToken: async () => ({ access_token: 'synthetic' }) };
  const name =
    'projects/urm-app-staging/locations/us-central1/queues/kit-images-index-executeFullIndexOperation/tasks/123';
  const api = cloudTasksTransport({
    credential,
    fetchImpl: async () => {
      requests++;
      throw Error('UNKNOWN_RESPONSE');
    },
  });
  await assert.rejects(api.deleteTask(name), /UNKNOWN_RESPONSE/);
  assert.equal(requests, 1);
  const missing = cloudTasksTransport({ credential, fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal(await missing.getTask(name), null);
  await assert.rejects(missing.inventory(), /API_404/);
  await assert.rejects(missing.deleteTask(name), /API_404/);
  const forbidden = cloudTasksTransport({ credential, fetchImpl: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(forbidden.getTask(name), /API_403/);
});
