import { isDeepStrictEqual as equal } from 'node:util';
import { proofDigest as hash, assertNativeSnapshot } from './temporal-release-runtime.mjs';
import { readMediaRecoveryAncestorAccess } from './temporal-bootstrap-pool.mjs';
import { verifyPreparedPoolMetadata } from './temporal-prepare-cloud-pool.mjs';
const fail = () => {
  throw new Error('MEDIA_RECOVERY_PHASE_POOL_UNCONFIRMED');
};
const normal = (x) =>
  typeof x === 'string' ? x.replace('projects/251680231116/', 'projects/urm-app-staging/') : fail();
const operation = (x) =>
  typeof x === 'string' &&
  /^projects\/(urm-app-staging|251680231116)\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/.test(x)
    ? normal(x)
    : fail();
/** Resource fence only. This does NOT authorize owned pollers/work or replace the
 * separate namespace protection policy. Unknown ACK has no successor authority. */
export function mediaRecoveryPhaseExpectation(p, phase, claimedPool, cycle) {
  if (
    hash(cycle?.plan) !== hash(p) ||
    !['diagnostic', 'start', 'stop', 'restore', 'completed', 'never-started'].includes(phase)
  )
    fail();
  const before = {
    diagnostic: p.origin,
    start: cycle.diagnostic?.pool,
    stop: cycle.start?.pool,
    restore: cycle.neverStarted ? cycle.diagnostic?.pool : cycle.stop?.pool,
    completed: cycle.restore?.pool,
    'never-started': cycle.diagnostic?.pool,
  }[phase];
  if (!before || !equal(claimedPool, before)) fail();
  if (phase === 'completed') {
    if (
      cycle.stage !== 'completed' ||
      cycle.restore?.stage !== 'completed' ||
      cycle.disposition !== 'restored-normal-zero'
    )
      fail();
    return {
      phase,
      before,
      template: p.normalTemplate,
      target: 0,
      stage: 'completed',
      exact: before,
      nativeOperation: operation(cycle.restore.nativeOperation),
    };
  }
  if (phase === 'never-started') {
    const x = cycle.start;
    if (
      cycle.diagnostic?.stage !== 'completed' ||
      cycle.recovery ||
      cycle.recoveryFailed ||
      cycle.drained ||
      cycle.stop ||
      cycle.restore ||
      (x &&
        (x.stage !== 'rejected' ||
          !Number.isInteger(x.status) ||
          x.status < 400 ||
          x.status >= 500 ||
          [408, 429].includes(x.status)))
    )
      fail();
    return { phase, before, template: p.diagnosticTemplate, target: 0, stage: 'no-start', exact: before };
  }
  if (
    phase === 'start' &&
    (cycle.diagnostic?.stage !== 'completed' ||
      cycle.recovery ||
      cycle.recoveryFailed ||
      cycle.drained ||
      cycle.stop ||
      cycle.restore)
  )
    fail();
  if (phase === 'stop' && (cycle.start?.stage !== 'completed' || !cycle.drained || cycle.restore)) fail();
  if (phase === 'restore' && !cycle.neverStarted && (cycle.stop?.stage !== 'completed' || !cycle.stopped)) fail();
  if (
    phase === 'diagnostic' &&
    (cycle.start || cycle.neverStarted || cycle.recovery || cycle.recoveryFailed || cycle.stop || cycle.restore)
  )
    fail();
  const template = phase === 'restore' ? p.normalTemplate : p.diagnosticTemplate,
    target = phase === 'start' ? 1 : 0,
    x = cycle[phase];
  const transition = { key: phase, operationId: p.operationId, before, templateSHA256: hash(template), target };
  const request = {
    url: `https://run.googleapis.com/v2/${p.name}?updateMask=${
      ['diagnostic', 'restore'].includes(phase) ? 'template' : 'scaling'
    }`,
    method: 'PATCH',
    body: ['diagnostic', 'restore'].includes(phase)
      ? { name: p.name, etag: before.etag, template }
      : { name: p.name, etag: before.etag, scaling: { manualInstanceCount: target } },
  };
  if (
    x &&
    (!equal(x.plan, transition) ||
      !equal(x.request, request) ||
      !['attempted', 'acknowledged', 'completed', 'rejected'].includes(x.stage) ||
      !Number.isFinite(Date.parse(x.attemptedAt)))
  )
    fail();
  if (x?.stage === 'rejected') fail();
  if (
    ['diagnostic', 'start'].includes(phase) &&
    (!x || x.stage === 'attempted') &&
    (!Number.isFinite(p.expiresAt) || Date.now() >= p.expiresAt)
  )
    fail();
  return {
    phase,
    before,
    template,
    target,
    stage: x?.stage ?? 'before-attempt',
    ...(x?.nativeOperation ? { nativeOperation: operation(x.nativeOperation) } : {}),
    ...(x?.stage === 'completed' ? { exact: x.pool } : {}),
  };
}
export async function observeMediaRecoveryPhasePool(o) {
  const sampledAt = Date.now(),
    monotonic = performance.now();
  let live = true;
  const fresh = () => {
    if (
      !live ||
      Date.now() - sampledAt < 0 ||
      Date.now() - sampledAt >= 5000 ||
      performance.now() - monotonic < 0 ||
      performance.now() - monotonic >= 5000
    )
      fail();
  };
  const read = async (fn) => {
    let timer;
    try {
      fresh();
      const v = await Promise.race([
        Promise.resolve().then(() => {
          fresh();
          return fn();
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('MEDIA_RECOVERY_PHASE_POOL_UNCONFIRMED')), 5000);
        }),
      ]);
      fresh();
      return v;
    } catch {
      live = false;
      return fail();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const authority = () =>
      read(() =>
        o.firestore.runTransaction(
          async (tx) => {
            fresh();
            const [parent, c, s] = await Promise.all([o.lockRef, o.controlRef, o.stateRef].map((r) => tx.get(r)));
            assertNativeSnapshot(o.ownedOperation, parent);
            assertNativeSnapshot(o.expectedAuthority.control, c);
            assertNativeSnapshot(o.expectedAuthority.state, s);
            if (
              parent.get('action') !== 'diagnose-cloud-run-media-recovery' ||
              parent.get('operationId') !== o.operationId ||
              parent.get('bindingDigest') !== o.bindingDigest ||
              parent.get('releaseId') !== o.config.releaseId ||
              c.get('admission') !== 'paused' ||
              c.get('releaseId') !== o.config.releaseId ||
              s.get('releaseId') !== o.config.releaseId ||
              s.get('phase') !== 'provider-usage-ready' ||
              ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
                (k) => c.get(`domains.${k}.admission`) !== 'paused'
              )
            )
              fail();
            return parent.get('cloudMediaRecovery');
          },
          { readOnly: true }
        )
      );
    const cycle = await authority(),
      p = o.plan,
      expected = mediaRecoveryPhaseExpectation(p, o.phase, o.pool, cycle);
    const ancestors = await read(() =>
      readMediaRecoveryAncestorAccess({ ...o, role: 'media', releaseId: o.config.releaseId, saved: undefined })
    );
    if (
      p.operationId !== o.operationId ||
      p.bindingDigest !== o.bindingDigest ||
      p.releaseId !== o.config.releaseId ||
      p.ancestorsSHA256 !== ancestors.receiptsSHA256 ||
      p.name !== ancestors.zeroPlan.body.name ||
      p.buildId !== ancestors.binding.buildId ||
      p.image !== ancestors.binding.image ||
      p.runner !== ancestors.binding.runnerServiceAccount
    )
      fail();
    let lro;
    if (['acknowledged', 'completed'].includes(expected.stage) && expected.nativeOperation) {
      lro = await read(() => o.api(`https://run.googleapis.com/v2/${expected.nativeOperation}`));
      if (
        operation(lro?.name) !== expected.nativeOperation ||
        lro.error ||
        (lro.done !== undefined && typeof lro.done !== 'boolean')
      )
        fail();
      if (expected.stage === 'completed' && lro.done !== true) fail();
    } else if (
      expected.stage === 'acknowledged' ||
      (['diagnostic', 'start', 'stop', 'restore'].includes(o.phase) && expected.stage === 'completed')
    )
      fail();
    const resource = await read(() => o.api(`https://run.googleapis.com/v2/${p.name}`));
    const beforeTemplate =
      o.phase === 'diagnostic' ? p.normalTemplate : o.phase === 'completed' ? p.normalTemplate : p.diagnosticTemplate;
    const beforeCount = expected.before.desiredManualInstanceCount;
    const parse = async (template, count) => {
      const v = verifyPreparedPoolMetadata(
        { ...ancestors.zeroPlan, body: { ...ancestors.zeroPlan.body, template } },
        resource,
        { manualInstanceCount: count }
      );
      const rev = await read(() => o.api(`https://run.googleapis.com/v2/${v.revision}`));
      const same = (a, b) =>
        Array.isArray(a)
          ? Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]))
          : a && typeof a === 'object'
          ? b && typeof b === 'object' && Object.entries(a).every(([k, v]) => same(v, b[k]))
          : a === b;
      if (
        normal(rev?.name) !== v.revision ||
        typeof rev.uid !== 'string' ||
        !rev.uid ||
        rev.deleteTime ||
        !same(template, rev) ||
        typeof resource.etag !== 'string' ||
        !resource.etag
      )
        fail();
      return { ...v, etag: resource.etag, revisionUid: rev.uid };
    };
    let observed, position;
    if (expected.exact) {
      observed = await parse(expected.template, expected.target);
      if (!equal(observed, expected.exact)) fail();
      position = 'exact';
    } else if (expected.stage === 'acknowledged') {
      try {
        observed = await parse(beforeTemplate, beforeCount);
      } catch (error) {
        if (!live) throw error;
      }
      if (observed && equal(observed, expected.before)) {
        if (lro.done === true) fail();
        position = 'before';
      } else {
        observed = await parse(expected.template, expected.target);
        const a = expected.before,
          b = observed;
        if (
          a.uid !== b.uid ||
          BigInt(b.generation) !== BigInt(a.generation) + 1n ||
          (['diagnostic', 'restore'].includes(o.phase)
            ? b.revision === a.revision || b.revisionUid === a.revisionUid
            : b.revision !== a.revision || b.revisionUid !== a.revisionUid)
        )
          fail();
        position = 'successor';
        if (lro.done === true) {
          const response = verifyPreparedPoolMetadata(
            { ...ancestors.zeroPlan, body: { ...ancestors.zeroPlan.body, template: expected.template } },
            lro.response,
            { manualInstanceCount: expected.target }
          );
          const { etag, revisionUid, ...native } = observed;
          if (!equal(response, native)) fail();
        }
      }
    } else {
      observed = await parse(beforeTemplate, beforeCount);
      if (!equal(observed, expected.before)) fail();
      position = 'before';
    }
    if (lro?.done === true) {
      const response = verifyPreparedPoolMetadata(
        { ...ancestors.zeroPlan, body: { ...ancestors.zeroPlan.body, template: expected.template } },
        lro.response,
        { manualInstanceCount: expected.target }
      );
      const { etag, revisionUid, ...native } = observed;
      if (!equal(response, native)) fail();
    }
    if (hash(await authority()) !== hash(cycle)) fail();
    fresh();
    return {
      schemaVersion: 1,
      kind: 'private-media-phase-pool-v1',
      operationId: o.operationId,
      phase: o.phase,
      planSHA256: hash(p),
      position,
      poolSHA256: hash(observed),
      ancestorsSHA256: ancestors.receiptsSHA256,
      observedAt: new Date(sampledAt).toISOString(),
      readOnly: true,
    };
  } catch {
    return fail();
  }
}
