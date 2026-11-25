import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';
import { GoogleAuth } from 'google-auth-library';
import * as metadata from './cloud-run-witness';
import {
  mediaRecoveryTaskAttestationBytes,
  mediaRecoveryTaskAttestationKey,
  mediaRecoveryTaskAttestationMode,
  mediaRecoveryTaskAttestationV2Mode,
  verifyMediaRecoveryTaskAttestation,
} from './media-recovery-task-attestation';
import {
  historicalMediaRecoveryExecutionWindow,
  joinMediaRecoveryTaskAttestation,
  mediaRecoveryTaskAttestationPath,
  recheckMediaRecoveryTaskAttestation,
} from './media-recovery-task-attestation-reader';
import { mediaRecoveryExecutionWindowVersion } from './media-recovery-execution-window';
import { loadMediaRecoveryJobIdentity } from './media-recovery-job-witness';
import { releaseProvenanceDigest as hash } from './release-provenance';

const operationId = '20f5ec50-6563-479e-a5ee-fdb1e795dbb0',
  releaseId = 'd871dabb-c872-4ac6-a330-1c2bde8f7607';
const buildId = 'b'.repeat(40),
  runner = 'tw-m-' + buildId.slice(0, 20) + '@urm-app-staging.iam.gserviceaccount.com';
const image = 'us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:' + 'a'.repeat(64);
const name = 'urm-media-recovery-' + operationId.replaceAll('-', ''),
  executionId = name + '-abcde';
const location = 'projects/urm-app-staging/locations/us-central1',
  job = location + '/jobs/' + name;
