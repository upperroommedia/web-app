import { proofDigest as hash, assertNativeSnapshot } from './temporal-release-runtime.mjs';

const fail = () => {
  throw new Error('MEDIA_RECOVERY_CAPSULE_UNCONFIRMED');
};
const kinds = [
  'Journal',
  'Start',
  'Kernel',
  'Startup',
  'OriginalReady',
  'OriginalSignal',
  'OriginalDeath',
  'Work',
  'ReplacementIntent',
  'ReplacementKernel',
  'ReplacementStartup',
  'ReplacementAdoption',
  'ReplacementCompleted',
  'ReplacementStop',
];
const stamp = (s) => {
  if (!s.exists || !s.createTime || !s.updateTime) fail();
  return {
    path: s.ref.path,
    dataSHA256: hash(s.data()),
    createTime: { seconds: s.createTime.seconds, nanoseconds: s.createTime.nanoseconds },
    updateTime: { seconds: s.updateTime.seconds, nanoseconds: s.updateTime.nanoseconds },
  };
};
/** Completion-transaction provenance only. This is never activation authority,
 * a substitute for historical native/image/artifact reads, or a parent overlay. */
export async function prepareCompletedMediaRecoveryCapsule(o, tx, parent, next, completion, drainRecord) {
  if (
    next.stage !== 'completed' ||
    !next.recovery ||
    next.recoveryFailed ||
    next.neverStarted ||
    !next.drained ||
    !next.stopped
  )
    fail();
  const p = next.plan,
    id = o.operationId;
  if (
    p.operationId !== id ||
    parent.get('action') !== 'diagnose-cloud-run-media-recovery' ||
    parent.get('operationId') !== id ||
    parent.get('bindingDigest') !== o.bindingDigest ||
    parent.get('releaseId') !== o.config.releaseId
  )
    fail();
  const refs = kinds.map((k) => o.firestore.doc(`_control/temporalMediaRecovery${k}-${id}`));
  const snapshots = await Promise.all(refs.map((r) => tx.get(r)));
  const facts = Object.fromEntries(kinds.map((k, i) => [k, snapshots[i]]));
  const journal = facts.Journal.data(),
    ack = facts.Start.data(),
    intent = parent.get('mediaRecoveryWorkflowStart'),
    attempt = parent.get('mediaRecoveryJournalAttempt');
  if (
    snapshots.some((s) => !s.exists) ||
    !intent ||
    intent.stage !== 'attempted' ||
    intent.planSHA256 !== hash(p) ||
    intent.poolSHA256 !== hash(next.start.pool) ||
    ack.stage !== 'confirmed' ||
    ack.operationId !== id ||
    ack.intentSHA256 !== hash(intent) ||
    ack.poolSHA256 !== hash(next.start.pool) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(ack.runId ?? '') ||
    !/^[a-f0-9]{64}$/.test(ack.nativeStartSHA256 ?? '') ||
    attempt?.stage !== 'completed' ||
    attempt.recordSHA256 !== hash(journal) ||
    attempt.attemptedAt !== journal.attemptedAt ||
    next.prepared.proofSHA256 !== hash(journal) ||
    journal.planSHA256 !== hash(p) ||
    hash(journal.authority) !== hash(o.expectedAuthority)
  )
    fail();
  const originalCycle = {
    plan: p,
    stage: 'prepared',
    prepared: next.prepared,
    diagnostic: next.diagnostic,
    start: next.start,
  };
  const expectedIntent = {
    schemaVersion: 1,
    stage: 'attempted',
    operationId: id,
    planSHA256: hash(p),
    cycleSHA256: hash(originalCycle),
    poolSHA256: hash(next.start.pool),
    preparedSHA256: hash(next.prepared),
    workflowId: `media-recovery-${id}`,
    workflowType: 'MediaRecoveryProbe',
    taskQueue: 'urm-media-kernel-recovery',
    inputSHA256: hash({ operationId: id, startNonce: intent.nonce }),
    nonce: intent.nonce,
    deploymentVersion: { deploymentName: 'urm-worker-media-recovery-staging', buildId: p.buildId },
    attemptedAt: intent.attemptedAt,
    expiresAt: p.expiresAt,
  };
  if (
    hash(intent) !== hash(expectedIntent) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(intent.nonce ?? '') ||
    Date.parse(intent.attemptedAt) < Date.parse(p.createdAt) ||
    !Number.isFinite(Date.parse(intent.attemptedAt)) ||
    Date.parse(intent.attemptedAt) >= p.expiresAt ||
    hash(completion.operatorPrincipal) !== hash(parent.get('operatorPrincipal'))
  )
    fail();
  for (const k of ['Kernel', 'ReplacementKernel'])
    if (
      facts[k].get('stage') !== 'closed' ||
      facts[k].get('close.descendantsAbsent') !== true ||
      facts[k].get('close.observerFailed') === true
    )
      fail();
  if (
    facts.Kernel.get('close.signal') !== 'SIGKILL' ||
    facts.ReplacementKernel.get('close.code') !== 0 ||
    facts.ReplacementKernel.get('close.signal') !== null
  )
    fail();
  const operatorIdentity = parent.get('operatorIdentity');
  if (
    !operatorIdentity ||
    Object.keys(operatorIdentity).sort().join(',') !==
      'descriptorSHA256,operatorClosureDigest,operatorCommit,operatorRoot,resourceBinding,runtimeCommit,runtimePins,runtimeRoot'
  )
    fail();
  const projection = {
    action: 'diagnose-cloud-run-media-recovery',
    operationId: id,
    releaseId: o.config.releaseId,
    bindingDigest: o.bindingDigest,
    operatorPrincipal: parent.get('operatorPrincipal'),
    operatorIdentity,
    cloudMediaRecovery: next,
    mediaRecoveryJournalAttempt: attempt,
    mediaRecoveryWorkflowStart: intent,
  };
  const value = {
    schemaVersion: 1,
    kind: 'completed-media-recovery-provenance-only-v1',
    operationId: id,
    releaseId: o.config.releaseId,
    bindingDigest: o.bindingDigest,
    source: {
      buildId: p.buildId,
      image: p.image,
      evidenceDigest: p.evidenceDigest,
      ancestorsSHA256: p.ancestorsSHA256,
    },
    originalParent: projection,
    originalAuthority: o.expectedAuthority,
    completionSHA256: hash(completion),
    drainSHA256: hash(drainRecord),
    restoredPool: next.restore.pool,
    facts: snapshots.map(stamp),
  };
  const record = { ...value, capsuleSHA256: hash(value) },
    ref = o.firestore.doc(`_control/temporalMediaRecoveryCapsule-${id}`),
    existing = await tx.get(ref);
  if (existing.exists && hash(existing.data()) !== hash(record)) fail();
  // Missing capsules cannot be backfilled for an already completed operation.
  if (parent.get('cloudMediaRecovery.stage') === 'completed' && !existing.exists) fail();
  return { ref, record, create: !existing.exists };
}

