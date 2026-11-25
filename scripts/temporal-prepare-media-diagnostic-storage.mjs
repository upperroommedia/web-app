import {
  mediaRecoveryAttestationCommitIsTimely,
  mediaRecoveryAttestedWorkExpiry,
  mediaRecoveryLaunchWindow,
} from './temporal-media-recovery-execution-window.mjs';
import { verifyMediaRecoveryTaskAttestation } from './temporal-media-recovery-task-attestation.mjs';
import { isDeepStrictEqual as equal } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { observeMediaDiagnosticStorage } from './temporal-media-diagnostic-storage.mjs';
import { attestationPublicKey } from './temporal-media-recovery-job.mjs';
import { verifyPreparedDirectPolicyGrant } from './temporal-preparation-iam.mjs';

const project = 'urm-app-staging',
  projectNumber = '251680231116';
const storage = 'https://storage.googleapis.com/storage/v1/b';
const iam = 'https://iam.googleapis.com/v1/projects/' + project + '/roles';
const permissions = ['storage.objects.create', 'storage.objects.delete', 'storage.objects.get', 'storage.objects.list'];
const uuid = (value) =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const etag = (value) => typeof value === 'string' && value.length > 0 && value.length < 1000;
function check(ok, gate) {
  if (!ok) throw new Error('MEDIA_DIAGNOSTIC_STORAGE_' + gate);
}

