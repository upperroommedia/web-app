import {
  assertNativeSnapshot,
  assertNativeSnapshotSuccessor,
  nativeSnapshotProof,
  proofDigest,
} from './temporal-release-runtime.mjs';
import { advanceTraditionalKubernetesWatch } from './temporal-traditional-kubernetes.mjs';
import { assertTraditionalRetirementWorkIdle, readTraditionalRetirementWork } from './temporal-retirement-work.mjs';
import { serverlessComputeSettings } from './temporal-serverless-platform.mjs';
import { independentPromotionRoles } from './temporal-promotion-roles.mjs';

export const traditionalRetirementAction = 'retire-traditional-staging-workers';
export const traditionalRetirementField = 'traditionalWorkerRetirement';
export const orchestrationHandoffAction = 'handoff-cloud-run-orchestration';
export const computeAttachmentAction = 'attach-cloud-run-worker-compute';
export const computeAttachmentField = 'cloudWorkerComputeAttachment';
export const workerWakeAction = 'verify-cloud-run-worker-wake';
export const workerWakeField = 'cloudWorkerWake';
export const workerComputeOrder = Object.freeze([...independentPromotionRoles, 'orchestration']);
const readinessPhases = {
  'workers-ready': ['provider-usage-ready', 'workers-ready'],
  'take-ownership': ['workers-ready'],
  open: ['ui-ready'],
};
const orchestrationField = 'cloudOrchestrationHandoff';
const orchestrationReceiptPath = (releaseId) => `_control/temporalOrchestrationHandoff-${releaseId}`;
const traditionalReceiptPath = (releaseId) => `_control/temporalTraditionalRetirement-${releaseId}`;
const computeReceiptPath = (releaseId, role) => `_control/temporalWorkerCompute-${releaseId}-${role}`;
const wakeReceiptPath = (releaseId, role) => `_control/temporalWorkerWake-${releaseId}-${role}`;
const domains = ['accounts', 'bundles', 'emails', 'images', 'media', 'publishing', 'search'];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha256 = /^[a-f0-9]{64}$/;
const equal = (left, right) => proofDigest(left) === proofDigest(right);
const fail = () => {
  throw new Error('TRADITIONAL_RETIREMENT_CHECKPOINT_UNCONFIRMED');
};
const stages = ['graceful', 'terminated', 'removed'];

