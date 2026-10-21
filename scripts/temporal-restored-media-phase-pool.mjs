import { isDeepStrictEqual as equal } from 'node:util';
import { proofDigest as hash } from './temporal-release-runtime.mjs';
import { assertRestoredActivationState, assertRestoredActivationPool } from './temporal-media-restored-activation.mjs';
import { readRestoredMediaPhaseResourceContext } from './temporal-restored-media-resources.mjs';
import { assertRestoredMediaActivationAuthority } from './temporal-media-restored-origin.mjs';
import { verifyPreparedPoolMetadata } from './temporal-prepare-cloud-pool.mjs';
const fail = () => {
  throw new Error('RESTORED_MEDIA_PHASE_RESOURCE_UNCONFIRMED');
};
const normalized = (x) =>
  typeof x === 'string' ? x.replace('projects/251680231116/', 'projects/urm-app-staging/') : fail();
const operation = (x) =>
  /^projects\/urm-app-staging\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/.test(normalized(x))
    ? normalized(x)
    : fail();
const matches = (e, a) =>
  Array.isArray(e)
    ? Array.isArray(a) && e.length === a.length && e.every((v, i) => matches(v, a[i]))
    : e && typeof e === 'object'
    ? a && typeof a === 'object' && Object.entries(e).every(([k, v]) => matches(v, a[k]))
    : e === a;
/** Resource-phase expectation only. It cannot permit pollers or work, establish
 * process counts, bypass namespace protection, or authorize any PATCH. */
export function restoredMediaPhaseExpectation({ plan, state, key, transition }) {
  assertRestoredActivationState(state);
  if (!equal(plan, state.plan) || !['start', 'retained', 'stop', 'stopped'].includes(key)) fail();
  const selected = key === 'retained' || key === 'stopped' ? state.start : state[key];
  if (!equal(transition ?? null, selected ?? null)) fail();
  const stopping = key === 'stop' || key === 'stopped';
  if (stopping) {
    if (state.start?.stage !== 'completed' || !state.cleanup || state.registration || state.disposition === 'retained')
      fail();
    if (
      key === 'stopped' &&
      (state.stop?.stage !== 'completed' || state.stage !== 'completed' || state.disposition !== 'stopped')
    )
      fail();
  } else {
    if (state.cleanup || state.stop || state.disposition === 'stopped') fail();
    if (key === 'retained' && state.start?.stage !== 'completed') fail();
  }
  const x = stopping ? state.stop : state.start;
  if (x?.stage === 'rejected') fail();
  const before = stopping ? state.start.pool : plan.origin.pool;
  const target = stopping ? 0 : 1;
  return {
    key,
    before,
    target,
    stage: x?.stage ?? 'before-attempt',
    ...(x?.nativeOperation ? { nativeOperation: operation(x.nativeOperation) } : {}),
    ...(x?.stage === 'completed' ? { exact: x.pool } : {}),
  };
}
export async function observeRestoredMediaPhasePool(o) {
  const at = Date.now(),
    mono = performance.now();
  let active = true;
  const fresh = () => {
    if (
      !active ||
      Date.now() < at ||
      Date.now() - at >= 5000 ||
      performance.now() < mono ||
      performance.now() - mono >= 5000
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
          timer = setTimeout(
            () => reject(new Error('RESTORED_MEDIA_PHASE_RESOURCE_UNCONFIRMED')),
            Math.max(1, 5000 - (Date.now() - at))
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
    const context = await read(() => readRestoredMediaPhaseResourceContext(o));
    if (!equal(context.state, o.state)) fail();
    const expected = restoredMediaPhaseExpectation({ ...o, state: context.state });
    const before = expected.before,
      api = (...a) => read(() => o.api(...a));
    let lro;
    if (['acknowledged', 'completed'].includes(expected.stage)) {
      if (!expected.nativeOperation) fail();
      lro = await api(`https://run.googleapis.com/v2/${expected.nativeOperation}`);
      if (
        operation(lro?.name) !== expected.nativeOperation ||
        lro.error ||
        (lro.done !== undefined && typeof lro.done !== 'boolean') ||
        (expected.stage === 'completed' && lro.done !== true)
      )
        fail();
    }
    const resource = await api(`https://run.googleapis.com/v2/${before.name}`);
    const count = resource?.scaling?.manualInstanceCount ?? 0;
    if (![0, 1].includes(count)) fail();
    const pool = {
      ...verifyPreparedPoolMetadata(context.ancestor.zeroPlan, resource, { manualInstanceCount: count }),
      etag: resource.etag,
      revisionUid: before.revisionUid,
    };
    const revision = await api(`https://run.googleapis.com/v2/${before.revision}`);
    if (
      normalized(revision?.name) !== before.revision ||
      revision.uid !== before.revisionUid ||
      revision.deleteTime ||
      !matches(context.ancestor.zeroPlan.body.template, revision)
    )
      fail();
    let position;
    if (equal(pool, before)) {
      if (lro?.done === true || expected.stage === 'completed') fail();
      position = 'before';
    } else {
      if (!lro || lro.done !== true || count !== expected.target) fail();
      assertRestoredActivationPool(pool, before, expected.target, 1);
      const response = {
        ...verifyPreparedPoolMetadata(context.ancestor.zeroPlan, lro.response, { manualInstanceCount: count }),
        etag: lro.response?.etag,
        revisionUid: before.revisionUid,
      };
      if (!equal(response, pool) || (expected.exact && !equal(expected.exact, pool))) fail();
      position = expected.exact ? 'exact' : 'successor';
    }
    // Exact roots, 13 native receipt stamps, source, access, and capsule are
    // checked again AFTER all external resource observations. Cleanup does not
    // request fresh quota or reuse the zero-only origin getter.
    const after = await read(() => readRestoredMediaPhaseResourceContext(o));
    if (hash(context) !== hash(after)) fail();
    await read(() => assertRestoredMediaActivationAuthority(o));
    fresh();
    return {
      kind: 'restored-media-phase-resource-v1',
      operationId: o.operationId,
      planSHA256: hash(o.plan),
      key: o.key,
      position,
      pool,
      expectation: expected,
      provenanceSHA256: context.provenanceSHA256,
      observedAt: new Date(at).toISOString(),
      scope: 'resource-only-no-namespace-or-mutation-authority',
    };
  } catch {
    return fail();
  }
}
