import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../package.json', import.meta.url));
require('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
});
const __dirname = fileURLToPath(new URL('../../apps/temporal-worker/src/integration/', import.meta.url));
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { Client } = require('@temporalio/client');
const {queuePollsWorkflows}=require(fileURLToPath(new URL('../../apps/temporal-worker/src/runtime/queue-polling.ts',import.meta.url)));
const { msToTs } = require('@temporalio/common/lib/time');
const { DefaultLogger, Runtime, Worker } = require('@temporalio/worker');
const { createLocalTestEnvironment } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/test-support/local-test-environment.ts', import.meta.url)
));
Runtime.install({ logger: new DefaultLogger('ERROR', () => undefined) });
const bounded = (work, ms = 10000) => {
  let timer;
  return Promise.race([
    work,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned protection test deadline')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
/** Real LOCAL Temporal/native Firestore observations, not deployed Cloud Run/IAM proof. */
test('native bootstrap protection recognizes original old pinned wait and rejects candidate execution/locks without edits', async () => {
  const config = JSON.parse(readFileSync(resolve(__dirname, '../../../../firebase.test.json'), 'utf8'));
  if (process.env.FIRESTORE_EMULATOR_HOST !== `127.0.0.1:${config.emulators.firestore.port}`)
    throw new Error('Dedicated emulator required');
  const script = resolve(__dirname, '../../../../scripts/temporal-bootstrap-observations.mjs'),
    runtime = resolve(__dirname, '../../../../scripts/temporal-release-runtime.mjs');
  const { observeBootstrapProtection, observeBootstrapRegistration } = await import(script);
  const { nativeSnapshotProof } = await import(runtime);
  const environment = await createLocalTestEnvironment({
      server: { executable: { type: 'cached-download', version: 'v1.9.1' } },
    }),
    namespace = 'urm-app-staging.qwejt';
  const app = initializeApp({ projectId: 'urm-app-staging' }, `native-controls-${randomUUID()}`),
    db = getFirestore(app);
  const client = new Client({ connection: environment.connection, namespace }),
    workers = [],
    failures = [];
  const operationId = randomUUID(),
    releaseId = randomUUID(),
    bindingDigest = 'd'.repeat(64),
    buildId = 'a'.repeat(40),
    deploymentName = 'urm-worker-controls-staging';
  const control = db.doc('_control/temporalRelease'),
    state = db.doc('_control/temporalReleaseState'),
    operation = db.doc('_control/temporalReleaseOperation'),
    lock = db.doc(`temporalProviderMutationLocks/${operationId}`);
  const handles = [];
  const rpc = (fn) => bounded(environment.connection.withDeadline(Date.now() + 5000, fn), 6000);
  const launch = async (queue, workflow, version, identity = `owned-bootstrap-${operationId}-${workers.length}`) => {
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace,
      taskQueue: queue,
      identity,
      ...(workflow
        ? {
            workflowsPath: fileURLToPath(
              new URL('../../apps/temporal-worker/src/workflows/verification/index.ts', import.meta.url)
            ),
          }
        : {}),
      activities: {
        bootstrapNeverInvoked: async () => {
          throw new Error('Unexpected bootstrap Activity');
        },
      },
      workerDeploymentOptions: { version, useWorkerVersioning: true, defaultVersioningBehavior: 'PINNED' },
      shutdownGraceTime: '2 seconds',
      shutdownForceTime: '5 seconds',
    });
    const done = worker.run();
    void done.catch((e) => failures.push(e));
    workers.push({ worker, done });
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      try {
        const v = await rpc(() =>
          client.connection.workflowService.describeWorkerDeploymentVersion({ namespace, deploymentVersion: version })
        );
        if (
          v.workerDeploymentVersionInfo?.taskQueueInfos?.some((q) => q.name === queue && q.type === (workflow ? 1 : 2))
        )
          return;
      } catch (error) {
        if (error.code !== 5) throw error;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Owned queue registration absent');
  };
  try {
    await rpc(() =>
      environment.connection.workflowService.registerNamespace({
        namespace,
        workflowExecutionRetentionPeriod: msToTs(86400000),
      })
    );
    await control.create({
      releaseId,
      admission: 'paused',
      domains: Object.fromEntries(
        ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].map((d) => [
          d,
          { admission: 'paused' },
        ])
      ),
    });
    await state.create({ releaseId, phase: 'provider-usage-ready' });
    await operation.create({ operationId, releaseId, bindingDigest, action: 'bootstrap-stop-cloud-run-controls' });
    const options = {
      client,
      firestore: db,
      platform: { temporalNamespace: namespace, roleBindings: [{ role: 'controls', buildId, deploymentName },{role:'orchestration',buildId,deploymentName:'urm-worker-staging'},{role:'search',buildId,deploymentName:'urm-worker-search-staging'},{role:'email',buildId,deploymentName:'urm-worker-email-staging'},{role:'images',buildId,deploymentName:'urm-worker-images-staging'},{role:'media',buildId,deploymentName:'urm-worker-media-staging'}] },
      role: 'controls',
      operationId,
      releaseId,
      bindingDigest,
      expectedAuthority: {
        control: nativeSnapshotProof(await control.get()),
        state: nativeSnapshotProof(await state.get()),
      },
    };
    const old = { deploymentName: 'urm-worker-staging', buildId: 'old-fixture' },
      oldQueue = `old-${operationId}`;
    await launch(oldQueue, true, old);
    const original = await rpc(() =>
      client.workflow.start('WorkerRestartProbe', {
        workflowId: `old-${operationId}`,
        taskQueue: oldQueue,
        versioningOverride: { pinnedTo: old },
        workflowExecutionTimeout: '1 minute',
      })
    );
    handles.push(original);
    await rpc(() => original.query('workerRestartProbe.status'));
    const proof = await observeBootstrapProtection(options);
    assert.equal(proof.protectedRunCount, 1);
    await launch('urm-controls', false, { deploymentName, buildId });
    assert.equal((await observeBootstrapRegistration(options)).role, 'controls');
    assert.equal((await observeBootstrapProtection(options)).protectedRunCount, 1);
    await launch('urm-orchestration',true,{deploymentName:'urm-worker-staging',buildId});
    await launch('urm-search',queuePollsWorkflows('cloud-run','urm-search'),{deploymentName:'urm-worker-search-staging',buildId});
    await launch('urm-email',queuePollsWorkflows('cloud-run','urm-email'),{deploymentName:'urm-worker-email-staging',buildId});
    await launch('urm-images',queuePollsWorkflows('cloud-run','urm-images'),{deploymentName:'urm-worker-images-staging',buildId});
    const mediaIdentity = `cloud-run-${'a'.repeat(64)}-${randomUUID()}`;
    await launch('urm-media', queuePollsWorkflows('cloud-run', 'urm-media'), {
      deploymentName: 'urm-worker-media-staging', buildId,
    }, mediaIdentity);
    assert.match((await observeBootstrapRegistration({
      ...options, role: 'media', expectedPoller: mediaIdentity,
    })).pollerSHA256, /^[a-f0-9]{64}$/);
    await assert.rejects(
      observeBootstrapRegistration({ ...options, role: 'media', expectedPoller: `cloud-run-${'b'.repeat(64)}-${randomUUID()}` }),
      /CLOUD_RUN_BOOTSTRAP_PROTECTION_UNCONFIRMED/
    );
    const selectRole=async role=>{options.role=role;await operation.update({action:`stop-cloud-run-${role}-activation`});};
    for(const role of ['controls','orchestration','search','email','images','media']){
      const actions=[`bootstrap-stop-cloud-run-${role}`,`activate-cloud-run-${role}-pool`,`stop-cloud-run-${role}-activation`];
      options.role=role;
      for(const action of actions){
        await operation.update({action});
        assert.equal((await observeBootstrapProtection(options)).protectedRunCount,1);
      }
      assert.deepEqual((await observeBootstrapRegistration(options)).queues,role!=='orchestration'?[{name:`urm-${role}`,type:2}]:[{name:'urm-orchestration',type:1},{name:'urm-orchestration',type:2}]);
    }
    await lock.create({ state: 'held', sessionId: 'original' });
    const before = await lock.get();
    await assert.rejects(observeBootstrapProtection(options), /CLOUD_RUN_BOOTSTRAP_PROTECTION_UNCONFIRMED/);
    assert.equal((await lock.get()).updateTime?.isEqual(before.updateTime), true);
    await lock.delete();
    const candidateQueue = 'urm-orchestration';
    const candidate = await rpc(() =>
      client.workflow.start('WorkerRestartProbe', {
        workflowId: `candidate-${operationId}`,
        taskQueue: candidateQueue,
        versioningOverride: { pinnedTo: { deploymentName:'urm-worker-staging', buildId } },
        workflowExecutionTimeout: '1 minute',
      })
    );
    handles.push(candidate);
    await rpc(() => candidate.query('workerRestartProbe.status'));
    for(const role of ['controls','orchestration','search','email','images','media']){await selectRole(role);await assert.rejects(observeBootstrapProtection(options),/CLOUD_RUN_BOOTSTRAP_PROTECTION_UNCONFIRMED/);}
    for (const handle of handles) {
      await rpc(() => handle.signal('workerRestartProbe.release'));
      await rpc(() => handle.result());
    }
    handles.length = 0;
    // Establish all other predicates after eventual visibility settles, so the
    // following denial demonstrates current-routing protection specifically.
    let noOpenRuns = false;
    const visibleEnd = Date.now() + 15000;
    while (Date.now() < visibleEnd) {
      const visible = await rpc(() =>
        client.connection.workflowService.listWorkflowExecutions({
          namespace,
          pageSize: 100,
          query: 'ExecutionStatus = "Running"',
        })
      );
      if (!(visible.executions ?? []).length) {
        noOpenRuns = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(noOpenRuns, true);
    // Each target's positive non-current baseline precedes its LOCAL CAS negative.
    for(const binding of options.platform.roleBindings){
      await selectRole(binding.role);
      assert.equal((await observeBootstrapProtection(options)).protectedRunCount,0);
      const described=await rpc(()=>client.connection.workflowService.describeWorkerDeployment({namespace,deploymentName:binding.deploymentName}));
      await rpc(()=>client.connection.workflowService.setWorkerDeploymentCurrentVersion({namespace,deploymentName:binding.deploymentName,buildId,
        conflictToken:described.conflictToken,identity:'owned-negative-protection-fixture'}));
      await assert.rejects(observeBootstrapProtection(options),/CLOUD_RUN_BOOTSTRAP_PROTECTION_UNCONFIRMED/);
    }
  } catch (error) {
    failures.unshift(error);
  } finally {
    // Independent bounded cleanups retain primary failure and always stop server.
    for (const h of handles)
      try {
        await rpc(() => h.signal('workerRestartProbe.release'));
      } catch (e) {
        failures.push(e);
      }
    for (const { worker } of workers)
      try {
        if (worker.getStatus().runState === 'RUNNING') worker.shutdown();
      } catch (e) {
        failures.push(e);
      }
    try {
      const r = await bounded(Promise.allSettled(workers.map((w) => w.done)), 15000);
      failures.push(...r.flatMap((x) => (x.status === 'rejected' ? [x.reason] : [])));
    } catch (e) {
      failures.push(e);
    }
    for (const ref of [lock, operation, control, state])
      try {
        await bounded(ref.delete());
      } catch (e) {
        failures.push(e);
      }
    try {
      await bounded(deleteApp(app));
    } catch (e) {
      failures.push(e);
    }
    try {
      await environment.teardown();
    } catch (e) {
      failures.push(e);
    }
    if (failures.length) throw new AggregateError(failures, 'Native controls protection fixture failed');
  }
});