function advance(previous, next, scope) {
  const plan = next?.plan;
  if (
    plan?.schemaVersion !== 1 ||
    plan.operationId !== scope.operationId ||
    plan.releaseId !== scope.releaseId ||
    plan.bindingDigest !== scope.bindingDigest ||
    !sha256.test(plan.protectionSHA256 ?? '') ||
    !sha256.test(plan.before?.digest ?? '') ||
    !Number.isSafeInteger(plan.before.observedAt) ||
    !Array.isArray(plan.before.deployments) ||
    !Array.isArray(plan.before.pods) ||
    !plan.before.deployments.some((row) => row.desired > 0) ||
    !next.attempts ||
    typeof next.attempts !== 'object' ||
    Array.isArray(next.attempts) ||
    !['planned', 'retiring', 'completed'].includes(next.stage)
  )
    fail();
  if (previous && !equal(previous.plan, plan)) fail();
  const deployments = new Map(plan.before.deployments.filter((row) => row.desired > 0).map((row) => [row.uid, row]));
  const priorAttempts = previous?.attempts ?? {};
  const attempts = Object.entries(next.attempts);
  for (const [uid, attempt] of attempts) {
    const deployment = deployments.get(uid);
    if (
      !deployment ||
      attempt?.resourceVersion !== deployment.resourceVersion ||
      !Number.isSafeInteger(attempt.attemptedAt) ||
      attempt.attemptedAt < plan.before.observedAt ||
      attempt.attemptedAt > Date.now() ||
      Object.keys(attempt).sort().join(',') !== 'attemptedAt,resourceVersion'
    )
      fail();
  }
  if (
    Object.entries(priorAttempts).some(([uid, attempt]) => !equal(attempt, next.attempts[uid] ?? null)) ||
    attempts.length - Object.keys(priorAttempts).length > 1
  )
    fail();
  if (!previous && (next.stage !== 'planned' || attempts.length || next.watch != null || next.receipt != null)) fail();
  if (next.stage === 'planned' && previous && !equal(previous, next)) fail();
  if (next.stage !== 'planned' && (!attempts.length || !next.watch)) fail();
  if (next.watch) {
    const attemptedAt = Math.min(...attempts.map(([, attempt]) => attempt.attemptedAt));
    const valid = advanceTraditionalKubernetesWatch({
      before: plan.before,
      attemptedAt,
      progress: next.watch,
      watch: [],
    });
    if (!equal(valid, next.watch)) fail();
    if (
      previous?.watch &&
      (BigInt(previous.watch.podResourceVersion) > BigInt(next.watch.podResourceVersion) ||
        Object.entries(previous.watch.pods).some(([uid, old]) => {
          const current = next.watch.pods[uid];
          return (
            !current ||
            stages.indexOf(current.stage) < stages.indexOf(old.stage) ||
            (old.stage !== 'graceful' && current.finishedAt !== old.finishedAt)
          );
        }))
    )
      fail();
    for (const [uid, observation] of Object.entries(valid.pods)) {
      const deployment = plan.before.pods.find((row) => row.uid === uid)?.deploymentUid;
      if (
        !next.attempts[deployment] ||
        (observation.stage !== 'graceful' && observation.finishedAt < next.attempts[deployment].attemptedAt)
      )
        fail();
    }
  }
  if (previous?.stage === 'completed' && !equal(previous, next)) fail();
  if (next.stage === 'completed') {
    const receipt = next.receipt;
    if (
      attempts.length !== deployments.size ||
      receipt?.beforeSHA256 !== plan.before.digest ||
      !sha256.test(receipt.afterSHA256 ?? '') ||
      !sha256.test(receipt.temporalSHA256 ?? '') ||
      receipt.podResourceVersion !== next.watch.podResourceVersion ||
      !Number.isSafeInteger(receipt.observedAt) ||
      !equal(
        receipt.exited,
        Object.entries(next.watch.pods).map(([uid, row]) => [uid, row.finishedAt])
      ) ||
      Object.values(next.watch.pods).length !== plan.before.pods.length ||
      Object.values(next.watch.pods).some((row) => row.stage !== 'removed' || row.finishedAt > receipt.observedAt)
    )
      fail();
  } else if (next.receipt != null) fail();
}

function bindAuthority(
  { firestore, config, ownedOperation, expectedAuthority, operationId, bindingDigest },
  action = traditionalRetirementAction,
  phases = ['provider-usage-ready']
) {
  const releaseId = config.releaseId;
  if (
    config.environment !== 'staging' ||
    config.projectId !== 'urm-app-staging' ||
    firestore.projectId !== config.projectId ||
    firestore.databaseId !== '(default)' ||
    !equal([...config.domains].sort(), domains) ||
    !uuid.test(operationId ?? '') ||
    !uuid.test(releaseId ?? '') ||
    !sha256.test(bindingDigest ?? '')
  )
    fail();
  const lockRef = firestore.doc('_control/temporalReleaseOperation');
  const controlRef = firestore.doc('_control/temporalRelease');
  const stateRef = firestore.doc('_control/temporalReleaseState');
  async function read(tx, assertLock = (lock) => assertNativeSnapshot(ownedOperation, lock)) {
    const [lock, control, state] = await Promise.all([lockRef, controlRef, stateRef].map((ref) => tx.get(ref)));
    assertLock(lock);
    assertNativeSnapshot(expectedAuthority.control, control);
    assertNativeSnapshot(expectedAuthority.state, state);
    if (
      lock.get('operationId') !== operationId ||
      lock.get('bindingDigest') !== bindingDigest ||
      lock.get('action') !== action ||
      lock.get('releaseId') !== releaseId ||
      state.get('releaseId') !== releaseId ||
      !phases.includes(state.get('phase')) ||
      control.get('releaseId') !== releaseId ||
      control.get('admission') !== 'paused' ||
      domains.some((domain) => control.get(`domains.${domain}.admission`) !== 'paused')
    )
      fail();
    return lock;
  }
  return { lockRef, read };
}

