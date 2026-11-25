import { generateKeyPairSync, sign } from 'node:crypto';
import { mediaRecoveryExecutionWindowVersion } from './temporal-media-recovery-execution-window.mjs';
import { mediaRecoveryTaskAttestationBytes } from './temporal-media-recovery-task-attestation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareMediaDiagnosticStorage,
  retireMediaDiagnosticStorageGrant,
} from './temporal-prepare-media-diagnostic-storage.mjs';
import { proofDigest } from './temporal-release-runtime.mjs';

const releaseId = '21a97f46-c089-47b0-956b-d2c8776a00af';
const operationId = '85bc9808-ced3-420d-94bb-8d9921e51e9f';
const terminalId = '24902730-ea79-4164-a71c-48d65c92fc46';
const retirementId = '514b1117-e002-4005-8c95-05f7a9c8901b';
const bindingDigest = '3'.repeat(64),
  evidenceDigest = '4'.repeat(64),
  buildId = '5'.repeat(40);
const bucket = 'urm-app-staging-mr-' + releaseId.replaceAll('-', '');
const bucketURL = 'https://storage.googleapis.com/storage/v1/b/' + bucket;
const iam = 'https://iam.googleapis.com/v1/projects/urm-app-staging/roles';
const roleId = 'tw_media_recovery_storage_' + buildId.slice(0, 20);
const name = 'projects/urm-app-staging/roles/' + roleId;
const runner = 'tw-m-' + buildId.slice(0, 20) + '@urm-app-staging.iam.gserviceaccount.com';
const clone = (v) => structuredClone(v);
const priorBinding = { role: 'roles/storage.legacyBucketOwner', members: ['projectOwner:urm-app-staging'] };
function fixture() {
  let saved, role, metadata;
  let policy = { version: 1, bindings: [clone(priorBinding)], etag: 'E0' };
  const packets = [],
    phases = [];
  const f = { lost: undefined, occupied: false, objects: [], stale: false };
  const options = {
    operationId,
    releaseId,
    buildId,
    bindingDigest,
    evidenceDigest,
    authorize: async ({ phase }) => {
      phases.push(phase);
      return {
        authoritySHA256: 'a'.repeat(64),
        poolSHA256: 'c'.repeat(64),
        runnerUniqueId: '123456789012345678901',
        observedAt: Date.now() - (f.stale ? 7000 : 0),
        observedMonotonic: performance.now(),
      };
    },
    save: async (next, previous) => {
      assert.deepEqual(saved, previous);
      saved = clone(next);
    },
    api: async (url, method = 'GET', body, fence) => {
      if (method !== 'GET') {
        await fence();
        packets.push({ url, method, body: clone(body) });
        if (url === iam && method === 'POST') {
          assert.equal(saved.role.stage, 'attempted');
          role = { name, etag: 'R1', ...body.role };
          if (f.lost === 'role') throw Error('lost response');
          return clone(role);
        }
        if (url === 'https://storage.googleapis.com/storage/v1/b?project=urm-app-staging' && method === 'POST') {
          assert.equal(saved.bucket.stage, 'attempted');
          metadata = {
            ...clone(body),
            kind: 'storage#bucket',
            id: bucket,
            projectNumber: '251680231116',
            etag: 'B1',
            metageneration: '1',
            timeCreated: '2026-11-21T01:02:03.000Z',
          };
          if (f.lost === 'bucket') throw Error('lost response');
          return clone(metadata);
        }
        assert.equal(url, bucketURL + '/iam');
        assert.equal(method, 'PUT');
        assert.equal(body.etag, policy.etag);
        const key = body.bindings.length === 1 ? 'revocation' : 'grant';
        assert.equal(saved[key].stage, 'attempted');
        policy = { ...clone(body), etag: key === 'grant' ? 'E1' : 'E2' };
        if (f.lost === key) throw Error('lost response');
      }
      if (url === iam + '/' + roleId && role) return clone(role);
      if (url === bucketURL && metadata) return clone(metadata);
      if (url === bucketURL && f.occupied) return { name: bucket };
      if (url === bucketURL + '/o?versions=true&maxResults=1') return { kind: 'storage#objects', items: f.objects };
      if ([bucketURL + '/iam', bucketURL + '/iam?optionsRequestedPolicyVersion=3'].includes(url))
        return { kind: 'storage#policy', resourceId: 'projects/_/buckets/' + bucket, ...clone(policy) };
      throw Object.assign(Error('absent'), { status: 404 });
    },
  };
  return Object.assign(f, {
    options,
    packets,
    phases,
    getSaved: () => clone(saved),
    reset: () => {
      saved = undefined;
    },
    changePolicy: () => {
      policy = { ...policy, etag: 'concurrent' };
    },
  });
}
const stamp = (receipt) => {
  const time = { seconds: receipt.operationId === terminalId ? 101 : 100, nanoseconds: 20 };
  return { dataDigest: proofDigest(receipt), createTime: time, updateTime: time };
};
function ancestors(prepared) {
  const job =
    'projects/urm-app-staging/locations/us-central1/jobs/urm-media-recovery-' + terminalId.replaceAll('-', '');
  const plan = {
    operationId: terminalId,
    releaseId,
    buildId,
    bindingDigest,
    evidenceDigest,
    runner,
    role: 'media',
    image: 'us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:' + 'b'.repeat(64),
    origin: { desiredManualInstanceCount: 0 },
    job: { name: job },
    diagnosticStorage: prepared.certificate,
  };
  const prepare = { operationId, releaseId, bindingDigest, identityState: prepared };
  const terminal = {
    operationId: terminalId,
    releaseId,
    bindingDigest,
    identityState: {
      stage: 'completed',
      disposition: 'normal-zero-after-job',
      plan,
      recovery: {
        kind: 'recovery',
        operationId: terminalId,
        bindingDigest,
        buildId,
        image: plan.image,
        proofSHA256: '7'.repeat(64),
      },
      jobTermination: {
        kind: 'job-task-terminated',
        operationId: terminalId,
        job,
        jobUid: 'bc0a407a-3405-4725-9e98-e04467a7ffdb',
        execution: job + '/executions/one',
        executionUid: '3c35ebd2-502d-4072-8b16-f8b8c4614b6d',
        proofSHA256: '8'.repeat(64),
      },
      jobDrain: {
        kind: 'job-queues-drained',
        operationId: terminalId,
        terminationSHA256: '8'.repeat(64),
        proofSHA256: '9'.repeat(64),
      },
    },
  };
  return {
    preparationReceipt: prepare,
    preparationProof: stamp(prepare),
    terminalReceipt: terminal,
    terminalProof: stamp(terminal),
  };
}
test('owns two creates, a single four-permission grant and the exact post-drain CAS restoring the prior policy', async () => {
  const f = fixture(),
    prepared = await prepareMediaDiagnosticStorage(f.options);
  assert.equal(prepared.stage, 'completed');
  assert.equal(prepared.certificate.bucket, bucket);
  assert.deepEqual(
    f.packets.map((x) => x.method),
    ['POST', 'POST', 'PUT']
  );
  assert.deepEqual(f.packets[0].body.role.includedPermissions, [
    'storage.objects.create',
    'storage.objects.delete',
    'storage.objects.get',
    'storage.objects.list',
  ]);
  assert.deepEqual(f.packets[2].body.bindings, [priorBinding, { role: name, members: ['serviceAccount:' + runner] }]);
  assert.deepEqual(await prepareMediaDiagnosticStorage({ ...f.options, saved: f.getSaved() }), prepared);
  f.reset();
  const retire = { ...f.options, operationId: retirementId, ...ancestors(prepared) };
  const ended = await retireMediaDiagnosticStorageGrant(retire);
  assert.equal(ended.retiredPolicyETag, 'E2');
  assert.deepEqual(f.packets[3].body, { version: 1, etag: 'E1', bindings: [priorBinding] });
  assert.deepEqual(await retireMediaDiagnosticStorageGrant({ ...retire, saved: f.getSaved() }), ended);
  assert.equal(f.packets.length, 4);
});
for (const [key, total] of [
  ['role', 1],
  ['bucket', 2],
  ['grant', 3],
]) {
  test('lost ' + key + ' ACK cannot be retried or adopted from matching live data', async () => {
    const f = fixture();
    f.lost = key;
    await assert.rejects(prepareMediaDiagnosticStorage(f.options));
    assert.equal(f.getSaved()[key].stage, 'attempted');
    await assert.rejects(prepareMediaDiagnosticStorage({ ...f.options, saved: f.getSaved() }));
    assert.equal(f.packets.length, total);
  });
}
test('occupied bucket and stale authority deny before the first provider mutation', async () => {
  for (const flag of ['occupied', 'stale']) {
    const f = fixture();
    f[flag] = true;
    await assert.rejects(prepareMediaDiagnosticStorage(f.options));
    assert.equal(f.packets.length, 0);
  }
});
test('changed grant etag or changed terminal receipt prevents retirement', async () => {
  const f = fixture(),
    provisioned = await prepareMediaDiagnosticStorage(f.options);
  const retire = { ...f.options, operationId: retirementId, ...ancestors(provisioned) };
  f.reset();
  const changed = clone(retire.terminalReceipt);
  changed.identityState.jobDrain.terminationSHA256 = '0'.repeat(64);
  await assert.rejects(
    retireMediaDiagnosticStorageGrant({ ...retire, terminalReceipt: changed, terminalProof: stamp(changed) }),
    /TERMINAL_DRAIN/
  );
  f.changePolicy();
  await assert.rejects(retireMediaDiagnosticStorageGrant(retire));
  assert.equal(f.packets.length, 3);
});
test('lost revocation ACK remains attempted, including when the baseline policy reappears', async () => {
  const f = fixture(),
    provisioned = await prepareMediaDiagnosticStorage(f.options);
  const retire = { ...f.options, operationId: retirementId, ...ancestors(provisioned) };
  f.reset();
  f.lost = 'revocation';
  await assert.rejects(retireMediaDiagnosticStorageGrant(retire));
  assert.equal(f.getSaved().revocation.stage, 'attempted');
  await assert.rejects(retireMediaDiagnosticStorageGrant({ ...retire, saved: f.getSaved() }));
  assert.equal(f.packets.length, 4);
});

