import { createHash, randomUUID } from 'node:crypto';
import { BUNDLE_TYPES, bootstrapRequestId } from './temporal-bootstrap-bundles.mjs';
export const RECOVERY_ACTION = 'recover-bundle-bootstrap';
export const CONTROL = '_control/temporalRelease';
export const STATE = '_control/temporalReleaseState';
export const OPERATION = '_control/temporalReleaseOperation';
const ACTOR = 'system:firebase-event';
const fail = (code) => Object.assign(new Error(code), { code });
export function canonical(value) {
  if (
    value &&
    Number.isInteger(value.seconds) &&
    Number.isInteger(value.nanoseconds) &&
    (Object.keys(value).sort().join(',') === '_nanoseconds,_seconds' ||
      Object.keys(value).sort().join(',') === 'nanoseconds,seconds')
  )
    return { seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === 'object'
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .filter((k) => value[k] !== undefined)
          .map((k) => [k, canonical(value[k])])
      )
    : value;
}
export const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const rawHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function native(value) {
  const v = canonical(value);
  if (
    !v ||
    Object.keys(v).sort().join(',') !== 'nanoseconds,seconds' ||
    !Number.isSafeInteger(v.seconds) ||
    !Number.isInteger(v.nanoseconds) ||
    v.nanoseconds < 0 ||
    v.nanoseconds >= 1e9
  )
    throw fail('BUNDLE_RECOVERY_NATIVE_TIMESTAMP_REQUIRED');
  return v;
}
export function assertRecoveryAuthority(config, authority, baseline) {
  const { control: c, state: s } = authority;
  const domains = ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'];
  if (
    !['urm-app-staging', 'urm-app'].includes(config.projectId) ||
    config.mode !== 'initial-cutover' ||
    !config.domains.includes('bundles') ||
    !/^[a-f0-9]{40}$/.test(config.compatibilityCommit) ||
    c?.schemaVersion !== 1 ||
    c.releaseId !== config.releaseId ||
    !Number.isSafeInteger(c.revision) ||
    c.revision < 1 ||
    s?.releaseId !== c.releaseId ||
    s.controlRevision !== c.revision ||
    s.phase !== 'backend-ready' ||
    s.mode !== config.mode ||
    s.compatibilityCommit !== config.compatibilityCommit ||
    s.uiCommit !== config.uiCommit ||
    digest(s.domains) !== digest(config.domains) ||
    c.admission !== 'paused' ||
    Object.keys(c.domains ?? {})
      .sort()
      .join(',') !== [...domains].sort().join(',') ||
    domains.some(
      (d) =>
        c.domains[d]?.owner !== (config.domains.includes(d) ? 'temporal' : 'legacy') ||
        c.domains[d]?.admission !== 'paused'
    )
  )
    throw fail('BUNDLE_RECOVERY_RELEASE_NOT_PAUSED_BACKEND_READY');
  if (
    digest(native(c.legacyAdmissionCutoff)) !== digest(native(s.legacySettlingCutoff)) ||
    digest(native(c.legacyAdmissionCutoff)) !== digest(native(s.compatibilityVerifiedAt))
  )
    throw fail('BUNDLE_RECOVERY_CUTOFF_CHANGED');
  for (const key of ['controlCreateTime', 'stateCreateTime', 'controlUpdateTime', 'stateUpdateTime', 'serverReadTime'])
    native(authority[key]);
  if (
    baseline &&
    ['control', 'state', 'controlCreateTime', 'stateCreateTime', 'controlUpdateTime', 'stateUpdateTime'].some(
      (k) => digest(authority[k]) !== digest(baseline[k])
    )
  )
    throw fail('BUNDLE_RECOVERY_AUTHORITY_CHANGED');
}
export function originalSpecs(config) {
  return BUNDLE_TYPES.map((bundleType) => {
    const requestId = bootstrapRequestId(config.releaseId, bundleType),
      key = digest([config.projectId, ACTOR, requestId]);
    return {
      bundleType,
      requestId,
      key,
      jobId: `job-${key.slice(0, 48)}`,
      entityKey: rawHash([config.projectId, 'bundle', bundleType, 'bundle']),
    };
  });
}
const jobIdentity = (j) =>
  Object.fromEntries(
    ['projectId', 'jobId', 'kind', 'entity', 'workflowId', 'generation', 'requestedBy', 'requestId', 'createdAt'].map(
      (k) => [k, j?.[k]]
    )
  );
