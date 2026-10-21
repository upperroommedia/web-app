import { isDeepStrictEqual as equal } from 'node:util';
import { proofDigest as hash, assertNativeSnapshot, nativeSnapshotProof } from './temporal-release-runtime.mjs';
import { readMediaRecoveryAncestorAccess } from './temporal-bootstrap-pool.mjs';
import { diagnosticTemplate } from './temporal-media-recovery-cycle.mjs';
import { verifyPreparedPoolMetadata } from './temporal-prepare-cloud-pool.mjs';
import { assertStoredMediaDiagnosticDrain } from './temporal-media-diagnostic-drain.mjs';
const fail = () => {
  throw new Error('RESTORED_MEDIA_ORIGIN_UNCONFIRMED');
};
const normal = (x) =>
  typeof x === 'string' ? x.replace('projects/251680231116/', 'projects/urm-app-staging/') : fail();
const opName = (x) =>
  typeof x === 'string' &&
  /^projects\/(urm-app-staging|251680231116)\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/.test(x)
    ? normal(x)
    : fail();
/** A NEW lineage type. It cannot replace an old zero-pool receipt or enable the
 * ordinary activation/promotion helpers. A future fixed action must explicitly
 * consume this additional immutable recovery certificate. */
async function readOrigin(o) {
  const db = o.firestore,
    deadline = Date.now() + 30000;
  let live = true;
  const read = async (fn) => {
    if (!live || Date.now() >= deadline) fail();
    let timer;
    try {
      const v = await Promise.race([
        Promise.resolve().then(() => {
          if (!live) fail();
          return fn();
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('RESTORED_MEDIA_ORIGIN_UNCONFIRMED')),
            Math.min(5000, Math.max(1, deadline - Date.now()))
          );
        }),
      ]);
      if (Date.now() >= deadline) fail();
      return v;
    } catch {
      live = false;
      return fail();
    } finally {
      clearTimeout(timer);
    }
  };
  if (db.projectId !== 'urm-app-staging' || db.databaseId !== '(default)' || o.role !== 'media') fail();
  const ancestor = await read(() => readMediaRecoveryAncestorAccess({ ...o, saved: undefined }));
  const receiptRef = db.doc(`_control/temporalCloudMediaRecovery-${o.operationId}`),
    drainRef = db.doc(`_control/temporalMediaRecoveryDrain-${o.operationId}`);
  const authority = () =>
    read(() =>
      db.runTransaction(
        async (tx) => {
          if (!live || Date.now() >= deadline) fail();
          const [parent, control, state, receipt, drain] = await Promise.all(
            [o.lockRef, o.controlRef, o.stateRef, receiptRef, drainRef].map((r) => tx.get(r))
          );
          assertNativeSnapshot(o.ownedOperation, parent);
          assertNativeSnapshot(o.expectedAuthority.control, control);
          assertNativeSnapshot(o.expectedAuthority.state, state);
          const data = receipt.data(),
            s = data?.identityState,
            p = s?.plan;
          if (
            !receipt.exists ||
            !drain.exists ||
            !equal(parent.get('cloudMediaRecovery'), s) ||
            parent.get('action') !== 'diagnose-cloud-run-media-recovery' ||
            parent.get('operationId') !== o.operationId ||
            parent.get('bindingDigest') !== o.bindingDigest ||
            parent.get('releaseId') !== o.releaseId ||
            !data ||
            Object.keys(data).sort().join(',') !==
              'bindingDigest,identityState,operationId,operatorPrincipal,releaseId' ||
            data.operationId !== o.operationId ||
            data.releaseId !== o.releaseId ||
            data.bindingDigest !== o.bindingDigest ||
            !equal(data.operatorPrincipal, parent.get('operatorPrincipal')) ||
            s.stage !== 'completed' ||
            s.disposition !== 'restored-normal-zero' ||
            s.recoveryFailed ||
            s.neverStarted ||
            !s.recovery ||
            !s.drained ||
            !s.stopped ||
            p?.operationId !== o.operationId ||
            p.releaseId !== o.releaseId ||
            p.bindingDigest !== o.bindingDigest ||
            p.ancestorsSHA256 !== ancestor.receiptsSHA256 ||
            p.evidenceDigest !== o.evidenceDigest ||
            p.role !== 'media' ||
            p.schemaVersion !== 1 ||
            p.expiresAt !== Date.parse(p.createdAt) + 300000 ||
            !Number.isFinite(p.expiresAt) ||
            hash(p.contract) !==
              hash({
                deploymentName: 'urm-worker-media-recovery-staging',
                queue: 'urm-media-kernel-recovery',
                workflowType: 'MediaRecoveryProbe',
                protocol: 'owned-media-recovery-v1',
              }) ||
            p.buildId !== ancestor.binding.buildId ||
            p.image !== ancestor.binding.image ||
            p.runner !== ancestor.binding.runnerServiceAccount ||
            p.name !== ancestor.zeroPlan.body.name ||
            !equal(p.normalTemplate, ancestor.zeroPlan.body.template) ||
            !equal(p.diagnosticTemplate, diagnosticTemplate(p.normalTemplate, o.operationId)) ||
            !equal((({ revisionUid, ...x }) => x)(p.origin), ancestor.origin) ||
            !p.origin.revisionUid ||
            control.get('admission') !== 'paused' ||
            control.get('releaseId') !== o.releaseId ||
            state.get('releaseId') !== o.releaseId ||
            state.get('phase') !== 'provider-usage-ready' ||
            ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
              (k) => control.get(`domains.${k}.admission`) !== 'paused'
            )
          )
            fail();
          const proof = (v, kind) => {
            if (
              !v ||
              Object.keys(v).sort().join(',') !==
                (kind === 'drained'
                  ? 'bindingDigest,buildId,image,kind,observation,operationId,proofSHA256'
                  : 'bindingDigest,buildId,image,kind,operationId,proofSHA256') ||
              v.kind !== kind ||
              v.operationId !== o.operationId ||
              v.bindingDigest !== o.bindingDigest ||
              v.buildId !== p.buildId ||
              v.image !== p.image ||
              !/^[a-f0-9]{64}$/.test(v.proofSHA256 ?? '')
            )
              fail();
          };
          for (const k of ['prepared', 'recovery', 'drained', 'stopped']) proof(s[k], k);
          if (s.drained.proofSHA256 !== hash(s.drained.observation)) fail();
          assertStoredMediaDiagnosticDrain(s.drained.observation, p, s.start?.pool);
          const expectedDrain = {
            schemaVersion: 1,
            operationId: o.operationId,
            releaseId: o.releaseId,
            bindingDigest: o.bindingDigest,
            planSHA256: hash(p),
            proof: s.drained,
          };
          if (!equal(drain.data(), expectedDrain)) fail();
          return {
            state: s,
            receiptSHA256: hash(data),
            drainSHA256: hash(expectedDrain),
            nativeSHA256: hash([
              parent.createTime,
              parent.updateTime,
              receipt.createTime,
              receipt.updateTime,
              drain.createTime,
              drain.updateTime,
            ]),
          };
        },
        { readOnly: true }
      )
    );
  const before = await authority(),
    s = before.state,
    p = s.plan;
  const { pool } = await readRestoredNativeLineage(o, ancestor, s, read);
  const access = await read(() => readMediaRecoveryAncestorAccess({ ...o, saved: undefined }));
  if (access.receiptsSHA256 !== ancestor.receiptsSHA256) fail();
  const sampledAt = Date.now(),
    sampledMonotonic = performance.now();
  const latest = await read(() => o.api(`https://run.googleapis.com/v2/${p.name}`));
  const latestPool = { ...verifyPreparedPoolMetadata(ancestor.zeroPlan, latest), etag: latest.etag };
  if (!equal(latestPool, pool)) fail();
  const latestRevision = await read(() => o.api(`https://run.googleapis.com/v2/${s.restore.pool.revision}`));
  if (
    normal(latestRevision?.name) !== s.restore.pool.revision ||
    latestRevision.uid !== s.restore.pool.revisionUid ||
    latestRevision.deleteTime
  )
    fail();
  if (
    hash(await authority()) !== hash(before) ||
    Date.now() - sampledAt > 5000 ||
    performance.now() - sampledMonotonic > 5000
  )
    fail();
  const observedAt = new Date(sampledAt).toISOString();
  const value = {
    schemaVersion: 1,
    kind: 'restored-media-normal-origin-v1',
    operationId: o.operationId,
    releaseId: o.releaseId,
    bindingDigest: o.bindingDigest,
    buildId: p.buildId,
    image: p.image,
    runner: p.runner,
    ancestorsSHA256: p.ancestorsSHA256,
    cycleSHA256: before.receiptSHA256,
    drainSHA256: before.drainSHA256,
    normalTemplateSHA256: hash(p.normalTemplate),
    pool: s.restore.pool,
    observedAt,
  };
  return { ...value, originSHA256: hash(value) };
}
export async function readRestoredMediaRecoveryOrigin(o) {
  try {
    return await readOrigin(o);
  } catch {
    return fail();
  }
}

