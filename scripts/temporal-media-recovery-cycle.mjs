import { renderMediaRecoveryJob } from './temporal-media-recovery-job.mjs';
import {assertStoredMediaDiagnosticDrain} from './temporal-media-diagnostic-drain.mjs';
import { isDeepStrictEqual as equal } from 'node:util';
import { proofDigest as hash } from './temporal-release-runtime.mjs';
import { readMediaRecoveryAncestorAccess, readMediaRecoveryNormalOrigin } from './temporal-bootstrap-pool.mjs';
import { verifyPreparedPoolMetadata } from './temporal-prepare-cloud-pool.mjs';
import { observeMediaDiskQuota, assertMediaDiskQuotaFresh } from './temporal-media-disk-quota.mjs';
const fail = () => {
  throw new Error('MEDIA_RECOVERY_CYCLE_UNCONFIRMED');
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const freeze = (x) => {
  if (x && typeof x === 'object') {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
};
const sha = (x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const operation = (x) =>
  typeof x === 'string' &&
  /^projects\/(urm-app-staging|251680231116)\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/.test(x)
    ? x.replace('projects/251680231116/', 'projects/urm-app-staging/')
    : fail();
/** This contract is separate from normal role routing and ordinary readiness. */
const contract = Object.freeze({
  deploymentName: 'urm-worker-media-recovery-staging',
  queue: 'urm-media-kernel-recovery',
  workflowType: 'MediaRecoveryProbe',
  protocol: 'owned-media-recovery-v1',
});
export function diagnosticTemplate(normal, operationId) {
  const t = structuredClone(normal),
    env = t.containers?.[0]?.env;
  if (!Array.isArray(env)) fail();
  for (const [name, value] of Object.entries({
    TEMPORAL_DEPLOYMENT_NAME: contract.deploymentName,
    TEMPORAL_TASK_QUEUES: contract.queue,
  })) {
    const rows = env.filter((v) => v.name === name);
    if (rows.length !== 1 || typeof rows[0].value !== 'string') fail();
    rows[0].value = value;
  }
  if (env.some((v) => v.name === 'TEMPORAL_WORKFLOW_BUNDLE')) fail();
  env.push({
    name: 'TEMPORAL_WORKFLOW_BUNDLE',
    value: '/workspace/apps/temporal-worker/lib/media-recovery-workflow-bundle.js',
  });
  if (env.some((v) => v.name === 'TEMPORAL_MEDIA_RECOVERY_OPERATION')) fail();
  env.push({ name: 'TEMPORAL_MEDIA_RECOVERY_OPERATION', value: operationId });
  return t;
}
function proof(value, plan, kind) {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== (kind==='drained'?'bindingDigest,buildId,image,kind,observation,operationId,proofSHA256':'bindingDigest,buildId,image,kind,operationId,proofSHA256') ||
    value.operationId !== plan.operationId ||
    value.bindingDigest !== plan.bindingDigest ||
    value.buildId !== plan.buildId ||
    value.image !== plan.image ||
    value.kind !== kind ||
    !sha(value.proofSHA256)
  )
    fail();
  if(kind==='drained'&&value.proofSHA256!==hash(value.observation))fail();
  return value;
}
/** One source-fixed cycle, never a normal bootstrap mode or promotion receipt.
 * Runtime methods are frozen canonical adapters, not CLI-supplied callbacks.
 * They remain mandatory even in unit fixtures; an unavailable adapter must deny
 * before the first checkpoint or native mutation.
 */
export async function runMediaRecoveryCycle(o) {
  const { api, save, observeProtection, authorizeMutation, runtime } = o;
  if (
    o.role !== 'media' ||
    !uuid.test(o.operationId ?? '') ||
    !uuid.test(o.releaseId ?? '') ||
    !sha(o.bindingDigest) ||
    [
      api,
      save,
      observeProtection,
      authorizeMutation,
      ...['assertSupported', 'prepare', 'execute', 'drain', 'confirmStopped', 'confirmNeverStarted'].map(
        (k) => runtime?.[k]
      ),
    ].some((v) => typeof v !== 'function')
  )
    fail();
  // Actual canonical integration deliberately cannot manufacture this capability
  // from controlled local tests, desired counts or a normal registration receipt.
  await runtime.assertSupported({
    operationId: o.operationId,
    buildId: o.platform.workerBuildId,
    image: o.platform.workerImage,
    contract,
  });
  const baseOptions = { ...o, saved: undefined };
  const ancestors = await readMediaRecoveryAncestorAccess(baseOptions);
  const revision = async (name, template) => {
    const prefix = `${ancestors.zeroPlan.body.name}/revisions/`;
    if (!name.startsWith(prefix) || !/^[a-z0-9-]{1,63}$/.test(name.slice(prefix.length))) fail();
    const actual = await api(`https://run.googleapis.com/v2/${name}`);
    const same = (expected, value) =>
      Array.isArray(expected)
        ? Array.isArray(value) && expected.length === value.length && expected.every((v, i) => same(v, value[i]))
        : expected && typeof expected === 'object'
        ? value && typeof value === 'object' && Object.entries(expected).every(([k, v]) => same(v, value[k]))
        : expected === value;
    if (
      !actual ||
      actual.name?.replace('projects/251680231116/', 'projects/urm-app-staging/') !== name ||
      typeof actual.uid !== 'string' ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(actual.uid) ||
      actual.deleteTime ||
      !same(template, actual)
    )
      fail();
    return actual.uid;
  };
  const originRevisionUid = await revision(ancestors.origin.revision, ancestors.zeroPlan.body.template);
  let state = o.saved,
    startCheckpointIssued = false;
  const createdAt = state?.plan?.createdAt ?? new Date().toISOString();
  const jobMode = typeof runtime.launchJob === 'function';
  if (jobMode && typeof runtime.drainJob !== 'function') fail();
  const taskAttestationPublicKey = jobMode && typeof runtime.prepareTaskAttestation === 'function'
    ? runtime.prepareTaskAttestation(o.operationId, state?.plan)
    : undefined;
  const proposed = {
    schemaVersion: 1,
    operationId: o.operationId,
    releaseId: o.releaseId,
    bindingDigest: o.bindingDigest,
    evidenceDigest: o.evidenceDigest,
    role: 'media',
    buildId: ancestors.binding.buildId,
    image: ancestors.binding.image,
    runner: ancestors.binding.runnerServiceAccount,
    name: ancestors.zeroPlan.body.name,
    ancestorsSHA256: ancestors.receiptsSHA256,
    origin: { ...ancestors.origin, revisionUid: originRevisionUid },
    normalTemplate: ancestors.zeroPlan.body.template,
    diagnosticTemplate: diagnosticTemplate(ancestors.zeroPlan.body.template, o.operationId),
    contract,
    ...(taskAttestationPublicKey === undefined ? {} : { taskAttestationPublicKey }),
    createdAt,
    expiresAt: Date.parse(createdAt) + 300000,
  };
  const plan = freeze(jobMode ? { ...proposed, job: renderMediaRecoveryJob(proposed) } : proposed);
  if (!Number.isFinite(plan.expiresAt) || (state && !equal(state.plan, plan))) fail();
  const put = async (next) => {
    const immutable = structuredClone(next);
    await save(structuredClone(immutable));
    state = freeze(immutable);
  };
  const fresh = () => {
    if (Date.now() >= plan.expiresAt || Date.parse(createdAt) > Date.now() + 5000) fail();
  };
  if (!state) {
    await readMediaRecoveryNormalOrigin(baseOptions);
    fresh();
    await put({ plan, stage: 'planned' });
  }
  const url = `https://run.googleapis.com/v2/${plan.name}`;
  const read = async (template, count) => {
    const resource = await api(url),
      p = verifyPreparedPoolMetadata(
        { ...ancestors.zeroPlan, body: { ...ancestors.zeroPlan.body, template } },
        resource,
        { manualInstanceCount: count }
      );
    if (p.uid !== plan.origin.uid || typeof resource.etag !== 'string' || !resource.etag) fail();
    return { ...p, etag: resource.etag, revisionUid: await revision(p.revision, template) };
  };
  const guard = async (phase, pool) => {
    await authorizeMutation();
    const access = await readMediaRecoveryAncestorAccess(baseOptions);
    if (access.receiptsSHA256 !== plan.ancestorsSHA256) fail();
    const p = await observeProtection({ plan, phase, pool });
    if (
      !p ||
      p.operationId !== plan.operationId ||
      p.phase !== phase ||
      p.role !== 'media' ||
      p.buildId !== plan.buildId ||
      p.namespace !== o.platform.temporalNamespace ||
      p.contractSHA256 !== hash(plan.contract) ||
      !sha(p.protectionSHA256) ||
      !sha(p.computeInventorySHA256) ||
      !Number.isFinite(Date.parse(p.observedAt)) ||
      Math.abs(Date.now() - Date.parse(p.observedAt)) > 5000
    )
      fail();
    return p;
  };
  const transition = async (key, before, template, target) => {
    let x = state[key];
    const request = {
      url: `${url}?updateMask=${key === 'diagnostic' || key === 'restore' ? 'template' : 'scaling'}`,
      method: 'PATCH',
      body:
        key === 'diagnostic' || key === 'restore'
          ? { name: plan.name, etag: before.etag, template }
          : { name: plan.name, etag: before.etag, scaling: { manualInstanceCount: target } },
    };
    const transitionPlan = { key, operationId: plan.operationId, before, templateSHA256: hash(template), target };
    const write = async (next) => {
      await put({ ...state, [key]: next });
      x = next;
    };
    if (x && (!equal(x.plan, transitionPlan) || !equal(x.request, request))) fail();
    if (!x) {
      if (['diagnostic', 'start'].includes(key)) fresh();
      const current = await read(
        key === 'diagnostic' ? plan.normalTemplate : plan.diagnosticTemplate,
        key === 'stop' ? 1 : 0
      );
      if (!equal(current, before)) fail();
      const protection = await guard(key, before);
      const quota = key === 'start' ? await observeMediaDiskQuota(ancestors.zeroPlan, api) : undefined;
      if (quota) assertMediaDiskQuotaFresh(quota);
      if (key === 'start') startCheckpointIssued = true;
      await write({
        plan: transitionPlan,
        request,
        stage: 'attempted',
        attemptedAt: new Date().toISOString(),
        protection,
        ...(quota ? { quota } : {}),
      });
      const fence = async () => {
        if (['diagnostic', 'start'].includes(key)) fresh();
        if (quota) assertMediaDiskQuotaFresh(quota);
        const atSend = await guard(key, before);
        if (
          atSend.protectionSHA256 !== protection.protectionSHA256 ||
          atSend.computeInventorySHA256 !== protection.computeInventorySHA256
        )
          fail();
        if (quota) {
          const observed = await observeMediaDiskQuota(ancestors.zeroPlan, api);
          assertMediaDiskQuotaFresh(quota);
          assertMediaDiskQuotaFresh(observed);
          if (observed.quotaSHA256 !== quota.quotaSHA256) fail();
        }
        const still = await read(
          key === 'diagnostic' ? plan.normalTemplate : plan.diagnosticTemplate,
          key === 'stop' ? 1 : 0
        );
        if (!equal(still, before)) fail();
        if (['diagnostic', 'start'].includes(key)) fresh();
        if (quota) assertMediaDiskQuotaFresh(quota);
        if (Math.abs(Date.now() - Date.parse(atSend.observedAt)) > 5000) fail();
      };
      let ack;
      let sendAuthorized = false;
      try {
        await fence();
        ack = await api(request.url, 'PATCH', request.body, async () => {
          await fence();
          sendAuthorized = true;
        });
      } catch (error) {
        if (
          sendAuthorized &&
          Number.isInteger(error?.status) &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 429].includes(error.status)
        ) {
          await write({ ...x, stage: 'rejected', status: error.status });
          fail();
        }
        // Unknown acknowledgement never grants a later transition or another PATCH.
      }
      if (ack) await write({ ...x, stage: 'acknowledged', nativeOperation: operation(ack.name) });
    }
    if (
      x.stage === 'completed' &&
      {
        diagnostic: state.start || state.neverStarted || state.restore,
        start: state.stop || state.recovery || state.recoveryFailed || state.drained,
        stop: state.stopped || state.restore,
        restore: state.stage === 'completed',
      }[key]
    )
      return x.pool;
    if (x.stage === 'attempted') {
      await read(template, target);
      fail();
    }
    if (!['acknowledged', 'completed'].includes(x.stage)) fail();
    await guard(key, before);
    if (x.stage === 'acknowledged') {
      const name = operation(x.nativeOperation),
        end = Date.now() + 30000;
      let result;
      do {
        result = await api(`https://run.googleapis.com/v2/${name}`);
        if (operation(result?.name) !== name) fail();
        if (result.done === true) break;
        if ((result.done !== undefined && result.done !== false) || Date.now() >= end) fail();
        await new Promise((r) => setTimeout(r, 200));
      } while (Date.now() < end);
      if (result?.done !== true || result.error) fail();
      const response = verifyPreparedPoolMetadata(
        { ...ancestors.zeroPlan, body: { ...ancestors.zeroPlan.body, template } },
        result.response,
        { manualInstanceCount: target }
      );
      const current = await read(template, target);
      if (!equal(response, (({ etag, revisionUid, ...p }) => p)(current))) fail();
      if (
        current.uid !== before.uid ||
        BigInt(current.generation) !== BigInt(before.generation) + 1n ||
        (key === 'diagnostic' || key === 'restore'
          ? current.revision === before.revision || current.revisionUid === before.revisionUid
          : current.revision !== before.revision || current.revisionUid !== before.revisionUid)
      )
        fail();
      // An acknowledged operation can take several seconds to settle. Refresh the
      // phase protections before accepting its successor or starting downstream work.
      const completionProtection = await guard(key, before);
      if (!equal(await read(template, target), current) ||
        Math.abs(Date.now() - Date.parse(completionProtection.observedAt)) > 5000) fail();
      await write({ ...x, stage: 'completed', pool: current, verifiedAt: new Date().toISOString() });
    }
    const current = await read(template, target);
    if (!equal(current, x.pool)) fail();
    return current;
  };
  if (!jobMode && state.stage === 'completed') {
    if (state.neverStarted) proof(state.neverStarted, plan, 'never-started');
    else proof(state.stopped, plan, 'stopped');
    if (!state.restore || !equal(await read(plan.normalTemplate, 0), state.restore.pool)) fail();
    await guard('completed', state.restore.pool);
    if (state.recoveryFailed || state.neverStarted) fail();
    return state;
  }
  if (!state.prepared) {
    fresh();
    const prepared = proof(await runtime.prepare({ plan }), plan, 'prepared');
    fresh();
    await put({ ...state, stage: 'prepared', prepared });
  }
  proof(state.prepared, plan, 'prepared');
  if (jobMode) {
    const checkNormalZero = async () => {
      await authorizeMutation();
      if (!equal(await read(plan.normalTemplate, 0), plan.origin)) fail();
    };
    if (state.stage === 'completed') {
      if (
        state.disposition !== 'normal-zero-after-job' ||
        state.jobTermination?.kind !== 'job-task-terminated' ||
        !sha(state.jobTermination.proofSHA256) ||
        state.jobDrain?.kind !== 'job-queues-drained' ||
        state.jobDrain.terminationSHA256 !== state.jobTermination.proofSHA256 ||
        !sha(state.jobDrain.proofSHA256)
      ) fail();
      proof(state.recovery, plan, 'recovery');
      await checkNormalZero();
      return state;
    }
    const protect = async () => {
      await checkNormalZero();
      await guard('diagnostic', plan.origin);
      const quota = await observeMediaDiskQuota(ancestors.zeroPlan, api);
      await checkNormalZero();
      assertMediaDiskQuotaFresh(quota);
    };
    const provider = await runtime.launchJob({ plan, protect, checkNormalZero });
    const jobRun = provider?.runIdentity;
    if (!jobRun || jobRun.stage !== 'acknowledged' || jobRun.jobPlanSHA256 !== hash(plan.job)) fail();
    await checkNormalZero();
    const episode = await runtime.execute({ plan, pool: plan.origin, prepared: state.prepared, jobRun });
    const recovery = proof(episode?.recovery, plan, 'recovery');
    const jobTermination = episode?.jobTermination;
    if (
      jobTermination?.kind !== 'job-task-terminated' || jobTermination.operationId !== plan.operationId ||
      jobTermination.job !== plan.job.name || jobTermination.jobUid !== jobRun.jobUid ||
      jobTermination.execution !== jobRun.execution || jobTermination.executionUid !== jobRun.executionUid ||
      !sha(jobTermination.proofSHA256)
    ) fail();
    const jobDrain = await runtime.drainJob({ plan, jobRun, jobTermination });
    if (
      jobDrain?.kind !== 'job-queues-drained' || jobDrain.operationId !== plan.operationId ||
      jobDrain.terminationSHA256 !== jobTermination.proofSHA256 || !sha(jobDrain.proofSHA256) ||
      !Number.isFinite(Date.parse(jobDrain.observedAt)) || Math.abs(Date.now() - Date.parse(jobDrain.observedAt)) > 5000
    ) fail();
    await checkNormalZero();
    if (Math.abs(Date.now() - Date.parse(jobDrain.observedAt)) > 5000) fail();
    await put({ ...state, stage: 'completed', disposition: 'normal-zero-after-job', recovery, jobTermination, jobDrain });
    return state;
  }
  const diagnostic = await transition('diagnostic', plan.origin, plan.diagnosticTemplate, 0);
  // No automatic restoration is inferred from a failed/unknown scale request.
  let started;
  if (!state.neverStarted)
    try {
      started = await transition('start', diagnostic, plan.diagnosticTemplate, 1);
    } catch (error) {
      const rejected =
        state.start?.stage === 'rejected' &&
        Number.isInteger(state.start.status) &&
        state.start.status >= 400 &&
        state.start.status < 500 &&
        ![408, 429].includes(state.start.status);
      // A lost checkpoint acknowledgement is NOT absence of a start attempt.
      if (!state.neverStarted && ((!state.start && !startCheckpointIssued) || rejected)) {
        const unchanged = await read(plan.diagnosticTemplate, 0);
        if (!equal(unchanged, diagnostic)) fail();
        await guard('never-started', unchanged);
        const neverStarted = proof(
          await runtime.confirmNeverStarted({
            plan,
            pool: unchanged,
            prepared: state.prepared,
            startRejection: rejected ? state.start : null,
          }),
          plan,
          'never-started'
        );
        await put({ ...state, stage: 'never-started', neverStarted });
      }
      if (!state.neverStarted) throw error;
    }
  if (state.neverStarted) {
    proof(state.neverStarted, plan, 'never-started');
    await transition('restore', diagnostic, plan.normalTemplate, 0);
    await put({
      ...state,
      stage: 'completed',
      disposition: 'restored-normal-zero',
      scope: 'never started; restoration only, no recovery or readiness proof',
    });
    fail();
  }
  if (!state.recovery && !state.recoveryFailed) {
    // Its first START still requires unexpired authority. A lost observation must
    // leave the saved START intent eligible for same-run readback on resume.
    const outcome = await runtime.execute({ plan, pool: started, prepared: state.prepared });
    if (outcome?.kind === 'recovery-failed') {
      const recoveryFailed = proof(outcome, plan, 'recovery-failed');
      await put({ ...state, stage: 'recovery-failed', recoveryFailed });
    } else {
      const recovery = proof(outcome, plan, 'recovery');
      await put({ ...state, stage: 'recovered', recovery });
    }
  }
  if (state.recovery) proof(state.recovery, plan, 'recovery');
  if (state.recoveryFailed !== undefined) {
    if (state.recovery) fail();
    proof(state.recoveryFailed, plan, 'recovery-failed');
  }
  if (!state.drained) {
    const drained = proof(
      await runtime.drain({ plan, pool: started, prepared: state.prepared, recovery: state.recovery ?? null }),
      plan,
      'drained'
    );
    await put({ ...state, stage: 'drained', drained });
  }
  proof(state.drained, plan, 'drained');
  assertStoredMediaDiagnosticDrain(state.drained.observation,plan,started);
  const zero = await transition('stop', started, plan.diagnosticTemplate, 0);
  if (!state.stopped) {
    const stopped = proof(await runtime.confirmStopped({ plan, pool: zero, drained: state.drained }), plan, 'stopped');
    await put({ ...state, stage: 'stopped', stopped });
  }
  proof(state.stopped, plan, 'stopped');
  await transition('restore', zero, plan.normalTemplate, 0);
  await put({
    ...state,
    stage: 'completed',
    disposition: 'restored-normal-zero',
    scope: 'revision lineage only; desired counts are not process counts; no promotion/readiness',
  });
  if (state.recoveryFailed) fail();
  return state;
}