export function validateOriginal(config, row, expected) {
  const { job: j, intent: i, receipt: r, outbox: o } = row;
  if (
    !j ||
    !i ||
    !r ||
    !o ||
    j.projectId !== config.projectId ||
    j.jobId !== expected.jobId ||
    j.kind !== 'bundle.regenerate' ||
    j.entity?.type !== 'bundle' ||
    j.entity.id !== expected.bundleType ||
    j.requestedBy !== ACTOR ||
    j.requestId !== expected.requestId ||
    j.workflowId !== `bundle:${config.projectId}:${expected.bundleType}` ||
    j.state !== 'failed' ||
    !Number.isSafeInteger(j.generation) ||
    j.generation < 1 ||
    !Number.isSafeInteger(j.revision) ||
    i.projectId !== j.projectId ||
    i.jobId !== j.jobId ||
    i.kind !== j.kind ||
    i.actorUid !== ACTOR ||
    digest(i.entity) !== digest(j.entity) ||
    i.generation !== j.generation ||
    digest(i.payload) !== digest({ bundleType: expected.bundleType }) ||
    r.actorUid !== ACTOR ||
    r.projectId !== j.projectId ||
    r.receipt?.jobId !== j.jobId ||
    r.receipt.projectId !== j.projectId ||
    r.receipt.requestId !== j.requestId ||
    r.receipt.generation !== j.generation ||
    r.inputHash !==
      digest({
        kind: j.kind,
        entity: { type: 'bundle', id: expected.bundleType },
        requestId: j.requestId,
        payload: { bundleType: expected.bundleType },
      }) ||
    o.projectId !== j.projectId ||
    o.jobId !== j.jobId ||
    o.dispatch?.ref?.jobId !== j.jobId ||
    o.dispatch.ref.projectId !== j.projectId ||
    o.dispatch.workflowId !== j.workflowId ||
    o.dispatch.workflowType !== 'bundlesWorkflow' ||
    o.dispatch.signal?.name !== 'requestBundleRegeneration'
  )
    throw fail('BUNDLE_RECOVERY_ORIGINAL_NOT_FAILED_BOOTSTRAP');
  return {
    ...expected,
    generation: j.generation,
    intentDigest: digest(i),
    receiptDigest: digest(r),
    jobIdentity: jobIdentity(j),
    outboxDispatchDigest: digest(o.dispatch),
  };
}
export function replacementRequest(config, original) {
  const requestId = `bundle-bootstrap-recovery-${rawHash([
    1,
    config.projectId,
    config.releaseId,
    original.jobId,
    original.generation,
  ])}`;
  const key = digest([config.projectId, ACTOR, requestId]);
  const input = {
    kind: 'bundle.regenerate',
    entity: { type: 'bundle', id: original.bundleType },
    requestId,
    payload: { bundleType: original.bundleType },
    expectedGeneration: original.generation,
  };
  return {
    key,
    jobId: `job-${key.slice(0, 48)}`,
    requestId,
    inputHash: digest(input),
    args: {
      ...input,
      actorUid: ACTOR,
      continuation: true,
      expectedReleaseControl: { releaseId: config.releaseId, revision: config.controlRevision },
    },
  };
}
export function makeRecoveryPlan(config, observation, operator, reason, evidenceReference, runtime) {
  assertRecoveryAuthority(config, observation.authority);
  if (observation.authority.control.revision !== config.controlRevision)
    throw fail('BUNDLE_RECOVERY_EXPECTED_REVISION_CHANGED');
  if (
    !operator?.email ||
    operator.verified !== true ||
    operator.authority !== 'google-adc-and-target-firestore-iam' ||
    typeof reason !== 'string' ||
    reason.trim().length < 10 ||
    reason.length > 2000 ||
    typeof evidenceReference !== 'string' ||
    !evidenceReference.trim() ||
    evidenceReference.length > 2000
  )
    throw fail('BUNDLE_RECOVERY_OPERATOR_REVIEW_REQUIRED');
  const originals = originalSpecs(config).map((spec) =>
    validateOriginal(config, observation.originals.find((r) => r.bundleType === spec.bundleType) ?? {}, spec)
  );
  const requests = originals.map((original) => ({
    bundleType: original.bundleType,
    ...replacementRequest(config, original),
  }));
  const recoveryId = rawHash([
    1,
    config.projectId,
    config.releaseId,
    config.compatibilityCommit,
    originals.map((o) => [o.jobId, o.generation, o.intentDigest]),
  ]);
  return canonical({
    schemaVersion: 1,
    recoveryId,
    projectId: config.projectId,
    releaseId: config.releaseId,
    runtimeCommit: config.compatibilityCommit,
    controlRevision: config.controlRevision,
    authority: observation.authority,
    operator,
    reason: reason.trim(),
    evidenceReference: evidenceReference.trim(),
    runtime,
    originalActorSemantics:
      'Shared trusted bundle server principal; this is operator release recovery, not an external Firebase event.',
    originals,
    requests,
  });
}
export function assertPlan(config, plan) {
  assertRecoveryAuthority(config, plan.authority);
  const expectedId = rawHash([
    1,
    config.projectId,
    config.releaseId,
    config.compatibilityCommit,
    plan.originals.map((o) => [o.jobId, o.generation, o.intentDigest]),
  ]);
  if (
    plan.schemaVersion !== 1 ||
    plan.projectId !== config.projectId ||
    plan.releaseId !== config.releaseId ||
    plan.runtimeCommit !== config.compatibilityCommit ||
    plan.controlRevision !== config.controlRevision ||
    plan.recoveryId !== expectedId ||
    plan.originals.length !== 6 ||
    plan.requests.length !== 6 ||
    originalSpecs(config).some(
      (s, i) =>
        s.jobId !== plan.originals[i].jobId ||
        s.bundleType !== plan.originals[i].bundleType ||
        digest(plan.requests[i]) !==
          digest({ bundleType: s.bundleType, ...replacementRequest(config, plan.originals[i]) })
    )
  )
    throw fail('BUNDLE_RECOVERY_PLAN_CHANGED');
}
function validateCurrent(config, type, current) {
  const { entity: e, job: j, intent: i, receipt: r } = current ?? {};
  if (
    !e ||
    !j ||
    !i ||
    !r ||
    e.projectId !== config.projectId ||
    e.entity?.type !== 'bundle' ||
    e.entity.id !== type ||
    !Number.isSafeInteger(e.generation) ||
    e.generation < 1 ||
    e.activeJobId !== j.jobId ||
    j.projectId !== config.projectId ||
    j.kind !== 'bundle.regenerate' ||
    j.entity?.type !== 'bundle' ||
    j.entity.id !== type ||
    j.workflowId !== `bundle:${config.projectId}:${type}` ||
    j.generation !== e.generation ||
    i.projectId !== j.projectId ||
    i.jobId !== j.jobId ||
    i.kind !== j.kind ||
    i.generation !== j.generation ||
    i.actorUid !== j.requestedBy ||
    digest(i.entity) !== digest(j.entity) ||
    digest(i.payload) !== digest({ bundleType: type }) ||
    r.projectId !== j.projectId ||
    r.actorUid !== j.requestedBy ||
    r.receipt?.jobId !== j.jobId ||
    r.receipt.projectId !== j.projectId ||
    r.receipt.generation !== j.generation ||
    r.receipt.requestId !== j.requestId ||
    !/^[a-f0-9]{64}$/.test(r.inputHash ?? '')
  )
    throw fail('BUNDLE_RECOVERY_CURRENT_GENERATION_UNBOUND');
  return j;
}
export function decideRecovery(config, plan, index, row) {
  const original = plan.originals[index],
    request = plan.requests[index];
  const verified = validateOriginal(config, row, original);
  if (digest(verified) !== digest(original)) throw fail('BUNDLE_RECOVERY_ORIGINAL_CHANGED');
  const current = validateCurrent(config, original.bundleType, row.current);
  const existing = row.replacement;
  if (existing?.receipt) {
    if (
      existing.receipt.inputHash !== request.inputHash ||
      existing.receipt.actorUid !== ACTOR ||
      existing.receipt.projectId !== config.projectId ||
      existing.receipt.receipt?.jobId !== request.jobId ||
      existing.receipt.receipt.requestId !== request.requestId ||
      existing.receipt.receipt.projectId !== config.projectId ||
      existing.receipt.receipt.generation !== original.generation + 1 ||
      existing.job?.jobId !== request.jobId ||
      existing.job.generation !== original.generation + 1 ||
      existing.job.projectId !== config.projectId ||
      existing.job.kind !== 'bundle.regenerate' ||
      existing.job.entity?.id !== original.bundleType ||
      existing.job.requestId !== request.requestId ||
      existing.intent?.actorUid !== ACTOR ||
      existing.intent.jobId !== request.jobId ||
      existing.intent.generation !== original.generation + 1 ||
      digest(existing.intent.payload) !== digest({ bundleType: original.bundleType })
    )
      throw fail('BUNDLE_RECOVERY_REPLACEMENT_RECEIPT_CHANGED');
  } else if (existing?.job || existing?.intent) throw fail('BUNDLE_RECOVERY_REPLACEMENT_PARTIAL_OR_FOREIGN');
  if (current.generation === original.generation && current.jobId === original.jobId) {
    if (existing?.receipt) throw fail('BUNDLE_RECOVERY_ENTITY_REGRESSED');
    return {
      bundleType: original.bundleType,
      decision: 'submit',
      jobId: request.jobId,
      generation: original.generation + 1,
    };
  }
  if (
    current.generation <= original.generation ||
    !['queued', 'running', 'retrying', 'reconciling', 'succeeded'].includes(current.state)
  )
    throw fail('BUNDLE_RECOVERY_NEWER_GENERATION_REQUIRES_REVIEW');
  if (current.jobId === request.jobId && !existing?.receipt) throw fail('BUNDLE_RECOVERY_REPLACEMENT_RECEIPT_MISSING');
  return {
    bundleType: original.bundleType,
    decision: current.jobId === request.jobId ? 'replacement-receipt-verified' : 'newer-legitimate-generation',
    jobId: current.jobId,
    generation: current.generation,
  };
}
export async function recoverBundleBootstrap(
  { config, plan, operationId = randomUUID(), resume = false, operator },
  deps
) {
  assertPlan(config, plan);
  const operation = await deps.acquire(plan, operationId, resume, operator);
  // Every later failure retains the nonexpiring owned operation and immutable plan.
  for (let index = 0; index < 6; index++) {
    let observation = await deps.observe(plan, operation);
    assertRecoveryAuthority(config, observation.authority, plan.authority);
    let decision = decideRecovery(config, plan, index, observation.originals[index]);
    if (decision.decision === 'submit') {
      await deps.submit(plan.requests[index].args); // Exactly once; ambiguous acknowledgement requires explicit resume.
      observation = await deps.observe(plan, operation);
      assertRecoveryAuthority(config, observation.authority, plan.authority);
      decision = decideRecovery(config, plan, index, observation.originals[index]);
      if (decision.decision === 'submit') throw fail('BUNDLE_RECOVERY_SUBMISSION_NOT_CONFIRMED');
    }
  }
  return deps.finish(plan, operation, operator);
}

