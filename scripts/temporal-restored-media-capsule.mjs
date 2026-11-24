import { proofDigest as hash, assertNativeSnapshot } from './temporal-release-runtime.mjs';
import { assertRestoredActivationState } from './temporal-media-restored-activation.mjs';
import { assertRestoredMediaBootChronology, restoredMediaBootV2 } from './temporal-restored-media-boot-policy.mjs';
const fail = () => {
  throw new Error('RESTORED_MEDIA_PROVENANCE_CAPSULE_UNCONFIRMED');
};
const prefixes = Object.freeze({
  runner: 'temporalCloudIdentityPreparation',
  scaler: 'temporalCloudIdentityPreparation',
  pool: 'temporalCloudPoolPreparation',
  runnerScaler: 'temporalCloudScalerAccessPreparation',
  scalerTrust: 'temporalCloudScalerAccessPreparation',
  poolAccess: 'temporalCloudScalerAccessPreparation',
  firestore: 'temporalCloudFirestoreAccessPreparation',
  projectRole: 'temporalCloudRuntimeRolePreparation',
  projectAccess: 'temporalCloudRuntimeAccessPreparation',
  storageRole: 'temporalCloudRuntimeRolePreparation',
  storageAccess: 'temporalCloudRuntimeAccessPreparation',
  bootstrapCycle: 'temporalCloudMediaBootstrapCycle',
  recovery: 'temporalCloudMediaRecovery',
});
export const mediaPromotionReceiptPrefixes = Object.freeze({
  ...prefixes,
  restoredActivation: 'temporalCloudRestoredMediaActivation',
  imagesPromotion: 'temporalCloudImagesPromotion',
});
const stamp = (s) => {
  if (!s.exists || !s.createTime || !s.updateTime) fail();
  return {
    path: s.ref.path,
    dataSHA256: hash(s.data()),
    createTime: { seconds: s.createTime.seconds, nanoseconds: s.createTime.nanoseconds },
    updateTime: { seconds: s.updateTime.seconds, nanoseconds: s.updateTime.nanoseconds },
  };
};
const immutable = (s) => {
  const value = stamp(s);
  if (hash(value.createTime) !== hash(value.updateTime)) fail();
  return value;
};
const authority = (c, s, releaseId) => {
  if (
    c.get('admission') !== 'paused' ||
    c.get('releaseId') !== releaseId ||
    s.get('releaseId') !== releaseId ||
    s.get('phase') !== 'provider-usage-ready' ||
    ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
      (d) => c.get(`domains.${d}.admission`) !== 'paused'
    )
  )
    fail();
  return { control: { data: c.data(), stamp: stamp(c) }, state: { data: s.data(), stamp: stamp(s) } };
};
/** Atomic producer provenance only. No capsule can replace native history,
 * image-byte replay, current pollers/resources or Cloud Run instance proof. */
