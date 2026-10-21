import { assertNativeSnapshot, nativeSnapshotProof, proofDigest as hash } from './temporal-release-runtime.mjs';
const fail = () => {
  throw new Error('MEDIA_RECOVERY_CHECKPOINT_UNCONFIRMED');
};
const domains = ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'];
export async function assertMediaRecoveryAuthority(o) {
  await o.firestore.runTransaction(
    async (tx) => {
      await authority(o, tx);
    },
    { readOnly: true }
  );
}
async function authority(o, tx) {
  const [parent, control, state] = await Promise.all([o.lockRef, o.controlRef, o.stateRef].map((r) => tx.get(r)));
  assertNativeSnapshot(o.ownedOperation, parent);
  assertNativeSnapshot(o.expectedAuthority.control, control);
  assertNativeSnapshot(o.expectedAuthority.state, state);
  if (
    parent.get('action') !== 'diagnose-cloud-run-media-recovery' ||
    parent.get('operationId') !== o.operationId ||
    parent.get('bindingDigest') !== o.bindingDigest ||
    parent.get('releaseId') !== o.config.releaseId ||
    control.get('releaseId') !== o.config.releaseId ||
    state.get('releaseId') !== o.config.releaseId ||
    control.get('admission') !== 'paused' ||
    state.get('phase') !== 'provider-usage-ready' ||
    domains.some((d) => control.get(`domains.${d}.admission`) !== 'paused')
  )
    fail();
  return parent;
}
export async function saveMediaRecoveryCheckpoint(o) {
  const next = o.identityState;
  if (
    !next ||
    next.plan?.operationId !== o.operationId ||
    next.plan?.releaseId !== o.config.releaseId ||
    next.plan?.bindingDigest !== o.bindingDigest ||
    next.plan?.role !== 'media' ||
    Object.keys(next).some(
      (k) =>
        ![
          'plan',
          'stage',
          'prepared',
          'diagnostic',
          'start',
          'recovery',
          'recoveryFailed',
          'drained',
          'stop',
          'stopped',
          'neverStarted',
          'restore',
          'disposition',
          'scope',
        ].includes(k)
    )
  )
    fail();
  await o.firestore.runTransaction(
    async (tx) => {
      const parent = await authority(o, tx),
        before = parent.get('cloudMediaRecovery');
      const transitions = {
        planned: ['planned', 'prepared'],
        prepared: ['prepared', 'recovered', 'recovery-failed', 'never-started'],
        recovered: ['recovered', 'drained'],
        'recovery-failed': ['recovery-failed', 'drained'],
        drained: ['drained', 'stopped', 'neverStarted'],
        stopped: ['stopped', 'completed'],
        'never-started': ['never-started', 'completed'],
        completed: ['completed'],
      };
      if (
        (!before && next.stage !== 'planned') ||
        (before && (!transitions[before.stage]?.includes(next.stage) || hash(before.plan) !== hash(next.plan)))
      )
        fail();
      for (const key of ['prepared', 'recovery', 'recoveryFailed', 'drained', 'stopped', 'neverStarted'])
        if (before && Object.hasOwn(before, key) && hash(before[key]) !== hash(next[key] ?? null)) fail();
      for (const key of ['diagnostic', 'start', 'stop', 'restore']) {
        const a = before?.[key],
          b = next[key];
        if (!a && b && b.stage !== 'attempted') fail();
        if (b) {
          const preceding = {
            diagnostic: next.prepared,
            start: next.diagnostic?.stage === 'completed',
            stop: next.start?.stage === 'completed' && next.drained,
            restore:
              (next.stop?.stage === 'completed' && next.stopped) ||
              (next.neverStarted && (!next.start || next.start.stage === 'rejected')),
          }[key];
          if (
            !preceding ||
            b.plan?.key !== key ||
            b.plan?.operationId !== o.operationId ||
            b.request?.method !== 'PATCH'
          )
            fail();
        }
        if (a) {
          if (
            !(
              {
                attempted: ['attempted', 'acknowledged', 'rejected'],
                acknowledged: ['acknowledged', 'completed'],
                completed: ['completed'],
                rejected: ['rejected'],
              }[a.stage] ?? []
            ).includes(b?.stage)
          )
            fail();
          for (const k of ['plan', 'request', 'protection', 'quota', 'attemptedAt'])
            if (hash(a[k] ?? null) !== hash(b[k] ?? null)) fail();
          if (
            (a.nativeOperation && a.nativeOperation !== b.nativeOperation) ||
            (['completed', 'rejected'].includes(a.stage) && hash(a) !== hash(b))
          )
            fail();
        }
      }
      const receipt = next.stage === 'completed' ? await tx.get(o.immutableReceipt) : undefined;
      const neverStarted =
        next.neverStarted &&
        !next.recovery &&
        !next.recoveryFailed &&
        !next.drained &&
        !next.stop &&
        !next.stopped &&
        (!next.start || next.start.stage === 'rejected');
      if (next.neverStarted && !neverStarted) fail();
      if (
        next.stage === 'completed' &&
        (!next.prepared ||
          next.diagnostic?.stage !== 'completed' ||
          next.restore?.stage !== 'completed' ||
          next.disposition !== 'restored-normal-zero' ||
          (!neverStarted &&
            (!next.drained ||
              !next.stopped ||
              Boolean(next.recovery) === Boolean(next.recoveryFailed) ||
              ['start', 'stop'].some((k) => next[k]?.stage !== 'completed'))))
      )
        fail();
      if (before?.stage === 'completed' && hash(before) !== hash(next)) fail();
      const record = {
        operationId: o.operationId,
        releaseId: o.config.releaseId,
        bindingDigest: o.bindingDigest,
        identityState: next,
        operatorPrincipal: o.operatorPrincipal,
      };
      if (receipt?.exists && hash(receipt.data()) !== hash(record)) fail();
      tx.update(o.lockRef, { cloudMediaRecovery: next });
      if (receipt && !receipt.exists) tx.create(o.immutableReceipt, record);
    },
    { maxAttempts: 1 }
  );
  return nativeSnapshotProof(await o.lockRef.get());
}