function failedAncestors(prepared) {
  const success = ancestors(prepared);
  const { preparationReceipt, preparationProof, terminalReceipt } = success;
  const { plan, jobTermination } = terminalReceipt.identityState;
  const job = plan.job.name;
  const operations = 'projects/urm-app-staging/locations/us-central1/operations/';
  const runOperation = operations + 'e78ddac7-f21c-49e5-803a-cafc2300cd01';
  const runId = '01a1ff28-1330-7cc6-83fc-c4ff818e34be';
  const workflowId = 'media-recovery-' + terminalId;
  const time = (seconds) => new Date(seconds * 1000).toISOString();
  const jobPlanSHA256 = proofDigest(plan.job);
  const run = { stage: 'acknowledged', operation: runOperation, attemptedAt: time(120), intentSHA256: '1'.repeat(64) };
  const runIdentity = {
    ...run,
    execution: jobTermination.execution,
    executionUid: jobTermination.executionUid,
    jobUid: jobTermination.jobUid,
    jobPlanSHA256,
  };
  const provider = {
    jobPlanSHA256,
    create: { stage: 'acknowledged', operation: operations + '002c769b-29ff-40c5-a58c-7dcdb8890e3d' },
    access: {
      stage: 'completed',
      outcome: 'attested-job-empty-direct-policy',
      plan: { grants: [], jobUid: runIdentity.jobUid, operationId: terminalId, resource: job, jobPlanSHA256 },
    },
    run,
    runIdentity,
  };
  const task = jobTermination.execution + '/tasks/one-task0';
  const failureReceipt = {
    schemaVersion: 1,
    kind: 'staging-media-diagnostic-started-failure',
    projectId: 'urm-app-staging',
    releaseId,
    buildId,
    bindingDigest,
    operationId: terminalId,
    preparationProof,
    provider,
    plan: {
      ...plan,
      createdAt: time(110),
      expiresAt: 410000,
      taskAttestationPublicKey: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.alloc(32, 1),
      ]).toString('base64'),
    },
    start: {
      schemaVersion: 1,
      stage: 'confirmed',
      operationId: terminalId,
      ack: 'native-start-response',
      runId,
      recordedAt: time(135),
      confirmedAt: time(140),
      intentSHA256: 'a'.repeat(64),
      nativeStartSHA256: 'b'.repeat(64),
      jobRunSHA256: proofDigest(runIdentity),
    },
    workflow: {
      workflowId,
      runId,
      status: 'FAILED',
      terminalEventId: '17',
      closedAt: time(205),
      historySHA256: 'c'.repeat(64),
      noNewExecutionRunId: true,
    },
    jobTermination: {
      kind: 'job-task-failed',
      job,
      jobUid: runIdentity.jobUid,
      runOperation,
      execution: runIdentity.execution,
      executionUid: runIdentity.executionUid,
      task,
      taskCreateTime: time(130),
      taskCompletionTime: time(208),
      executionCompletionTime: time(210),
      exitCode: 1,
      retried: 0,
      proofSHA256: 'd'.repeat(64),
    },
    closure: {
      kind: 'failed-episode-no-pending-work',
      workflowId,
      runId,
      job,
      executionUid: runIdentity.executionUid,
      task,
      inventorySHA256: 'e'.repeat(64),
      computeSHA256: 'f'.repeat(64),
      queuesEmpty: true,
      computeAbsent: true,
      noPendingOperations: true,
    },
  };
  return { preparationReceipt, preparationProof, failureReceipt, failureProof: failureStamp(failureReceipt) };
}
function failureStamp(receipt) {
  const time = { seconds: 500, nanoseconds: 1000 };
  return { dataDigest: proofDigest(receipt), createTime: time, updateTime: time };
}
function failedRetirement(f, prepared, args = failedAncestors(prepared)) {
  return {
    ...f.options,
    ...args,
    operationId: retirementId,
    authorize: async (input) => {
      const authority = await f.options.authorize(input);
      assert.deepEqual(input.failureProof, args.failureProof);
      assert.equal(input.terminalProof, undefined);
      return {
        ...authority,
        failedClosure: {
          failureSHA256: args.failureProof.dataDigest,
          workflowHistorySHA256: args.failureReceipt.workflow.historySHA256,
          jobTerminationSHA256: args.failureReceipt.jobTermination.proofSHA256,
          inventorySHA256: '0'.repeat(64),
          computeSHA256: '1'.repeat(64),
          workflowFailed: true,
          jobFailed: true,
          queuesEmpty: true,
          computeAbsent: true,
          noPendingOperations: true,
        },
      };
    },
  };
}