function planFor(o, action) {
  const { operationId, releaseId, buildId, bindingDigest, evidenceDigest } = o;
  check(
    uuid(operationId) &&
      uuid(releaseId) &&
      operationId !== releaseId &&
      /^[a-f0-9]{40}$/.test(buildId) &&
      sha(bindingDigest) &&
      sha(evidenceDigest) &&
      [o.api, o.save, o.authorize].every((fn) => typeof fn === 'function'),
    'SCOPE'
  );
  const suffix = buildId.slice(0, 20);
  return {
    schemaVersion: 1,
    action,
    operationId,
    releaseId,
    buildId,
    bindingDigest,
    evidenceDigest,
    project,
    projectNumber,
    region: 'US-CENTRAL1',
    bucket: project + '-mr-' + releaseId.replaceAll('-', ''),
    roleId: 'tw_media_recovery_storage_' + suffix,
    runner: 'tw-m-' + suffix + '@' + project + '.iam.gserviceaccount.com',
  };
}
const roleName = (p) => 'projects/' + project + '/roles/' + p.roleId;
const grantFor = (p) => ({ role: roleName(p), members: ['serviceAccount:' + p.runner] });
const bucketBody = (p) => ({
  name: p.bucket,
  location: p.region,
  storageClass: 'STANDARD',
  versioning: { enabled: true },
  iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' },
  labels: { urm_release: p.releaseId, urm_build: p.buildId, urm_storage_operation: p.operationId },
});
const roleBody = (p) => ({
  roleId: p.roleId,
  role: {
    title: 'Temporal staging private media recovery storage',
    stage: 'GA',
    description: 'urm-private-media-storage:' + p.operationId + ':' + proofDigest(p),
    includedPermissions: [...permissions],
  },
});
const bucketURL = (p) => storage + '/' + p.bucket;
const policyURL = (p) => bucketURL(p) + '/iam';
function bucketValue(p, v) {
  check(
    v?.kind === 'storage#bucket' &&
      v.name === p.bucket &&
      v.id === p.bucket &&
      v.projectNumber === projectNumber &&
      v.location === p.region &&
      v.storageClass === 'STANDARD' &&
      date(v.timeCreated) &&
      etag(v.etag) &&
      typeof v.metageneration === 'string' &&
      /^[1-9][0-9]*$/.test(v.metageneration) &&
      v.versioning?.enabled === true &&
      v.iamConfiguration?.uniformBucketLevelAccess?.enabled === true &&
      v.iamConfiguration?.publicAccessPrevention === 'enforced' &&
      (v.lifecycle === undefined || equal(v.lifecycle, { rule: [] })) &&
      equal(v.labels, bucketBody(p).labels),
    'BUCKET'
  );
  // All provider fields, including retention/encryption/soft-delete, are bound.
  const { etag: tag, metageneration, updated, ...configuration } = v;
  return {
    name: v.name,
    timeCreated: v.timeCreated,
    metageneration,
    etag: tag,
    configurationSHA256: proofDigest(configuration),
  };
}
function sameBucket(owned, current) {
  check(
    owned &&
      current &&
      owned.name === current.name &&
      owned.timeCreated === current.timeCreated &&
      owned.configurationSHA256 === current.configurationSHA256 &&
      BigInt(current.metageneration) >= BigInt(owned.metageneration),
    'BUCKET_CUSTODY'
  );
}
function roleValue(p, v) {
  const expected = roleBody(p).role;
  check(
    v?.name === roleName(p) &&
      v.title === expected.title &&
      v.description === expected.description &&
      v.stage === 'GA' &&
      [undefined, false].includes(v.deleted) &&
      etag(v.etag) &&
      Array.isArray(v.includedPermissions) &&
      equal([...v.includedPermissions].sort(), permissions),
    'ROLE'
  );
  return { name: v.name, etag: v.etag, ...expected };
}
function cleanPolicy(p, v) {
  check(
    v?.kind === 'storage#policy' &&
      v.resourceId === 'projects/_/buckets/' + p.bucket &&
      etag(v.etag) &&
      [undefined, 1, 3].includes(v.version) &&
      Array.isArray(v.bindings) &&
      Object.keys(v).every((k) => ['kind', 'resourceId', 'bindings', 'etag', 'version'].includes(k)),
    'POLICY'
  );
  return { etag: v.etag, version: v.version ?? 1, bindings: v.bindings };
}
function semantics(v) {
  return {
    version: v.version,
    bindings: v.bindings
      .map((b) => ({ ...b, members: [...b.members].sort() }))
      .sort((a, b) => proofDigest(a).localeCompare(proofDigest(b))),
  };
}
function addGrant(p, before) {
  const grant = grantFor(p);
  check(
    before.bindings.every(
      (b) => b.role !== grant.role && Array.isArray(b.members) && !b.members.includes(grant.members[0])
    ),
    'EXISTING_GRANT'
  );
  const desired = { ...before, bindings: [...before.bindings, grant] };
  // Use the shared native policy parser, which also rejects public principals, invalid conditions and duplicate bindings.
  verifyPreparedDirectPolicyGrant(desired, grant, 'projects/_/buckets/' + p.bucket);
  return desired;
}
function confirmedPolicy(ack, desired) {
  check(etag(ack?.etag) && ack.etag !== desired.etag && equal(semantics(ack), semantics(desired)), 'POLICY_ACK');
  return ack;
}
function directPolicy(p, api) {
  return api(policyURL(p) + '?optionsRequestedPolicyVersion=3', 'GET').then((v) => cleanPolicy(p, v));
}
async function absent(api, url) {
  try {
    await api(url, 'GET');
  } catch (e) {
    if (e?.status === 404) return;
    throw e;
  }
  check(false, 'OCCUPIED');
}
async function empty(p, api) {
  const r = await api(bucketURL(p) + '/o?versions=true&maxResults=1', 'GET');
  check(
    r?.kind === 'storage#objects' &&
      [undefined, ''].includes(r.nextPageToken) &&
      (r.items === undefined || equal(r.items, [])) &&
      (r.prefixes === undefined || equal(r.prefixes, [])),
    'BUCKET_NOT_EMPTY'
  );
}

