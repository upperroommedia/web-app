import { isDeepStrictEqual as equal } from 'node:util';
import { proofDigest as hash, nativeSnapshotProof } from './temporal-release-runtime.mjs';
import { assertRestoredMediaActivationAuthority } from './temporal-media-restored-origin.mjs';
import { assertRestoredActivationState, assertRestoredActivationPool } from './temporal-media-restored-activation.mjs';
import { readMediaRecoveryAncestorAccess } from './temporal-bootstrap-pool.mjs';
import { verifyPreparedPoolMetadata } from './temporal-prepare-cloud-pool.mjs';
import { observeMediaDiskQuota, assertMediaDiskQuotaFresh } from './temporal-media-disk-quota.mjs';
const fail = () => {
  throw new Error('RESTORED_MEDIA_RESOURCE_UNCONFIRMED');
};
const names = Object.freeze({
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
const normalized = (x) =>
  typeof x === 'string' ? x.replace('projects/251680231116/', 'projects/urm-app-staging/') : fail();
const operation = (x) =>
  typeof x === 'string' &&
  /^projects\/(urm-app-staging|251680231116)\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/.test(x)
    ? normalized(x)
    : fail();
const matches = (expected, actual) =>
  Array.isArray(expected)
    ? Array.isArray(actual) && expected.length === actual.length && expected.every((v, i) => matches(v, actual[i]))
    : expected && typeof expected === 'object'
    ? actual && typeof actual === 'object' && Object.entries(expected).every(([k, v]) => matches(v, actual[k]))
    : expected === actual;
/** Read-only resource half. It cannot authorize private/normal pollers, work,
 * process counts, startup, retained registration, scale or promotion. */
async function inspect(o, kind) {
  const began = Date.now(),
    mono = performance.now();
  let live = true;
  const fresh = () => {
    if (!live || Date.now() < began || Date.now() - began >= 30000 || performance.now() - mono >= 30000) fail();
  };
  const read = async (fn) => {
    let timer;
    try {
      fresh();
      const value = await Promise.race([
        Promise.resolve().then(() => {
          fresh();
          return fn();
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('RESTORED_MEDIA_RESOURCE_UNCONFIRMED')),
            Math.min(5000, Math.max(1, 30000 - (Date.now() - began)))
          );
        }),
      ]);
      fresh();
      return value;
    } catch {
      live = false;
      return fail();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const p = o.plan;
    if (
      o.role !== 'media' ||
      !p ||
      p.operationId !== o.operationId ||
      p.recoveryOperationId !== o.recoveryOperationId ||
      p.bindingDigest !== o.bindingDigest ||
      p.releaseId !== o.releaseId ||
      p.evidenceDigest !== o.evidenceDigest ||
      p.buildId !== o.platform.workerBuildId ||
      p.image !== o.platform.workerImage ||
      hash(o.receipts) !== p.receiptsSHA256 ||
      Object.keys(o.receipts).sort().join(',') !== Object.keys(names).sort().join(',') ||
      Object.entries(o.receipts).some(([k, v]) => v.operationId !== p.receiptIds[k])
    )
      fail();
    const authority = () => read(() => assertRestoredMediaActivationAuthority(o));
    const root = await authority(),
      state = root.cloudRestoredMediaActivation;
    assertRestoredActivationState(state);
    if (!equal(state.plan, p)) fail();
    const snapshots = () =>
      read(() =>
        o.firestore.runTransaction(
          async (tx) => {
            const all = await Promise.all(
              Object.entries(names).map(([k, prefix]) =>
                tx.get(o.firestore.doc(`_control/${prefix}-${p.receiptIds[k]}`))
              )
            );
            const cap = await tx.get(o.firestore.doc(`_control/temporalMediaRecoveryCapsule-${p.recoveryOperationId}`));
            if (
              all.some(
                (s, i) =>
                  !s.exists ||
                  hash(s.data()) !== hash(o.receipts[Object.keys(names)[i]]) ||
                  hash(s.createTime) !== hash(s.updateTime)
              ) ||
              !cap.exists ||
              hash(cap.createTime) !== hash(cap.updateTime) ||
              hash(cap.createTime) !== hash(all.at(-1).createTime)
            )
              fail();
            const { capsuleSHA256, ...preimage } = cap.data();
            if (
              capsuleSHA256 !== p.origin.capsuleSHA256 ||
              hash(preimage) !== capsuleSHA256 ||
              cap.get('schemaVersion') !== 1 ||
              cap.get('kind') !== 'completed-media-recovery-provenance-only-v1' ||
              cap.get('operationId') !== p.recoveryOperationId ||
              cap.get('releaseId') !== p.releaseId ||
              cap.get('source.buildId') !== p.buildId ||
              cap.get('source.image') !== p.image ||
              cap.get('source.evidenceDigest') !== p.evidenceDigest ||
              cap.get('completionSHA256') !== hash(all.at(-1).data()) ||
              hash(cap.get('restoredPool')) !== hash(p.origin.pool)
            )
              fail();
            return { stamps: [...all, cap].map(nativeSnapshotProof), capsule: cap.data() };
          },
          { readOnly: true }
        )
      );
    const first = await snapshots(),
      { recovery: _recovery, ...receipts } = o.receipts;
    const api = (...args) => read(() => o.api(...args));
    // This narrow original-access helper never observes a current zero pool. Its
    // unused protection callback is source-fixed deny, not supplied by the caller.
    const ancestor = await read(() =>
      readMediaRecoveryAncestorAccess({ ...o, receipts, saved: undefined, observeProtection: fail, api })
    );
    if (
      first.capsule.source.ancestorsSHA256 !== ancestor.receiptsSHA256 ||
      ancestor.binding.buildId !== p.buildId ||
      ancestor.binding.image !== p.image ||
      ancestor.zeroPlan.body.name !== p.origin.pool.name ||
      ancestor.origin.uid !== p.origin.pool.uid
    )
      fail();
    let result;
    const sampled = Date.now(),
      sampleMono = performance.now();
    if (kind === 'quota') {
      result = await read(() => observeMediaDiskQuota(ancestor.zeroPlan, api));
      assertMediaDiskQuotaFresh(result);
    } else {
      if (![0, 1].includes(o.count)) fail();
      const before = p.origin.pool;
      let exact;
      if (o.count === 1) {
        if (!['acknowledged', 'completed'].includes(state.start?.stage) || state.stop?.stage === 'completed') fail();
        exact = state.start.pool;
      } else if (!state.start || !['acknowledged', 'completed'].includes(state.start.stage)) {
        // Before a start (including unknown ACK), zero has only original identity.
        exact = before;
      } else {
        if (!['acknowledged', 'completed'].includes(state.stop?.stage)) fail();
        exact = state.stop.pool;
      }
      const resource = await api(`https://run.googleapis.com/v2/${before.name}`);
      const pool = {
        ...verifyPreparedPoolMetadata(ancestor.zeroPlan, resource, { manualInstanceCount: o.count }),
        etag: resource.etag,
      };
      const revision = await api(`https://run.googleapis.com/v2/${before.revision}`);
      if (
        normalized(revision?.name) !== before.revision ||
        revision.uid !== before.revisionUid ||
        revision.deleteTime ||
        !matches(ancestor.zeroPlan.body.template, revision)
      )
        fail();
      pool.revisionUid = revision.uid;
      assertRestoredActivationPool(pool, before, o.count, o.count === 1 ? 1 : exact === before ? 0 : 2);
      if (exact && !equal(exact, pool)) fail();
      if (o.nativeResponse !== undefined) {
        const transition = o.count === 1 ? state.start : state.stop;
        if (transition?.stage !== 'acknowledged') fail();
        const name = operation(transition.nativeOperation),
          lro = await api(`https://run.googleapis.com/v2/${name}`);
        if (
          operation(lro?.name) !== name ||
          lro.done !== true ||
          lro.error ||
          hash(lro.response) !== hash(o.nativeResponse)
        )
          fail();
        const response = verifyPreparedPoolMetadata(ancestor.zeroPlan, lro.response, { manualInstanceCount: o.count });
        if (!equal(response, (({ etag, revisionUid, ...v }) => v)(pool))) fail();
      }
      result = pool;
    }
    if (
      hash(await snapshots()) !== hash(first) ||
      hash(await authority()) !== hash(root) ||
      Date.now() < sampled ||
      Date.now() - sampled >= 5000 ||
      performance.now() - sampleMono >= 5000
    )
      fail();
    if (kind === 'quota') assertMediaDiskQuotaFresh(result);
    return result;
  } catch {
    return fail();
  }
}
export const readRestoredMediaActivationPool = (o) => inspect(o, 'pool');
export const readRestoredMediaActivationQuota = (o) => inspect(o, 'quota');
