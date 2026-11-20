import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTROL_PATH, RELEASE_DOMAINS, firebaseAdmin, validateReleaseConfig } from './temporal-release-lib.mjs';
import { createReleaseApi } from './temporal-release-api.mjs';
import { runWithCleanup } from './temporal-release-resources.mjs';
import { readPreparationReceipt } from './temporal-preparation-evidence.mjs';
import {
  assertNativeSnapshot,
  hash,
  nativeSnapshotProof,
  pinReleaseCheckouts,
  prepareLocalReleaseADC,
  proofDigest,
  verifyReleaseOperator,
} from './temporal-release-runtime.mjs';

const projectId = 'urm-app-staging';
const releaseId = '417a472a-c79b-4c3b-bb85-f3d9e4d04696';
const runtimeCommit = 'b008afa426291ad2aa94cb8319d4bf06afdce1e0';
const operationId = 'd8cbf798-77f6-4af3-b429-cd2eddadc7de';
const revision = 65;
const action = 'prepare-cloud-run-pool';
const attemptedAt = '2026-11-20T12:05:37.367Z';
const auditTimestamp = '2026-11-20T12:05:42.132901Z';
const auditInsertId = '17llmkzd434g';
const parent = `projects/${projectId}/locations/us-central1`;
const target = `${parent}/workerPools/urm-worker-controls-b008afa426291ad2aa94`;
const method = 'google.cloud.run.v2.WorkerPools.CreateWorkerPool';
const logName = `projects/${projectId}/logs/cloudaudit.googleapis.com%2Factivity`;
const rejection = 'Violation in CreateWorkerPoolRequest.worker_pool: worker_pool.name must be empty on CreateWorkerPoolRequest.';
const lockPath = '_control/temporalReleaseOperation';
const statePath = '_control/temporalReleaseState';
const providerPath = '_control/temporalProviderUsage';
const successfulPath = `_control/temporalCloudPoolPreparation-${operationId}`;
const failurePath = `_control/temporalCloudPoolCreateRejection-${operationId}`;
const paths = [lockPath, CONTROL_PATH, statePath, providerPath];
const checkpointSHA256 = '152131db4b078b2f74400fddd62f586a85aea8f750bf87ef04f98bf54c4de409';
const auditSHA256 = 'ca4d7b304f3ac3336babe5ecc50021e621e5933c395043e59cbc0053912fd272';
const absenceDeadlineMs = 5_000;
const commitPattern = /^[a-f0-9]{40}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const assert = (condition) => {
  if (!condition) throw new Error('STAGING_POOL_CREATE_REJECTION_SETTLEMENT_UNCONFIRMED');
};

export function validateRejectedAttempt(checkpoint) {
  assert(Object.keys(checkpoint ?? {}).length === paths.length && paths.every((path) => checkpoint[path]));
  const lock = checkpoint[lockPath].data;
  const control = checkpoint[CONTROL_PATH].data;
  const state = checkpoint[statePath].data;
  const provider = checkpoint[providerPath].data;
  const original = lock.cloudPoolPreparation;
  assert(
    lock.operationId === operationId && lock.releaseId === releaseId && lock.action === action &&
    proofDigest(lock.operatorIdentity) === lock.bindingDigest &&
    lock.operatorIdentity.runtimeCommit === runtimeCommit && lock.operatorPrincipal.adcAndGcloudAccountMatch === true &&
    typeof lock.operatorPrincipal.email === 'string' &&
    original.stage === 'attempted' && original.attemptedAt === attemptedAt && !original.nativeOperation &&
    original.plan.operationId === operationId && original.plan.releaseId === releaseId &&
    original.plan.role === 'controls' && original.plan.buildId === runtimeCommit &&
    original.plan.body.name === target && original.plan.body.annotations['urm.upperroom.media/preparation'] === operationId
  );
  assert(
    control.releaseId === releaseId && control.revision === revision && control.admission === 'paused' &&
    Object.keys(control.domains).length === RELEASE_DOMAINS.length &&
    RELEASE_DOMAINS.every((domain) => control.domains[domain]?.admission === 'paused') &&
    state.releaseId === releaseId && state.controlRevision === revision && state.phase === 'provider-usage-ready' &&
    state.compatibilityCommit === runtimeCommit && provider.projectId === projectId &&
    typeof state.providerUsageEpoch === 'string' && state.providerUsageEpoch === provider.epoch
  );
  return lock;
}

