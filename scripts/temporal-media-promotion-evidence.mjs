import { isDeepStrictEqual as equal } from 'node:util';
import { proofDigest as hash } from './temporal-release-runtime.mjs';
import { readRestoredMediaPromotionInput } from './temporal-restored-media-capsule.mjs';
import { readMediaRecoveryAncestorAccess } from './temporal-bootstrap-pool.mjs';
import { verifyPreparedPoolMetadata } from './temporal-prepare-cloud-pool.mjs';
const fail = () => {
  throw new Error('MEDIA_PROMOTION_RETAINED_EVIDENCE_UNCONFIRMED');
};
const normal = (x) =>
  typeof x === 'string' ? x.replace('projects/251680231116/', 'projects/urm-app-staging/') : fail();
const op = (x) =>
  typeof x === 'string' &&
  /^projects\/(urm-app-staging|251680231116)\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/.test(x)
    ? normal(x)
    : fail();
const matches = (a, b) =>
  Array.isArray(a)
    ? Array.isArray(b) && a.length === b.length && a.every((v, i) => matches(v, b[i]))
    : a && typeof a === 'object'
    ? b && typeof b === 'object' && Object.entries(a).every(([k, v]) => matches(v, b[k]))
    : a === b;
/** Fixed promotion-parent current-one resource reader. Never invokes a zero-only
 * origin getter or reconstructs an old singleton. It grants no routing mutation. */