export async function prepareRestoredMediaActivationCapsule(o, tx, parent, control, state, record) {
  const began = Date.now(),
    mono = performance.now();
  const fresh = () => {
    if (
      Date.now() < began ||
      Date.now() - began >= 5000 ||
      performance.now() < mono ||
      performance.now() - mono >= 5000 ||
      Math.abs(Date.now() - Date.parse(record.identityState.registration?.observedAt)) >= 5000
    )
      fail();
  };
  const next = record.identityState,
    p = next.plan;
  assertRestoredActivationState(next);
  if (
    next.stage !== 'completed' ||
    next.disposition !== 'retained' ||
    parent.get('action') !== 'activate-restored-cloud-run-media' ||
    parent.get('operationId') !== p.operationId ||
    record.bindingDigest !== p.bindingDigest ||
    hash(record.operatorPrincipal) !== hash(parent.get('operatorPrincipal'))
  )
    fail();
  const operatorIdentity = parent.get('operatorIdentity');
  if (
    !operatorIdentity ||
    Object.keys(operatorIdentity).sort().join(',') !==
      'descriptorSHA256,operatorClosureDigest,operatorCommit,operatorRoot,resourceBinding,runtimeCommit,runtimePins,runtimeRoot'
  )
    fail();
  const refs = [
    ...Object.entries(prefixes).map(([key, prefix]) => o.firestore.doc(`_control/${prefix}-${p.receiptIds[key]}`)),
    o.firestore.doc(`_control/temporalRestoredMediaKernel-${p.operationId}`),
    o.firestore.doc(`temporalRestoredMediaStartupCapacity/${p.operationId}`),
  ];
  const all = await Promise.all(refs.map((ref) => tx.get(ref))),
    receipts = Object.fromEntries(Object.keys(prefixes).map((key, i) => [key, all[i].data()]));
  if (all.some((s) => !s.exists) || hash(receipts) !== p.receiptsSHA256) fail();
  const facts = all.slice(0, 13).map(immutable),
    kernel = all[13],
    startup = all[14],
    k = kernel.data(),
    s = startup.data();
  const start = next.start;
  const v2 = p.startup?.protocol === restoredMediaBootV2.protocol;
  const intentSHA256 = hash({
    kind: v2 ? 'restored-normal-media-startup-v2' : 'restored-normal-media-startup-v1',
    operationId: p.operationId,
    recoveryOperationId: p.recoveryOperationId,
    releaseId: p.releaseId,
    bindingDigest: p.bindingDigest,
    plan: p,
    start: {
      before: start.before,
      request: start.request,
      attemptedAt: start.attemptedAt,
      phaseSHA256: start.phaseSHA256,
      computeSHA256: start.computeSHA256,
      quota: start.quota,
    },
  });
  const birth = { context: k.context, intent: k.intent, birth: k.birth, worker: k.worker };
  const { digest, ...preimage } = s;
  if (
    k.context?.intentSHA256 !== intentSHA256 ||
    k.stage !== 'running' ||
    k.schemaVersion !== 1 ||
    k.context?.protocol !== (v2 ? restoredMediaBootV2.protocol : 'restored-normal-media-kernel-v1') ||
    k.context.operationId !== p.operationId ||
    k.context.recoveryOperationId !== p.recoveryOperationId ||
    k.context.capsuleSHA256 !== p.origin.capsuleSHA256 ||
    !k.context.actorUid ||
    s.kind !== (v2 ? 'restored-normal-media-startup-capacity-v2' : 'restored-normal-media-startup-capacity-v1') ||
    s.schemaVersion !== 1 ||
    s.operationId !== p.operationId ||
    s.recoveryOperationId !== p.recoveryOperationId ||
    s.intentSHA256 !== k.context.intentSHA256 ||
    s.capsuleSHA256 !== p.origin.capsuleSHA256 ||
    s.kernel?.operationId !== p.operationId ||
    s.kernel.birthDigest !== hash(birth) ||
    hash(s.worker) !== hash(k.worker) ||
    digest !== hash(preimage)
  )
    fail();
  if (v2)
    assertRestoredMediaBootChronology(start.attemptedAt, kernel.createTime, [
      k.birth.spawnedAt,
      kernel.updateTime,
      s.capacity?.observedAt,
      s.observedAt,
      startup.createTime,
    ]);
  const originalAuthority = authority(control, state, p.releaseId);
  if (
    k.context.controlVersion !==
      hash({
        createTime: originalAuthority.control.stamp.createTime,
        updateTime: originalAuthority.control.stamp.updateTime,
      }) ||
    k.context.stateVersion !==
      hash({
        createTime: originalAuthority.state.stamp.createTime,
        updateTime: originalAuthority.state.stamp.updateTime,
      })
  )
    fail();
  const value = {
    schemaVersion: 1,
    kind: 'retained-restored-media-provenance-only-v1',
    operationId: p.operationId,
    releaseId: p.releaseId,
    bindingDigest: p.bindingDigest,
    source: {
      buildId: p.buildId,
      image: p.image,
      evidenceDigest: p.evidenceDigest,
      receiptIds: p.receiptIds,
      receiptsSHA256: p.receiptsSHA256,
    },
    originalParent: {
      action: 'activate-restored-cloud-run-media',
      operationId: p.operationId,
      releaseId: p.releaseId,
      bindingDigest: p.bindingDigest,
      operatorPrincipal: parent.get('operatorPrincipal'),
      operatorIdentity,
      cloudRestoredMediaActivation: next,
    },
    rootCreationTime: stamp(parent).createTime,
    originalAuthority,
    activationReceiptSHA256: hash(record),
    recoveryCapsuleSHA256: p.origin.capsuleSHA256,
    pool: next.start.pool,
    registrationSHA256: hash(next.registration),
    facts: [...facts, stamp(kernel), immutable(startup)],
    kernel: k,
    startup: s,
  };
  const capsule = { ...value, capsuleSHA256: hash(value) },
    ref = o.firestore.doc(`_control/temporalRestoredMediaActivationCapsule-${p.operationId}`),
    existing = await tx.get(ref);
  if (existing.exists && hash(existing.data()) !== hash(capsule)) fail();
  if (parent.get('cloudRestoredMediaActivation.stage') === 'completed' && !existing.exists) fail();
  if (!existing.exists) fresh();
  return {
    ref,
    record: capsule,
    create: !existing.exists,
    checkFresh: () => {
      if (!existing.exists) fresh();
    },
  };
}
/** Fixed NEW promotion-parent input reader. The original parent is never used
 * as current authority; no reader flag, reconstruction or missing-capsule backfill. */
