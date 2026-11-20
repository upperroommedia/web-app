import { proofDigest as hash } from './temporal-release-runtime.mjs';
import { assertRestoredMediaActivationAuthority } from './temporal-media-restored-origin.mjs';
import { scanRestoredMediaInventory } from './temporal-restored-media-inventory.mjs';
import { scanPrivateMediaInventory } from './temporal-media-private-inventory.mjs';
import { observeNamespaceComputeIsolation } from './temporal-compute-isolation.mjs';
const fail = () => {
  throw new Error('RESTORED_MEDIA_PHASE_PROTECTION_UNCONFIRMED');
};
const age = (x) => {
  const at = Date.parse(x?.observedAt);
  if (!Number.isFinite(at) || Math.abs(Date.now() - at) >= 5000) fail();
};
/** Own startup may advance but cannot change its original parent, intent,
 * birth, worker, or authenticated identity once those facts have appeared. */
export function assertRestoredMediaStartupProgress(a, b) {
  const rank = { absent: 0, armed: 1, born: 2, running: 3, closed: 4 };
  if (!(a?.stage in rank) || !(b?.stage in rank) || rank[b.stage] < rank[a.stage]) fail();
  for (const key of ['originSHA256', 'birthSHA256', 'workerSHA256']) if (a[key] && a[key] !== b[key]) fail();
  if (a.stage === 'closed' && (b.allowedPollerIdentity || a.ownFactsSHA256 !== b.ownFactsSHA256)) fail();
  if (
    a.allowedPollerIdentity &&
    b.stage !== 'closed' &&
    (a.allowedPollerIdentity !== b.allowedPollerIdentity || a.ownFactsSHA256 !== b.ownFactsSHA256)
  )
    fail();
}
/** The restored-zero parent has no authority to accept even a candidate
 * poller. Join both native inventories and compute across two observations. */
export async function observeRestoredMediaOriginProtection(o) {
  const auth = () => o.read(() => assertRestoredMediaActivationAuthority(o));
  const root = await auth();
  if (
    o.client.options.namespace !== 'urm-app-staging.qwejt' ||
    Object.hasOwn(root, 'cloudRestoredMediaActivation') ||
    o.originalPlan?.operationId !== o.recoveryOperationId
  )
    fail();
  const capture = async () => {
    const normal = await scanRestoredMediaInventory({
      client: o.client,
      plan: o.originalPlan,
      startup: null,
      rpc: o.rpc,
    });
    const diagnostic = await scanPrivateMediaInventory({
      client: o.client,
      db: o.firestore,
      plan: o.originalPlan,
      operationId: o.recoveryOperationId,
      read: o.read,
      rpc: o.rpc,
      auth: o.originalAuth,
    });
    const compute = await o.read(() =>
      observeNamespaceComputeIsolation(o.client, 'urm-app-staging.qwejt', { deadline: o.deadline })
    );
    age(compute);
    return { normal, diagnostic, computeSHA256: compute.inventorySHA256 };
  };
  const first = await capture();
  const second = await capture();
  if (hash(first) !== hash(second) || hash(await auth()) !== hash(root)) fail();
  return second;
}

/** Only fixed verified-source callers provide these readers. Neither a CLI
 * descriptor nor a receipt can supply an identity or a positive guard result. */
export async function observeRestoredMediaPhaseProtection(o) {
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
            () => reject(new Error('RESTORED_MEDIA_PHASE_PROTECTION_UNCONFIRMED')),
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
  const rpc = (fn) => read(() => o.client.connection.withDeadline(at + 5000, fn));
  try {
    const phase = o.phasePool,
      p = o.plan;
    if (
      o.client.options.namespace !== 'urm-app-staging.qwejt' ||
      phase?.kind !== 'restored-media-phase-resource-v1' ||
      phase.operationId !== o.operationId ||
      phase.planSHA256 !== hash(p) ||
      phase.key !== o.key ||
      !['before', 'successor', 'exact'].includes(phase.position)
    )
      fail();
    age(phase);
    const auth = () => read(() => assertRestoredMediaActivationAuthority(o));
    const root = await auth();
    if (hash(root.cloudRestoredMediaActivation) !== hash(o.state)) fail();
    const current = async () => {
      const x = await read(() => o.readStartup());
      age(x);
      if (
        x?.kind !== 'restored-media-phase-startup-v1' ||
        x.operationId !== o.operationId ||
        x.planSHA256 !== hash(p) ||
        x.scope !== 'identity-only-no-work-or-poll-authority'
      )
        fail();
      if (phase.position === 'before' && o.key === 'start' && x.stage !== 'absent') fail();
      if (o.key === 'retained' && (x.stage !== 'running' || !x.allowedPollerIdentity)) fail();
      if (o.key === 'stop' && !['running', 'closed'].includes(x.stage)) fail();
      if (o.key === 'stop' && x.stage === 'running' && !x.allowedPollerIdentity) fail();
      if (o.key === 'stopped' && (x.stage !== 'closed' || x.allowedPollerIdentity)) fail();
      return x;
    };
    const first = await current();
    const scan = async (startup) => {
      const normal = await scanRestoredMediaInventory({
        client: o.client,
        plan: p,
        startup: startup.allowedPollerIdentity
          ? {
              kind: 'restored-media-startup-witness-v1',
              operationId: p.operationId,
              planSHA256: hash(p),
              identity: startup.allowedPollerIdentity,
            }
          : null,
        rpc,
      });
      const diagnostic = await scanPrivateMediaInventory({
        client: o.client,
        db: o.firestore,
        plan: o.originalPlan,
        operationId: o.recoveryOperationId,
        read,
        rpc,
        auth: o.originalAuth,
      });
      return {
        protected: { normal: normal.protected, diagnostic },
        ownVersion: normal.ownVersion,
        ownedPollers: normal.ownedPollers,
      };
    };
    const before = await scan(first),
      middle = await current();
    assertRestoredMediaStartupProgress(first, middle);
    const after = await scan(middle),
      last = await current();
    assertRestoredMediaStartupProgress(middle, last);
    const compute = await read(() => observeNamespaceComputeIsolation(o.client, 'urm-app-staging.qwejt'));
    age(compute);
    if (
      hash(before.protected) !== hash(after.protected) ||
      (before.ownVersion && hash(before.ownVersion) !== hash(after.ownVersion)) ||
      hash(await auth()) !== hash(root)
    )
      fail();
    age(phase);
    fresh();
    return {
      kind: 'restored-media-activation-phase-v1',
      operationId: o.operationId,
      planSHA256: hash(p),
      key: o.key,
      phaseSHA256: hash({ plan: hash(p), key: o.key, provenance: phase.provenanceSHA256, inventory: after.protected }),
      computeSHA256: compute.inventorySHA256,
      ownStartupSHA256: last.ownFactsSHA256,
      ownedPollersSHA256: hash(after.ownedPollers),
      observedAt: new Date(at).toISOString(),
    };
  } catch {
    return fail();
  }
}