function clock(wall, mono) {
  const age = Date.now() - wall,
    elapsed = performance.now() - mono;
  check(
    Number.isSafeInteger(wall) && Number.isFinite(mono) && age >= 0 && age < 5000 && elapsed >= 0 && elapsed < 5000,
    'FRESHNESS'
  );
}
async function authorized(o, p, state, phase) {
  const began = Date.now(),
    monotonic = performance.now();
  const observed = await o.authorize({
    phase,
    operationId: p.operationId,
    releaseId: p.releaseId,
    buildId: p.buildId,
    bindingDigest: p.bindingDigest,
    evidenceDigest: p.evidenceDigest,
    state,
    ...(o.preparationReceipt
      ? {
          preparationReceipt: o.preparationReceipt,
          preparationProof: o.preparationProof,
          ...(p.failureProof
            ? { failureReceipt: o.failureReceipt, failureProof: o.failureProof }
            : { terminalReceipt: o.terminalReceipt, terminalProof: o.terminalProof }),
        }
      : {}),
  });
  check(
    observed &&
      sha(observed.authoritySHA256) &&
      sha(observed.poolSHA256) &&
      /^[1-9][0-9]{5,29}$/.test(observed.runnerUniqueId) &&
      observed.observedAt >= began &&
      observed.observedMonotonic >= monotonic,
    'AUTHORITY'
  );
  clock(observed.observedAt, observed.observedMonotonic);
  const stable = {
    authoritySHA256: observed.authoritySHA256,
    poolSHA256: observed.poolSHA256,
    runnerUniqueId: observed.runnerUniqueId,
    ...(p.failureProof ? { failedClosure: freshFailedClosure(o, observed.failedClosure) } : {}),
  };
  if (state?.authority) check(equal(state.authority, stable), 'AUTHORITY_CHANGED');
  return stable;
}

/** A synchronous API response belongs to the caller that saved this attempt.
 * GET-only observations cannot turn an unacknowledged mutation into ownership. */
async function step(ctx, key, actions) {
  const { o, p } = ctx;
  const started = ctx.state[key];
  if (started) {
    check(
      started.stage === 'acknowledged' && date(started.attemptedAt) && started.ack,
      'UNCONFIRMED_' + key.toUpperCase()
    );
    await actions.join(started);
    return;
  }
  check(ctx.state.stage === 'planned', 'JOURNAL');
  const before = await actions.before();
  await authorized(o, p, ctx.state, key + '-before-attempt');
  const attempted = { stage: 'attempted', attemptedAt: new Date().toISOString(), before };
  await ctx.put({ ...ctx.state, [key]: attempted });
  let fenced = false;
  const fence = async () => {
    check(!fenced, 'DUPLICATE_SEND');
    const wall = Date.now(),
      mono = performance.now();
    const [fresh] = await Promise.all([actions.before(), authorized(o, p, ctx.state, key + '-before-send')]);
    check(equal(before, fresh), 'PROTECTION_CHANGED');
    clock(wall, mono);
    fenced = true;
  };
  let raw;
  try {
    raw = await actions.send(before, fence);
  } catch (e) {
    if (fenced && Number.isInteger(e?.status) && e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status))
      await ctx.put({ ...ctx.state, [key]: { ...attempted, stage: 'rejected', rejectedStatus: e.status } });
    throw e;
  }
  check(fenced, 'TRANSPORT_FENCE');
  const ack = actions.ack(raw, before);
  await ctx.put({ ...ctx.state, [key]: { ...attempted, stage: 'acknowledged', ack } });
  await actions.join(ctx.state[key]);
}
async function context(o, p) {
  const ctx = {
    o,
    p,
    state: o.saved,
    async put(next) {
      await o.save(next, this.state);
      this.state = next;
    },
  };
  if (ctx.state === undefined) {
    const authority = await authorized(o, p, undefined, 'initialize');
    await ctx.put({ schemaVersion: 1, plan: p, stage: 'planned', authority });
  }
  check(
    ctx.state?.schemaVersion === 1 &&
      equal(ctx.state.plan, p) &&
      ['planned', 'completed'].includes(ctx.state.stage) &&
      ctx.state.authority,
    'JOURNAL'
  );
  await authorized(o, p, ctx.state, 'held');
  return ctx;
}

