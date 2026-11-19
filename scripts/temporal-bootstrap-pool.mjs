import {observeMediaDiskQuota,assertMediaDiskQuotaFresh,assertMediaDiskQuotaProof} from './temporal-media-disk-quota.mjs';
import {verifyPreparedDirectPolicyGrant} from './temporal-preparation-iam.mjs';
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
import { verifyPreparedPoolMetadata, verifyPoolPreparationSecretPrerequisites } from './temporal-prepare-cloud-pool.mjs';
const fail = () => {
  throw new Error('CLOUD_RUN_ROLE_POOL_BOOTSTRAP_UNCONFIRMED');
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
function policyHas(policy,grant,resource){
  if(resource.startsWith('projects/_/buckets/')){
    if(policy?.kind!=='storage#policy'||policy.resourceId!==resource||Object.keys(policy).some(key=>!['kind','resourceId','bindings','version','etag'].includes(key)))fail();
    const {kind:_kind,resourceId:_id,...value}=policy;policy=value;
  }
  verifyPreparedDirectPolicyGrant(policy,grant,resource);
}
/** Read the requested source-derived grants, not a frozen whole project policy:
 * later legitimate grants can coexist. No inherited/effective isolation claim. */
async function verifyAccess(o, zeroPlan) {
  const { platform, role, settings, releaseId, evidenceDigest, receipts: r, api } = o,
    b = platform.roleBindings.find((b) => b.role === role);
  if(role==='media')assertMediaDiskQuotaProof(r.pool.identityState.prerequisites?.mediaDiskQuota);
  const runner = await readOwnedPreparationRunner(zeroPlan, r.runner, api),
    scaler = await readOwnedPreparationScaler({ ...zeroPlan, scaler: b.invokerServiceAccount }, r.scaler, api);
  if (runner.uniqueId === scaler.uniqueId || runner.uniqueId !== r.pool.identityState.prerequisites?.runnerUniqueId)
    fail();
  await verifyPoolPreparationSecretPrerequisites(zeroPlan, r.runner, api);
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
  policyHas(projectPolicy, expectedFirestore.grants[0], 'projects/urm-app-staging');
  const proofs = [];
  for (const surface of ['search','email'].includes(role) ? ['project'] : ['project', 'storage']) {
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
    const bucket = surface === 'storage' ? (role==='images'?platform.firebaseResources.imagesBucket:platform.firebaseResources.storageBucket) : undefined;
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
    policyHas(policy, expected.grants[0], resource);
    proofs.push(proofDigest({ owned, policy }));
  }
  const {observedAt:_observedAt,...scalerPolicyProjection}=scalerPolicies;
  return {
    runnerUniqueId: runner.uniqueId,
    scalerUniqueId: scaler.uniqueId,
    policiesSHA256: proofDigest({ scalerPolicies:scalerPolicyProjection, projectPolicy, proofs }),
  };
}
/** Bootstrap one unused source-bound role pool, observe its non-current native queue,
 * then stop that same pool under the SAME parent, including observation failure.
 * A later handoff activation needs its own reviewed operation; this cycle does
 * not promote routing, attach WCI, retire workers or prove live instance count.
 */
function deriveReviewedPoolOperation(o, mode, expectedRole) {
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
    role !== expectedRole ||
    !['controls','orchestration','search','email','images','media'].includes(expectedRole) ||
    !['cycle', 'retain', 'abort', 'inspect-promotion'].includes(mode) ||
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
  const baseKeys = [
    'runner',
    'scaler',
    'pool',
    'runnerScaler',
    'scalerTrust',
    'poolAccess',
    'firestore',
    'projectRole',
    'projectAccess',
    ...(['search','email'].includes(role) ? [] : ['storageRole', 'storageAccess']),
  ];
  const base = Object.fromEntries(baseKeys.map((key) => [key, r[key]]));
  const expectedKeys = [
    ...baseKeys,
    ...(mode !== 'cycle' ? ['bootstrapCycle'] : []),
    ...(['abort','inspect-promotion'].includes(mode) ? ['activation'] : []),
  ];
  if (Object.keys(r).sort().join(',') !== expectedKeys.sort().join(',')) fail();
  const originalCyclePlan = (id) => ({
    schemaVersion: 1,
    operationId: id,
    releaseId,
    evidenceDigest,
    role,
    buildId: b.buildId,
    name: body.name,
    ...(role==='media'?{mediaStartup:{canary:'filesystem-allocation-native-audio-and-kernel-v4',kernel:'owned-application-child-v1',image:b.image,runner:b.runnerServiceAccount,budgets:{sourceBytes:20*1024**3,outputBytes:20*1024**3,workspaceBytes:64*1024**3,headroomBytes:16*1024**3}}}:{}),
    poolReceiptSHA256: proofDigest(r.pool),
    settingsSHA256: proofDigest(settings),
    receiptsSHA256: proofDigest(base),
    origin: zero.pool,
  });
  const matchingPool = (pool, origin, count, increment) => {
    if (
      !pool ||
      pool.name !== origin.name ||
      pool.uid !== origin.uid ||
      pool.revision !== origin.revision ||
      pool.desiredManualInstanceCount !== count ||
      typeof pool.etag !== 'string' ||
      !pool.etag ||
      !/^[1-9][0-9]*$/.test(String(pool.generation ?? '')) ||
      BigInt(pool.generation) !== BigInt(origin.generation) + BigInt(increment)
    )
      fail();
    return pool;
  };
  const confirmed = (state) => {
    const p = state.observation?.registration;
    if (
      state.observation?.status !== 'confirmed' ||
      p?.role !== role ||
      p.buildId !== b.buildId ||
      !/^[a-f0-9]{64}$/.test(p.registrationSHA256 ?? '') ||
      !Number.isFinite(Date.parse(p.observedAt ?? ''))
    )
      fail();
  };
  let origin = zero.pool,
    cycle;
  if (mode !== 'cycle') {
    cycle = completed(r.bootstrapCycle, releaseId);
    if(role==='media')assertMediaDiskQuotaProof(cycle.start?.protection?.mediaDiskQuota);
    if (
      !isDeepStrictEqual(cycle.plan, originalCyclePlan(r.bootstrapCycle.operationId)) ||
      (cycle.disposition !== undefined && cycle.disposition !== 'stopped')
    )
      fail();
    confirmed(cycle);
    const start = cycle.start,
      stop = cycle.stop;
    if (
      start?.stage !== 'completed' ||
      stop?.stage !== 'completed' ||
      !isDeepStrictEqual(cycle.activationState, start) ||
      !isDeepStrictEqual(start.plan, {
        operationId: r.bootstrapCycle.operationId,
        mode: 'start',
        target: 1,
        origin: zero.pool,
      }) ||
      !isDeepStrictEqual(stop.plan, {
        operationId: r.bootstrapCycle.operationId,
        mode: 'stop',
        target: 0,
        origin: start.pool,
      })
    )
      fail();
    matchingPool(start.pool, zero.pool, 1, 1);
    origin = matchingPool(stop.pool, zero.pool, 0, 2);
  }
  const retentionPlan = (id) => ({
    schemaVersion: 2,
    operationId: id,
    releaseId,
    evidenceDigest,
    role,
    mode: 'retain',
    buildId: b.buildId,
    name: body.name,
    ...(role==='media'?{mediaStartup:{canary:'filesystem-allocation-native-audio-and-kernel-v4',kernel:'owned-application-child-v1',image:b.image,runner:b.runnerServiceAccount,budgets:{sourceBytes:20*1024**3,outputBytes:20*1024**3,workspaceBytes:64*1024**3,headroomBytes:16*1024**3}}}:{}),
    poolReceiptSHA256: proofDigest(r.pool),
    settingsSHA256: proofDigest(settings),
    receiptsSHA256: proofDigest({ ...base, bootstrapCycle: r.bootstrapCycle }),
    origin: cycle.stop.pool,
  });
  if (['abort','inspect-promotion'].includes(mode)) {
    const activation = completed(r.activation, releaseId);
    if(role==='media')assertMediaDiskQuotaProof(activation.start?.protection?.mediaDiskQuota);
    if (
      !isDeepStrictEqual(activation.plan, retentionPlan(r.activation.operationId)) ||
      activation.disposition !== 'retained' ||
      activation.stop !== undefined ||
      activation.start?.stage !== 'completed' ||
      !isDeepStrictEqual(activation.activationState, activation.start) ||
      !isDeepStrictEqual(activation.start.plan, {
        operationId: r.activation.operationId,
        mode: 'start',
        target: 1,
        origin,
      })
    )
      fail();
    confirmed(activation);
    const retained = activation.retainedRegistration;
    if (
      retained?.role !== role ||
      retained.buildId !== b.buildId ||
      !/^[a-f0-9]{64}$/.test(retained.registrationSHA256 ?? '') ||
      !Number.isFinite(Date.parse(retained.observedAt ?? ''))
    )
      fail();
    origin = matchingPool(activation.start.pool, origin, 1, 1);
  }
  const plan =
    mode === 'cycle'
      ? originalCyclePlan(operationId)
      : mode === 'retain'
      ? retentionPlan(operationId)
      : {
          schemaVersion: 2,
          operationId,
          releaseId,
          evidenceDigest,
          role,
          mode,
          buildId: b.buildId,
          name: body.name,
          ...(role==='media'?{mediaStartup:{canary:'filesystem-allocation-native-audio-and-kernel-v4',kernel:'owned-application-child-v1',image:b.image,runner:b.runnerServiceAccount,budgets:{sourceBytes:20*1024**3,outputBytes:20*1024**3,workspaceBytes:64*1024**3,headroomBytes:16*1024**3}}}:{}),
    poolReceiptSHA256: proofDigest(r.pool),
          settingsSHA256: proofDigest(settings),
          receiptsSHA256: proofDigest(r),
          origin,
        };
  return { b, zero, body, zeroPlan, origin, plan, confirmed };
}

async function runReviewedPoolOperation(o, mode, expectedRole) {
  const {platform,role,settings,operationId,releaseId,evidenceDigest,receipts:r,api,save,observeProtection,observeRegistration,saved}=o;
  const {b,zero,body,zeroPlan,origin,plan,confirmed}=deriveReviewedPoolOperation(o,mode,expectedRole);
  const url = `https://run.googleapis.com/v2/${body.name}`;
  let state = saved;
  const persist = async (next) => {
    await save(next);
    state = next;
  };
  const guard = async (allocationRequired=false) => {
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
    if(role!=='media'||!allocationRequired)return p;
    const mediaDiskQuota=await observeMediaDiskQuota(zeroPlan,api);
    if(Math.abs(Date.now()-Date.parse(p.observedAt))>5000)fail();
    return {...p,mediaDiskQuota};
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
  if(mode==='inspect-promotion') {
    // Fixed read-only entrypoint rederives the original retained chain and all
    // native resource permissions. No scale/checkpoint or noncurrent assumption.
    if(!['controls','search','email','images','media'].includes(role)||saved!==undefined)fail();
    const access=await verifyAccess(o,zeroPlan);
    const pool=await current(1);
    if(!isDeepStrictEqual(pool,origin))fail();
    return {role,buildId:b.buildId,pool,access,receiptsSHA256:proofDigest(r)};
  }
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
      const protection = await guard(target===1),
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
      const fresh = await guard(target===1);
      if(role==='media'&&target===1){assertMediaDiskQuotaFresh(protection.mediaDiskQuota);assertMediaDiskQuotaFresh(fresh.mediaDiskQuota);if(fresh.mediaDiskQuota.quotaSHA256!==protection.mediaDiskQuota.quotaSHA256)fail();}
      if (
        fresh.protectionSHA256 !== protection.protectionSHA256 ||
        fresh.computeInventorySHA256 !== protection.computeInventorySHA256 ||
        Date.now() - Date.parse(fresh.observedAt) > 5000
      )
        fail();
      let ack;
      let sendAuthorized = false;
      try {
        ack = await api(request.url, request.method, request.body, async () => {
          // The controller invokes this source-owned fence after obtaining its
          // Google credential. A slow credential refresh cannot renew authority.
          if(role==='media'&&target===1)assertMediaDiskQuotaFresh(protection.mediaDiskQuota);
          const atSend = await guard(target===1);
          if(role==='media'&&target===1){assertMediaDiskQuotaFresh(protection.mediaDiskQuota);assertMediaDiskQuotaFresh(atSend.mediaDiskQuota);if(atSend.mediaDiskQuota.quotaSHA256!==protection.mediaDiskQuota.quotaSHA256)fail();}
          if (
            atSend.protectionSHA256 !== protection.protectionSHA256 ||
            atSend.computeInventorySHA256 !== protection.computeInventorySHA256 ||
            Math.abs(Date.now() - Date.parse(atSend.observedAt)) > 5000
          )
            fail();
          sendAuthorized = true;
        });
      } catch (error) {
        // A credential or protected read failure is not the scale request's response.
        if (!sendAuthorized) return fail();
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
    if(role==='media'&&state?.start&&state.start.stage!=='planned')assertMediaDiskQuotaProof(state.start.protection?.mediaDiskQuota);
    if (!state) await persist({ plan, stage: 'planned' });
    if (state.stage === 'completed') {
      await verifyAccess(o, zeroPlan);
      await guard();
      if (mode === 'retain' && state.disposition === 'retained') {
        if (
          state.stop ||
          !isDeepStrictEqual(state.activationState, state.start) ||
          !isDeepStrictEqual(await current(1), state.start?.pool)
        )
          fail();
        confirmed(state);
        if (
          state.retainedRegistration?.role !== role ||
          state.retainedRegistration.buildId !== b.buildId ||
          !/^[a-f0-9]{64}$/.test(state.retainedRegistration.registrationSHA256 ?? '') ||
          !Number.isFinite(Date.parse(state.retainedRegistration.observedAt ?? ''))
        )
          fail();
        const fresh = await observeRegistration();
        if (
          fresh?.role !== role ||
          fresh.buildId !== b.buildId ||
          !/^[a-f0-9]{64}$/.test(fresh.registrationSHA256 ?? '') ||
          !Number.isFinite(Date.parse(fresh.observedAt ?? '')) ||
          Math.abs(Date.now() - Date.parse(fresh.observedAt)) > 5000
        )
          fail();
        await guard();
        if (!isDeepStrictEqual(await current(1), state.start.pool)) fail();
        return state;
      }
      if (!state.stop || !isDeepStrictEqual(await current(0), state.stop.pool)) fail();
      if (mode === 'retain' || (mode !== 'abort' && state.observation?.status !== 'confirmed')) fail();
      return state;
    }
    if (mode === 'abort') {
      await persist({ ...state, stage: 'stopping' });
      await scale('stop', 0, origin);
      await persist({
        ...state,
        stage: 'completed',
        disposition: 'stopped',
        verifiedAt: new Date().toISOString(),
        scope: 'owned unused non-current activation stop; desired zero not observed process termination or drainage',
      });
      return state;
    }
    if (!state.activationState) {
      await persist({ ...state, stage: 'starting' });
      const start = await scale('start', 1, origin);
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
    if (mode === 'retain' && state.observation.status === 'confirmed' && !state.stop && !state.retentionFailed) {
      let retainedRegistration;
      try {
        await verifyAccess(o, zeroPlan);
        retainedRegistration = await observeRegistration();
        if (
          retainedRegistration?.role !== role ||
          retainedRegistration.buildId !== b.buildId ||
          !/^[a-f0-9]{64}$/.test(retainedRegistration.registrationSHA256 ?? '') ||
          !Number.isFinite(Date.parse(retainedRegistration.observedAt ?? ''))
        )
          fail();
        await guard();
        if (
          !isDeepStrictEqual(await current(1), state.start.pool) ||
          Math.abs(Date.now() - Date.parse(retainedRegistration.observedAt)) > 5000
        )
          fail();
      } catch {
        // This decision is persisted before any cleanup attempt and never expires.
        await persist({ ...state, stage: 'stopping', retentionFailed: true });
      }
      if (!state.retentionFailed) {
        // Unknown completion-checkpoint ACK retains ownership, never infers a
        // cleanup decision or stops a possibly committed retained activation.
        await persist({
          ...state,
          stage: 'completed',
          disposition: 'retained',
          retainedRegistration,
          verifiedAt: new Date().toISOString(),
          scope:
            'owned role-bound desired-one non-current registration retained for separate guarded handoff; not live count, effective runtime access, promotion, WCI or readiness',
        });
        return state;
      }
    }
    // Failure/timeout does not bypass owned cleanup, and cleanup never expires.
    await scale('stop', 0, state.start.pool);
    await persist({
      ...state,
      stage: 'completed',
      disposition: 'stopped',
      verifiedAt: new Date().toISOString(),
      scope:
        'owned role-bound bootstrap/stop cycle; desired counts not live process counts; unknown ACK not causal; no promotion/WCI/drainage/readiness',
    });
    if (state.observation.status !== 'confirmed' || mode === 'retain') fail();
    return state;
  } catch {
    return fail();
  }
}

// Fixed entrypoints: descriptors cannot choose a cleanup policy or role.
const execute = async (o, mode, role) => {
  try {
    return await runReviewedPoolOperation(o, mode, role);
  } catch {
    return fail();
  }
};
export const bootstrapStopCloudRunControlsPool = (o) => execute(o, 'cycle', 'controls');
export const activateCloudRunControlsPool = (o) => execute(o, 'retain', 'controls');
export const stopCloudRunControlsActivation = (o) => execute(o, 'abort', 'controls');

export const bootstrapStopCloudRunOrchestrationPool=o=>execute(o,'cycle','orchestration');
export const activateCloudRunOrchestrationPool=o=>execute(o,'retain','orchestration');
export const stopCloudRunOrchestrationActivation=o=>execute(o,'abort','orchestration');

export const bootstrapStopCloudRunSearchPool=o=>execute(o,'cycle','search');
export const activateCloudRunSearchPool=o=>execute(o,'retain','search');
export const stopCloudRunSearchActivation=o=>execute(o,'abort','search');

export const bootstrapStopCloudRunEmailPool=o=>execute(o,'cycle','email');
export const activateCloudRunEmailPool=o=>execute(o,'retain','email');
export const stopCloudRunEmailActivation=o=>execute(o,'abort','email');

export const bootstrapStopCloudRunImagesPool=o=>execute(o,'cycle','images');
export const activateCloudRunImagesPool=o=>execute(o,'retain','images');
export const stopCloudRunImagesActivation=o=>execute(o,'abort','images');

export const bootstrapStopCloudRunMediaPool=o=>execute(o,'cycle','media');
export const activateCloudRunMediaPool=o=>execute(o,'retain','media');
export const stopCloudRunMediaActivation=o=>execute(o,'abort','media');

export const verifyControlsPromotionResources=o=>execute(o,'inspect-promotion','controls');

export const verifySearchPromotionResources=o=>execute(o,'inspect-promotion','search');

export const verifyEmailPromotionResources=o=>execute(o,'inspect-promotion','email');

export const verifyImagesPromotionResources=o=>execute(o,'inspect-promotion','images');

export const verifyMediaPromotionResources=o=>execute(o,'inspect-promotion','media');

/** Fixed media-only ancestor reader for a separate recovery cycle. Normal bootstrap
 * modes and original-revision checks above remain unchanged. No checkpoint/write. */
export async function readMediaRecoveryAncestorAccess(o) {
  if(o.role!=='media'||o.saved!==undefined||!o.receipts||new Set(Object.values(o.receipts).map(r=>r?.operationId)).size!==12||Object.values(o.receipts).some(r=>!uuid.test(r?.operationId??'')||r.operationId===o.operationId))fail();
  const args={...o,save:()=>fail(),observeRegistration:()=>fail()};
  const {b,zeroPlan,origin}=deriveReviewedPoolOperation(args,'retain','media');
  const access=await verifyAccess(args,zeroPlan);
  return {binding:b,zeroPlan,origin,access,receiptsSHA256:proofDigest(o.receipts)};
}
export async function readMediaRecoveryNormalOrigin(o) {
  const result=await readMediaRecoveryAncestorAccess(o);
  const resource=await o.api(`https://run.googleapis.com/v2/${result.zeroPlan.body.name}`);
  const pool={...verifyPreparedPoolMetadata(result.zeroPlan,resource),etag:resource.etag};
  if(!pool.etag||!isDeepStrictEqual(pool,result.origin))fail();
  return {...result,pool};
}
