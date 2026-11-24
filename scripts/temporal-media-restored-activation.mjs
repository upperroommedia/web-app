import { isDeepStrictEqual as equal } from 'node:util';
import { proofDigest as hash } from './temporal-release-runtime.mjs';
import { assertMediaDiskQuotaFresh, assertMediaDiskQuotaProof } from './temporal-media-disk-quota.mjs';
import { restoredMediaStartupSettings } from './temporal-restored-media-boot-policy.mjs';
const fail = () => {
  throw new Error('RESTORED_MEDIA_ACTIVATION_UNCONFIRMED');
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = (x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const copy = (x) => structuredClone(x);
const nativeOperation = (x) =>
  typeof x === 'string' &&
  /^projects\/urm-app-staging\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/.test(x)
    ? x
    : fail();
const keys = (x, expected) => x && Object.keys(x).sort().join(',') === expected.split(',').sort().join(',');
export function assertRestoredActivationPool(pool, origin, count, delta) {
  if (
    !keys(pool, 'name,uid,generation,revision,revisionUid,etag,desiredManualInstanceCount') ||
    pool.name !== origin.name ||
    pool.uid !== origin.uid ||
    pool.revision !== origin.revision ||
    pool.revisionUid !== origin.revisionUid ||
    pool.desiredManualInstanceCount !== count ||
    !/^[1-9][0-9]*$/.test(String(pool.generation)) ||
    !/^[1-9][0-9]*$/.test(String(origin.generation)) ||
    BigInt(pool.generation) !== BigInt(origin.generation) + BigInt(delta) ||
    typeof pool.etag !== 'string' ||
    !pool.etag ||
    typeof pool.uid !== 'string' ||
    !pool.uid ||
    typeof pool.revisionUid !== 'string' ||
    !pool.revisionUid
  )
    fail();
}
export function assertRestoredActivationState(s) {
  const p = s?.plan;
  if (
    !s ||
    Object.keys(s).some(
      (k) => !['plan', 'stage', 'start', 'stop', 'registration', 'cleanup', 'disposition'].includes(k)
    ) ||
    !keys(
      p,
      'schemaVersion,operationId,recoveryOperationId,releaseId,bindingDigest,evidenceDigest,role,buildId,image,receiptIds,receiptsSHA256,origin,startup,createdAt'
    ) ||
    p.schemaVersion !== 1 ||
    p.role !== 'media' ||
    !uuid.test(p.operationId) ||
    !uuid.test(p.recoveryOperationId) ||
    p.operationId === p.recoveryOperationId ||
    !uuid.test(p.releaseId) ||
    !sha(p.bindingDigest) ||
    !sha(p.evidenceDigest) ||
    !sha(p.receiptsSHA256) ||
    !/^[a-f0-9]{40}$/.test(p.buildId) ||
    !/^us-central1-docker.pkg.dev\/urm-app-staging\/.+@sha256:[a-f0-9]{64}$/.test(p.image) ||
    !Number.isFinite(Date.parse(p.createdAt)) ||
    !equal(p.startup, restoredMediaStartupSettings(p.startup?.bootPolicy)) ||
    !keys(
      p.receiptIds,
      'runner,scaler,pool,runnerScaler,scalerTrust,poolAccess,firestore,projectRole,projectAccess,storageRole,storageAccess,bootstrapCycle,recovery'
    ) ||
    p.receiptIds.recovery !== p.recoveryOperationId ||
    new Set(Object.values(p.receiptIds)).size !== 13 ||
    Object.values(p.receiptIds).some((id) => !uuid.test(id) || id === p.operationId) ||
    p.origin?.kind !== 'restored-media-activation-origin-v1' ||
    p.origin.operationId !== p.operationId ||
    p.origin.recoveryOperationId !== p.recoveryOperationId ||
    p.origin.bindingDigest !== p.bindingDigest ||
    p.origin.releaseId !== p.releaseId ||
    p.origin.buildId !== p.buildId ||
    p.origin.image !== p.image ||
    !sha(p.origin.proofSHA256) ||
    !sha(p.origin.capsuleSHA256) ||
    !['planned', 'starting', 'started', 'cleaning', 'completed'].includes(s.stage)
  )
    fail();
  assertRestoredActivationPool(p.origin.pool, p.origin.pool, 0, 0);
  const url = `https://run.googleapis.com/v2/${p.origin.pool.name}?updateMask=scaling`;
  if (
    !new RegExp(
      `^projects/urm-app-staging/locations/us-central1/workerPools/urm-worker-media-${p.buildId.slice(0, 20)}$`
    ).test(p.origin.pool.name)
  )
    fail();
  for (const key of ['start', 'stop']) {
    const x = s[key],
      before = key === 'start' ? p.origin.pool : s.start?.pool,
      target = key === 'start' ? 1 : 0;
    if (!x) continue;
    if (
      !before ||
      !['attempted', 'acknowledged', 'completed', 'rejected'].includes(x.stage) ||
      !equal(x.request, {
        url,
        method: 'PATCH',
        body: { name: before.name, etag: before.etag, scaling: { manualInstanceCount: target } },
      }) ||
      !equal(x.before, before) ||
      !Number.isFinite(Date.parse(x.attemptedAt)) ||
      !sha(x.phaseSHA256) ||
      !sha(x.computeSHA256)
    )
      fail();
    if (key === 'start') assertMediaDiskQuotaProof(x.quota);
    if (['acknowledged', 'completed'].includes(x.stage)) nativeOperation(x.nativeOperation);
    if (x.stage === 'completed') assertRestoredActivationPool(x.pool, before, target, 1);
    if (
      x.stage === 'rejected' &&
      (!Number.isInteger(x.status) || x.status < 400 || x.status >= 500 || [408, 429].includes(x.status))
    )
      fail();
    if (key === 'stop' && (!s.cleanup || s.start?.stage !== 'completed' || s.registration)) fail();
  }
  if (
    s.registration &&
    (s.start?.stage !== 'completed' ||
      s.cleanup ||
      s.stop ||
      s.registration.kind !== 'restored-media-normal-registration-v1' ||
      s.registration.operationId !== p.operationId ||
      s.registration.planSHA256 !== hash(p) ||
      !equal(s.registration.pool, s.start.pool) ||
      !sha(s.registration.proofSHA256) ||
      !Number.isFinite(Date.parse(s.registration.observedAt)))
  )
    fail();
  if (
    s.cleanup &&
    (!keys(s.cleanup, 'kind,operationId,planSHA256,decisionAt') ||
      s.cleanup.kind !== 'unused-cleanup' ||
      s.cleanup.operationId !== p.operationId ||
      s.cleanup.planSHA256 !== hash(p) ||
      !Number.isFinite(Date.parse(s.cleanup.decisionAt)))
  )
    fail();
  if (s.stage === 'planned' && (s.start || s.stop || s.registration || s.cleanup)) fail();
  if (['started', 'cleaning', 'completed'].includes(s.stage) && s.start?.stage !== 'completed') fail();
  if (s.stage === 'cleaning' && !s.cleanup) fail();
  if (
    s.stage === 'completed' &&
    (s.disposition === 'retained'
      ? !s.registration || s.stop || s.cleanup
      : s.disposition !== 'stopped' || !s.cleanup || s.stop?.stage !== 'completed' || s.registration)
  )
    fail();
}
/** Separate fixed lifecycle. The zero-only origin reader is never invoked after
 * an attempted start, even after a lost ACK. Phase adapters must prove the exact
 * owned transition and fresh history/artifacts/IAM/work/compute independently. */
export async function activateRestoredCloudRunMedia(o) {
  const { runtime: r, api, save } = o;
  if (
    o.role !== 'media' ||
    !uuid.test(o.operationId) ||
    !uuid.test(o.recoveryOperationId) ||
    o.operationId === o.recoveryOperationId ||
    [
      api,
      save,
      ...['assertSupported', 'readOrigin', 'readPool', 'phase', 'quota', 'registration', 'unused'].map((k) => r?.[k]),
    ].some((f) => typeof f !== 'function')
  )
    fail();
  await r.assertSupported();
  let state = o.saved ? copy(o.saved) : undefined;
  const put = async (next) => {
    assertRestoredActivationState(next);
    await save(copy(next));
    state = copy(next);
  };
  if (!state) {
    const origin = await r.readOrigin();
    const receiptIds = Object.fromEntries(Object.entries(o.receipts).map(([k, v]) => [k, v.operationId]));
    const plan = {
      schemaVersion: 1,
      operationId: o.operationId,
      recoveryOperationId: o.recoveryOperationId,
      releaseId: o.releaseId,
      bindingDigest: o.bindingDigest,
      evidenceDigest: o.evidenceDigest,
      role: 'media',
      buildId: origin.buildId,
      image: origin.image,
      receiptIds,
      receiptsSHA256: hash(o.receipts),
      origin,
      startup: restoredMediaStartupSettings(o.bootPolicy),
      createdAt: new Date().toISOString(),
    };
    await put({ plan, stage: 'planned' });
  }
  assertRestoredActivationState(state);
  const p = state.plan;
  if (
    p.operationId !== o.operationId ||
    p.recoveryOperationId !== o.recoveryOperationId ||
    p.releaseId !== o.releaseId ||
    p.bindingDigest !== o.bindingDigest ||
    p.evidenceDigest !== o.evidenceDigest ||
    p.receiptsSHA256 !== hash(o.receipts) ||
    !equal(p.startup, restoredMediaStartupSettings(o.bootPolicy))
  )
    fail();
  const phase = async (key, x) => {
    const began = Date.now(),
      mono = performance.now();
    let timer;
    try {
      const value = await Promise.race([
        r.phase({ plan: p, state: copy(state), key, transition: copy(x) }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('RESTORED_MEDIA_ACTIVATION_UNCONFIRMED')), 5000);
        }),
      ]);
      if (
        Date.now() < began ||
        Date.now() - began >= 5000 ||
        performance.now() - mono >= 5000 ||
        value?.kind !== 'restored-media-activation-phase-v1' ||
        value.operationId !== p.operationId ||
        value.planSHA256 !== hash(p) ||
        value.key !== key ||
        !sha(value.phaseSHA256) ||
        !sha(value.computeSHA256) ||
        !Number.isFinite(Date.parse(value.observedAt)) ||
        Math.abs(Date.now() - Date.parse(value.observedAt)) >= 5000
      )
        fail();
      return value;
    } finally {
      clearTimeout(timer);
    }
  };
  const scale = async (key, target, before) => {
    let x = state[key];
    if (!x) {
      const v2Start = key === 'start' && p.startup.bootPolicy;
      if (!equal(await r.readPool({ plan: p, count: 1 - target }), before)) fail();
      const guard = await phase(key, null),
        quota = key === 'start' ? await r.quota({ plan: p }) : undefined;
      if (quota) assertMediaDiskQuotaFresh(quota);
      const request = {
        url: `https://run.googleapis.com/v2/${before.name}?updateMask=scaling`,
        method: 'PATCH',
        body: { name: before.name, etag: before.etag, scaling: { manualInstanceCount: target } },
      };
      x = {
        stage: 'attempted',
        before,
        request,
        attemptedAt: new Date().toISOString(),
        phaseSHA256: guard.phaseSHA256,
        computeSHA256: guard.computeSHA256,
        ...(quota ? { quota } : {}),
      };
      await put({ ...state, stage: key === 'start' ? 'starting' : 'cleaning', [key]: x });
      const authorizeV2Start = async () => {
        const wall = Date.now(),
          mono = performance.now();
        const outcomes = await Promise.allSettled([
          phase(key, x),
          r.readPool({ plan: p, count: 1 - target }),
          r.quota({ plan: p }),
        ]);
        if (outcomes.some((result) => result.status === 'rejected')) fail();
        const [current, pool, freshQuota] = outcomes.map((result) => result.value);
        assertMediaDiskQuotaFresh(freshQuota);
        // The committed attempt binds the semantics, while this post-intent
        // packet supplies the actual short-lived authority to send.
        if (
          current.phaseSHA256 !== x.phaseSHA256 ||
          current.computeSHA256 !== x.computeSHA256 ||
          !equal(pool, before) ||
          freshQuota.quotaSHA256 !== quota.quotaSHA256 ||
          Date.now() < wall ||
          Date.now() - wall >= 5000 ||
          performance.now() - mono >= 5000 ||
          Date.now() >= Date.parse(x.attemptedAt) + v2Start.outerWindowMs
        )
          fail();
      };
      const fence = async () => {
        if (quota) assertMediaDiskQuotaFresh(quota);
        const g = await phase(key, x);
        if (
          g.phaseSHA256 !== x.phaseSHA256 ||
          g.computeSHA256 !== x.computeSHA256 ||
          !equal(await r.readPool({ plan: p, count: 1 - target }), before)
        )
          fail();
        if (quota) {
          const now = await r.quota({ plan: p });
          assertMediaDiskQuotaFresh(quota);
          assertMediaDiskQuotaFresh(now);
          if (now.quotaSHA256 !== quota.quotaSHA256) fail();
        }
        if (Math.abs(Date.now() - Date.parse(g.observedAt)) >= 5000) fail();
      };
      if (!v2Start) await fence();
      let ack,
        authorized = false,
        entered = false;
      try {
        ack = await api(
          request.url,
          'PATCH',
          request.body,
          v2Start
            ? async () => {
                if (entered) fail();
                entered = true;
                await authorizeV2Start();
                authorized = true;
              }
            : fence
        );
        if (v2Start && !authorized) fail();
      } catch (e) {
        // An error in the local pre-send callback is not a provider rejection.
        if (v2Start && !authorized) fail();
        if (Number.isInteger(e?.status) && e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status)) {
          await put({ ...state, [key]: { ...x, stage: 'rejected', status: e.status } });
          fail();
        }
      }
      if (ack) {
        x = { ...x, stage: 'acknowledged', nativeOperation: nativeOperation(ack.name) };
        await put({ ...state, [key]: x });
      }
    }
    // No LRO ACK means GET-only reconciliation; desired one alone is not owned success.
    if (x.stage === 'attempted') {
      await r.readPool({ plan: p, count: target });
      fail();
    }
    if (x.stage === 'rejected') fail();
    const v2Start = key === 'start' && p.startup.bootPolicy;
    if (!v2Start || x.stage === 'completed') await phase(key, x);
    if (x.stage === 'acknowledged') {
      const end = v2Start ? Date.parse(x.attemptedAt) + v2Start.outerWindowMs : Date.now() + 30000;
      let result;
      do {
        result = await api(`https://run.googleapis.com/v2/${nativeOperation(x.nativeOperation)}`);
        if (result?.name !== x.nativeOperation) fail();
        if (result.done === true) break;
        if (result.done !== undefined && result.done !== false) fail();
        await new Promise((resolve) => setTimeout(resolve, v2Start ? 1000 : 200));
      } while (Date.now() < end);
      if (result?.done !== true || result.error) fail();
      const pool = await r.readPool({ plan: p, count: target, nativeResponse: result.response });
      assertRestoredActivationPool(pool, before, target, 1);
      await phase(key, x);
      if (!equal(await r.readPool({ plan: p, count: target }), pool)) fail();
      x = { ...x, stage: 'completed', pool };
      await put({ ...state, [key]: x });
    }
    if (!equal(await r.readPool({ plan: p, count: target }), x.pool)) fail();
    return x.pool;
  };
  if (state.stage === 'completed') {
    await phase(state.disposition === 'retained' ? 'retained' : 'stopped', state.start);
    if (
      !equal(
        await r.readPool({ plan: p, count: state.disposition === 'retained' ? 1 : 0 }),
        state.stop?.pool ?? state.start.pool
      )
    )
      fail();
    return state;
  }
  const pool =
    state.cleanup && state.start?.stage === 'completed' ? state.start.pool : await scale('start', 1, p.origin.pool);
  if (state.stage === 'starting') await put({ ...state, stage: 'started' });
  if (!state.cleanup && !state.registration) {
    let registration;
    const began = Date.now(),
      mono = performance.now();
    const fresh = () => {
      if (Date.now() < began || Date.now() - began >= 5000 || performance.now() - mono >= 5000) fail();
    };
    const read = async (fn) => {
      let timer;
      try {
        fresh();
        const result = await Promise.race([
          Promise.resolve().then(() => {
            fresh();
            return fn();
          }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('RESTORED_MEDIA_ACTIVATION_UNCONFIRMED')),
              Math.max(1, 5000 - (Date.now() - began))
            );
          }),
        ]);
        fresh();
        return result;
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      registration = await read(() => r.registration({ plan: p, pool }));
      const candidate = { ...state, registration };
      assertRestoredActivationState(candidate);
      if (Math.abs(Date.now() - Date.parse(registration.observedAt)) >= 5000) fail();
      await read(() => phase('retained', state.start));
      if (!equal(await read(() => r.readPool({ plan: p, count: 1 })), pool)) fail();
      fresh();
      if (Math.abs(Date.now() - Date.parse(registration.observedAt)) >= 5000) fail();
    } catch {
      registration = undefined;
    }
    // A lost retention commit ACK must escape: never reinterpret it as cleanup.
    if (registration) {
      fresh();
      if (Math.abs(Date.now() - Date.parse(registration.observedAt)) >= 5000) fail();
      await put({ ...state, stage: 'completed', disposition: 'retained', registration });
      return state;
    }
    // Registration can still be pending after provider readiness. V2 keeps
    // the original attempt recoverable and needs separate proof for a STOP.
    if (p.startup.bootPolicy) throw new Error('RESTORED_MEDIA_V2_REGISTRATION_UNCONFIRMED');
    await put({
      ...state,
      stage: 'cleaning',
      cleanup: {
        kind: 'unused-cleanup',
        operationId: p.operationId,
        planSHA256: hash(p),
        decisionAt: new Date().toISOString(),
      },
    });
  }
  // Cleanup deliberately does not refresh quota. This immutable decision never
  // expires, but exact current/active/unknown work must still deny the stop.
  await r.unused({ plan: p, pool, state: copy(state) });
  await scale('stop', 0, pool);
  await put({ ...state, stage: 'completed', disposition: 'stopped' });
  fail();
}