async function observedBucket(o, p) {
  return bucketValue(p, await o.api(bucketURL(p), 'GET'));
}
async function observedRole(o, p) {
  return roleValue(p, await o.api(iam + '/' + p.roleId, 'GET'));
}
function policyMatches(a, b) {
  return a.etag === b.etag && equal(semantics(a), semantics(b));
}
function assertPreparedShape(p, state) {
  check(
    state?.schemaVersion === 1 &&
      state.stage === 'completed' &&
      equal(state.plan, p) &&
      state.authority &&
      [state.role, state.bucket, state.grant].every((s) => s?.stage === 'acknowledged' && date(s.attemptedAt)),
    'PREPARATION_RECEIPT'
  );
  check(
    equal(roleValue(p, state.role.ack), state.role.ack) &&
      equal(state.grant.before.role, state.role.ack) &&
      equal(state.grant.before.bucket, state.bucket.ack) &&
      policyMatches(confirmedPolicy(state.grant.ack, addGrant(p, state.grant.before.policy)), state.grant.ack),
    'PREPARATION_RECEIPT'
  );
  sameBucket(state.bucket.ack, state.preparedBucket);
  check(
    state.certificate?.schemaVersion === 1 &&
      state.certificate.bucket === p.bucket &&
      state.certificate.projectNumber === projectNumber &&
      state.certificate.createdAt === state.bucket.ack.timeCreated &&
      state.certificate.preparationSHA256 ===
        proofDigest({
          metageneration: state.preparedBucket.metageneration,
          policyETag: state.grant.ack.etag,
          roleETag: state.role.ack.etag,
          permissions,
        }),
    'CERTIFICATE'
  );
}

export async function prepareMediaDiagnosticStorage(o) {
  const p = planFor(o, 'prepare-media-diagnostic-storage');
  const ctx = await context(o, p);
  check(
    (!ctx.state.bucket || ctx.state.role?.stage === 'acknowledged') &&
      (!ctx.state.grant || ctx.state.bucket?.stage === 'acknowledged'),
    'JOURNAL_ORDER'
  );
  await step(ctx, 'role', {
    before: async () => {
      await Promise.all([absent(o.api, iam + '/' + p.roleId), absent(o.api, bucketURL(p))]);
      return { requestSHA256: proofDigest(roleBody(p)) };
    },
    send: (_before, fence) => o.api(iam, 'POST', roleBody(p), fence),
    ack: (raw) => roleValue(p, raw),
    join: async (s) =>
      check(
        equal(s.before, { requestSHA256: proofDigest(roleBody(p)) }) && equal(s.ack, await observedRole(o, p)),
        'ROLE_CUSTODY'
      ),
  });
  await step(ctx, 'bucket', {
    before: async () => {
      const [role] = await Promise.all([observedRole(o, p), absent(o.api, bucketURL(p))]);
      check(equal(role, ctx.state.role.ack), 'ROLE_CUSTODY');
      return { role, requestSHA256: proofDigest(bucketBody(p)) };
    },
    send: (_before, fence) => o.api(storage + '?project=' + project, 'POST', bucketBody(p), fence),
    ack: (raw) => bucketValue(p, raw),
    join: async (s) => {
      check(equal(s.before, { role: ctx.state.role.ack, requestSHA256: proofDigest(bucketBody(p)) }), 'BUCKET_INTENT');
      const b = await observedBucket(o, p);
      sameBucket(s.ack, b);
      if (!ctx.state.grant || ctx.state.grant.stage !== 'acknowledged') check(equal(s.ack, b), 'BUCKET_CHANGED');
    },
  });
  await step(ctx, 'grant', {
    before: async () => {
      const [role, bucket, policy] = await Promise.all([
        observedRole(o, p),
        observedBucket(o, p),
        directPolicy(p, o.api),
        empty(p, o.api),
      ]);
      check(equal(role, ctx.state.role.ack) && equal(bucket, ctx.state.bucket.ack), 'CREATE_CUSTODY');
      addGrant(p, policy);
      return { role, bucket, policy };
    },
    send: (before, fence) => o.api(policyURL(p), 'PUT', addGrant(p, before.policy), fence),
    ack: (raw, before) => confirmedPolicy(cleanPolicy(p, raw), addGrant(p, before.policy)),
    join: async (s) => {
      check(equal(s.before.role, ctx.state.role.ack) && equal(s.before.bucket, ctx.state.bucket.ack), 'GRANT_CUSTODY');
      confirmedPolicy(s.ack, addGrant(p, s.before.policy));
      check(policyMatches(await directPolicy(p, o.api), s.ack), 'GRANT_CUSTODY');
    },
  });
  const [preparedBucket, certificate] = await Promise.all([
    observedBucket(o, p),
    observeMediaDiagnosticStorage({ api: o.api, releaseId: p.releaseId, buildId: p.buildId, requireEmpty: true }),
  ]);
  sameBucket(ctx.state.bucket.ack, preparedBucket);
  const result = { ...ctx.state, stage: 'completed', preparedBucket, certificate };
  assertPreparedShape(p, result);
  await authorized(o, p, ctx.state, 'preparation-complete');
  if (ctx.state.stage === 'completed') check(equal(ctx.state, result), 'PREPARATION_RECEIPT');
  else await ctx.put(result);
  return ctx.state;
}