export async function readRestoredMediaPromotionInput(o) {
  const at = Date.now(),
    mono = performance.now();
  let timer;
  const fresh = () => {
    if (Date.now() < at || Date.now() - at >= 5000 || performance.now() < mono || performance.now() - mono >= 5000)
      fail();
  };
  const work = async () =>
    o.firestore.runTransaction(
      async (tx) => {
        fresh();
        const get = async (ref) => {
          fresh();
          const v = await tx.get(ref);
          fresh();
          return v;
        };
        const [root, c, s] = await Promise.all([o.lockRef, o.controlRef, o.stateRef].map((ref) => get(ref)));
        assertNativeSnapshot(o.ownedOperation, root);
        assertNativeSnapshot(o.expectedAuthority.control, c);
        assertNativeSnapshot(o.expectedAuthority.state, s);
        if (
          o.role !== 'media' ||
          root.get('action') !== 'promote-cloud-run-media' ||
          root.get('operationId') !== o.operationId ||
          root.get('bindingDigest') !== o.bindingDigest ||
          root.get('releaseId') !== o.releaseId ||
          root.get('operatorPrincipal.adcAndGcloudAccountMatch') !== true ||
          Object.keys(o.receipts).sort().join(',') !== Object.keys(mediaPromotionReceiptPrefixes).sort().join(',')
        )
          fail();
        authority(c, s, o.releaseId);
        const id = o.receipts.restoredActivation?.operationId;
        if (
          !id ||
          id === o.operationId ||
          new Set(Object.values(o.receipts).map((r) => r.operationId)).size !== 15 ||
          Object.values(o.receipts).some((r) => r.operationId === o.operationId)
        )
          fail();
        const cap = await get(o.firestore.doc(`_control/temporalRestoredMediaActivationCapsule-${id}`));
        if (!cap.exists) fail();
        const v = cap.data(),
          { capsuleSHA256, ...value } = v;
        immutable(cap);
        const snaps = await Promise.all(
          Object.entries(mediaPromotionReceiptPrefixes).map(([key, prefix]) =>
            get(o.firestore.doc(`_control/${prefix}-${o.receipts[key].operationId}`))
          )
        );
        for (let i = 0; i < snaps.length; i++) {
          immutable(snaps[i]);
          if (hash(snaps[i].data()) !== hash(o.receipts[Object.keys(mediaPromotionReceiptPrefixes)[i]])) fail();
        }
        const activation = snaps[13],
          next = activation.get('identityState'),
          p = next?.plan;
        assertRestoredActivationState(next);
        if (
          capsuleSHA256 !== hash(value) ||
          v.schemaVersion !== 1 ||
          v.kind !== 'retained-restored-media-provenance-only-v1' ||
          v.operationId !== id ||
          v.bindingDigest !== activation.get('bindingDigest') ||
          v.releaseId !== o.releaseId ||
          v.activationReceiptSHA256 !== hash(activation.data()) ||
          hash(cap.createTime) !== hash(activation.createTime) ||
          next.stage !== 'completed' ||
          next.disposition !== 'retained' ||
          p.image !== o.platform.workerImage ||
          p.buildId !== o.platform.workerBuildId ||
          p.evidenceDigest !== o.evidenceDigest ||
          hash(v.originalParent.cloudRestoredMediaActivation) !== hash(next) ||
          v.registrationSHA256 !== hash(next.registration) ||
          hash(v.pool) !== hash(next.start.pool) ||
          v.recoveryCapsuleSHA256 !== p.origin.capsuleSHA256 ||
          hash(v.source) !==
            hash({
              buildId: p.buildId,
              image: p.image,
              evidenceDigest: p.evidenceDigest,
              receiptIds: p.receiptIds,
              receiptsSHA256: p.receiptsSHA256,
            })
        )
          fail();
        const committed = cap.createTime.toMillis(),
          registered = Date.parse(next.registration.observedAt);
        if (!Number.isFinite(registered) || Math.abs(committed - registered) >= 5000) fail();
        const old = v.originalParent,
          a = v.originalAuthority;
        if (
          old?.action !== 'activate-restored-cloud-run-media' ||
          old.operationId !== id ||
          old.releaseId !== p.releaseId ||
          old.bindingDigest !== p.bindingDigest ||
          hash(old.operatorPrincipal) !== hash(activation.get('operatorPrincipal')) ||
          old.operatorPrincipal?.adcAndGcloudAccountMatch !== true ||
          !old.operatorIdentity ||
          Object.keys(old.operatorIdentity).sort().join(',') !==
            'descriptorSHA256,operatorClosureDigest,operatorCommit,operatorRoot,resourceBinding,runtimeCommit,runtimePins,runtimeRoot'
        )
          fail();
        for (const key of ['control', 'state'])
          if (
            !a?.[key]?.data ||
            a[key].stamp?.path !== (key === 'control' ? o.controlRef.path : o.stateRef.path) ||
            a[key].stamp.dataSHA256 !== hash(a[key].data)
          )
            fail();
        if (
          a.control.data.releaseId !== p.releaseId ||
          a.state.data.releaseId !== p.releaseId ||
          a.control.data.admission !== 'paused' ||
          a.state.data.phase !== 'provider-usage-ready' ||
          ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
            (d) => a.control.data.domains?.[d]?.admission !== 'paused'
          )
        )
          fail();
        if (
          v.kernel?.context?.controlVersion !==
            hash({ createTime: a.control.stamp.createTime, updateTime: a.control.stamp.updateTime }) ||
          v.kernel?.context?.stateVersion !==
            hash({ createTime: a.state.stamp.createTime, updateTime: a.state.stamp.updateTime })
        )
          fail();
        const originalReceipts = Object.fromEntries(Object.keys(prefixes).map((key) => [key, o.receipts[key]]));
        if (
          hash(originalReceipts) !== p.receiptsSHA256 ||
          Object.keys(prefixes).some((key) => p.receiptIds[key] !== o.receipts[key].operationId) ||
          !Array.isArray(v.facts) ||
          v.facts.length !== 15
        )
          fail();
        const expectedPaths = [
          ...Object.entries(prefixes).map(([key, prefix]) => `_control/${prefix}-${p.receiptIds[key]}`),
          `_control/temporalRestoredMediaKernel-${id}`,
          `temporalRestoredMediaStartupCapacity/${id}`,
        ];
        if (hash(v.facts.map((f) => f.path)) !== hash(expectedPaths)) fail();
        const originalCap = await get(
          o.firestore.doc(`_control/temporalMediaRecoveryCapsule-${p.recoveryOperationId}`)
        );
        immutable(originalCap);
        if (
          originalCap.get('capsuleSHA256') !== v.recoveryCapsuleSHA256 ||
          hash((({ capsuleSHA256, ...preimage }) => preimage)(originalCap.data())) !== v.recoveryCapsuleSHA256 ||
          originalCap.get('completionSHA256') !== hash(o.receipts.recovery) ||
          hash(originalCap.createTime) !== hash(snaps[12].createTime)
        )
          fail();
        const facts = await Promise.all(v.facts.map((f) => get(o.firestore.doc(f.path))));
        if (
          hash(facts.map(stamp)) !== hash(v.facts) ||
          facts[13].get('stage') !== 'running' ||
          hash(facts[13].data()) !== hash(v.kernel) ||
          hash(facts[14].data()) !== hash(v.startup)
        )
          fail();
        fresh();
        return {
          kind: 'restored-media-promotion-input-v1',
          operationId: o.operationId,
          activationOperationId: id,
          recoveryOperationId: p.recoveryOperationId,
          activationBindingDigest: p.bindingDigest,
          capsuleSHA256,
          activationReceiptSHA256: v.activationReceiptSHA256,
          nativeFactsSHA256: hash(v.facts),
          pool: v.pool,
          observedAt: new Date(at).toISOString(),
          scope: 'sealed-input-only-no-promotion-or-readiness-authority',
        };
      },
      { readOnly: true }
    );
  try {
    const result = await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('RESTORED_MEDIA_PROVENANCE_CAPSULE_UNCONFIRMED')), 5000);
      }),
    ]);
    fresh();
    return result;
  } catch {
    return fail();
  } finally {
    clearTimeout(timer);
  }
}

