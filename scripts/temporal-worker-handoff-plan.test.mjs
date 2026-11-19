import assert from 'node:assert/strict';
import test from 'node:test';
import { independentPromotionRoles } from './temporal-promotion-roles.mjs';
import { serverlessResourceNames } from './temporal-serverless-platform.mjs';
import {
  assertWorkerHandoffPromotion,
  validateWorkerHandoffPlan,
  verifyWorkerHandoffVm,
  workerHandoffInput,
} from './temporal-worker-handoff-plan.mjs';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const buildId = 'a'.repeat(40);
const previousBuildId = 'b'.repeat(40);
const evidenceDigest = 'c'.repeat(64);
const roles = ['controls', 'email', 'images', 'media', 'orchestration', 'search'];
const config = { projectId: 'urm-app-staging', environment: 'staging', releaseId: uuid(10) };
const platform = {
  firebaseProjectId: config.projectId,
  workerHosting: 'cloud-run',
  temporalNamespace: 'urm-app-staging.qwejt',
  workerBuildId: buildId,
  workerImage: `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'d'.repeat(64)}`,
  workerRoles: roles,
};
const fail = /STAGING_WORKER_HANDOFF_PLAN_UNCONFIRMED/;
function plan() {
  return {
    schemaVersion: 1,
    releaseId: config.releaseId,
    buildId,
    previousBuildId,
    workerImage: platform.workerImage,
    evidenceDigest,
    promotionOperationIds: Object.fromEntries(independentPromotionRoles.map((role, n) => [role, uuid(20 + n)])),
    pools: Object.fromEntries(
      roles.map((role, n) => [
        role,
        {
          poolUid: `pool-${role}`,
          revision: `${serverlessResourceNames(buildId, role).poolName}-00001-xyr`,
          revisionUid: `revision-${role}`,
          workerIdentity: `cloud-run-${'e'.repeat(64)}-${uuid(30 + n)}`,
          instanceId: `instance-${role}`,
          startedAt: Date.now() - 1000,
        },
      ])
    ),
    traditionalCluster: {
      context: 'reviewed-staging',
      clusterUid: uuid(70),
      nodeUid: uuid(71),
      nodeName: 'urm-temporal-staging',
      builds: [previousBuildId, 'f'.repeat(40)],
    },
  };
}

test('handoff CLI applies one hash-pinned plan and existing image proof to staging actions only', () => {
  const args = [
    '--worker-handoff-plan',
    '/tmp/handoff.json',
    '--worker-handoff-plan-sha256',
    'a'.repeat(64),
    '--preparation-proof',
    '/tmp/proof.json',
    '--preparation-proof-sha256',
    evidenceDigest,
  ];
  const parsed = workerHandoffInput('handoff-cloud-run-orchestration', args, config);
  assert.equal(parsed.planDigest, 'a'.repeat(64));
  assert.equal(parsed.evidenceDigest, evidenceDigest);
  assert.deepEqual(workerHandoffInput('retire-traditional-staging-workers', args, config), parsed);
  assert.deepEqual(
    workerHandoffInput('attach-cloud-run-worker-compute', [...args, '--worker-compute-role', 'media'], config),
    { ...parsed, role: 'media' }
  );
  assert.throws(() => workerHandoffInput('attach-cloud-run-worker-compute', args, config), fail);
  assert.equal(workerHandoffInput('workers-ready', [], config, 'kubernetes'), undefined);
  for (const action of ['workers-ready', 'take-ownership', 'open']) {
    assert.deepEqual(workerHandoffInput(action, args, config, 'cloud-run'), parsed);
    assert.throws(() => workerHandoffInput(action, [], config, 'cloud-run'), fail);
  }
  assert.throws(() => workerHandoffInput('retire-traditional-staging-workers', args.slice(1), config), fail);
  assert.throws(
    () => workerHandoffInput('retire-traditional-staging-workers', [...args, ...args.slice(0, 2)], config),
    fail
  );
  assert.throws(
    () => workerHandoffInput('handoff-cloud-run-orchestration', args, { ...config, environment: 'production' }),
    fail
  );
});

test('immutable references and prepared roles must match the reviewed release and proposed previous fleet', () => {
  assert.equal(validateWorkerHandoffPlan(plan(), config, platform, evidenceDigest).buildId, buildId);
  for (const change of [
    (value) => {
      value.releaseId = uuid(99);
    },
    (value) => {
      value.workerImage = 'image:latest';
    },
    (value) => {
      value.promotionOperationIds.controls = value.promotionOperationIds.media;
    },
    (value) => {
      value.pools.controls.revision = value.pools.media.revision;
    },
    (value) => {
      value.pools.controls.workerIdentity = value.pools.media.workerIdentity;
    },
    (value) => {
      value.pools.controls.instanceId = value.pools.media.instanceId;
    },
    (value) => {
      value.traditionalCluster.builds.push(buildId);
    },
    (value) => {
      value.traditionalCluster.nodeName = '../../foreign';
    },
    (value) => {
      value.readiness = true;
    },
  ]) {
    const value = plan();
    change(value);
    assert.throws(() => validateWorkerHandoffPlan(value, config, platform, evidenceDigest), fail);
  }
});

test('native VM observation is fixed to the same staging instance and private address', async () => {
  const suffix = '/projects/urm-app-staging/zones/us-central1-a/instances/urm-temporal-staging';
  const state = {
    id: '6510989279221520106',
    name: 'urm-temporal-staging',
    status: 'RUNNING',
    zone: 'https://compute.googleapis.com/compute/v1/projects/urm-app-staging/zones/us-central1-a',
    selfLink: `https://compute.googleapis.com/compute/v1${suffix}`,
    networkInterfaces: [{ networkIP: '10.241.0.10' }],
  };
  await verifyWorkerHandoffVm(async (url) => {
    assert.ok(url.endsWith(suffix));
    return state;
  });
  await assert.rejects(
    verifyWorkerHandoffVm(async () => ({ ...state, id: '6510989279221520107' })),
    fail
  );
});

test('handoff requires the same promoted media worker, pool revision, instance and startup time', () => {
  const expected = plan().pools.media;
  const version = { deploymentName: 'urm-worker-media-staging', buildId };
  const promoted = {
    plan: { role: 'media', ...version },
    resources: { pool: { uid: expected.poolUid, revision: `pools/owned/revisions/${expected.revision}` } },
    observed: {
      mediaStartup: structuredClone(expected),
      queueRouting: { pollers: [{ identity: expected.workerIdentity, deploymentOptions: version }] },
    },
  };
  assertWorkerHandoffPromotion('media', promoted, expected);
  for (const [key, value] of [
    ['poolUid', 'wrong-pool'],
    ['revision', 'wrong-revision'],
    ['workerIdentity', 'wrong-poller'],
    ['revisionUid', 'wrong-revision-uid'],
    ['instanceId', 'wrong-provider-instance'],
    ['startedAt', expected.startedAt - 1],
  ]) {
    assert.throws(() => assertWorkerHandoffPromotion('media', promoted, { ...expected, [key]: value }), fail);
  }
});