function immutableReceipt(proof, receipt) {
  const { seconds, nanoseconds } = proof?.createTime ?? {};
  check(
    receipt &&
      proof?.dataDigest === proofDigest(receipt) &&
      equal(proof.createTime, proof.updateTime) &&
      Number.isSafeInteger(seconds) &&
      seconds > 0 &&
      Number.isInteger(nanoseconds) &&
      nanoseconds >= 0 &&
      nanoseconds < 1e9,
    'RECEIPT_STAMP'
  );
}
function freshFailedClosure(o, observed) {
  const f = o.failureReceipt;
  check(
    sha(observed?.inventorySHA256) &&
      sha(observed.computeSHA256) &&
      equal(observed, {
        failureSHA256: o.failureProof.dataDigest,
        workflowHistorySHA256: f.workflow.historySHA256,
        jobTerminationSHA256: f.jobTermination.proofSHA256,
        inventorySHA256: observed.inventorySHA256,
        computeSHA256: observed.computeSHA256,
        workflowFailed: true,
        jobFailed: true,
        queuesEmpty: true,
        computeAbsent: true,
        noPendingOperations: true,
      }),
    'FAILED_CLOSURE'
  );
  return { ...observed };
}

function instantNanos(text) {
  const parsed = typeof text === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(text);
  check(
    parsed && date(parsed[1] + 'Z') && new Date(parsed[1] + 'Z').toISOString().slice(0, 19) === parsed[1],
    'FAILURE_TIME'
  );
  return BigInt(Date.parse(parsed[1] + 'Z')) * 1000000n + BigInt((parsed[2] ?? '').padEnd(9, '0'));
}

