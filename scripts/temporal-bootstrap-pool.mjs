import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import {
  validateCloudRunReleasePlatform,
  verifyCloudRunScalerPolicies,
  temporalCloudScalerPrincipals,
} from './temporal-release-cloud-run.mjs';
import { renderServerlessWorkerPool } from './temporal-serverless-resources.mjs';
import {
  readOwnedPreparationRunner,
  readOwnedPreparationScaler,
  renderPreparationWorkload,
} from './temporal-preparation-resources.mjs';
import { readOwnedPreparationRuntimeRole } from './temporal-prepare-runtime-role.mjs';
import { verifyPreparedPoolMetadata, verifyPoolPreparationPrerequisites } from './temporal-prepare-cloud-pool.mjs';
const fail = () => {
  throw new Error('CLOUD_RUN_CONTROLS_BOOTSTRAP_UNCONFIRMED');
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const rawHash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const opName = (x) =>
  typeof x === 'string' &&
  /^projects\/(urm-app-staging|251680231116)\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/.test(x)
    ? x.replace('projects/251680231116/', 'projects/urm-app-staging/')
    : fail();
const completed = (r, releaseId) => {
  if (
    !r ||
    !uuid.test(r.operationId ?? '') ||
    r.releaseId !== releaseId ||
    r.identityState?.stage !== 'completed' ||
    r.identityState.plan?.operationId !== r.operationId
  )
    fail();
  return r.identityState;
};
function policyHas(policy, grant) {
  if (
    typeof policy?.etag !== 'string' ||
    !policy.etag ||
    !Array.isArray(policy.bindings) ||
    policy.bindings.some(
      (b) => !Array.isArray(b.members) || b.members.some((m) => m === 'allUsers' || m === 'allAuthenticatedUsers')
    )
  )
    fail();
  const matches = policy.bindings.filter(
    (b) => b.role === grant.role && isDeepStrictEqual(b.condition, grant.condition)
  );
  if (matches.length !== 1 || !grant.members.every((m) => matches[0].members.includes(m))) fail();
}
/** Read the requested source-derived grants, not a frozen whole project policy:
 * later legitimate grants can coexist. No inherited/effective isolation claim. */
async function verifyAccess(o, zeroPlan) {
  const { platform, role, settings, releaseId, evidenceDigest, receipts: r, api } = o,
    b = platform.roleBindings.find((b) => b.role === role);
  const runner = await readOwnedPreparationRunner(zeroPlan, r.runner, api),
    scaler = await readOwnedPreparationScaler({ ...zeroPlan, scaler: b.invokerServiceAccount }, r.scaler, api);
  if (runner.uniqueId === scaler.uniqueId || runner.uniqueId !== r.pool.identityState.prerequisites?.runnerUniqueId)
    fail();
  await verifyPoolPreparationPrerequisites(zeroPlan, r.runner, api);
  const scalerPolicies = await verifyCloudRunScalerPolicies(platform, api, [role]);
  const account = (email) => `projects/urm-app-staging/serviceAccounts/${email}`;
  const scalerGrants = {
    runnerScaler: {
      surface: 'runner-scaler-user',
      resource: account(b.runnerServiceAccount),
      grants: [{ role: 'roles/iam.serviceAccountUser', members: [`serviceAccount:${b.invokerServiceAccount}`] }],
    },
    scalerTrust: {
      surface: 'scaler-trust',
      resource: account(b.invokerServiceAccount),
      grants: [{ role: 'roles/iam.serviceAccountTokenCreator', members: [...temporalCloudScalerPrincipals] }],
    },
    poolAccess: {
      surface: 'pool-access',
      resource: zeroPlan.body.name,
      grants: [
        { role: 'roles/run.viewer', members: [`serviceAccount:${b.runnerServiceAccount}`] },
        { role: 'roles/run.developer', members: [`serviceAccount:${b.invokerServiceAccount}`] },
      ],
    },
  };
  for (const [key, v] of Object.entries(scalerGrants)) {
    const state = completed(r[key], releaseId),
      p = state.plan;
    const expected = {
      schemaVersion: 1,
      operationId: r[key].operationId,
      releaseId,
      evidenceDigest,
      role,
      surface: v.surface,
      buildId: b.buildId,
      runner: b.runnerServiceAccount,
      scaler: b.invokerServiceAccount,
      resource: v.resource,
      grants: v.grants,
      settingsSHA256: proofDigest(settings),
      runnerReceiptSHA256: proofDigest(r.runner),
      scalerReceiptSHA256: proofDigest(r.scaler),
      poolReceiptSHA256: proofDigest(r.pool),
    };
    if (
      !isDeepStrictEqual(p, expected) ||
      state.prerequisites?.runnerUniqueId !== runner.uniqueId ||
      state.prerequisites?.scalerUniqueId !== scaler.uniqueId
    )
      fail();
  }
  const member = `serviceAccount:${b.runnerServiceAccount}`,
    database = 'projects/urm-app-staging/databases/(default)',
    workload = renderPreparationWorkload(platform, role, settings);
  const expectedFirestore = {
    schemaVersion: 1,
    operationId: r.firestore.operationId,
    releaseId,
    evidenceDigest,
    role,
    buildId: b.buildId,
    runner: b.runnerServiceAccount,
    resource: 'projects/urm-app-staging',
    database,
    workload: { type: workload.type, name: workload.body.name },
    settingsSHA256: proofDigest(settings),
    identityReceiptSHA256: proofDigest(r.runner),
    grants: [
      {
        role: 'roles/datastore.user',
        members: [member],
        condition: { title: 'urm-temporal-default-firestore', expression: `resource.name=="${database}"` },
      },
    ],
  };
  const f = completed(r.firestore, releaseId);
  if (!isDeepStrictEqual(f.plan, expectedFirestore) || f.prerequisites?.runnerUniqueId !== runner.uniqueId) fail();
  const db = await api(`https://firestore.googleapis.com/v1/${database}`),
    old = f.prerequisites?.database;
  if (
    !old ||
    old.name !== database ||
    old.type !== 'FIRESTORE_NATIVE' ||
    old.locationId !== 'us-central1' ||
    db?.name !== database ||
    db.uid !== old.uid ||
    !db.uid ||
    db.type !== 'FIRESTORE_NATIVE' ||
    db.locationId !== 'us-central1' ||
    db.deleteTime
  )
    fail();
  const projectPolicy = await api(
    'https://cloudresourcemanager.googleapis.com/v1/projects/urm-app-staging:getIamPolicy',
    'POST',
    { options: { requestedPolicyVersion: 3 } }
  );
  policyHas(projectPolicy, expectedFirestore.grants[0]);
  const proofs = [];
  for (const surface of ['project', 'storage']) {
    const roleReceipt = r[`${surface}Role`],
      access = completed(r[`${surface}Access`], releaseId);
    const owned = await readOwnedPreparationRuntimeRole({
      platform,
      role,
      surface,
      settings,
      releaseId,
      evidenceDigest,
      identityReceipt: r.runner,
      roleReceipt,
      api,
    });
    const bucket = surface === 'storage' ? platform.firebaseResources.storageBucket : undefined;
    const resource = bucket ? `projects/_/buckets/${bucket}` : 'projects/urm-app-staging';
    const expected = {
      schemaVersion: 1,
      operationId: r[`${surface}Access`].operationId,
      releaseId,
      evidenceDigest,
      role,
      surface,
      buildId: b.buildId,
      runner: b.runnerServiceAccount,
      pool: zeroPlan.body.name,
      resource,
      settingsSHA256: proofDigest(settings),
      identityReceiptSHA256: proofDigest(r.runner),
      roleReceiptSHA256: proofDigest(roleReceipt),
      grants: [
        { role: `projects/urm-app-staging/roles/${roleReceipt.identityState.plan.request.roleId}`, members: [member] },
      ],
    };
    if (!isDeepStrictEqual(access.plan, expected) || access.prerequisites?.runnerUniqueId !== runner.uniqueId) fail();
    let policy = projectPolicy;
    if (bucket) {
      const metadata = await api(
          `https://storage.googleapis.com/storage/v1/b/${bucket}?fields=name,id,projectNumber,timeCreated`
        ),
        original = access.prerequisites?.resourceIdentity;
      if (
        !original ||
        !Number.isFinite(Date.parse(original.timeCreated ?? '')) ||
        metadata?.name !== bucket ||
        metadata.id !== bucket ||
        metadata.projectNumber !== '251680231116' ||
        metadata.timeCreated !== original.timeCreated ||
        original.name !== bucket ||
        original.id !== bucket ||
        original.projectNumber !== metadata.projectNumber
      )
        fail();
      policy = await api(`https://storage.googleapis.com/storage/v1/b/${bucket}/iam?optionsRequestedPolicyVersion=3`);
      if (policy.kind !== 'storage#policy' || policy.resourceId !== resource) fail();
    }
    policyHas(policy, expected.grants[0]);
    proofs.push(proofDigest({ owned, policy }));
  }
  return {
    runnerUniqueId: runner.uniqueId,
    scalerUniqueId: scaler.uniqueId,
    policiesSHA256: proofDigest({ scalerPolicies, projectPolicy, proofs }),
  };
}
/** Bootstrap one unused controls pool, observe its non-current native queue,
 * then stop that same pool under the SAME parent, including observation failure.
 * A later handoff activation needs its own reviewed operation; this cycle does
 * not promote routing, attach WCI, retire workers or prove live instance count.
 */
export async function bootstrapStopCloudRunControlsPool(o) {
  const {
    platform,
    role,
    settings,
    operationId,
    releaseId,
    evidenceDigest,
    receipts: r,
    api,
    save,
    observeProtection,
    observeRegistration,
    saved,
  } = o;
  validateCloudRunReleasePlatform(platform);
  if (
    role !== 'controls' ||
    !uuid.test(operationId ?? '') ||
    !uuid.test(releaseId ?? '') ||
    !/^[a-f0-9]{64}$/.test(evidenceDigest ?? '') ||
    [api, save, observeProtection, observeRegistration].some((f) => typeof f !== 'function')
  )
    fail();
  const b = platform.roleBindings.find((b) => b.role === role),
    zero = completed(r.pool, releaseId),
    body = renderServerlessWorkerPool(b, settings);
  body.annotations = { 'urm.upperroom.media/preparation': r.pool.operationId };
  const zeroPlan = {
    schemaVersion: 1,
    operationId: r.pool.operationId,
    releaseId,
    evidenceDigest,
    role,
    buildId: b.buildId,
    runner: b.runnerServiceAccount,
    identityReceiptSHA256: rawHash(r.runner),
    body,
  };
  if (
    !isDeepStrictEqual(zero.plan, zeroPlan) ||
    zero.pool?.name !== body.name ||
    zero.pool.desiredManualInstanceCount !== 0
  )
    fail();
  const plan = {
    schemaVersion: 1,
    operationId,
    releaseId,
    evidenceDigest,
    role,
    buildId: b.buildId,
    name: body.name,
    poolReceiptSHA256: proofDigest(r.pool),
    settingsSHA256: proofDigest(settings),
    receiptsSHA256: proofDigest(r),
    origin: zero.pool,
  };
  const url = `https://run.googleapis.com/v2/${body.name}`;
  let state = saved;
  const persist = async (next) => {
    await save(next);
    state = next;
  };
  const guard = async () => {
    const p = await observeProtection();
    if (
      p?.role !== role ||
      p.buildId !== b.buildId ||
      p.namespace !== platform.temporalNamespace ||
      !/^[a-f0-9]{64}$/.test(p.protectionSHA256 ?? '') ||
      !/^[a-f0-9]{64}$/.test(p.computeInventorySHA256 ?? '') ||
      !Number.isFinite(Date.parse(p.observedAt)) ||
      Math.abs(Date.now() - Date.parse(p.observedAt)) > 5000
    )
      fail();
    return p;
  };
  const current = async (count) => {
    const resource = await api(url),
      pool = verifyPreparedPoolMetadata(zeroPlan, resource, { manualInstanceCount: count });
    if (
      pool.uid !== zero.pool.uid ||
      pool.revision !== zero.pool.revision ||
      typeof resource.etag !== 'string' ||
      !resource.etag
    )
      fail();
    return { ...pool, etag: resource.etag };
  };
  const scale = async (key, target, origin) => {
    let x = state[key];
    const scalePlan = { operationId, mode: key, target, origin };
    const put = async (next) => {
      await persist({ ...state, [key]: next });
      x = next;
    };
    if (
      x !== undefined &&
      (!x ||
        !isDeepStrictEqual(x.plan, scalePlan) ||
        !['planned', 'attempted', 'acknowledged', 'completed', 'rejected', 'failed'].includes(x.stage))
    )
      fail();
    if (!x) {
      await put({ plan: scalePlan, stage: 'planned' });
    }
    if (['rejected', 'failed'].includes(x.stage)) fail();
    if (x.stage === 'planned') {
      const access = await verifyAccess(o, zeroPlan),
        before = await current(1 - target);
      const { etag, ...projection } = before;
      const { etag: originEtag, ...originProjection } = origin;
      if (!isDeepStrictEqual(projection, originProjection) || (originEtag !== undefined && etag !== originEtag)) fail();
      const protection = await guard(),
        request = {
          url: `${url}?updateMask=scaling`,
          method: 'PATCH',
          body: { name: body.name, etag, scaling: { manualInstanceCount: target } },
        };
      await put({
        plan: scalePlan,
        stage: 'attempted',
        attemptedAt: new Date().toISOString(),
        before,
        access,
        protection,
        request,
      });
      // Recheck native account/grants and protection AFTER the awaited checkpoint.
      await verifyAccess(o, zeroPlan);
      const fresh = await guard();
      if (fresh.protectionSHA256 !== protection.protectionSHA256 || Date.now() - Date.parse(fresh.observedAt) > 5000)
        fail();
      let ack;
      try {
        ack = await api(request.url, request.method, request.body);
      } catch (error) {
        if (
          Number.isInteger(error?.status) &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 429].includes(error.status)
        ) {
          await put({ ...x, stage: 'rejected', rejectedStatus: error.status });
          return fail();
        }
      }
      if (ack) {
        await put({ ...x, stage: 'acknowledged', nativeOperation: opName(ack.name) });
      }
    }
    if (
      !x.before ||
      !x.access ||
      !x.protection ||
      !Number.isFinite(Date.parse(x.attemptedAt ?? '')) ||
      !isDeepStrictEqual(x.request, {
        url: `${url}?updateMask=scaling`,
        method: 'PATCH',
        body: { name: body.name, etag: x.before.etag, scaling: { manualInstanceCount: target } },
      })
    )
      fail();
    await verifyAccess(o, zeroPlan);
    await guard();
    if (x.stage === 'acknowledged') {
      const name = opName(x.nativeOperation),
        end = Date.now() + 30000;
      let result;
      do {
        result = await api(`https://run.googleapis.com/v2/${name}`);
        if (opName(result?.name) !== name) fail();
        if (result.done === true) break;
        if ((result.done !== undefined && result.done !== false) || Date.now() >= end) fail();
        await new Promise((r) => setTimeout(r, 200));
      } while (Date.now() < end);
      if (result?.done !== true) fail();
      if (result.error) {
        await put({ ...x, stage: 'failed', errorSHA256: proofDigest(result.error) });
        return fail();
      }
      const response = verifyPreparedPoolMetadata(zeroPlan, result.response, { manualInstanceCount: target }),
        now = await current(target);
      if (proofDigest(response) !== proofDigest((({ etag, ...p }) => p)(now))) fail();
    }
    const pool = await current(target);
    if (BigInt(pool.generation) !== BigInt(origin.generation) + 1n) fail();
    if (x.stage === 'completed') {
      if (!isDeepStrictEqual(x.pool, pool)) fail();
      return x;
    }
    await guard();
    const final = await current(target);
    if (!isDeepStrictEqual(final, pool)) fail();
    await put({
      ...x,
      stage: 'completed',
      pool,
      verifiedAt: new Date().toISOString(),
      outcome:
        x.stage === 'acknowledged' ? 'native-acknowledgement-and-readback' : 'desired-count-observed-after-unknown-ack',
    });
    return x;
  };
  try {
    if (
      state !== undefined &&
      (!state ||
        !isDeepStrictEqual(state.plan, plan) ||
        !['planned', 'starting', 'started', 'stopping', 'completed'].includes(state.stage))
    )
      fail();
    if (!state) await persist({ plan, stage: 'planned' });
    if (state.stage === 'completed') {
      await verifyAccess(o, zeroPlan);
      await guard();
      if (!state.stop || !isDeepStrictEqual(await current(0), state.stop.pool)) fail();
      if (state.observation?.status !== 'confirmed') fail();
      return state;
    }
    if (!state.activationState) {
      await persist({ ...state, stage: 'starting' });
      const start = await scale('start', 1, zero.pool);
      // Atomic immutable activation record before native observation or cleanup.
      await persist({ ...state, stage: 'started', activationState: start });
    }
    if (!isDeepStrictEqual(state.activationState, state.start) || state.start?.stage !== 'completed') fail();
    if (!state.observation) {
      let observation;
      try {
        const registration = await observeRegistration();
        if (
          registration?.role !== role ||
          registration.buildId !== b.buildId ||
          !/^[a-f0-9]{64}$/.test(registration.registrationSHA256 ?? '') ||
          !Number.isFinite(Date.parse(registration.observedAt)) ||
          Math.abs(Date.now() - Date.parse(registration.observedAt)) > 5000
        )
          fail();
        await guard();
        if (!isDeepStrictEqual(await current(1), state.start.pool)) fail();
        observation = { status: 'confirmed', registration };
      } catch {
        observation = { status: 'unconfirmed' };
      }
      await persist({ ...state, stage: 'stopping', observation });
    }
    // Failure/timeout does not bypass owned cleanup, and cleanup never expires.
    await scale('stop', 0, state.start.pool);
    await persist({
      ...state,
      stage: 'completed',
      verifiedAt: new Date().toISOString(),
      scope:
        'owned controls bootstrap/stop cycle; desired counts not live process counts; unknown ACK not causal; no promotion/WCI/drainage/readiness',
    });
    if (state.observation.status !== 'confirmed') fail();
    return state;
  } catch {
    return fail();
  }
}