/** Firestore adapter; caller injects real SDK clients. No hidden clock, expiry or manual job writes. */
export function createRecoveryStore({ db, config, serverTimestamp }) {
  const ref = (p) => db.doc(p),
    planPath = (id) => `_control/temporalBundleBootstrapRecovery-${id}`,
    resultPath = (id) => `_control/temporalBundleBootstrapRecoveryResult-${id}`;
  const read = (tx, r) => (tx ? tx.get(r) : r.get());
  async function observe(plan, operation, tx) {
    const [c, s, o] = await Promise.all([CONTROL, STATE, OPERATION].map((p) => read(tx, ref(p))));
    const authority = {
      control: c.data(),
      state: s.data(),
      controlCreateTime: c.createTime,
      stateCreateTime: s.createTime,
      controlUpdateTime: c.updateTime,
      stateUpdateTime: s.updateTime,
      serverReadTime: c.readTime,
    };
    assertRecoveryAuthority(config, authority, plan?.authority);
    if (operation) {
      const certificate = await read(tx, ref(planPath(plan.recoveryId)));
      if (!certificate.exists || digest(certificate.get('plan')) !== digest(plan))
        throw fail('BUNDLE_RECOVERY_AUDIT_CHANGED');
    }
    if (
      operation &&
      (!o.exists || digest(o.data()) !== operation.digest || digest(o.updateTime) !== digest(operation.updateTime))
    )
      throw fail('BUNDLE_RECOVERY_OPERATION_CHANGED');
    const specs = originalSpecs(config);
    const originals = await Promise.all(
      specs.map(async (spec, index) => {
        const [j, i, r, e, b, p] = await Promise.all(
          [
            `durableJobs/${spec.jobId}`,
            `durableJobIntents/${spec.jobId}`,
            `durableAdmissionReceipts/${spec.key}`,
            `durableJobEntities/${spec.entityKey}`,
            `durableJobOutbox/${spec.jobId}`,
            `_durableBundlePointers/${spec.bundleType}`,
          ].map((path) => read(tx, ref(path)))
        );
        if (e.exists && !/^job-[a-f0-9]{48}$/.test(e.get('activeJobId') ?? ''))
          throw fail('BUNDLE_RECOVERY_CURRENT_GENERATION_UNBOUND');
        const currentJob = e.get('activeJobId')
          ? await read(tx, ref(`durableJobs/${e.get('activeJobId')}`))
          : undefined;
        let currentIntent, currentReceipt;
        if (currentJob?.exists) {
          currentIntent = await read(tx, ref(`durableJobIntents/${currentJob.id}`));
          const actor = currentJob.get('requestedBy'),
            requestId = currentJob.get('requestId');
          if (typeof actor !== 'string' || typeof requestId !== 'string')
            throw fail('BUNDLE_RECOVERY_CURRENT_GENERATION_UNBOUND');
          currentReceipt = await read(
            tx,
            ref(`durableAdmissionReceipts/${digest([config.projectId, actor, requestId])}`)
          );
        }
        const replacement = plan?.requests[index];
        let replacementDocs = [];
        if (replacement)
          replacementDocs = await Promise.all(
            [
              `durableAdmissionReceipts/${replacement.key}`,
              `durableJobs/${replacement.jobId}`,
              `durableJobIntents/${replacement.jobId}`,
            ].map((path) => read(tx, ref(path)))
          );
        return {
          bundleType: spec.bundleType,
          job: j.data(),
          intent: i.data(),
          receipt: r.data(),
          outbox: b.data(),
          pointer: p.data() ?? null,
          current: {
            entity: e.data(),
            job: currentJob?.data(),
            intent: currentIntent?.data(),
            receipt: currentReceipt?.data(),
          },
          replacement: replacement
            ? { receipt: replacementDocs[0].data(), job: replacementDocs[1].data(), intent: replacementDocs[2].data() }
            : undefined,
        };
      })
    );
    return { authority, originals, operation: o.data() ?? null };
  }
  async function unsettled(tx) {
    const leases = await tx.get(
      db.collection('legacyAdmissionLeases').where('state', 'in', ['active', 'needs_attention']).limit(1)
    );
    const heads = await tx.get(
      db.collection('durableActivityExecutions').where('projectId', '==', config.projectId).limit(501)
    );
    const critical = await tx.get(
      db.collection('durableJobCriticalSections').where('projectId', '==', config.projectId).limit(1)
    );
    if (!leases.empty || !critical.empty || heads.size > 500) throw fail('BUNDLE_RECOVERY_EXECUTIONS_NOT_SETTLED');
    const drains = await Promise.all(
      heads.docs.map(async (d) => {
        const h = d.data();
        const id = rawHash([h.workflowId, h.runId, h.activityId, h.scheduledAt]);
        if (h.executionId !== id || !Number.isSafeInteger(h.attempt) || h.attempt < 1 || !h.worker?.instanceId)
          throw fail('BUNDLE_RECOVERY_EXECUTION_INVALID');
        const key = rawHash([config.projectId, h.jobId, h.executionId, h.attempt, h.worker.instanceId]);
        const snapshot = await tx.get(ref(`durableActivityDrains/${key}`)),
          v = snapshot.data();
        if (
          v?.schemaVersion !== 1 ||
          v.projectId !== config.projectId ||
          v.jobId !== h.jobId ||
          v.executionId !== h.executionId ||
          v.state !== 'drained' ||
          v.source !== 'worker_settled' ||
          !Number.isFinite(v.drainedAt) ||
          v.execution?.attempt !== h.attempt ||
          v.execution?.worker?.instanceId !== h.worker.instanceId ||
          ['workflowId', 'runId', 'activityId', 'activityType', 'scheduledAt'].some((k) => v.execution?.[k] !== h[k])
        )
          throw fail('BUNDLE_RECOVERY_EXECUTIONS_NOT_SETTLED');
        return key;
      })
    );
    return { latestExecutionWitnesses: drains.length };
  }
  return {
    observe,
    async readPlan(recoveryId) {
      const [p, r] = await Promise.all([ref(planPath(recoveryId)).get(), ref(resultPath(recoveryId)).get()]);
      return { plan: p.data(), result: r.data() };
    },
    async acquire(plan, operationId, resume, operator) {
      await db.runTransaction(async (tx) => {
        const observation = await observe(plan, undefined, tx);
        for (let i = 0; i < 6; i++) decideRecovery(config, plan, i, observation.originals[i]);
        const [lock, certificate, result] = await Promise.all(
          [OPERATION, planPath(plan.recoveryId), resultPath(plan.recoveryId)].map((p) => tx.get(ref(p)))
        );
        if (result.exists) throw fail('BUNDLE_RECOVERY_ALREADY_COMPLETED');
        if (resume) {
          if (
            !lock.exists ||
            lock.get('operationId') !== operationId ||
            lock.get('action') !== RECOVERY_ACTION ||
            lock.get('releaseId') !== config.releaseId ||
            lock.get('recoveryId') !== plan.recoveryId ||
            !certificate.exists ||
            digest(certificate.data().plan) !== digest(plan)
          )
            throw fail('BUNDLE_RECOVERY_RESUME_IDENTITY_CHANGED');
        } else {
          if (lock.exists || certificate.exists) throw fail('BUNDLE_RECOVERY_EXPLICIT_RESUME_REQUIRED');
          await unsettled(tx);
          tx.create(ref(planPath(plan.recoveryId)), { schemaVersion: 1, plan, createdAt: serverTimestamp() });
          tx.create(ref(OPERATION), {
            operationId,
            action: RECOVERY_ACTION,
            releaseId: config.releaseId,
            runtimeCommit: config.compatibilityCommit,
            controlRevision: config.controlRevision,
            recoveryId: plan.recoveryId,
            operator,
            createdAt: serverTimestamp(),
          });
        }
      });
      const lock = await ref(OPERATION).get();
      if (lock.get('operationId') !== operationId || lock.get('recoveryId') !== plan.recoveryId)
        throw fail('BUNDLE_RECOVERY_OPERATION_CHANGED');
      return { operationId, digest: digest(lock.data()), updateTime: canonical(lock.updateTime) };
    },
    async finish(plan, operation, operator) {
      return db.runTransaction(async (tx) => {
        const observation = await observe(plan, operation, tx);
        const [certificate, existing] = await Promise.all(
          [planPath(plan.recoveryId), resultPath(plan.recoveryId)].map((p) => tx.get(ref(p)))
        );
        if (!certificate.exists || digest(certificate.get('plan')) !== digest(plan) || existing.exists)
          throw fail('BUNDLE_RECOVERY_AUDIT_CHANGED');
        const decisions = observation.originals.map((row, i) => decideRecovery(config, plan, i, row));
        if (decisions.some((d) => d.decision === 'submit')) throw fail('BUNDLE_RECOVERY_SUBMISSION_NOT_CONFIRMED');
        const result = {
          schemaVersion: 1,
          result: 'recovery-admissions-verified',
          projectId: config.projectId,
          releaseId: config.releaseId,
          controlRevision: config.controlRevision,
          recoveryId: plan.recoveryId,
          operationId: operation.operationId,
          operator,
          planDigest: digest(plan),
          decisions,
          claimsJobsSucceeded: false,
          claimsBundlesConverged: false,
          claimsAdmissionOpen: false,
        };
        tx.create(ref(resultPath(plan.recoveryId)), { ...result, verifiedAt: serverTimestamp() });
        tx.delete(ref(OPERATION));
        return result;
      });
    },
  };
}