function failedEpisode(o, p, prepared) {
  const f = o.failureReceipt;
  const { provider, start, workflow, jobTermination: run, closure, plan } = f;
  const native = provider?.runIdentity;
  const job = plan.job.name;
  const operationRoot = 'projects/' + project + '/locations/us-central1/operations/';
  const execution = native?.execution;
  const suffix =
    typeof execution === 'string' && execution.startsWith(job + '/executions/')
      ? execution.slice((job + '/executions/').length)
      : '';
  const workflowId = 'media-recovery-' + f.operationId;
  const stamp = BigInt(o.failureProof.createTime.seconds) * 1000000000n + BigInt(o.failureProof.createTime.nanoseconds);
  attestationPublicKey(plan.taskAttestationPublicKey);
  const window = mediaRecoveryLaunchWindow(plan);
  check(window, 'FAILURE_ARCHIVE');
  let taskBirthDeadline = BigInt(window.launchExpiresAt) * 1_000_000n;
  let executionExpiresAt = window.launchExpiresAt;
  if (window.version !== undefined) {
    const { failureCertificate, failureCertificateProof: proof } = o;
    immutableReceipt(proof, failureCertificate);
    check(equal(proof, f.facts?.[1]), 'FAILED_CERTIFICATE_PROVENANCE');
    const signed = verifyMediaRecoveryTaskAttestation(failureCertificate, plan.taskAttestationPublicKey);
    executionExpiresAt = mediaRecoveryAttestedWorkExpiry(plan, signed);
    check(
      executionExpiresAt !== undefined &&
        mediaRecoveryAttestationCommitIsTimely(window, signed, proof.createTime) &&
        signed.operationId === f.operationId &&
        signed.planSHA256 === proofDigest(plan) &&
        signed.job === job && signed.jobUid === native?.jobUid &&
        signed.createOperation === provider?.create?.operation &&
        signed.runOperation === native?.operation && signed.runIntentSHA256 === native?.intentSHA256 &&
        signed.execution === execution && signed.executionUid === native?.executionUid &&
        signed.task === run?.task && signed.taskCreateTime === run?.taskCreateTime &&
        signed.taskUid === (run?.taskUid ?? null) &&
        f.intent?.expiresAt === executionExpiresAt && start?.intentSHA256 === proofDigest(f.intent),
      'FAILED_CERTIFICATE_AUTHORITY'
    );
    taskBirthDeadline = BigInt(window.attestationExpiresAt) * 1_000_000n;
  }
  check(
    f.schemaVersion === 1 &&
      f.kind === 'staging-media-diagnostic-started-failure' &&
      f.projectId === project &&
      f.buildId === p.buildId &&
      equal(f.preparationProof, o.preparationProof) &&
      Number.isSafeInteger(plan.expiresAt) &&
      date(plan.createdAt) &&
      plan.expiresAt === Date.parse(plan.createdAt) + 300000 &&
      stamp > BigInt(executionExpiresAt) * 1_000_000n &&
      equal(plan.diagnosticStorage, prepared.certificate),
    'FAILURE_ARCHIVE'
  );
  const access = provider?.access;
  check(
    access?.stage === 'completed' &&
      access.plan?.jobUid === native?.jobUid &&
      access.plan.resource === job &&
      access.plan.operationId === f.operationId &&
      access.plan.jobPlanSHA256 === provider.jobPlanSHA256 &&
      ((access.outcome === 'attested-job-empty-direct-policy' && equal(access.plan.grants, [])) ||
        (access.outcome === 'acknowledged-write-and-policy-observation' &&
          equal(access.plan.grants, [{ role: 'roles/run.viewer', members: ['serviceAccount:' + p.runner] }]))),
    'FAILED_JOB_ACCESS'
  );
  check(
    provider?.create?.stage === 'acknowledged' &&
      provider.run?.stage === 'acknowledged' &&
      native?.stage === 'acknowledged' &&
      native.operation === provider.run.operation &&
      typeof provider.create.operation === 'string' &&
      provider.create.operation.startsWith(operationRoot) &&
      uuid(provider.create.operation.slice(operationRoot.length)) &&
      typeof native.operation === 'string' &&
      native.operation.startsWith(operationRoot) &&
      uuid(native.operation.slice(operationRoot.length)) &&
      native.operation !== provider.create.operation &&
      uuid(native.jobUid) &&
      uuid(native.executionUid) &&
      sha(native.intentSHA256) &&
      native.intentSHA256 === provider.run.intentSHA256 &&
      date(provider.run.attemptedAt) &&
      provider.run.attemptedAt === native.attemptedAt &&
      Date.parse(native.attemptedAt) >= Date.parse(plan.createdAt) &&
      Date.parse(native.attemptedAt) < plan.expiresAt &&
      provider.jobPlanSHA256 === proofDigest(plan.job) &&
      native.jobPlanSHA256 === provider.jobPlanSHA256 &&
      /^[a-z0-9][a-z0-9-]{0,62}$/.test(suffix),
    'FAILED_JOB_AUTHORITY'
  );
  check(
    start?.schemaVersion === 1 &&
      start.stage === 'confirmed' &&
      start.operationId === f.operationId &&
      ['native-start-response', 'unknown-ack-native-get-only'].includes(start.ack) &&
      sha(start.nativeStartSHA256) &&
      sha(start.intentSHA256) &&
      start.jobRunSHA256 === proofDigest(native) &&
      typeof start.runId === 'string' &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(start.runId) &&
      start.runId !== '00000000-0000-0000-0000-000000000000' &&
      workflow?.workflowId === workflowId &&
      workflow.runId === start.runId &&
      workflow.status === 'FAILED' &&
      typeof workflow.terminalEventId === 'string' &&
      /^[1-9][0-9]*$/.test(workflow.terminalEventId) &&
      BigInt(workflow.terminalEventId) > 1n &&
      instantNanos(workflow.closedAt) < stamp &&
      instantNanos(start.recordedAt) >= instantNanos(native.attemptedAt) &&
      instantNanos(start.confirmedAt) >= instantNanos(start.recordedAt) &&
      instantNanos(start.confirmedAt) < stamp &&
      workflow.noNewExecutionRunId === true &&
      sha(workflow.historySHA256),
    'FAILED_WORKFLOW'
  );
  check(
    run?.kind === 'job-task-failed' &&
      run.job === job &&
      run.jobUid === native.jobUid &&
      run.runOperation === native.operation &&
      run.execution === execution &&
      run.executionUid === native.executionUid &&
      run.task === execution + '/tasks/' + suffix + '-task0' &&
      run.retried === 0 &&
      Number.isInteger(run.exitCode) &&
      run.exitCode > 0 &&
      run.exitCode <= 255 &&
      sha(run.proofSHA256) &&
      instantNanos(native.attemptedAt) <= instantNanos(run.taskCreateTime) &&
      instantNanos(run.taskCreateTime) < taskBirthDeadline &&
      instantNanos(run.taskCreateTime) <= instantNanos(workflow.closedAt) &&
      instantNanos(run.taskCreateTime) <= instantNanos(run.taskCompletionTime) &&
      instantNanos(run.taskCompletionTime) <= instantNanos(run.executionCompletionTime) &&
      instantNanos(run.executionCompletionTime) < stamp,
    'FAILED_JOB'
  );
  check(
    closure?.kind === 'failed-episode-no-pending-work' &&
      closure.workflowId === workflowId &&
      closure.runId === workflow.runId &&
      closure.job === job &&
      closure.executionUid === run.executionUid &&
      closure.task === run.task &&
      sha(closure.inventorySHA256) &&
      sha(closure.computeSHA256) &&
      closure.queuesEmpty === true &&
      closure.computeAbsent === true &&
      closure.noPendingOperations === true,
    'FAILED_EPISODE_DRAIN'
  );
}