export async function readOrchestrationHandoffAuthority(options, onSaved) {
  const authority = bindAuthority(options, orchestrationHandoffAction);
  return options.firestore.runTransaction(
    async (tx) => {
      const lock = await authority.read(tx);
      const saved = lock.get(orchestrationField);
      onSaved?.(saved);
      return {
        saved,
        workSHA256: assertTraditionalRetirementWorkIdle(await readTraditionalRetirementWork(options.firestore, tx)),
      };
    },
    { readOnly: true }
  );
}

export async function saveOrchestrationHandoffCheckpoint(options) {
  const { firestore, config, operationId, bindingDigest, next } = options;
  const releaseId = config.releaseId;
  const authority = bindAuthority(options, orchestrationHandoffAction);
  const receiptRef = firestore.doc(orchestrationReceiptPath(releaseId));
  const proposed = await firestore.runTransaction(
    async (tx) => {
      const [lock, receipt] = await Promise.all([authority.read(tx), tx.get(receiptRef)]);
      if (
        next.plan?.operationId !== operationId ||
        next.plan.releaseId !== releaseId ||
        next.plan.bindingDigest !== bindingDigest ||
        !sha256.test(next.plan.handoffPlanSHA256 ?? '')
      )
        fail();
      const prior = lock.get(orchestrationField);
      if (!prior) {
        if (next.stage !== 'attempted' || receipt.exists) fail();
      } else {
        for (const field of [
          'plan',
          'attemptedAt',
          'originalToken',
          'preHandoffInventory',
          'immutableSHA256',
          'protectedWorkSHA256',
        ])
          if (!equal(prior[field], next[field])) fail();
        const legal = {
          attempted: ['acknowledged', 'completed'],
          acknowledged: ['completed'],
          completed: ['completed'],
        };
        if (
          !legal[prior.stage]?.includes(next.stage) ||
          (prior.acknowledgedToken && prior.acknowledgedToken !== next.acknowledgedToken) ||
          (prior.stage === 'completed' && !equal(prior, next))
        )
          fail();
      }
      if (next.stage === 'completed') {
        const value = { schemaVersion: 1, releaseId, operationId, bindingDigest, handoff: next };
        if (!receipt.exists) tx.create(receiptRef, value);
        else if (!receipt.createTime?.isEqual(receipt.updateTime) || !equal(receipt.data(), value)) fail();
      } else if (receipt.exists) fail();
      tx.update(authority.lockRef, { [orchestrationField]: next });
      return proofDigest({ ...lock.data(), [orchestrationField]: next });
    },
    { maxAttempts: 1 }
  );
  return assertNativeSnapshotSuccessor(options.ownedOperation, proposed, await authority.lockRef.get());
}

/** The retirement consumer loads the original immutable receipt directly.
 * Operator arguments cannot replace the pre-handoff observation or timestamp. */
export async function readOrchestrationHandoffReceipt(firestore, config, platform, handoffPlanSHA256) {
  if (
    firestore.projectId !== 'urm-app-staging' ||
    firestore.databaseId !== '(default)' ||
    config.projectId !== firestore.projectId ||
    config.environment !== 'staging' ||
    !uuid.test(config.releaseId ?? '') ||
    !sha256.test(handoffPlanSHA256 ?? '')
  )
    fail();
  const snap = await firestore.doc(orchestrationReceiptPath(config.releaseId)).get();
  const row = snap.data(),
    handoff = row?.handoff;
  if (
    !snap.exists ||
    !snap.createTime?.isEqual(snap.updateTime) ||
    row.schemaVersion !== 1 ||
    row.releaseId !== config.releaseId ||
    row.releaseId !== handoff?.plan?.releaseId ||
    row.operationId !== handoff.plan.operationId ||
    row.bindingDigest !== handoff.plan.bindingDigest ||
    handoff.plan.schemaVersion !== 1 ||
    handoff.plan.handoffPlanSHA256 !== handoffPlanSHA256 ||
    handoff.plan.deploymentName !== 'urm-worker-staging' ||
    handoff.plan.buildId !== platform.workerBuildId ||
    handoff.plan.image !== platform.workerImage ||
    handoff.plan.namespace !== platform.temporalNamespace ||
    handoff.stage !== 'completed' ||
    !Number.isSafeInteger(handoff.attemptedAt) ||
    !Number.isSafeInteger(handoff.handoffAt) ||
    handoff.handoffAt < handoff.attemptedAt ||
    handoff.handoffAt > Date.now() ||
    !Number.isSafeInteger(handoff.preHandoffInventory?.observedAt) ||
    handoff.preHandoffInventory.observedAt >= handoff.handoffAt ||
    !sha256.test(handoff.preHandoffInventory.digest ?? '') ||
    !Array.isArray(handoff.preHandoffInventory.versions) ||
    !handoff.preHandoffInventory.versions.some(
      (version) => version.buildId === handoff.plan.previousBuildId && version.active
    ) ||
    !handoff.preHandoffInventory.versions.some(
      (version) => version.buildId === platform.workerBuildId && !version.active
    )
  )
    fail();
  return handoff;
}