export async function readMediaPromotionRetainedResources(o) {
  const at = Date.now(),
    mono = performance.now();
  let active = true;
  const fresh = () => {
    if (!active || Date.now() < at || Date.now() - at >= 30000 || performance.now() - mono >= 30000) fail();
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
          timer = setTimeout(
            () => reject(new Error('MEDIA_PROMOTION_RETAINED_EVIDENCE_UNCONFIRMED')),
            Math.min(5000, Math.max(1, 30000 - (Date.now() - at)))
          );
        }),
      ]);
      fresh();
      return v;
    } catch {
      active = false;
      return fail();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const before = await read(() => readRestoredMediaPromotionInput(o));
    const cap = await read(() =>
      o.firestore.doc(`_control/temporalRestoredMediaActivationCapsule-${before.activationOperationId}`).get()
    );
    if (cap.get('capsuleSHA256') !== before.capsuleSHA256) fail();
    const retained = cap.get('originalParent.cloudRestoredMediaActivation'),
      p = retained.plan,
      recovery = o.receipts.recovery.identityState,
      r = recovery.plan;
    const { recovery: _recovery, restoredActivation: _retained, imagesPromotion: _images, ...receipts } = o.receipts;
    const api = (...args) => read(() => o.api(...args));
    const ancestor = await read(() =>
      readMediaRecoveryAncestorAccess({ ...o, receipts, saved: undefined, observeProtection: fail, api })
    );
    if (
      ancestor.binding.buildId !== p.buildId ||
      ancestor.binding.image !== p.image ||
      ancestor.receiptsSHA256 !== r.ancestorsSHA256 ||
      ancestor.zeroPlan.body.name !== r.name ||
      !equal(ancestor.zeroPlan.body.template, r.normalTemplate) ||
      r.operationId !== before.recoveryOperationId ||
      p.recoveryOperationId !== r.operationId ||
      hash(recovery.restore.pool) !== hash(p.origin.pool) ||
      r.origin.uid !== p.origin.pool.uid
    )
      fail();
    let preceding = r.origin;
    for (const key of ['diagnostic', 'start', 'stop', 'restore']) {
      const x = recovery[key],
        template = key === 'restore' ? r.normalTemplate : r.diagnosticTemplate,
        target = key === 'start' ? 1 : 0;
      const request = {
        url: `https://run.googleapis.com/v2/${r.name}?updateMask=${
          ['diagnostic', 'restore'].includes(key) ? 'template' : 'scaling'
        }`,
        method: 'PATCH',
        body: ['diagnostic', 'restore'].includes(key)
          ? { name: r.name, etag: preceding.etag, template }
          : { name: r.name, etag: preceding.etag, scaling: { manualInstanceCount: target } },
      };
      if (
        x?.stage !== 'completed' ||
        !equal(x.request, request) ||
        !equal(x.plan, {
          key,
          operationId: r.operationId,
          before: preceding,
          templateSHA256: hash(template),
          target,
        }) ||
        x.pool?.uid !== r.origin.uid ||
        x.pool.name !== r.name ||
        x.pool.desiredManualInstanceCount !== target ||
        BigInt(x.pool.generation) !== BigInt(preceding.generation) + 1n ||
        !x.pool.etag ||
        !x.pool.revisionUid ||
        (['diagnostic', 'restore'].includes(key)
          ? x.pool.revision === preceding.revision || x.pool.revisionUid === preceding.revisionUid
          : x.pool.revision !== preceding.revision || x.pool.revisionUid !== preceding.revisionUid)
      )
        fail();
      const name = op(x.nativeOperation),
        lro = await api(`https://run.googleapis.com/v2/${name}`);
      if (op(lro?.name) !== name || lro.done !== true || lro.error) fail();
      const response = verifyPreparedPoolMetadata(
        { ...ancestor.zeroPlan, body: { ...ancestor.zeroPlan.body, template } },
        lro.response,
        { manualInstanceCount: target }
      );
      if (!equal(response, (({ etag, revisionUid, ...v }) => v)(x.pool)) || lro.response.etag !== x.pool.etag) fail();
      preceding = x.pool;
    }
    const start = retained.start,
      request = {
        url: `https://run.googleapis.com/v2/${p.origin.pool.name}?updateMask=scaling`,
        method: 'PATCH',
        body: { name: p.origin.pool.name, etag: p.origin.pool.etag, scaling: { manualInstanceCount: 1 } },
      };
    if (
      start.stage !== 'completed' ||
      !equal(start.before, p.origin.pool) ||
      !equal(start.request, request) ||
      BigInt(start.pool.generation) !== BigInt(p.origin.pool.generation) + 1n ||
      start.pool.uid !== p.origin.pool.uid ||
      start.pool.revision !== p.origin.pool.revision ||
      start.pool.revisionUid !== p.origin.pool.revisionUid
    )
      fail();
    const name = op(start.nativeOperation),
      lro = await api(`https://run.googleapis.com/v2/${name}`);
    if (
      op(lro?.name) !== name ||
      lro.done !== true ||
      lro.error ||
      !equal(
        verifyPreparedPoolMetadata(ancestor.zeroPlan, lro.response, { manualInstanceCount: 1 }),
        (({ etag, revisionUid, ...v }) => v)(start.pool)
      ) ||
      lro.response.etag !== start.pool.etag
    )
      fail();
    const sampled = Date.now(),
      sampleMono = performance.now();
    const actual = await api(`https://run.googleapis.com/v2/${p.origin.pool.name}`);
    const pool = {
      ...verifyPreparedPoolMetadata(ancestor.zeroPlan, actual, { manualInstanceCount: 1 }),
      etag: actual.etag,
      revisionUid: p.origin.pool.revisionUid,
    };
    if (!equal(pool, start.pool)) fail();
    for (const [saved, template] of [
      [r.origin, r.normalTemplate],
      [recovery.diagnostic.pool, r.diagnosticTemplate],
      [p.origin.pool, r.normalTemplate],
    ]) {
      if (!saved.revision?.startsWith(`${r.name}/revisions/`)) fail();
      const revision = await api(`https://run.googleapis.com/v2/${saved.revision}`);
      if (
        normal(revision?.name) !== saved.revision ||
        revision.uid !== saved.revisionUid ||
        revision.deleteTime ||
        !matches(template, revision)
      )
        fail();
    }
    const after = await read(() => readRestoredMediaPromotionInput(o));
    if (
      hash(before) !== hash({ ...after, observedAt: before.observedAt }) ||
      Date.now() < sampled ||
      Date.now() - sampled >= 5000 ||
      performance.now() - sampleMono >= 5000
    )
      fail();
    return {
      kind: 'media-promotion-retained-resources-v1',
      operationId: o.operationId,
      activationOperationId: before.activationOperationId,
      recoveryOperationId: before.recoveryOperationId,
      capsuleSHA256: before.capsuleSHA256,
      plan: p,
      recoveryPlan: r,
      pool,
      nativeFactsSHA256: before.nativeFactsSHA256,
      accessSHA256: hash(ancestor.access),
      observedAt: new Date(sampled).toISOString(),
      scope: 'readonly-retained-resource-input-no-mutation-or-platform-authority',
    };
  } catch {
    return fail();
  }
}