function retirementAncestors(o, p) {
  const preparation = o.preparationReceipt,
    failed = o.failureReceipt !== undefined || o.failureProof !== undefined,
    terminal = failed ? o.failureReceipt : o.terminalReceipt,
    terminalProof = failed ? o.failureProof : o.terminalProof;
  check(!failed || (o.terminalReceipt === undefined && o.terminalProof === undefined), 'AMBIGUOUS_OUTCOME');
  immutableReceipt(o.preparationProof, preparation);
  immutableReceipt(terminalProof, terminal);
  const stamp = (proof) => BigInt(proof.createTime.seconds) * 1000000000n + BigInt(proof.createTime.nanoseconds);
  check(stamp(o.preparationProof) < stamp(terminalProof), 'RECEIPT_ORDER');
  const prepared = preparation.identityState,
    completed = terminal.identityState;
  check(
    uuid(preparation.operationId) &&
      uuid(terminal.operationId) &&
      sha(preparation.bindingDigest) &&
      sha(terminal.bindingDigest) &&
      new Set([p.operationId, preparation.operationId, terminal.operationId, p.releaseId]).size === 4 &&
      preparation.releaseId === p.releaseId &&
      terminal.releaseId === p.releaseId,
    'RECEIPT_SCOPE'
  );
  const pp = planFor(
    { ...o, operationId: preparation.operationId, bindingDigest: preparation.bindingDigest },
    'prepare-media-diagnostic-storage'
  );
  assertPreparedShape(pp, prepared);
  const run = completed?.jobTermination,
    drain = completed?.jobDrain,
    plan = failed ? terminal.plan : completed?.plan;
  check(
    plan?.operationId === terminal.operationId &&
      plan.releaseId === p.releaseId &&
      plan.buildId === p.buildId &&
      plan.bindingDigest === terminal.bindingDigest &&
      plan.evidenceDigest === p.evidenceDigest &&
      plan.runner === p.runner &&
      plan.role === 'media' &&
      /^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/.test(plan.image) &&
      plan.job?.name ===
        'projects/' +
          project +
          '/locations/us-central1/jobs/urm-media-recovery-' +
          terminal.operationId.replaceAll('-', '') &&
      plan.origin?.desiredManualInstanceCount === 0 &&
      equal(plan.diagnosticStorage, prepared.certificate),
    'EPISODE_PLAN'
  );
  if (failed) {
    failedEpisode(o, p, prepared);
    return { pp, prepared };
  }
  check(
    completed?.stage === 'completed' &&
      completed.disposition === 'normal-zero-after-job' &&
      completed.recovery?.kind === 'recovery' &&
      completed.recovery.operationId === terminal.operationId &&
      completed.recovery.bindingDigest === terminal.bindingDigest &&
      completed.recovery.buildId === p.buildId &&
      completed.recovery.image === plan.image &&
      sha(completed.recovery.proofSHA256) &&
      run?.kind === 'job-task-terminated' &&
      run.operationId === terminal.operationId &&
      run.job === plan.job?.name &&
      uuid(run.jobUid) &&
      uuid(run.executionUid) &&
      typeof run.execution === 'string' &&
      run.execution.startsWith(run.job + '/executions/') &&
      sha(run.proofSHA256) &&
      drain?.kind === 'job-queues-drained' &&
      drain.operationId === terminal.operationId &&
      sha(drain.proofSHA256) &&
      drain.terminationSHA256 === run.proofSHA256,
    'TERMINAL_DRAIN'
  );
  return { pp, prepared };
}

