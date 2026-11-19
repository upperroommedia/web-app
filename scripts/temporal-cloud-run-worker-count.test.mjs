import assert from 'node:assert/strict';
import test from 'node:test';
import { readCloudRunRevisionInstanceCount, readCloudRunWorkerCount } from './temporal-cloud-run-worker-count.mjs';

const pool = 'urm-worker-controls-aaaaaaaaaaaaaaaaaaaa';
const revision = `${pool}.2`;
const to = Date.UTC(2026, 10, 17, 18, 0, 0);
const from = to - 10 * 60 * 1000;
const input = { pool, revision, from, to };
const point = (offsetMinutes, value) => ({
  interval: { endTime: new Date(from + offsetMinutes * 60 * 1000).toISOString() },
  value: { int64Value: value },
});
const series = (points, state = 'active') => ({
  metric: {
    type: 'run.googleapis.com/container/containers',
    labels: { container_name: 'worker', state },
  },
  resource: {
    type: 'cloud_run_worker_pool',
    labels: {
      project_id: 'urm-app-staging',
      location: 'us-central1',
      worker_pool_name: pool,
      revision_name: revision,
      configuration_name: pool,
    },
  },
  metricKind: 'GAUGE',
  valueType: 'INT64',
  points,
});

test('reads raw explicit zero and positive samples across pages without filling gaps', async () => {
  const calls = [];
  const api = async (wire) => {
    const url = new URL(wire);
    assert.equal(url.origin, 'https://monitoring.googleapis.com');
    assert.equal(url.pathname, '/v3/projects/urm-app-staging/timeSeries');
    assert.equal(url.searchParams.get('view'), 'FULL');
    assert.match(url.searchParams.get('filter'), /resource.type = "cloud_run_worker_pool"/);
    assert.match(url.searchParams.get('filter'), new RegExp(`resource.labels.revision_name = "${pool}\\.2"`));
    assert.match(url.searchParams.get('filter'), /metric.labels.container_name = "worker"/);
    assert.equal(url.searchParams.has('aggregation.alignmentPeriod'), false);
    const page = url.searchParams.get('pageToken');
    calls.push(page);
    if (!page) return { timeSeries: [series([point(9, '0'), point(6, '1')])], nextPageToken: 'next' };
    return { timeSeries: [series([point(3, '0')])] };
  };
  assert.deepEqual(await readCloudRunWorkerCount({ ...input, api }), [
    { at: from + 3 * 60000, count: 0 },
    { at: from + 6 * 60000, count: 1 },
    { at: from + 9 * 60000, count: 0 },
  ]);
  assert.deepEqual(calls, [null, 'next']);
});

test('no native samples yields no observations, including an idle-only response', async () => {
  assert.deepEqual(await readCloudRunWorkerCount({ ...input, api: async () => ({}) }), []);
  assert.deepEqual(
    await readCloudRunWorkerCount({
      ...input,
      api: async () => ({ timeSeries: [series([point(6, '0')], 'idle')] }),
    }),
    []
  );
});

test('rejects unverifiable partial, changed or incorrectly typed provider observations', async () => {
  const foreign = series([point(2, '0')]);
  foreign.resource.labels.revision_name = `${pool}.3`;
  const altered = series([point(7, '0')]);
  altered.resource.labels.configuration_name = 'another-series';
  for (const reply of [
    { executionErrors: [{ code: 9 }] },
    { unreachable: ['us-central1'] },
    { timeSeries: [foreign] },
    { timeSeries: [series([point(8, '1')], 'idle')] },
    { timeSeries: [series([point(8, 0)])] },
    { timeSeries: [series([point(0, '0')])] },
    { timeSeries: [series([point(8, '0'), point(8, '1')])] },
    { timeSeries: [series([point(8, '0')]), altered] },
    { nextPageToken: 'repeated' },
  ])
    await assert.rejects(readCloudRunWorkerCount({ ...input, api: async () => reply }), /UNCONFIRMED/);
});

test('unsafe or foreign revision strings are rejected before authentication calls', async () => {
  const api = () => {
    throw new Error('API should not be called');
  };
  for (const invalid of ['foreign.2', `${pool}/.2`, `${pool}.0`, `${pool}.2/../../revisions`])
    await assert.rejects(readCloudRunWorkerCount({ ...input, revision: invalid, api }), /UNCONFIRMED/);
});

test('reads revision-wide instance gauge without narrowing to a worker container', async () => {
  const sample = series([point(8, '0')]);
  sample.metric = { type: 'run.googleapis.com/container/instance_count', labels: { state: 'active' } };
  const api = async (url) => {
    const filter = new URL(url).searchParams.get('filter');
    assert.ok(filter.includes('metric.type = "run.googleapis.com/container/instance_count"'));
    assert.doesNotMatch(filter, /container_name/);
    return { timeSeries: [sample] };
  };
  assert.deepEqual(await readCloudRunRevisionInstanceCount({ ...input, api }), [{ at: from + 8 * 60000, count: 0 }]);
  for (const bad of [
    series([point(8, '0')]),
    { ...sample, metric: { ...sample.metric, labels: { state: 'active', container_name: 'worker' } } },
    { ...sample, metric: { ...sample.metric, labels: { state: 'active', instanceId: 'claimed-original' } } },
  ]) {
    await assert.rejects(readCloudRunRevisionInstanceCount({ ...input, api: async () => ({ timeSeries: [bad] }) }));
  }
});
