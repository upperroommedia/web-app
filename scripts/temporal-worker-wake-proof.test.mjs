import assert from 'node:assert/strict';
import test from 'node:test';
import { proveWorkerWake } from './temporal-worker-wake-proof.mjs';
import { readCloudRunWorkerScaleAudit } from './temporal-cloud-run-worker-scale-audit.mjs';

const at = Date.UTC(2026, 9, 24, 14);
const pool = `urm-worker-controls-${'a'.repeat(20)}`;
const invoker = `ts-c-${'a'.repeat(20)}@urm-app-staging.iam.gserviceaccount.com`;
const delegate = 'serverless@example.iam.gserviceaccount.com';
const resource = `projects/urm-app-staging/locations/us-central1/workerPools/${pool}`;
function entry(id, seconds, count) {
  return {
    insertId: id,
    logName: 'projects/urm-app-staging/logs/cloudaudit.googleapis.com%2Factivity',
    timestamp: new Date(at + seconds * 1000).toISOString(),
    protoPayload: {
      serviceName: 'run.googleapis.com',
      methodName: 'google.cloud.run.v2.WorkerPools.UpdateWorkerPool',
      resourceName: resource,
      authenticationInfo: {
        principalEmail: invoker,
        serviceAccountDelegationInfo: [{ firstPartyPrincipal: { principalEmail: delegate } }],
      },
      request: { updateMask: 'scaling', workerPool: { name: resource, scaling: { manualInstanceCount: count } } },
    },
  };
}

const read = (api) =>
  readCloudRunWorkerScaleAudit({
    api,
    pool,
    invoker,
    allowedDelegates: [`serviceAccount:${delegate}`],
    from: at,
    to: at + 180000,
  });
test('reads approved scale-only audit entries and retains foreign or failed updates as ambiguous', async () => {
  const foreign = entry('foreign', 40, 2);
  foreign.protoPayload.authenticationInfo.serviceAccountDelegationInfo = [];
  const failed = entry('failed', 50, 1);
  failed.protoPayload.status = { code: 7 };
  const v1 = entry('v1', 60, 1);
  v1.protoPayload.methodName = 'google.cloud.run.v1.WorkerPools.ReplaceWorkerPool';
  v1.protoPayload.resourceName = `namespaces/urm-app-staging/workerpools/${pool}`;
  const two = entry('two', 120, 0);
  const rows = await read(async (url, method, { filter, resourceNames, pageToken }) => {
    assert.equal(url, 'https://logging.googleapis.com/v2/entries:list');
    assert.equal(method, 'POST');
    assert.deepEqual(resourceNames, ['projects/urm-app-staging']);
    assert.ok(filter.includes(v1.protoPayload.resourceName));
    assert.ok(!filter.includes('protoPayload.methodName'));
    assert.ok(filter.includes(resource));
    return pageToken
      ? { entries: [entry('one', 30, 1), foreign, failed, v1] }
      : { entries: [two], nextPageToken: 'next' };
  });
  assert.deepEqual(
    rows.map(({ insertId, count }) => [insertId, count]),
    [
      ['one', 1],
      ['foreign', null],
      ['failed', null],
      ['v1', null],
      ['two', 0],
    ]
  );
  await assert.rejects(
    read(async () => ({ entries: [two, two] })),
    /AUDIT_UNCONFIRMED/
  );
  await assert.rejects(
    read(async () => ({ nextPageToken: 'repeat' })),
    /AUDIT_UNCONFIRMED/
  );
});

function fixture() {
  const role = 'controls',
    revision = `${pool}.1`,
    poolUid = 'pool-uid',
    revisionUid = 'revision-uid';
  const image = 'test-image';
  const workerIdentity = 'current-poller';
  return {
    phase: 'retry',
    expected: { role, revision, poolUid, revisionUid, image, maxInstances: 1 },
    event: { eligibleAt: at + 29000, startedAt: at + 50000, workerIdentity },
    beforeInstance: 'prior-provider-instance',
    after: at + 70000,
    zeroAfter: at + 70001,
    telemetry: {
      role,
      revision,
      poolUid,
      revisionUid,
      declaredImage: image,
      start: { at: at + 45000, workerIdentity, instanceId: 'different-provider-instance' },
      samples: [
        { at: at + 2000, count: 0 },
        { at: at + 60000, count: 1 },
        { at: at + 122000, count: 0 },
      ],
    },
    audit: [
      { at: at + 30000, count: 1 },
      { at: at + 100000, count: 0 },
    ],
  };
}
test('joins zero before eligibility, approved scale out, an actual distinct poller and positive drain', () => {
  const probe = fixture();
  assert.deepEqual(proveWorkerWake(probe).drain, { at: at + 122000, count: 0 });
});
test('missing points, premature scale-out, other mutations, reused instances or changed revision fail closed', () => {
  const changes = [
    (f) => f.telemetry.samples.shift(),
    (f) => {
      f.telemetry.samples[1].count = 0;
    },
    (f) => f.telemetry.samples.pop(),
    (f) => {
      f.audit[0].at = at + 28000;
    },
    (f) => f.audit.splice(1, 0, { at: at + 65000, count: null }),
    (f) => {
      f.audit[1].at = at + 69000;
    },
    (f) => {
      f.telemetry.start.instanceId = f.beforeInstance;
    },
    (f) => {
      f.telemetry.revisionUid = 'another';
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    assert.throws(() => proveWorkerWake(f), /WAKE_UNCONFIRMED/);
  }
});