async function readComputeReceipts(options, tx, lock, allAttached = false) {
  const { firestore, config, platform, role, evidenceDigest } = options;
  const index = allAttached ? workerComputeOrder.length : workerComputeOrder.indexOf(role);
  if (index < 0 || !sha256.test(evidenceDigest ?? '')) fail();
  const refs = workerComputeOrder.map((role) => firestore.doc(computeReceiptPath(config.releaseId, role)));
  const rows = await Promise.all(refs.map((ref) => tx.get(ref)));
  const saved = lock.get(computeAttachmentField);
  for (let i = 0; i < rows.length; i++) {
    const snap = rows[i];
    if (i > index || (i === index && saved?.stage !== 'completed')) {
      if (snap.exists) fail();
      continue;
    }
    const binding = platform.roleBindings.find((row) => row.role === workerComputeOrder[i]);
    const data = snap.data(),
      complete = data?.state;
    if (
      !binding ||
      !snap.exists ||
      !snap.createTime?.isEqual(snap.updateTime) ||
      data.schemaVersion !== 1 ||
      data.role !== binding.role ||
      data.releaseId !== config.releaseId ||
      !completeComputeReceipt(complete) ||
      complete.plan?.releaseId !== config.releaseId ||
      complete.plan.evidenceDigest !== evidenceDigest ||
      !uuid.test(complete.plan.operationId ?? '') ||
      complete.plan.bindingSHA256 !== proofDigest(binding) ||
      complete.plan.computeSHA256 !== proofDigest(serverlessComputeSettings(binding)) ||
      (i === index && !equal(complete, saved))
    )
      fail();
  }
  return {
    saved,
    priorReceiptsSHA256: proofDigest(rows.slice(0, index).map((row) => nativeSnapshotProof(row))),
    attachedRoles: workerComputeOrder.slice(0, index),
    receiptRef: refs[index],
  };
}

function completeComputeReceipt(state) {
  return (
    state?.stage === 'completed' &&
    Number.isSafeInteger(state.attemptedAt) &&
    Number.isSafeInteger(state.observedAt) &&
    state.observedAt >= state.attemptedAt &&
    state.observedAt <= Date.now() &&
    ['native-acknowledgement-and-readback', 'desired-compute-observed-after-unknown-ack'].includes(state.outcome)
  );
}

function retiredResult(retired, releaseId) {
  const value = retired.data();
  if (
    !retired.exists ||
    !retired.createTime?.isEqual(retired.updateTime) ||
    value.schemaVersion !== 1 ||
    value.releaseId !== releaseId ||
    !uuid.test(value.operationId ?? '') ||
    !sha256.test(value.bindingDigest ?? '') ||
    !sha256.test(value.planSHA256 ?? '') ||
    !sha256.test(value.result?.afterSHA256 ?? '') ||
    !sha256.test(value.result.temporalSHA256 ?? '')
  )
    fail();
  return value.result;
}

async function readWakeReceipts(options, tx, saved) {
  const { firestore, config, role, platform, evidenceDigest } = options;
  if (workerComputeOrder.indexOf(role) < 0 || !sha256.test(evidenceDigest ?? '')) fail();
  const refs = workerComputeOrder.map((role) => firestore.doc(wakeReceiptPath(config.releaseId, role)));
  const rows = await Promise.all(refs.map((ref) => tx.get(ref)));
  const completed = [];
  const index = workerComputeOrder.indexOf(role);
  for (let i = 0; i < rows.length; i++) {
    const snap = rows[i];
    if (i > index || (i === index && saved?.stage !== 'completed')) {
      if (snap.exists) fail();
      continue;
    }
    const row = snap.data();
    if (
      !snap.exists ||
      !snap.createTime?.isEqual(snap.updateTime) ||
      row?.schemaVersion !== 1 ||
      row.releaseId !== config.releaseId ||
      row.role !== workerComputeOrder[i] ||
      row.evidenceDigest !== evidenceDigest ||
      row.buildId !== platform.workerBuildId ||
      row.image !== platform.workerImage ||
      row.state?.stage !== 'completed' ||
      !row.state.proof ||
      (i === index && !equal(row.state, saved))
    )
      fail();
    if (i < index) completed.push(nativeSnapshotProof(snap));
  }
  return { priorSHA256: proofDigest(completed), ref: refs[index] };
}