/** Fixed NEW-parent read-side authorization. This cannot authorize a scale
 * request; later activation needs its own immutable intent and final fence. */
export async function assertRestoredMediaActivationAuthority(o) {
  return o.firestore.runTransaction(
    async (tx) => {
      const [root, c, s] = await Promise.all([o.lockRef, o.controlRef, o.stateRef].map((r) => tx.get(r)));
      assertNativeSnapshot(o.ownedOperation, root);
      assertNativeSnapshot(o.expectedAuthority.control, c);
      assertNativeSnapshot(o.expectedAuthority.state, s);
      if (
        o.firestore.projectId !== 'urm-app-staging' ||
        o.firestore.databaseId !== '(default)' ||
        o.role !== 'media' ||
        o.operationId === o.recoveryOperationId ||
        root.get('action') !== 'activate-restored-cloud-run-media' ||
        root.get('operationId') !== o.operationId ||
        root.get('bindingDigest') !== o.bindingDigest ||
        root.get('releaseId') !== o.releaseId ||
        root.get('operatorPrincipal.adcAndGcloudAccountMatch') !== true ||
        c.get('releaseId') !== o.releaseId ||
        s.get('releaseId') !== o.releaseId ||
        c.get('admission') !== 'paused' ||
        s.get('phase') !== 'provider-usage-ready' ||
        ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
          (k) => c.get(`domains.${k}.admission`) !== 'paused'
        )
      )
        fail();
      return root.data();
    },
    { readOnly: true }
  );
}