export function validateNativeRejection(page, originalAudit, lock) {
  assert(!page.nextPageToken && Array.isArray(page.entries) && page.entries.length === 1 && originalAudit.length === 1);
  const [entry] = page.entries;
  const payload = entry.protoPayload;
  const projectedBody = structuredClone(lock.cloudPoolPreparation.plan.body);
  // The pinned Admin Activity entry omits these fields. The checkpoint retains them.
  delete projectedBody.template.containers[0].env;
  delete projectedBody.template.volumes[0].secret.items[0].path;
  assert(
    entry.insertId === auditInsertId && entry.timestamp === auditTimestamp && entry.logName === logName &&
    Date.parse(entry.timestamp) > Date.parse(attemptedAt) &&
    payload.serviceName === 'run.googleapis.com' && payload.methodName === method &&
    payload.resourceName === target && payload.authenticationInfo.principalEmail === lock.operatorPrincipal.email &&
    payload.status?.code === 3 && payload.status.message === rejection &&
    !Object.hasOwn(entry, 'operation') && !Object.hasOwn(payload, 'response') &&
    proofDigest(payload.request) === proofDigest({
      '@type': 'type.googleapis.com/google.cloud.run.v2.CreateWorkerPoolRequest', parent, workerPool: projectedBody,
    }) &&
    proofDigest(entry) === proofDigest(originalAudit[0])
  );
  return entry;
}

const serializedSnapshot = (snapshot) => JSON.parse(JSON.stringify({
  createTime: snapshot.createTime, updateTime: snapshot.updateTime, data: snapshot.data(),
}));

function archiveContents(archive) {
  const { settledAt, ...stored } = archive.data();
  const { createTime, updateTime } = nativeSnapshotProof(archive);
  assert(settledAt && typeof settledAt.toDate === 'function' && proofDigest(createTime) === proofDigest(updateTime));
  const absence = Date.parse(stored.nativeAbsence?.observedAt);
  assert(Number.isFinite(absence) && absence <= settledAt.toDate().getTime());
  return stored;
}

function readOriginalProofs(originals, checkpoint) {
  const reconciled = !originals[0].exists;
  const archive = originals[5];
  assert(!originals[4].exists && archive.exists === reconciled);
  const archived = reconciled ? archiveContents(archive) : undefined;
  const proofs = paths.map((path, index) => {
    if (!index && reconciled) {
      const original = checkpoint[path];
      assert(proofDigest(JSON.parse(JSON.stringify(archived.originalAttempt))) === proofDigest(original.data));
      const fromSavedTimestamp = (stamp) => ({ seconds: stamp._seconds, nanoseconds: stamp._nanoseconds });
      return {
        dataDigest: proofDigest(archived.originalAttempt),
        createTime: fromSavedTimestamp(original.createTime),
        updateTime: fromSavedTimestamp(original.updateTime),
      };
    }
    assert(originals[index].exists && proofDigest(serializedSnapshot(originals[index])) === proofDigest(checkpoint[path]));
    return nativeSnapshotProof(originals[index]);
  });
  return { proofs, archived };
}