test('an immutable failed Workflow and Task with fresh idle proof retire only the original grant', async () => {
  const f = fixture(),
    prepared = await prepareMediaDiagnosticStorage(f.options);
  f.reset();
  const retire = failedRetirement(f, prepared);
  const result = await retireMediaDiagnosticStorageGrant(retire);
  assert.deepEqual(result.plan.failureProof, retire.failureProof);
  assert.equal(result.plan.terminalProof, undefined);
  assert.equal(result.retiredPolicyETag, 'E2');
  assert.deepEqual(f.packets[3].body, { etag: 'E1', version: 1, bindings: [priorBinding] });
  assert.deepEqual(await retireMediaDiagnosticStorageGrant({ ...retire, saved: f.getSaved() }), result);
  assert.equal(f.packets.length, 4);
});

test('failed v2 retirement joins the original signed Task born after the launch cutoff', async () => {
  const f = fixture();
  const prepared = await prepareMediaDiagnosticStorage(f.options);
  f.reset();
  const args = failedAncestors(prepared);
  const record = args.failureReceipt;
  const { plan, provider, start, workflow, jobTermination: task } = record;
  const time = seconds => new Date(seconds * 1000).toISOString();
  const key = generateKeyPairSync('ed25519');
  plan.executionWindowVersion = mediaRecoveryExecutionWindowVersion;
  plan.taskAttestationPublicKey = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  task.taskCreateTime = time(430);
  task.taskCompletionTime = time(570);
  task.executionCompletionTime = time(571);
  workflow.closedAt = time(569);
  start.recordedAt = time(440);
  start.confirmedAt = time(444);
  record.intent = { expiresAt: 615000 };
  start.intentSHA256 = proofDigest(record.intent);
  const payload = {
    operationId: record.operationId, releaseId: record.releaseId, bindingDigest: record.bindingDigest,
    buildId: record.buildId, image: plan.image, runner: plan.runner, planSHA256: proofDigest(plan),
    jobPlanSHA256: provider.jobPlanSHA256,
    armingSHA256: '8'.repeat(64), authoritySHA256: '9'.repeat(64),
    job: task.job, jobUid: task.jobUid, createOperation: provider.create.operation, runOperation: task.runOperation,
    runIntentSHA256: provider.runIdentity.intentSHA256, execution: task.execution, executionUid: task.executionUid,
    executionGeneration: '1', task: task.task, taskCreateTime: task.taskCreateTime, taskGeneration: '1', taskUid: null,
    issuedAt: time(435), expiresAt: 615000, executionWindowVersion: plan.executionWindowVersion,
  };
  const certificate = { payload, signature: sign(null, mediaRecoveryTaskAttestationBytes(payload), key.privateKey).toString('base64') };
  const stamp = (data, seconds) => ({
    dataDigest: proofDigest(data), createTime: { seconds, nanoseconds: 0 }, updateTime: { seconds, nanoseconds: 0 },
  });
  args.failureCertificate = certificate;
  args.failureCertificateProof = stamp(certificate, 436);
  record.facts = [null, args.failureCertificateProof];
  args.failureProof = stamp(record, 616);
  await assert.rejects(retireMediaDiagnosticStorageGrant({
    ...failedRetirement(f, prepared, args), failureCertificateProof: stamp(certificate, 437),
  }), /FAILED_CERTIFICATE_PROVENANCE/);
  await assert.rejects(retireMediaDiagnosticStorageGrant({
    ...failedRetirement(f, prepared, args), failureProof: stamp(record, 614),
  }), /FAILURE_ARCHIVE/);
  const result = await retireMediaDiagnosticStorageGrant(failedRetirement(f, prepared, args));
  assert.equal(result.retiredPolicyETag, 'E2');
  assert.equal(f.packets.length, 4);
});