/** Native resource/receipt half only. The canonical entrypoint additionally
 * requires actual original history/artifacts and exact-image replay. */
export async function readRestoredMediaActivationAccess(o) {
  const began = Date.now(),
    mono = performance.now();
  let active = true;
  const fresh = () => {
    if (!active || Date.now() < began || Date.now() - began >= 30000 || performance.now() - mono >= 30000) fail();
  };
  const read = async (fn) => {
    let timer;
    try {
      fresh();
      const value = await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('RESTORED_MEDIA_ORIGIN_UNCONFIRMED')),
            Math.min(5000, Math.max(1, 30000 - (Date.now() - began)))
          );
        }),
      ]);
      fresh();
      return value;
    } catch {
      active = false;
      return fail();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(o.recoveryOperationId ?? '')) fail();
    const root = await read(() => assertRestoredMediaActivationAuthority(o));
    const receiptRef = o.firestore.doc(`_control/temporalCloudMediaRecovery-${o.recoveryOperationId}`),
      capRef = o.firestore.doc(`_control/temporalMediaRecoveryCapsule-${o.recoveryOperationId}`),
      drainRef = o.firestore.doc(`_control/temporalMediaRecoveryDrain-${o.recoveryOperationId}`);
    const snapshots = () =>
      read(() =>
        o.firestore.runTransaction(
          async (tx) => {
            const all = await Promise.all([receiptRef, capRef, drainRef].map((r) => tx.get(r)));
            if (
              all.some((s) => !s.exists || hash(s.createTime) !== hash(s.updateTime)) ||
              hash(all[0].createTime) !== hash(all[1].createTime)
            )
              fail();
            return {
              receipt: all[0].data(),
              capsule: all[1].data(),
              drain: all[2].data(),
              stamps: all.map(nativeSnapshotProof),
            };
          },
          { readOnly: true }
        )
      );
    const first = await snapshots(),
      v = first.capsule,
      { capsuleSHA256, ...preimage } = v,
      s = first.receipt.identityState,
      p = s?.plan;
    if (
      v.schemaVersion !== 1 ||
      v.kind !== 'completed-media-recovery-provenance-only-v1' ||
      hash(preimage) !== capsuleSHA256 ||
      v.operationId !== o.recoveryOperationId ||
      v.releaseId !== o.releaseId ||
      first.receipt.operationId !== o.recoveryOperationId ||
      first.receipt.releaseId !== o.releaseId ||
      v.bindingDigest !== first.receipt.bindingDigest ||
      p?.bindingDigest !== v.bindingDigest ||
      p.operationId !== o.recoveryOperationId ||
      p.releaseId !== o.releaseId ||
      p.evidenceDigest !== o.evidenceDigest ||
      p.buildId !== o.platform.workerBuildId ||
      p.image !== o.platform.workerImage ||
      hash(v.originalParent?.cloudMediaRecovery) !== hash(s) ||
      hash(first.receipt) !== v.completionSHA256 ||
      hash(first.drain) !== v.drainSHA256 ||
      s.stage !== 'completed' ||
      s.disposition !== 'restored-normal-zero' ||
      !s.recovery ||
      s.recoveryFailed ||
      s.neverStarted ||
      !s.drained ||
      !s.stopped ||
      hash(s.restore?.pool) !== hash(v.restoredPool)
    )
      fail();
    for (const key of [
      'descriptorSHA256',
      'operatorCommit',
      'runtimeCommit',
      'operatorClosureDigest',
      'runtimePins',
      'resourceBinding',
    ])
      if (
        !v.originalParent.operatorIdentity ||
        hash(v.originalParent.operatorIdentity[key]) !== hash(root.operatorIdentity?.[key])
      )
        fail();
    const originalOptions = {
      ...o,
      operationId: o.recoveryOperationId,
      bindingDigest: v.bindingDigest,
      saved: undefined,
    };
    const ancestor = await read(() => readMediaRecoveryAncestorAccess(originalOptions));
    if (
      p.ancestorsSHA256 !== ancestor.receiptsSHA256 ||
      p.name !== ancestor.zeroPlan.body.name ||
      p.runner !== ancestor.binding.runnerServiceAccount ||
      !equal(p.normalTemplate, ancestor.zeroPlan.body.template) ||
      !equal(p.diagnosticTemplate, diagnosticTemplate(p.normalTemplate, o.recoveryOperationId)) ||
      !equal((({ revisionUid, ...value }) => value)(p.origin), ancestor.origin) ||
      !p.origin.revisionUid
    )
      fail();
    assertStoredMediaDiagnosticDrain(s.drained.observation, p, s.start.pool);
    if (
      s.drained.proofSHA256 !== hash(s.drained.observation) ||
      !equal(first.drain, {
        schemaVersion: 1,
        operationId: o.recoveryOperationId,
        releaseId: o.releaseId,
        bindingDigest: v.bindingDigest,
        planSHA256: hash(p),
        proof: s.drained,
      })
    )
      fail();
    const { pool } = await readRestoredNativeLineage(originalOptions, ancestor, s, read);
    const access = await read(() => readMediaRecoveryAncestorAccess(originalOptions));
    if (access.receiptsSHA256 !== ancestor.receiptsSHA256) fail();
    const sampled = Date.now(),
      sampleMono = performance.now(),
      actual = await read(() => o.api(`https://run.googleapis.com/v2/${p.name}`));
    const latest = { ...verifyPreparedPoolMetadata(ancestor.zeroPlan, actual), etag: actual.etag };
    if (!equal(latest, pool)) fail();
    const revision = await read(() => o.api(`https://run.googleapis.com/v2/${s.restore.pool.revision}`));
    if (
      normal(revision?.name) !== s.restore.pool.revision ||
      revision.uid !== s.restore.pool.revisionUid ||
      revision.deleteTime
    )
      fail();
    if (
      hash(await snapshots()) !== hash(first) ||
      hash(await read(() => assertRestoredMediaActivationAuthority(o))) !== hash(root) ||
      Date.now() < sampled ||
      Date.now() - sampled >= 5000 ||
      performance.now() - sampleMono >= 5000
    )
      fail();
    return {
      plan: p,
      pool: s.restore.pool,
      capsuleSHA256,
      provenanceSHA256: hash(first),
      accessSHA256: hash(access),
      observedAt: new Date(sampled).toISOString(),
    };
  } catch {
    return fail();
  }
}