/** Same-parent completion readback before the controller releases its singleton.
 * A future new-parent activation consumer must independently authorize itself;
 * this interface intentionally cannot be used under that new parent. */
export async function confirmCompletedMediaRecoveryCapsule(o) {
  const began = Date.now(),
    mono = performance.now();
  let timer;
  const fresh = () => {
    if (
      Date.now() - began < 0 ||
      Date.now() - began >= 5000 ||
      performance.now() - mono < 0 ||
      performance.now() - mono >= 5000
    )
      fail();
  };
  try {
    const value = await Promise.race([
      o.firestore.runTransaction(
        async (tx) => {
          fresh();
          if (o.firestore.projectId !== 'urm-app-staging' || o.firestore.databaseId !== '(default)') fail();
          const [parent, c, s, receipt, drain] = await Promise.all(
            [
              o.lockRef,
              o.controlRef,
              o.stateRef,
              o.firestore.doc(`_control/temporalCloudMediaRecovery-${o.operationId}`),
              o.firestore.doc(`_control/temporalMediaRecoveryDrain-${o.operationId}`),
            ].map((r) => tx.get(r))
          );
          assertNativeSnapshot(o.ownedOperation, parent);
          assertNativeSnapshot(o.expectedAuthority.control, c);
          assertNativeSnapshot(o.expectedAuthority.state, s);
          if (
            c.get('admission') !== 'paused' ||
            s.get('phase') !== 'provider-usage-ready' ||
            c.get('releaseId') !== o.config.releaseId ||
            s.get('releaseId') !== o.config.releaseId ||
            ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
              (k) => c.get(`domains.${k}.admission`) !== 'paused'
            ) ||
            !receipt.exists ||
            !drain.exists ||
            hash(receipt.get('identityState')) !== hash(parent.get('cloudMediaRecovery'))
          )
            fail();
          const result = await prepareCompletedMediaRecoveryCapsule(
            o,
            tx,
            parent,
            parent.get('cloudMediaRecovery'),
            receipt.data(),
            drain.data()
          );
          if (result.create) fail();
          fresh();
          return {
            kind: 'completed-media-recovery-capsule-readback-v1',
            operationId: o.operationId,
            capsuleSHA256: result.record.capsuleSHA256,
            scope: 'historical-provenance-only-no-activation-authority',
          };
        },
        { readOnly: true }
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('MEDIA_RECOVERY_CAPSULE_UNCONFIRMED')), 5000);
      }),
    ]);
    fresh();
    return value;
  } catch {
    return fail();
  } finally {
    clearTimeout(timer);
  }
}