export async function settleRejectedPoolCreation({ firestore, api, checkpoint, originalAudit, operator, apply, serverTimestamp }) {
  const lock = validateRejectedAttempt(checkpoint);
  assert(operator?.adcAndGcloudAccountMatch === true && operator.email === lock.operatorPrincipal.email &&
    commitPattern.test(operator.operatorCommit) && shaPattern.test(operator.operatorClosureDigest));
  const refs = [...paths, successfulPath, failurePath].map((path) => firestore.doc(path));
  const [lockRef, , , , successfulRef, failureRef] = refs;
  const originals = await firestore.getAll(...refs);
  const { proofs, archived } = readOriginalProofs(originals, checkpoint);
  const observedAudit = validateNativeRejection(await api('https://logging.googleapis.com/v2/entries:list', 'POST', {
    resourceNames: [`projects/${projectId}`],
    pageSize: 20,
    filter: `logName="${logName}" AND protoPayload.serviceName="run.googleapis.com" AND protoPayload.methodName="${method}" AND protoPayload.resourceName="${target}" AND timestamp>="${attemptedAt}" AND timestamp<="2026-11-20T12:05:53.000Z"`,
  }), originalAudit, lock);
  try {
    await api(`https://run.googleapis.com/v2/${target}`);
    assert(false);
  } catch (error) {
    assert(error?.status === 404);
  }
  const absenceObservedAt = Date.now();
  const absenceObservedMonotonic = performance.now();
  const audit = {
    schemaVersion: 1, projectId, releaseId, revision, operationId, target,
    result: 'native-invalid-argument-before-operation-creation',
    checkpointSHA256, auditSHA256,
    authority: Object.fromEntries(paths.map((path, index) => [path, proofs[index]])),
    originalAttempt: archived ? archived.originalAttempt : originals[0].data(),
    nativeRejection: { code: 3, message: rejection, entryDigest: proofDigest(observedAudit), auditInsertId, auditTimestamp },
    nativeAbsence: { status: 404, observedAt: archived?.nativeAbsence?.observedAt ?? new Date(absenceObservedAt).toISOString() },
    settlementOperator: {
      email: operator.email,
      operatorCommit: operator.operatorCommit,
      operatorClosureDigest: operator.operatorClosureDigest,
    },
    poolWrites: 0, releaseStateWrites: 0,
  };
  if (archived) {
    const current = await firestore.getAll(...refs);
    assert(!current[0].exists && proofDigest(archived) === proofDigest(audit));
    const confirmed = readOriginalProofs(current, checkpoint);
    assertNativeSnapshot(nativeSnapshotProof(originals[5]), current[5]);
    assert(proofDigest(confirmed.archived) === proofDigest(audit));
    return { mode: 'reconciled', operationId, revision, auditPath: failurePath, targetAbsent: true, operationReleased: true };
  }
  if (!apply) return { mode: 'inspect', operationId, revision, auditInsertId, targetAbsent: true };
  try {
    await firestore.runTransaction(async (tx) => {
      const snapshots = await tx.getAll(...refs);
      for (let index = 0; index < proofs.length; index++) assertNativeSnapshot(proofs[index], snapshots[index]);
      const absenceAge = Date.now() - absenceObservedAt;
      assert(
        !snapshots[4].exists && !snapshots[5].exists && absenceAge >= 0 && absenceAge <= absenceDeadlineMs &&
        performance.now() - absenceObservedMonotonic <= absenceDeadlineMs
      );
      tx.create(failureRef, { ...audit, settledAt: serverTimestamp() });
      tx.delete(lockRef, { lastUpdateTime: snapshots[0].updateTime });
    }, { maxAttempts: 1 });
  } catch {
    // A failed acknowledgement allows only readback of this exact transaction outcome.
  }
  const [closed, successful, savedArchive] = await firestore.getAll(lockRef, successfulRef, failureRef);
  assert(!closed.exists && !successful.exists && savedArchive.exists);
  assert(proofDigest(archiveContents(savedArchive)) === proofDigest(audit));
  return { mode: 'apply', operationId, revision, auditPath: failurePath, targetAbsent: true, operationReleased: true };
}

async function main(args) {
  const values = {};
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    assert(!Object.hasOwn(values, key));
    if (key === '--apply') {
      assert(!apply);
      apply = true;
    } else {
      assert(['--release', '--runtime-root', '--checkpoint', '--audit'].includes(key));
      values[key] = args[++index];
      assert(typeof values[key] === 'string' && values[key].length > 0 && !values[key].startsWith('--'));
    }
  }
  assert(Object.keys(values).length === 4);
  assert(!['FIRESTORE_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']
    .some((name) => Object.hasOwn(process.env, name)));
  const [checkpoint, originalAudit] = await Promise.all([
    readPreparationReceipt(values['--checkpoint'], checkpointSHA256),
    readPreparationReceipt(values['--audit'], auditSHA256),
  ]);
  const lock = validateRejectedAttempt(checkpoint);
  const releaseBytes = readFileSync(values['--release']);
  assert(hash(releaseBytes) === lock.operatorIdentity.descriptorSHA256);
  const config = validateReleaseConfig(JSON.parse(releaseBytes));
  assert(config.environment === 'staging' && config.projectId === projectId && config.releaseId === releaseId &&
    config.compatibilityCommit === runtimeCommit);
  const operatorRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const binding = pinReleaseCheckouts(operatorRoot, values['--runtime-root'], config);
  assert(binding.runtimeRoot === lock.operatorIdentity.runtimeRoot && binding.runtimeCommit === runtimeCommit);
  const adc = prepareLocalReleaseADC(binding.operatorRoot, projectId);
  let resources;
  try {
    resources = firebaseAdmin(projectId);
  } catch (error) {
    adc.close();
    throw error;
  }
  await runWithCleanup(async () => {
    assert(resources.credential === adc.credential);
    const operator = {
      ...await verifyReleaseOperator(binding, resources.credential),
      operatorCommit: binding.operatorCommit,
      operatorClosureDigest: binding.operatorClosureDigest,
    };
    const api = createReleaseApi({
      getAccessToken: async () => (await resources.credential.getAccessToken()).access_token,
    });
    const result = await settleRejectedPoolCreation({
      firestore: resources.firestore, api, checkpoint, originalAudit, operator, apply, serverTimestamp: resources.serverTimestamp,
    });
    console.log(JSON.stringify(result));
  }, () => runWithCleanup(() => resources.close(), () => adc.close()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2)).catch(() => {
    console.error('STAGING_POOL_CREATE_REJECTION_SETTLEMENT_UNCONFIRMED');
    process.exitCode = 1;
  });
}