const execution = job + '/executions/' + executionId;
const binding = { operationId, buildId, runner, image, job, execution };
const nativeMetadata = {
  projectId: 'urm-app-staging',
  projectNumber: '251680231116',
  serviceAccount: runner,
  instanceId: 'platform-instance',
};
const keys = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey };
};
const signer = keys();
function row(path: string, data: Record<string, any> | undefined, stamp = { seconds: 1, nanoseconds: 7 }) {
  const time = { ...stamp, isEqual: (t: unknown) => t === time };
  return {
    ref: { path },
    exists: data !== undefined,
    data: () => data,
    createTime: time,
    updateTime: time,
    get: (field: string) => field.split('.').reduce((v, k) => v?.[k], data as any),
  } as unknown as DocumentSnapshot;
}
function fixture(v2 = false) {
  const now = Date.now(),
    createdAt = new Date(now - (v2 ? 310000 : 10000)).toISOString(),
    expiresAt = Date.parse(createdAt) + 300000;
  const env = {
    TEMPORAL_MEDIA_RECOVERY_ATTESTATION_MODE: v2 ? mediaRecoveryTaskAttestationV2Mode : mediaRecoveryTaskAttestationMode,
    TEMPORAL_MEDIA_RECOVERY_ATTESTATION_KEY: signer.key,
  };
  const plan = {
    ...binding,
    releaseId,
    role: 'media',
    bindingDigest: '1'.repeat(64),
    createdAt,
    expiresAt,
    ...(v2 && { executionWindowVersion: mediaRecoveryExecutionWindowVersion, taskAttestationPublicKey: signer.key }),
    job: {
      name: job,
      template: { template: { containers: [{ env: Object.entries(env).map(([name, value]) => ({ name, value })) }] } },
    },
  };
  const journal = {
    operationId,
    releaseId,
    bindingDigest: plan.bindingDigest,
    scope: 'arming-only-no-execution-authority',
    planSHA256: hash(plan),
    authority: { control: { dataDigest: 'b'.repeat(64) }, state: { dataDigest: 'c'.repeat(64) } },
  };
  const payload = {
    operationId,
    releaseId,
    bindingDigest: plan.bindingDigest,
    buildId,
    image,
    runner,
    planSHA256: hash(plan),
    jobPlanSHA256: hash(plan.job),
    armingSHA256: hash(journal),
    authoritySHA256: hash(journal.authority),
    job,
    jobUid: '4c024b1c-1abe-4d03-a58f-d54d394461ce',
    createOperation: location + '/operations/original-create',
    runOperation: location + '/operations/original-run',
    runIntentSHA256: '4'.repeat(64),
    execution,
    executionUid: 'eb1b82e7-11d0-476d-9bcf-7dfccacfbeee',
    executionGeneration: '1',
    task: execution + '/tasks/' + executionId + '-task0',
    taskCreateTime: new Date(now - 5000).toISOString(),
    taskGeneration: '1',
    taskUid: null,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: v2 ? now - 1000 + 180000 : expiresAt,
    ...(v2 && { executionWindowVersion: mediaRecoveryExecutionWindowVersion }),
  };
  const signRecord = (p: typeof payload, key = signer.privateKey) => ({
    payload: p,
    signature: sign(null, mediaRecoveryTaskAttestationBytes(p), key).toString('base64'),
  });
  const cert = signRecord(payload);
  const run = {
    stage: 'acknowledged',
    attemptedAt: createdAt,
    operation: payload.runOperation,
    intentSHA256: payload.runIntentSHA256,
  };
  const op = {
    operationId,
    releaseId,
    bindingDigest: plan.bindingDigest,
    action: 'diagnose-cloud-run-media-recovery',
    mediaRecoveryTaskAttestation: { certificateSHA256: hash(cert) },
    cloudMediaRecovery: { stage: 'prepared', plan, prepared: { proofSHA256: hash(journal) } },
    mediaRecoveryJournalAttempt: { stage: 'completed', recordSHA256: hash(journal) },
    mediaRecoveryJobProvider: {
      jobPlanSHA256: payload.jobPlanSHA256,
      create: { stage: 'acknowledged', operation: payload.createOperation },
      run,
      runIdentity: {
        ...run,
        jobPlanSHA256: payload.jobPlanSHA256,
        jobUid: payload.jobUid,
        execution,
        executionUid: payload.executionUid,
      },
    },
  };
  const stamp = (ms: number, additionalNanos = 0) => ({
    seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1_000_000 + additionalNanos,
  });
  const snapshots = (record = cert, stamped = v2 ? stamp(now - 999) : undefined) =>
    [
      row('_control/temporalReleaseOperation', op),
      row('_control/temporalMediaRecoveryJournal-' + operationId, journal),
      row(mediaRecoveryTaskAttestationPath(operationId), record, stamped),
    ] as const;
  return { payload, cert, op, journal, signRecord, snapshots, now, env, stamp };
}

test('the controller and worker agree on a signed work deadline after the provider launch window', () => {
  const f = fixture(true);
  const plan = f.op.cloudMediaRecovery.plan;
  const operator = resolve(__dirname, '../../../../scripts/temporal-media-recovery-task-attestation.mjs');
  const bytes = execFileSync(process.execPath, [
    '--input-type=module', '-e',
    'const m = await import(process.argv[1]); process.stdout.write(m.mediaRecoveryTaskAttestationBytes(JSON.parse(process.argv[2])));',
    operator, JSON.stringify(f.payload),
  ]);
  expect(bytes).toEqual(mediaRecoveryTaskAttestationBytes(f.payload));
  expect(plan.expiresAt).toBeLessThan(f.now);
  expect(historicalMediaRecoveryExecutionWindow(plan, f.snapshots()[2]).expiresAt).toBe(f.payload.expiresAt);
  const issued = Date.parse(f.payload.issuedAt);
  const onBoundary = f.snapshots(f.cert, f.stamp(issued + 5000))[2];
  const tooLate = f.snapshots(f.cert, f.stamp(issued + 5000, 1))[2];
  expect(historicalMediaRecoveryExecutionWindow(plan, onBoundary).expiresAt).toBe(f.payload.expiresAt);
  expect(() => historicalMediaRecoveryExecutionWindow(plan, tooLate)).toThrow();
  expect(() => historicalMediaRecoveryExecutionWindow({ ...plan, bindingDigest: 'f'.repeat(64) }, onBoundary)).toThrow();
  expect(() => historicalMediaRecoveryExecutionWindow(plan)).toThrow();
  const tampered = { ...f.cert, payload: { ...f.payload, expiresAt: f.payload.expiresAt + 1 } };
  expect(() => historicalMediaRecoveryExecutionWindow(plan, f.snapshots(tampered)[2])).toThrow();
});