function assertWakeBinding(row, role, options) {
  const { config, platform, evidenceDigest, pools } = options;
  const { plan, attempt, run, retryWait, proof } = row.state;
  if (
    plan?.schemaVersion !== 1 ||
    plan.releaseId !== config.releaseId ||
    plan.evidenceDigest !== evidenceDigest ||
    plan.buildId !== platform.workerBuildId ||
    plan.role !== role ||
    !uuid.test(plan.operationId ?? '') ||
    !sha256.test(plan.bindingDigest ?? '') ||
    !sha256.test(plan.protectionSHA256 ?? '') ||
    attempt?.input?.nonce !== plan.operationId.replaceAll('-', '') ||
    attempt.input.projectId !== config.projectId ||
    attempt.input.buildId !== platform.workerBuildId ||
    attempt.input.role !== role ||
    attempt.workflowId !== `worker-wake-${attempt.input.nonce}` ||
    run?.workflowId !== attempt.workflowId ||
    !uuid.test(run.runId ?? '') ||
    !equal(run.input, attempt.input) ||
    retryWait?.workflowId !== run.workflowId ||
    retryWait.runId !== run.runId ||
    retryWait.role !== role ||
    !Number.isSafeInteger(attempt.attemptedAt) ||
    !Number.isFinite(retryWait.observedAt) ||
    !Number.isFinite(retryWait.eligibleAt) ||
    !(attempt.attemptedAt <= retryWait.observedAt && retryWait.observedAt < retryWait.eligibleAt) ||
    proof?.schemaVersion !== 1 ||
    proof.workflowId !== run.workflowId ||
    proof.runId !== run.runId
  )
    fail();

  for (const [phase, targetRole] of [
    ['timer', 'orchestration'],
    ['retry', role],
  ]) {
    const target = pools?.[targetRole];
    const binding = platform.roleBindings.find(({ role }) => role === targetRole);
    const wake = proof[phase];
    if (
      !target ||
      !binding ||
      wake?.phase !== phase ||
      wake.role !== targetRole ||
      wake.poolUid !== target.poolUid ||
      wake.revision !== target.revision ||
      wake.revisionUid !== target.revisionUid ||
      !wake.workerIdentity ||
      wake.start?.workerIdentity !== wake.workerIdentity ||
      !wake.start?.instanceId ||
      wake.zeroBefore?.count !== 0 ||
      !Number.isSafeInteger(wake.scaleOut?.count) ||
      wake.scaleOut.count < 1 ||
      wake.scaleOut.count > binding.maxInstances ||
      wake.scaleIn?.count !== 0 ||
      wake.drain?.count !== 0 ||
      !(
        wake.zeroBefore.at < wake.scaleOut?.at &&
        wake.scaleOut.at <= wake.start?.at &&
        wake.start.at < wake.scaleIn.at &&
        wake.scaleIn.at < wake.drain.at
      ) ||
      (phase === 'retry' && !(wake.zeroBefore.at < retryWait.eligibleAt && retryWait.eligibleAt <= wake.scaleOut.at))
    )
      fail();
  }
  return [plan.operationId, run.runId];
}

/** Read all six immutable wake receipts against one paused release and the
 * same set of provider pool/revision identities used by the handoff. */
/** Persist the original intent before giving this invocation START authority.
 * A response loss here is distinct from loss of a Temporal START response.
 * Only the in-process writer has the exact proposed successor. A resumed
 * invocation with a saved intent continues through the GET-only collector.
 */