/** SAME-parent readback before releasing the singleton. Historical input
 * consumers must use their separately authorized promotion-parent reader. */
export async function confirmRestoredMediaActivationCapsule(o) {
  const at = Date.now(),
    mono = performance.now();
  let timer;
  const fresh = () => {
    if (Date.now() < at || Date.now() - at >= 5000 || performance.now() < mono || performance.now() - mono >= 5000)
      fail();
  };
  const run = () =>
    o.firestore.runTransaction(
      async (tx) => {
        const get = async (ref) => {
          fresh();
          const value = await tx.get(ref);
          fresh();
          return value;
        };
        const [root, c, s, receipt, cap] = await Promise.all(
          [
            o.lockRef,
            o.controlRef,
            o.stateRef,
            o.firestore.doc(`_control/temporalCloudRestoredMediaActivation-${o.operationId}`),
            o.firestore.doc(`_control/temporalRestoredMediaActivationCapsule-${o.operationId}`),
          ].map(get)
        );
        assertNativeSnapshot(o.ownedOperation, root);
        assertNativeSnapshot(o.expectedAuthority.control, c);
        assertNativeSnapshot(o.expectedAuthority.state, s);
        if (
          root.get('action') !== 'activate-restored-cloud-run-media' ||
          root.get('operationId') !== o.operationId ||
          root.get('bindingDigest') !== o.bindingDigest ||
          root.get('releaseId') !== o.config.releaseId
        )
          fail();
        authority(c, s, o.config.releaseId);
        immutable(receipt);
        immutable(cap);
        const v = cap.data(),
          { capsuleSHA256, ...value } = v,
          next = receipt.get('identityState');
        assertRestoredActivationState(next);
        if (
          next.stage !== 'completed' ||
          next.disposition !== 'retained' ||
          capsuleSHA256 !== hash(value) ||
          v.kind !== 'retained-restored-media-provenance-only-v1' ||
          v.operationId !== o.operationId ||
          v.bindingDigest !== o.bindingDigest ||
          v.activationReceiptSHA256 !== hash(receipt.data()) ||
          hash(cap.createTime) !== hash(receipt.createTime) ||
          hash(root.get('cloudRestoredMediaActivation')) !== hash(next) ||
          hash(v.originalParent.cloudRestoredMediaActivation) !== hash(next) ||
          Math.abs(cap.createTime.toMillis() - Date.parse(next.registration.observedAt)) >= 5000
        )
          fail();
        const facts = await Promise.all(v.facts.map((f) => get(o.firestore.doc(f.path))));
        if (hash(facts.map(stamp)) !== hash(v.facts)) fail();
        fresh();
        return {
          operationId: o.operationId,
          capsuleSHA256,
          receiptSHA256: v.activationReceiptSHA256,
          scope: 'same-parent-sealed-retention-readback-only',
        };
      },
      { readOnly: true }
    );
  try {
    const value = await Promise.race([
      Promise.resolve().then(run),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('RESTORED_MEDIA_PROVENANCE_CAPSULE_UNCONFIRMED')), 5000);
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