test('unknown, still-running, mismatched and ambiguous failure records cannot reserve a write', async () => {
  const f = fixture(),
    prepared = await prepareMediaDiagnosticStorage(f.options);
  f.reset();
  const retire = failedRetirement(f, prepared);
  const edits = [
    (f) => {
      f.provider.run.stage = 'attempted';
    },
    (f) => {
      f.start.stage = 'acknowledged';
    },
    (f) => {
      f.workflow.status = 'RUNNING';
    },
    (f) => {
      f.workflow.noNewExecutionRunId = false;
    },
    (f) => {
      f.jobTermination.executionUid = releaseId;
    },
    (f) => {
      f.jobTermination.exitCode = 0;
    },
    (f) => {
      f.closure.noPendingOperations = false;
    },
    (f) => {
      f.preparationProof.dataDigest = '0'.repeat(64);
    },
  ];
  for (const edit of edits) {
    const failureReceipt = clone(retire.failureReceipt);
    edit(failureReceipt);
    await assert.rejects(
      retireMediaDiagnosticStorageGrant({ ...retire, failureReceipt, failureProof: failureStamp(failureReceipt) })
    );
    assert.equal(f.getSaved(), undefined);
  }
  await assert.rejects(retireMediaDiagnosticStorageGrant({ ...retire, ...ancestors(prepared) }), /AMBIGUOUS_OUTCOME/);
  assert.equal(f.packets.length, 3);
});

test('fresh failed-closure evidence must survive the final native send fence', async () => {
  const f = fixture(),
    prepared = await prepareMediaDiagnosticStorage(f.options);
  f.reset();
  const r = failedRetirement(f, prepared);
  const authorize = async (input) => {
    const a = await r.authorize(input);
    if (input.phase === 'revocation-before-send') a.failedClosure.computeAbsent = false;
    return a;
  };
  await assert.rejects(retireMediaDiagnosticStorageGrant({ ...r, authorize }), /FAILED_CLOSURE/);
  assert.equal(f.getSaved().revocation.stage, 'attempted');
  await assert.rejects(retireMediaDiagnosticStorageGrant({ ...r, saved: f.getSaved() }), /UNCONFIRMED_REVOCATION/);
  assert.equal(f.packets.length, 3);
});