export async function saveWorkerReadinessStartIntent(options) {
  const { action, firestore, intent, artifactDirectory, ownedOperation } = options;
  const phases = Object.hasOwn(readinessPhases, action) ? readinessPhases[action] : undefined;
  if (
    !phases ||
    !/^[a-f0-9]{32}$/.test(intent?.nonce ?? '') ||
    intent.workflowId !== `serverless-readiness-${intent.nonce}` ||
    typeof artifactDirectory !== 'string'
  )
    fail();
  const authority = bindAuthority(options, action, phases);
  const checkpoint = { ...intent, artifactDirectory };
  let proposed;
  let unknownAcknowledgement = false;
  try {
    await firestore.runTransaction(
      async (tx) => {
        const lock = await authority.read(tx);
        if (Object.hasOwn(lock.data(), 'cloudWorkerIntent')) fail();
        const dataDigest = proofDigest({ ...lock.data(), cloudWorkerIntent: checkpoint });
        tx.update(authority.lockRef, { cloudWorkerIntent: checkpoint });
        proposed = dataDigest;
      },
      { maxAttempts: 1 }
    );
  } catch (error) {
    if (proposed === undefined) throw error;
    unknownAcknowledgement = true;
  }
  if (proposed === undefined) fail();
  const successor = await firestore.runTransaction(
    async (tx) => {
      let proof;
      await authority.read(tx, (lock) => {
        proof = assertNativeSnapshotSuccessor(ownedOperation, proposed, lock);
      });
      return proof;
    },
    { readOnly: true }
  );
  if (unknownAcknowledgement) throw new Error('WORKER_READINESS_INTENT_ACK_UNCONFIRMED');
  return successor;
}

export async function readWorkerWakeReadiness(options, transaction) {
  const { firestore, config, platform, action, evidenceDigest } = options;
  const phases = Object.hasOwn(readinessPhases, action) ? readinessPhases[action] : undefined;
  if (!phases || !sha256.test(evidenceDigest ?? '')) fail();
  const authority = bindAuthority(options, action, phases);
  const read = async (tx) => {
    const lock = await authority.read(tx);
    const [compute, retired, wakes] = await Promise.all([
      readComputeReceipts(options, tx, lock, true),
      tx.get(firestore.doc(traditionalReceiptPath(config.releaseId))),
      Promise.all(workerComputeOrder.map((role) => tx.get(firestore.doc(wakeReceiptPath(config.releaseId, role))))),
    ]);
    const retiredSHA256 = retiredResult(retired, config.releaseId).afterSHA256;
    const operations = new Set(),
      runs = new Set();
    for (const [index, snap] of wakes.entries()) {
      const role = workerComputeOrder[index];
      const row = snap.data();
      if (
        !snap.exists ||
        !snap.createTime?.isEqual(snap.updateTime) ||
        row?.schemaVersion !== 1 ||
        row.releaseId !== config.releaseId ||
        row.role !== role ||
        row.evidenceDigest !== evidenceDigest ||
        row.buildId !== platform.workerBuildId ||
        row.image !== platform.workerImage ||
        row.state?.stage !== 'completed'
      )
        fail();
      const [operation, run] = assertWakeBinding(row, role, options);
      if (operations.has(operation) || runs.has(run)) fail();
      operations.add(operation);
      runs.add(run);
    }
    return {
      retiredSHA256,
      wakeReceiptsSHA256: proofDigest({
        retired: nativeSnapshotProof(retired),
        compute: compute.priorReceiptsSHA256,
        wakes: wakes.map(nativeSnapshotProof),
      }),
    };
  };
  return transaction ? read(transaction) : firestore.runTransaction(read, { readOnly: true });
}

export async function readWorkerWakeAuthority(options, onSaved) {
  const authority = bindAuthority(options, workerWakeAction);
  const { firestore, config } = options;
  return firestore.runTransaction(
    async (tx) => {
      const lock = await authority.read(tx);
      const saved = lock.get(workerWakeField);
      onSaved?.(saved);
      const [compute, priorWakes, work, retired] = await Promise.all([
        readComputeReceipts(options, tx, lock, true),
        readWakeReceipts(options, tx, saved),
        readTraditionalRetirementWork(firestore, tx),
        tx.get(firestore.doc(traditionalReceiptPath(config.releaseId))),
      ]);
      return {
        saved,
        retiredSHA256: retiredResult(retired, config.releaseId).afterSHA256,
        protectionSHA256: proofDigest({
          retired: nativeSnapshotProof(retired),
          compute: compute.priorReceiptsSHA256,
          wakes: priorWakes.priorSHA256,
          work: assertTraditionalRetirementWorkIdle(work),
        }),
      };
    },
    { readOnly: true }
  );
}