test('uses domain-separated fixed field order and rejects key, signature, schema and payload replacement', () => {
  const { payload, cert, signRecord } = fixture();
  expect(JSON.parse(mediaRecoveryTaskAttestationBytes(payload).toString())[0]).toBe(
    'urm.staging.media-recovery.task-attestation.v1'
  );
  expect(verifyMediaRecoveryTaskAttestation(cert, signer.key)).toEqual(payload);
  expect(mediaRecoveryTaskAttestationBytes(Object.fromEntries(Object.entries(payload).reverse()))).toEqual(
    mediaRecoveryTaskAttestationBytes(payload)
  );
  for (const attempt of [
    { ...cert, payload: { ...payload, taskGeneration: '2' } },
    { ...cert, publicKey: keys().key },
    { ...cert, signature: cert.signature + ' ' },
    { ...cert, payload: { ...payload, taskUid: 'synthetic' } },
    signRecord(payload, keys().privateKey),
  ])
    expect(() => verifyMediaRecoveryTaskAttestation(attempt, signer.key)).toThrow();
  expect(() =>
    mediaRecoveryTaskAttestationKey({ TEMPORAL_MEDIA_RECOVERY_ATTESTATION_MODE: mediaRecoveryTaskAttestationMode })
  ).toThrow();
  expect(() => mediaRecoveryTaskAttestationKey({ TEMPORAL_MEDIA_RECOVERY_ATTESTATION_KEY: signer.key })).toThrow();
  expect(mediaRecoveryTaskAttestationKey({})).toBeUndefined();
});