async function readRestoredNativeLineage(o, ancestor, s, read) {
  const p = s.plan;
  let preceding = p.origin;
  for (const key of ['diagnostic', 'start', 'stop', 'restore']) {
    const x = s[key],
      template = key === 'restore' ? p.normalTemplate : p.diagnosticTemplate,
      target = key === 'start' ? 1 : 0;
    const expectedRequest = {
      url: `https://run.googleapis.com/v2/${p.name}?updateMask=${
        ['diagnostic', 'restore'].includes(key) ? 'template' : 'scaling'
      }`,
      method: 'PATCH',
      body: ['diagnostic', 'restore'].includes(key)
        ? { name: p.name, etag: preceding.etag, template }
        : { name: p.name, etag: preceding.etag, scaling: { manualInstanceCount: target } },
    };
    if (
      x?.stage !== 'completed' ||
      !equal(x.request, expectedRequest) ||
      !equal(x.plan, { key, operationId: o.operationId, before: preceding, templateSHA256: hash(template), target }) ||
      x.pool?.uid !== p.origin.uid ||
      x.pool.name !== p.name ||
      x.pool.desiredManualInstanceCount !== target ||
      BigInt(x.pool.generation) !== BigInt(preceding.generation) + 1n ||
      !x.pool.etag ||
      !x.pool.revisionUid ||
      (['diagnostic', 'restore'].includes(key)
        ? x.pool.revision === preceding.revision || x.pool.revisionUid === preceding.revisionUid
        : x.pool.revision !== preceding.revision || x.pool.revisionUid !== preceding.revisionUid)
    )
      fail();
    const name = opName(x.nativeOperation),
      lro = await read(() => o.api(`https://run.googleapis.com/v2/${name}`));
    if (opName(lro?.name) !== name || lro.done !== true || lro.error) fail();
    const response = verifyPreparedPoolMetadata(
      { ...ancestor.zeroPlan, body: { ...ancestor.zeroPlan.body, template } },
      lro.response,
      { manualInstanceCount: target }
    );
    if (!equal(response, (({ etag, revisionUid, ...x }) => x)(x.pool))) fail();
    preceding = x.pool;
  }
  const actual = await read(() => o.api(`https://run.googleapis.com/v2/${p.name}`));
  const pool = { ...verifyPreparedPoolMetadata(ancestor.zeroPlan, actual), etag: actual.etag };
  if (!equal(pool, (({ revisionUid, ...v }) => v)(s.restore.pool))) fail();
  for (const [saved, template] of [
    [p.origin, p.normalTemplate],
    [s.diagnostic.pool, p.diagnosticTemplate],
    [s.restore.pool, p.normalTemplate],
  ]) {
    if (!saved.revision?.startsWith(`${p.name}/revisions/`)) fail();
    const native = await read(() => o.api(`https://run.googleapis.com/v2/${saved.revision}`));
    const same = (a, b) =>
      Array.isArray(a)
        ? Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]))
        : a && typeof a === 'object'
        ? b && typeof b === 'object' && Object.entries(a).every(([k, v]) => same(v, b[k]))
        : a === b;
    if (
      normal(native?.name) !== saved.revision ||
      native.uid !== saved.revisionUid ||
      native.deleteTime ||
      !same(template, native)
    )
      fail();
  }

  return { pool };
}