export async function saveWorkerWakeCheckpoint(options) {
  const authority = bindAuthority(options, workerWakeAction);
  const { firestore, config, platform, role, evidenceDigest, operationId, bindingDigest, next } = options;
  const proposed = await firestore.runTransaction(
    async (tx) => {
      const lock = await authority.read(tx);
      const saved = lock.get(workerWakeField);
      const { ref } = await readWakeReceipts(options, tx, saved);
      const attempt = next?.attempt;
      const stages = ['attempted', 'started', 'retry-wait', 'completed'];
      const index = stages.indexOf(next?.stage);
      if (
        index < 0 ||
        index !== (saved ? stages.indexOf(saved.stage) + 1 : 0) ||
        next.plan?.operationId !== operationId ||
        next.plan.bindingDigest !== bindingDigest ||
        next.plan.releaseId !== config.releaseId ||
        next.plan.evidenceDigest !== evidenceDigest ||
        next.plan.role !== role ||
        next.plan.buildId !== platform.workerBuildId ||
        !sha256.test(next.plan.protectionSHA256 ?? '') ||
        attempt?.input?.role !== role ||
        attempt.input.projectId !== config.projectId ||
        attempt.input.buildId !== platform.workerBuildId ||
        attempt.input.nonce !== operationId.replaceAll('-', '') ||
        attempt.workflowId !== `worker-wake-${attempt.input.nonce}` ||
        !Number.isSafeInteger(attempt.attemptedAt) ||
        attempt.attemptedAt > Date.now()
      )
        fail();
      if (
        saved &&
        (!equal(saved.plan, next.plan) ||
          !equal(saved.attempt, attempt) ||
          (saved.run && !equal(saved.run, next.run)) ||
          (saved.retryWait && !equal(saved.retryWait, next.retryWait)))
      )
        fail();
      if (
        index >= 1 &&
        (next.run?.workflowId !== attempt.workflowId ||
          !uuid.test(next.run.runId ?? '') ||
          !equal(next.run.input, attempt.input))
      )
        fail();
      if (
        index >= 2 &&
        (next.retryWait?.workflowId !== next.run.workflowId ||
          next.retryWait.runId !== next.run.runId ||
          next.retryWait.role !== role ||
          !Number.isFinite(next.retryWait.eligibleAt) ||
          !Number.isFinite(next.retryWait.observedAt) ||
          next.retryWait.observedAt >= next.retryWait.eligibleAt)
      )
        fail();
      if (index === 3) {
        if (
          next.proof?.workflowId !== next.run.workflowId ||
          next.proof.runId !== next.run.runId ||
          next.proof.timer?.role !== 'orchestration' ||
          next.proof.retry?.role !== role
        )
          fail();
        tx.create(ref, {
          schemaVersion: 1,
          releaseId: config.releaseId,
          role,
          evidenceDigest,
          buildId: platform.workerBuildId,
          image: platform.workerImage,
          state: next,
        });
      }
      tx.update(authority.lockRef, { [workerWakeField]: next });
      return proofDigest({ ...lock.data(), [workerWakeField]: next });
    },
    { maxAttempts: 1 }
  );
  return assertNativeSnapshotSuccessor(options.ownedOperation, proposed, await authority.lockRef.get());
}

export async function readComputeAttachmentAuthority(options, onSaved) {
  const authority = bindAuthority(options, computeAttachmentAction);
  const { firestore, config } = options;
  return firestore.runTransaction(
    async (tx) => {
      const lock = await authority.read(tx);
      onSaved?.(lock.get(computeAttachmentField));
      const [peers, work, retired] = await Promise.all([
        readComputeReceipts(options, tx, lock),
        readTraditionalRetirementWork(firestore, tx),
        tx.get(firestore.doc(traditionalReceiptPath(config.releaseId))),
      ]);
      return {
        saved: peers.saved,
        attachedRoles: peers.attachedRoles,
        retiredSHA256: retiredResult(retired, config.releaseId).afterSHA256,
        protectionSHA256: proofDigest({
          retired: nativeSnapshotProof(retired),
          prior: peers.priorReceiptsSHA256,
          work: assertTraditionalRetirementWorkIdle(work),
        }),
      };
    },
    { readOnly: true }
  );
}