/** Retire only the causal, still-identical direct grant. All forensic objects and
 * role definition remain available to the independently authorized historical verifier. */
export async function retireMediaDiagnosticStorageGrant(o) {
  const p = {
    ...planFor(o, 'retire-media-diagnostic-storage-grant'),
    preparationProof: o.preparationProof,
    ...(o.failureProof !== undefined ? { failureProof: o.failureProof } : { terminalProof: o.terminalProof }),
  };
  const { pp, prepared } = retirementAncestors(o, p);
  const ctx = await context(o, p);
  check(ctx.state.authority.runnerUniqueId === prepared.authority.runnerUniqueId, 'RUNNER_CUSTODY');
  const desired = () => ({ ...prepared.grant.before.policy, etag: prepared.grant.ack.etag });
  await step(ctx, 'revocation', {
    before: async () => {
      const [bucket, role, policy, certificate] = await Promise.all([
        observedBucket(o, pp),
        observedRole(o, pp),
        directPolicy(pp, o.api),
        observeMediaDiagnosticStorage({ api: o.api, releaseId: p.releaseId, buildId: p.buildId }),
      ]);
      check(
        equal(bucket, prepared.preparedBucket) &&
          equal(role, prepared.role.ack) &&
          policyMatches(policy, prepared.grant.ack) &&
          equal(certificate, prepared.certificate),
        'RETIRE_CUSTODY'
      );
      return { bucket, role, policy, certificate };
    },
    send: (_before, fence) => o.api(policyURL(pp), 'PUT', desired(), fence),
    ack: (raw) => confirmedPolicy(cleanPolicy(pp, raw), desired()),
    join: async (s) => {
      const [bucket, role, policy] = await Promise.all([
        observedBucket(o, pp),
        observedRole(o, pp),
        directPolicy(pp, o.api),
      ]);
      sameBucket(prepared.preparedBucket, bucket);
      check(
        equal(role, prepared.role.ack) &&
          equal(s.before.bucket, prepared.preparedBucket) &&
          equal(s.before.role, role) &&
          equal(s.before.certificate, prepared.certificate) &&
          policyMatches(s.before.policy, prepared.grant.ack) &&
          policyMatches(confirmedPolicy(s.ack, desired()), policy),
        'RETIRE_READBACK'
      );
    },
  });
  const retiredBucket = await observedBucket(o, pp);
  sameBucket(prepared.preparedBucket, retiredBucket);
  await authorized(o, p, ctx.state, 'retirement-complete');
  const result = { ...ctx.state, stage: 'completed', retiredBucket, retiredPolicyETag: ctx.state.revocation.ack.etag };
  if (ctx.state.stage === 'completed') check(equal(ctx.state, result), 'RETIREMENT_RECEIPT');
  else await ctx.put(result);
  return ctx.state;
}