test('the compiled worker verifies the exact operator wire bytes and digest', () => {
  const { payload, cert } = fixture();
  const operator = resolve(__dirname, '../../../../scripts/temporal-media-recovery-task-attestation.mjs');
  const observed = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { readFileSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const operator = await import(pathToFileURL(process.argv[1]));
    const payload = operator.verifyMediaRecoveryTaskAttestation(input.cert, input.key);
    process.stdout.write(operator.mediaRecoveryTaskAttestationBytes(payload));
  `,
      operator,
    ],
    { input: JSON.stringify({ cert, key: signer.key }) }
  );
  expect(observed).toEqual(mediaRecoveryTaskAttestationBytes(payload));
});

test('joins only the signed original known RUN, immutable Job template, current deadline, and real instance metadata', () => {
  const { now, op, cert, payload, signRecord, snapshots } = fixture();
  const join = (time = now) =>
    joinMediaRecoveryTaskAttestation(signer.key, binding, nativeMetadata, ...snapshots(), time);
  expect(join()?.identity).toMatchObject({
    job,
    execution,
    executionUid: payload.executionUid,
    taskCreateTime: payload.taskCreateTime,
    instanceId: nativeMetadata.instanceId,
  });
  expect(join()?.identity).not.toHaveProperty('taskUid');
  expect(() => join(payload.expiresAt)).toThrow();
  expect(() =>
    joinMediaRecoveryTaskAttestation(
      signer.key,
      binding,
      { ...nativeMetadata, serviceAccount: 'other' },
      ...snapshots(),
      now
    )
  ).toThrow();
  for (const changed of [
    { executionUid: 'ebb86aa1-a0bf-44cb-abd8-a8a7670d5a7e' },
    { runIntentSHA256: '7'.repeat(64) },
    { createOperation: location + '/operations/other' },
    { jobUid: '85bc50db-676a-4d73-bdf5-586786c270f7' },
    { authoritySHA256: 'f'.repeat(64) },
  ]) {
    const other = signRecord({ ...payload, ...changed });
    op.mediaRecoveryTaskAttestation.certificateSHA256 = hash(other);
    expect(() =>
      joinMediaRecoveryTaskAttestation(signer.key, binding, nativeMetadata, ...snapshots(other), now)
    ).toThrow();
  }
  op.mediaRecoveryTaskAttestation.certificateSHA256 = hash(cert);
  op.mediaRecoveryJobProvider.run.stage = 'attempted';
  expect(() => join()).toThrow();
});

test('attested parent obtains its audience from platform metadata and performs zero Cloud Run API requests', async () => {
  const f = fixture();
  const raw: Record<string, string> = {
    'project/project-id': nativeMetadata.projectId,
    'project/numeric-project-id': nativeMetadata.projectNumber,
    'instance/service-accounts/default/email': runner,
    'instance/id': nativeMetadata.instanceId,
  };
  const meta = jest.spyOn(metadata, 'readCloudRunMetadata').mockImplementation(async (path) => raw[path]);
  const adc = jest.spyOn(GoogleAuth.prototype, 'getClient').mockImplementation(async () => {
    throw Error('UNEXPECTED_CLOUD_RUN_CLIENT');
  });
  const db = {
    projectId: 'urm-app-staging',
    databaseId: '(default)',
    doc: (path: string) => ({ path }),
    runTransaction: (fRead: (t: unknown) => unknown) => fRead({ getAll: async () => f.snapshots() }),
  } as unknown as Firestore;
  try {
    const result = await loadMediaRecoveryJobIdentity(
      buildId,
      {
        ...f.env,
        FIREBASE_PROJECT_ID: 'urm-app-staging',
        TEMPORAL_CLOUD_REGION: 'us-central1',
        TEMPORAL_WORKER_HOSTING: 'cloud-run',
        TEMPORAL_TASK_QUEUES: 'urm-media-kernel-recovery',
        TEMPORAL_DEPLOYMENT_NAME: 'urm-worker-media-recovery-staging',
        TEMPORAL_MEDIA_RECOVERY_COMPUTE: 'cloud-run-job-v1',
        TEMPORAL_MEDIA_RECOVERY_OPERATION: operationId,
        TEMPORAL_CLOUD_RUN_SERVICE_ACCOUNT: runner,
        TEMPORAL_WORKER_IMAGE: image,
        CLOUD_RUN_JOB: name,
        CLOUD_RUN_EXECUTION: executionId,
        CLOUD_RUN_TASK_INDEX: '0',
        CLOUD_RUN_TASK_ATTEMPT: '0',
        CLOUD_RUN_TASK_COUNT: '1',
      },
      async () => db
    );
    expect(result.instanceId).toBe(nativeMetadata.instanceId);
    const transaction = { get: async () => f.snapshots()[2] } as unknown as Transaction;
    await expect(
      recheckMediaRecoveryTaskAttestation(
        db,
        transaction,
        operationId,
        result,
        f.op.cloudMediaRecovery.plan,
        f.op.mediaRecoveryTaskAttestation,
        f.env
      )
    ).resolves.toBeUndefined();
    await expect(
      recheckMediaRecoveryTaskAttestation(
        db,
        transaction,
        operationId,
        result,
        f.op.cloudMediaRecovery.plan,
        { certificateSHA256: '0'.repeat(64) },
        f.env
      )
    ).rejects.toThrow();
    await expect(
      recheckMediaRecoveryTaskAttestation(
        db,
        transaction,
        operationId,
        { ...result },
        f.op.cloudMediaRecovery.plan,
        f.op.mediaRecoveryTaskAttestation,
        f.env
      )
    ).rejects.toThrow();
    expect(meta).toHaveBeenCalledTimes(4);
    expect(adc).not.toHaveBeenCalled();
  } finally {
    meta.mockRestore();
    adc.mockRestore();
  }
});
