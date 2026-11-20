import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { activateRestoredCloudRunMedia } from './temporal-media-restored-activation.mjs';
import { restoredActivationFixture } from './tests/fixtures/restored-media-activation.mjs';
const require = createRequire(new URL('../package.json', import.meta.url));
const compiler = require('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
});
const {
  restoredMediaStartupIntent,
  restoredMediaHistoricalStartupIntent,
  restoredMediaKernelContext,
} = require(fileURLToPath(new URL('../apps/temporal-worker/src/runtime/restored-media-startup.ts', import.meta.url)));
const { mediaStartupIntent } = require(fileURLToPath(
  new URL('../apps/temporal-worker/src/runtime/media-startup-capacity.ts', import.meta.url)
));
compiler.enabled(false);
if (process[Symbol.for('ts-node.register.instance')] === compiler)
  delete process[Symbol.for('ts-node.register.instance')];
async function operation() {
  const f = restoredActivationFixture(),
    image = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'c'.repeat(64)}`;
  f.replaceOrigin({
    ...f.origin,
    image,
    pool: { ...f.origin.pool, revision: `${f.origin.pool.name}/revisions/normal` },
  });
  const save = f.options.save;
  f.options.save = async (next) => {
    await save(next);
    if (next.start?.stage === 'attempted') throw Error('CONTROLLED_CAPTURE');
  };
  await assert.rejects(activateRestoredCloudRunMedia(f.options), /CONTROLLED_CAPTURE/);
  return {
    action: 'activate-restored-cloud-run-media',
    operationId: f.options.operationId,
    releaseId: f.options.releaseId,
    bindingDigest: f.options.bindingDigest,
    cloudRestoredMediaActivation: f.saved,
  };
}
test('new intent preserves original attempted bytes across ACK convergence', async () => {
  const op = await operation(),
    before = restoredMediaStartupIntent(op);
  op.cloudRestoredMediaActivation.start.stage = 'acknowledged';
  op.cloudRestoredMediaActivation.start.nativeOperation =
    'projects/urm-app-staging/locations/us-central1/operations/one';
  assert.equal(restoredMediaStartupIntent(op).intentSHA256, before.intentSHA256);
  assert.throws(() => mediaStartupIntent(op));
});
for (const mode of [
  'oldaction',
  'sameid',
  'missingancestor',
  'foreignetag',
  'diagnosticqueue',
  'oldstartup',
  'wrongrevision',
  'cleanup',
  'wrongimage',
])
  test(`new startup cannot reinterpret foreign lineage / ${mode}`, async () => {
    const op = await operation(),
      s = op.cloudRestoredMediaActivation;
    if (mode === 'oldaction') op.action = 'activate-cloud-run-media-pool';
    if (mode === 'sameid') s.plan.recoveryOperationId = s.plan.operationId;
    if (mode === 'missingancestor') delete s.plan.receiptIds.storageRole;
    if (mode === 'foreignetag') s.start.request.body.etag = 'foreign';
    if (mode === 'diagnosticqueue') s.plan.startup.protocol = 'owned-media-recovery-v1';
    if (mode === 'oldstartup') s.plan.startup.capacity = 'filesystem-only-v1';
    if (mode === 'wrongrevision') s.start.before.revision = 'foreign';
    if (mode === 'cleanup') s.cleanup = { kind: 'unused-cleanup' };
    if (mode === 'wrongimage') s.plan.image = s.plan.image.replace('urm-temporal/worker', 'foreign/worker');
    assert.throws(() => restoredMediaStartupIntent(op));
  });
test('ordinary cold start does not acquire unused Auth or create a restored journal', async () => {
  let auth = 0;
  const db = {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    doc: () => ({ get: async () => ({ get: () => undefined }) }),
  };
  assert.equal(
    await restoredMediaKernelContext(
      db,
      () => {
        auth++;
        throw Error();
      },
      { buildId: 'a'.repeat(40), instanceId: randomUUID() }
    ),
    undefined
  );
  assert.equal(auth, 0);
});
test('stalled initial authority read is bounded before any Auth/IPC', async () => {
  let auth = 0;
  const db = {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    doc: () => ({ get: () => new Promise(() => {}) }),
  };
  const result = await Promise.race([
    restoredMediaKernelContext(
      db,
      () => {
        auth++;
        throw Error();
      },
      {}
    ).then(
      () => 'granted',
      () => 'denied'
    ),
    new Promise((resolve) => setTimeout(() => resolve('stalled'), 5600)),
  ]);
  assert.equal(result, 'denied');
  assert.equal(auth, 0);
});

test('fixed historical cleanup preserves original start intent while live bootstrap stays denied', async () => {
  const op = await operation(),
    s = op.cloudRestoredMediaActivation,
    before = restoredMediaStartupIntent(op);
  s.start.stage = 'completed';
  s.start.pool = {
    ...s.plan.origin.pool,
    generation: String(BigInt(s.plan.origin.pool.generation) + 1n),
    etag: 'known-start',
    desiredManualInstanceCount: 1,
  };
  s.stage = 'cleaning';
  s.cleanup = {
    kind: 'unused-cleanup',
    operationId: op.operationId,
    planSHA256: 'a'.repeat(64),
    decisionAt: new Date().toISOString(),
  };
  const { proofDigest } = await import('./temporal-release-runtime.mjs');
  s.cleanup.planSHA256 = proofDigest(s.plan);
  const read = restoredMediaHistoricalStartupIntent(op);
  assert.equal(read.intentSHA256, before.intentSHA256);
  assert.equal(read.start.attemptedAt, before.start.attemptedAt);
  assert.throws(() => restoredMediaStartupIntent(op));
  s.start.stage = 'attempted';
  assert.throws(() => restoredMediaHistoricalStartupIntent(op));
});