export async function saveComputeAttachmentCheckpoint(options) {
  const authority = bindAuthority(options, computeAttachmentAction);
  const { firestore, config, operationId, bindingDigest, role, next } = options;
  const proposed = await firestore.runTransaction(
    async (tx) => {
      const lock = await authority.read(tx);
      const { saved, receiptRef } = await readComputeReceipts(options, tx, lock);
      const b = options.platform.roleBindings.find((row) => row.role === role);
      if (
        !b ||
        next?.plan?.operationId !== operationId ||
        next.plan.releaseId !== config.releaseId ||
        next.plan.bindingDigest !== bindingDigest ||
        next.plan.evidenceDigest !== options.evidenceDigest ||
        next.plan.bindingSHA256 !== proofDigest(b) ||
        next.plan.computeSHA256 !== proofDigest(serverlessComputeSettings(b)) ||
        !sha256.test(next.protectionSHA256 ?? '') ||
        !Number.isSafeInteger(next.attemptedAt) ||
        next.attemptedAt > Date.now() ||
        (!saved && next.stage !== 'attempted')
      )
        fail();
      if (saved) {
        const legal = { attempted: ['acknowledged', 'completed'], acknowledged: ['completed'], completed: [] };
        if (
          !legal[saved.stage]?.includes(next.stage) ||
          !equal(saved.plan, next.plan) ||
          next.protectionSHA256 !== saved.protectionSHA256 ||
          next.attemptedAt !== saved.attemptedAt
        )
          fail();
      }
      if (next.stage === 'completed') {
        if (!completeComputeReceipt(next)) fail();
        tx.create(receiptRef, { schemaVersion: 1, role, releaseId: config.releaseId, state: next });
      }
      tx.update(authority.lockRef, { [computeAttachmentField]: next });
      return proofDigest({ ...lock.data(), [computeAttachmentField]: next });
    },
    { maxAttempts: 1 }
  );
  return assertNativeSnapshotSuccessor(options.ownedOperation, proposed, await authority.lockRef.get());
}

/** Verify current paused ownership and idle mutations in one native snapshot. */
export async function readTraditionalRetirementAuthority(options, { onSaved } = {}) {
  const { firestore } = options;
  const authority = bindAuthority(options);
  return firestore.runTransaction(
    async (tx) => {
      const lock = await authority.read(tx);
      const saved = lock.get(traditionalRetirementField);
      onSaved?.(saved);
      const work = await readTraditionalRetirementWork(firestore, tx);
      return { saved, workSHA256: assertTraditionalRetirementWorkIdle(work) };
    },
    { readOnly: true }
  );
}

/** Save progress inside the existing paused release and operation lock.
 * Failed or uncertain Kubernetes updates retain the original attempt. */
export async function saveTraditionalRetirementCheckpoint(options) {
  const { firestore, config, operationId, bindingDigest, next } = options;
  const { releaseId } = config;
  const authority = bindAuthority(options);
  const { lockRef } = authority;
  const receiptRef = firestore.doc(traditionalReceiptPath(releaseId));
  const proposed = await firestore.runTransaction(
    async (tx) => {
      const [lock, receipt] = await Promise.all([authority.read(tx), tx.get(receiptRef)]);
      advance(lock.get(traditionalRetirementField), next, { operationId, bindingDigest, releaseId });
      if (next.stage === 'completed') {
        const immutable = {
          schemaVersion: 1,
          releaseId,
          operationId,
          bindingDigest,
          planSHA256: proofDigest(next.plan),
          result: next.receipt,
        };
        if (!receipt.exists) tx.create(receiptRef, immutable);
        else if (!equal(receipt.data(), immutable) || !receipt.createTime?.isEqual(receipt.updateTime)) fail();
      } else if (receipt.exists) fail();
      tx.update(lockRef, { [traditionalRetirementField]: next });
      return proofDigest({ ...lock.data(), [traditionalRetirementField]: next });
    },
    { maxAttempts: 1 }
  );
  return assertNativeSnapshotSuccessor(options.ownedOperation, proposed, await lockRef.get());
}
