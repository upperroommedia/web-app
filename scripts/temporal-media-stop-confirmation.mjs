import { isDeepStrictEqual as equal } from 'node:util';
import { assertMediaDiagnosticNeverStartedObservation } from './temporal-media-diagnostic-drain.mjs';
import { proofDigest as hash } from './temporal-release-runtime.mjs';
import { readMediaRecoveryAncestorAccess } from './temporal-bootstrap-pool.mjs';
import { verifyPreparedPoolMetadata } from './temporal-prepare-cloud-pool.mjs';
const fail = () => {
  throw new Error('MEDIA_DIAGNOSTIC_ZERO_POOL_UNCONFIRMED');
};
/** Diagnostic-only native zero configuration. It cannot stand in for a normal
 * zero receipt, process count, kernel death, drain or restored-origin proof. */
export async function observeMediaRecoveryDiagnosticZeroPool(o) {
  const sampledAt = Date.now(),
    sampledMonotonic = performance.now();
  let live = true;
  const read = async (fn) => {
    let timer;
    try {
      if (!live || Date.now() - sampledAt >= 5000 || performance.now() - sampledMonotonic >= 5000) fail();
      const v = await Promise.race([
        Promise.resolve().then(() => {
          if (!live) fail();
          return fn();
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('MEDIA_DIAGNOSTIC_ZERO_POOL_UNCONFIRMED')), 5000);
        }),
      ]);
      if (Date.now() - sampledAt >= 5000 || performance.now() - sampledMonotonic >= 5000) fail();
      return v;
    } catch {
      live = false;
      return fail();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const ancestors = await read(() =>
      readMediaRecoveryAncestorAccess({ ...o, role: 'media', releaseId: o.config.releaseId, saved: undefined })
    );
    const p = o.plan;
    if (
      p.operationId !== o.operationId ||
      p.bindingDigest !== o.bindingDigest ||
      p.releaseId !== o.config.releaseId ||
      p.ancestorsSHA256 !== ancestors.receiptsSHA256 ||
      p.buildId !== ancestors.binding.buildId ||
      p.image !== ancestors.binding.image ||
      p.runner !== ancestors.binding.runnerServiceAccount ||
      p.name !== ancestors.zeroPlan.body.name ||
      o.pool.desiredManualInstanceCount !== 0
    )
      fail();
    const resource = await read(() => o.api(`https://run.googleapis.com/v2/${p.name}`));
    const metadata = verifyPreparedPoolMetadata(
      { ...ancestors.zeroPlan, body: { ...ancestors.zeroPlan.body, template: p.diagnosticTemplate } },
      resource,
      { manualInstanceCount: 0 }
    );
    const revision = await read(() => o.api(`https://run.googleapis.com/v2/${metadata.revision}`));
    const normal = (x) =>
      typeof x === 'string' ? x.replace('projects/251680231116/', 'projects/urm-app-staging/') : fail();
    const same = (a, b) =>
      Array.isArray(a)
        ? Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]))
        : a && typeof a === 'object'
        ? b && typeof b === 'object' && Object.entries(a).every(([k, v]) => same(v, b[k]))
        : a === b;
    if (
      normal(revision?.name) !== metadata.revision ||
      revision.deleteTime ||
      typeof revision.uid !== 'string' ||
      !revision.uid ||
      !same(p.diagnosticTemplate, revision)
    )
      fail();
    const pool = { ...metadata, etag: resource.etag, revisionUid: revision.uid };
    if (!equal(pool, o.pool) || pool.uid !== p.origin.uid) fail();
    return { pool, sampledAt, sampledMonotonic, ancestorsSHA256: ancestors.receiptsSHA256 };
  } catch {
    return fail();
  }
}
export function assertMediaZeroPoolSampleFresh(sample) {
  if (
    !Number.isFinite(sample?.sampledAt) ||
    !Number.isFinite(sample.sampledMonotonic) ||
    Date.now() - sample.sampledAt < 0 ||
    Date.now() - sample.sampledAt >= 5000 ||
    performance.now() - sample.sampledMonotonic < 0 ||
    performance.now() - sample.sampledMonotonic >= 5000
  )
    fail();
}
export function mediaDiagnosticNeverStartedProof(o, observation, before, after) {
  assertMediaZeroPoolSampleFresh(before);
  assertMediaZeroPoolSampleFresh(after);
  assertMediaDiagnosticNeverStartedObservation(observation, o.plan, o.pool);
  const observed = Date.parse(observation.observedAt);
  if (
    o.plan.operationId !== o.operationId ||
    o.pool.desiredManualInstanceCount !== 0 ||
    !equal(before.pool, o.pool) ||
    !equal(after.pool, o.pool) ||
    before.ancestorsSHA256 !== o.plan.ancestorsSHA256 ||
    after.ancestorsSHA256 !== o.plan.ancestorsSHA256 ||
    observed < before.sampledAt ||
    observed > after.sampledAt ||
    observed > Date.now() ||
    before.sampledMonotonic > after.sampledMonotonic
  )
    fail();
  const kind = 'never-started';
  return {
    kind,
    operationId: o.operationId,
    bindingDigest: o.bindingDigest,
    buildId: o.plan.buildId,
    image: o.plan.image,
    proofSHA256: hash({ kind, observation, pool: after.pool, ancestorsSHA256: after.ancestorsSHA256 }),
  };
}
