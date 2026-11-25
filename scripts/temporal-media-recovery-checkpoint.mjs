import { mediaRecoveryAttestationCommitIsTimely, mediaRecoveryAttestedWorkExpiry, mediaRecoveryLaunchWindow } from './temporal-media-recovery-execution-window.mjs';
import { hasCompletedMediaRecoveryJobAccess, mediaRecoveryJobAccessPlan, requiresEmptyAttestedJobPolicy, renderMediaRecoveryJob, renderMediaRecoveryJobCreateRequest, sameMediaRecoveryTask } from './temporal-media-recovery-job.mjs';
import {assertStoredMediaDiagnosticDrain,assertFreshMediaDiagnosticDrain} from './temporal-media-diagnostic-drain.mjs';
import { assertNativeSnapshot, assertNativeSnapshotSuccessor, nativeSnapshotProof, proofDigest as hash } from './temporal-release-runtime.mjs';
import {prepareCompletedMediaRecoveryCapsule} from './temporal-media-recovery-capsule.mjs';
const fail = () => {
  throw new Error('MEDIA_RECOVERY_CHECKPOINT_UNCONFIRMED');
};
const domains = ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'];
export async function assertMediaRecoveryAuthority(o) {
  await o.firestore.runTransaction(
    async (tx) => {
      await authority(o, tx);
    },
    { readOnly: true }
  );
}
async function authority(o, tx) {
  const [parent, control, state] = await Promise.all([
    ...[o.lockRef, o.controlRef, o.stateRef].map(r => tx.get(r)), o.assertOriginalRecoveryAuthority?.(tx),
  ]);
  assertNativeSnapshot(o.ownedOperation, parent);
  assertNativeSnapshot(o.expectedAuthority.control, control);
  assertNativeSnapshot(o.expectedAuthority.state, state);
  if (
    parent.get('action') !== 'diagnose-cloud-run-media-recovery' ||
    parent.get('operationId') !== o.operationId ||
    parent.get('bindingDigest') !== o.bindingDigest ||
    parent.get('releaseId') !== o.config.releaseId ||
    control.get('releaseId') !== o.config.releaseId ||
    state.get('releaseId') !== o.config.releaseId ||
    control.get('admission') !== 'paused' ||
    state.get('phase') !== 'provider-usage-ready' ||
    domains.some((d) => control.get(`domains.${d}.admission`) !== 'paused')
  )
    fail();
  return parent;
}
export async function saveMediaRecoveryCheckpoint(o) {
  const next = o.identityState;
  if (
    !next ||
    next.plan?.operationId !== o.operationId ||
    next.plan?.releaseId !== o.config.releaseId ||
    next.plan?.bindingDigest !== o.bindingDigest ||
    next.plan?.role !== 'media' ||
    (next.recoveryFailed !== undefined &&
      (!next.recoveryFailed ||
        next.recovery ||
        Object.keys(next.recoveryFailed).sort().join(',') !== 'bindingDigest,buildId,image,kind,operationId,proofSHA256' ||
        next.recoveryFailed.kind !== 'recovery-failed' ||
        next.recoveryFailed.operationId !== next.plan.operationId ||
        next.recoveryFailed.bindingDigest !== next.plan.bindingDigest ||
        next.recoveryFailed.buildId !== next.plan.buildId ||
        next.recoveryFailed.image !== next.plan.image ||
        !/^[a-f0-9]{64}$/.test(next.recoveryFailed.proofSHA256 ?? ''))) ||
    Object.keys(next).some(
      (k) =>
        ![
          'plan',
          'stage',
          'prepared',
          'diagnostic',
          'start',
          'recovery',
          'recoveryFailed',
          'drained',
          'stop',
          'stopped',
          'neverStarted',
          'restore',
          'disposition',
          'jobTermination',
          'jobDrain',
          'scope',
        ].includes(k)
    )
  )
    fail();
  const proposedDigest = await o.firestore.runTransaction(
    async (tx) => {
      const parent = await authority(o, tx),
        before = parent.get('cloudMediaRecovery');
      const transitions = {
        planned: ['planned', 'prepared'],
        prepared: ['prepared', 'recovered', 'recovery-failed', 'never-started'],
        recovered: ['recovered', 'drained'],
        'recovery-failed': ['recovery-failed', 'drained'],
        drained: ['drained', 'stopped', 'neverStarted'],
        stopped: ['stopped', 'completed'],
        'never-started': ['never-started', 'completed'],
        completed: ['completed'],
      };
      if (
        (Boolean(next.plan.job) &&
          (hash(next.plan.job) !== hash(renderMediaRecoveryJob(next.plan)) ||
           !['planned', 'prepared', 'completed'].includes(next.stage) ||
           ['diagnostic','start','stop','restore','drained','stopped','neverStarted','recoveryFailed'].some(k => next[k]))) ||
        (!next.plan.job && (next.jobTermination || next.jobDrain)) ||
        (!before && next.stage !== 'planned') ||
        (before && ((!transitions[before.stage]?.includes(next.stage) &&
           !(next.plan.job && before.stage === 'prepared' && next.stage === 'completed')) ||
           hash(before.plan) !== hash(next.plan)))
      )
        fail();
      for (const key of ['prepared', 'recovery', 'recoveryFailed', 'drained', 'stopped', 'neverStarted'])
        if (before && Object.hasOwn(before, key) && hash(before[key]) !== hash(next[key] ?? null)) fail();
      for (const key of ['diagnostic', 'start', 'stop', 'restore']) {
        const a = before?.[key],
          b = next[key];
        if (!a && b && b.stage !== 'attempted') fail();
        if (b) {
          const preceding = {
            diagnostic: next.prepared,
            start: next.diagnostic?.stage === 'completed',
            stop: next.start?.stage === 'completed' && next.drained,
            restore:
              (next.stop?.stage === 'completed' && next.stopped) ||
              (next.neverStarted && (!next.start || next.start.stage === 'rejected')),
          }[key];
          if (
            !preceding ||
            b.plan?.key !== key ||
            b.plan?.operationId !== o.operationId ||
            b.request?.method !== 'PATCH'
          )
            fail();
        }
        if (a) {
          if (
            !(
              {
                attempted: ['attempted', 'acknowledged', 'rejected'],
                acknowledged: ['acknowledged', 'completed'],
                completed: ['completed'],
                rejected: ['rejected'],
              }[a.stage] ?? []
            ).includes(b?.stage)
          )
            fail();
          for (const k of ['plan', 'request', 'protection', 'quota', 'attemptedAt'])
            if (hash(a[k] ?? null) !== hash(b[k] ?? null)) fail();
          if (
            (a.nativeOperation && a.nativeOperation !== b.nativeOperation) ||
            (['completed', 'rejected'].includes(a.stage) && hash(a) !== hash(b))
          )
            fail();
        }
      }
      // Prepared is an immutable native arming journal, never an operator-supplied
      // digest. Retain this join through cleanup without renewing its expiry.
      if (next.prepared) {
        const journal = await tx.get(o.firestore.doc(`_control/temporalMediaRecoveryJournal-${o.operationId}`));
        const record = journal.data(),
          attempt = parent.get('mediaRecoveryJournalAttempt'),
          p = next.prepared;
        if (
          !journal.exists ||
          record?.schemaVersion !== 1 ||
          record.scope !== 'arming-only-no-execution-authority' ||
          record.operationId !== o.operationId ||
          record.releaseId !== o.config.releaseId ||
          record.bindingDigest !== o.bindingDigest ||
          record.planSHA256 !== hash(next.plan) ||
          record.buildId !== next.plan.buildId ||
          record.image !== next.plan.image ||
          record.runner !== next.plan.runner ||
          record.pool !== next.plan.name ||
          hash(record.contract) !== hash(next.plan.contract) ||
          record.createdAt !== next.plan.createdAt ||
          record.expiresAt !== next.plan.expiresAt ||
          hash(record.authority) !== hash(o.expectedAuthority) ||
          !attempt ||
          Object.keys(attempt).sort().join(',') !== 'attemptedAt,planSHA256,recordSHA256,schemaVersion,stage' ||
          attempt.schemaVersion !== 1 ||
          attempt.stage !== 'completed' ||
          attempt.planSHA256 !== hash(next.plan) ||
          attempt.recordSHA256 !== hash(record) ||
          record.attemptedAt !== attempt.attemptedAt ||
          !Number.isFinite(Date.parse(attempt.attemptedAt)) ||
          Date.parse(attempt.attemptedAt) < Date.parse(next.plan.createdAt) ||
          Date.parse(attempt.attemptedAt) >= next.plan.expiresAt ||
          Object.keys(p).sort().join(',') !== 'bindingDigest,buildId,image,kind,operationId,proofSHA256' ||
          p.operationId !== o.operationId ||
          p.bindingDigest !== o.bindingDigest ||
          p.buildId !== next.plan.buildId ||
          p.image !== next.plan.image ||
          p.kind !== 'prepared' ||
          p.proofSHA256 !== hash(record)
        )
          fail();
      }
      if (next.plan.job && next.stage === 'completed') {
        if (before?.stage !== 'prepared' || !before.prepared || !next.prepared ||
            next.disposition !== 'normal-zero-after-job') fail();
        const provider = parent.get('mediaRecoveryJobProvider'), run = provider?.runIdentity;
        const terminal = next.jobTermination, drained = next.jobDrain, result = next.recovery;
        const intent = parent.get('mediaRecoveryWorkflowStart');
        const [start, original, replacement, receipt] = await Promise.all([
          ...['Start', 'Kernel', 'ReplacementKernel'].map(kind =>
            tx.get(o.firestore.doc(`_control/temporalMediaRecovery${kind}-${o.operationId}`))),
          tx.get(o.immutableReceipt),
        ]);
        const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
        const job = replacement.get('worker.cloudRunJob');
        if (
          receipt.exists || !run || run.stage !== 'acknowledged' ||
          run.jobPlanSHA256 !== hash(next.plan.job) || !start.exists ||
          start.get('stage') !== 'confirmed' || start.get('intentSHA256') !== hash(intent) ||
          start.get('jobRunSHA256') !== hash(run) || intent?.jobRunSHA256 !== hash(run) ||
          terminal?.kind !== 'job-task-terminated' || terminal.operationId !== o.operationId ||
          terminal.job !== next.plan.job.name || terminal.jobUid !== run.jobUid ||
          terminal.operation !== run.operation || terminal.execution !== run.execution ||
          terminal.executionUid !== run.executionUid || !digest(terminal.proofSHA256) ||
          !sameMediaRecoveryTask(terminal,job)||
          job.executionUid !== run.executionUid || hash(job) !== hash(original.get('worker.cloudRunJob')) ||
          original.get('stage') !== 'closed' || replacement.get('stage') !== 'closed' ||
          original.get('close.signal') !== 'SIGKILL' || replacement.get('close.signal') !== null ||
          replacement.get('close.code') !== 0 ||
          original.get('close.descendantsAbsent') !== true || replacement.get('close.descendantsAbsent') !== true ||
          drained?.kind !== 'job-queues-drained' || drained.operationId !== o.operationId ||
          drained.terminationSHA256 !== terminal.proofSHA256 || !digest(drained.proofSHA256) ||
          !Number.isFinite(Date.parse(drained.observedAt)) || Math.abs(Date.now() - Date.parse(drained.observedAt)) > 5000 ||
          result?.kind !== 'recovery' || result.operationId !== o.operationId ||
          result.bindingDigest !== o.bindingDigest || result.buildId !== next.plan.buildId ||
          result.image !== next.plan.image || !digest(result.proofSHA256)
        ) fail();
        const completion = {
          operationId: o.operationId, releaseId: o.config.releaseId, bindingDigest: o.bindingDigest,
          identityState: next, operatorPrincipal: o.operatorPrincipal,
        };
        const drainRef = o.firestore.doc(`_control/temporalMediaRecoveryDrain-${o.operationId}`);
        const drainRecord = {
          schemaVersion: 2, operationId: o.operationId, releaseId: o.config.releaseId, bindingDigest: o.bindingDigest,
          planSHA256: hash(next.plan), proof: drained,
        };
        const existingDrain = await tx.get(drainRef);
        if (existingDrain.exists) fail();
        const capsule = await prepareCompletedMediaRecoveryCapsule(o, tx, parent, next, completion, drainRecord);
        if (!capsule.create || Math.abs(Date.now() - Date.parse(drained.observedAt)) > 5000) fail();
        tx.create(drainRef, drainRecord);
        tx.create(capsule.ref, capsule.record);
        tx.create(o.immutableReceipt, completion);
        tx.update(o.lockRef, { cloudMediaRecovery: next });
        return hash({ ...parent.data(), cloudMediaRecovery: next });
      }
      if (next.plan.job && (next.recovery || next.jobTermination || next.jobDrain || next.disposition)) fail();
      let drainRef,drainRecord,createDrain=false;
      if(next.drained){
        const p=next.drained;
        if(Object.keys(p).sort().join(',')!=='bindingDigest,buildId,image,kind,observation,operationId,proofSHA256'||p.kind!=='drained'||p.operationId!==o.operationId||p.bindingDigest!==o.bindingDigest||p.buildId!==next.plan.buildId||p.image!==next.plan.image||p.proofSHA256!==hash(p.observation))fail();
        assertStoredMediaDiagnosticDrain(p.observation,next.plan,next.start?.pool);
        drainRef=o.firestore.doc(`_control/temporalMediaRecoveryDrain-${o.operationId}`);
        const existing=await tx.get(drainRef);
        drainRecord={schemaVersion:1,operationId:o.operationId,releaseId:o.config.releaseId,bindingDigest:o.bindingDigest,planSHA256:hash(next.plan),proof:p};
        if(before?.drained){if(!existing.exists||hash(existing.data())!==hash(drainRecord))fail();}
        else{if(existing.exists||next.stage!=='drained')fail();assertFreshMediaDiagnosticDrain(p.observation,next.plan,next.start.pool);createDrain=true;}
      }
      const receipt = next.stage === 'completed' ? await tx.get(o.immutableReceipt) : undefined;
      const neverStarted =
        next.neverStarted &&
        !next.recovery &&
        !next.recoveryFailed &&
        !next.drained &&
        !next.stop &&
        !next.stopped &&
        (!next.start || next.start.stage === 'rejected');
      if (next.neverStarted && !neverStarted) fail();
      if (
        next.stage === 'completed' &&
        (!next.prepared ||
          next.diagnostic?.stage !== 'completed' ||
          next.restore?.stage !== 'completed' ||
          next.disposition !== 'restored-normal-zero' ||
          (!neverStarted &&
            (!next.drained ||
              !next.stopped ||
              Boolean(next.recovery) === Boolean(next.recoveryFailed) ||
              ['start', 'stop'].some((k) => next[k]?.stage !== 'completed'))))
      )
        fail();
      if (before?.stage === 'completed' && hash(before) !== hash(next)) fail();
      const record = {
        operationId: o.operationId,
        releaseId: o.config.releaseId,
        bindingDigest: o.bindingDigest,
        identityState: next,
        operatorPrincipal: o.operatorPrincipal,
      };
      if (receipt?.exists && hash(receipt.data()) !== hash(record)) fail();
      const capsule=next.stage==='completed'&&next.recovery&&!next.recoveryFailed&&!next.neverStarted
        ?await prepareCompletedMediaRecoveryCapsule(o,tx,parent,next,record,drainRecord):undefined;
      if(capsule?.create)tx.create(capsule.ref,capsule.record);
      if(createDrain){assertFreshMediaDiagnosticDrain(next.drained.observation,next.plan,next.start.pool);tx.create(drainRef,drainRecord);}
      tx.update(o.lockRef, { cloudMediaRecovery: next });
      if (receipt && !receipt.exists) tx.create(o.immutableReceipt, record);
      if (next.plan.job) return hash({ ...parent.data(), cloudMediaRecovery: next });
    },
    { maxAttempts: 1 }
  );
  const current = await o.lockRef.get();
  return next.plan.job
    ? assertNativeSnapshotSuccessor(o.ownedOperation, proposedDigest, current)
    : nativeSnapshotProof(current);
}

/** The Job provider journal belongs to the exact paused release operation.
 * Existing pool-oriented recovery checkpoints and capsules have separate schemas. */
export async function readMediaRecoveryJobJournal(o) {
  return o.firestore.runTransaction(async (tx) => {
    const parent = await authority(o, tx);
    const cycle = parent.get('cloudMediaRecovery');
    if (
      cycle?.stage !== 'prepared' ||
      !cycle.prepared ||
      hash(cycle.plan) !== hash(o.plan) ||
      cycle.diagnostic || cycle.start || cycle.stop || cycle.restore
    ) fail();
    return parent.get('mediaRecoveryJobProvider');
  }, { readOnly: true });
}

export async function saveMediaRecoveryJobJournal(o, before, next) {
  const stampBefore = o.ownedOperation;
  const proposedDigest = await o.firestore.runTransaction(async (tx) => {
    const parent = await authority(o, tx);
    const cycle = parent.get('cloudMediaRecovery');
    if (
      cycle?.stage !== 'prepared' || !cycle.prepared ||
      hash(cycle.plan) !== hash(o.plan) ||
      cycle.diagnostic || cycle.start || cycle.stop || cycle.restore ||
      hash(parent.get('mediaRecoveryJobProvider') ?? null) !== hash(before ?? null) ||
      next?.jobPlanSHA256 !== hash(o.plan.job)
    ) fail();
    const key = ['create','access','run','runIdentity'].find(key => hash(before?.[key] ?? null) !== hash(next[key] ?? null));
    if (!key) fail();
    const changed = next[key];
    if (!changed || hash({ ...(before ?? { jobPlanSHA256: next.jobPlanSHA256 }), [key]: changed }) !== hash(next))
      fail();
    const previous = before?.[key];
    const noGrant = requiresEmptyAttestedJobPolicy(o.plan);
    const hasAccess = noGrant
      ? hasCompletedMediaRecoveryJobAccess(o.plan, before?.access, before?.access?.plan?.jobUid)
      : before?.access?.stage === 'completed' && before.access.outcome === 'acknowledged-write-and-policy-observation';
    if (key === 'access') {
      const prior = previous?.stage;
      const allowed = {
        planned: [undefined],
        attempted: ['planned'],
        acknowledged: ['attempted'],
        rejected: ['attempted'],
        completed: ['acknowledged', 'attempted', 'planned'],
      };
      if (before?.create?.stage !== 'acknowledged' || before.run) fail();
      if (noGrant) {
        if (previous || !hasCompletedMediaRecoveryJobAccess(o.plan, changed, changed.plan?.jobUid)) fail();
      } else if (
        hash(changed.plan) !== hash(mediaRecoveryJobAccessPlan(o.plan, changed.plan?.jobUid)) ||
        !Object.hasOwn(allowed, changed.stage) || !allowed[changed.stage].includes(prior) ||
        (previous && hash(previous.plan) !== hash(changed.plan)) ||
        (prior === 'acknowledged' && changed.outcome !== 'acknowledged-write-and-policy-observation')
      ) fail();
    } else if (key === 'runIdentity') {
      if (previous || before?.run?.stage !== 'acknowledged' ||
          before.access?.stage !== 'completed' || (noGrant && !hasAccess) || before.access.plan.jobUid !== changed.jobUid ||
          changed.stage !== 'acknowledged' || changed.operation !== before.run.operation ||
          changed.intentSHA256 !== before.run.intentSHA256 || changed.attemptedAt !== before.run.attemptedAt ||
          changed.jobPlanSHA256 !== next.jobPlanSHA256) fail();
    } else {
      const request = changed.request;
      const attemptedAt = Date.parse(changed.attemptedAt);
      if (
        request?.method !== 'POST' ||
        (key === 'create' ? hash(request) !== hash(renderMediaRecoveryJobCreateRequest(o.plan)) :
          request.url !== 'https://run.googleapis.com/v2/' + o.plan.job.name + ':run' ||
          Object.keys(request.body ?? {}).join(',') !== 'etag' || typeof request.body.etag !== 'string' || !request.body.etag) ||
        !Number.isFinite(attemptedAt) || attemptedAt > Date.now() ||
        attemptedAt < Date.parse(o.plan.createdAt) || attemptedAt >= o.plan.expiresAt ||
        changed.intentSHA256 !== hash({ key, request, jobPlanSHA256: next.jobPlanSHA256, attemptedAt: changed.attemptedAt })
      ) fail();
      if ((key === 'run' && (before?.create?.stage !== 'acknowledged' || !hasAccess)) ||
          (!previous && changed.stage !== 'attempted') ||
          (previous && (previous.stage !== 'attempted' || changed.stage !== 'acknowledged' ||
            hash({ ...previous, stage: 'acknowledged', operation: changed.operation }) !== hash(changed)))) fail();
    }
    tx.update(o.lockRef, { mediaRecoveryJobProvider: next });
    return hash({ ...parent.data(), mediaRecoveryJobProvider: next });
  }, { maxAttempts: 1 });
  return assertNativeSnapshotSuccessor(stampBefore, proposedDigest, await o.lockRef.get());
}

/** Bind the sole signed Task witness to the exact original paused release and
 * acknowledged Job. Keep the provider journal's historical shape intact. */
export async function checkpointMediaRecoveryTaskAttestation(o) {
  const ref = o.firestore.doc(`_control/temporalMediaRecoveryTaskAttestation-${o.operationId}`);
  const arming = o.firestore.doc(`_control/temporalMediaRecoveryJournal-${o.operationId}`);
  const window = mediaRecoveryLaunchWindow(o.plan);
  if (!window) fail();
  const assertTimely = certificate => {
    if (window.version === undefined) return;
    const payload = certificate.data()?.payload;
    if (mediaRecoveryAttestedWorkExpiry(o.plan, payload) === undefined ||
        payload.operationId !== o.operationId || payload.planSHA256 !== hash(o.plan) ||
        !mediaRecoveryAttestationCommitIsTimely(window, payload, certificate.createTime)) fail();
  };
  const fresh = () => {
    if (!Number.isFinite(o.sampledAt) || performance.now() < o.sampledAt ||
        performance.now() - o.sampledAt > 5000 || Date.now() >= window.attestationExpiresAt) fail();
  };
  const observed = await o.firestore.runTransaction(async tx => {
    const parent = await authority(o, tx);
    const [journal, certificate] = await Promise.all([tx.get(arming), tx.get(ref)]);
    const plan = o.plan, cycle = parent.get('cloudMediaRecovery'), pointer = parent.get('mediaRecoveryTaskAttestation');
    const record = journal.data(), armingSHA256 = hash(record ?? null);
    if (!plan.taskAttestationPublicKey || cycle?.stage !== 'prepared' || hash(cycle.plan) !== hash(plan) ||
        hash(parent.get('mediaRecoveryJobProvider') ?? null) !== hash(o.provider) ||
        o.provider.runIdentity?.stage !== 'acknowledged' || cycle.prepared?.proofSHA256 !== armingSHA256 ||
        !journal.exists || !journal.createTime?.isEqual(journal.updateTime) ||
        record?.scope !== 'arming-only-no-execution-authority' || record.planSHA256 !== hash(plan) ||
        hash(record.authority) !== hash(o.expectedAuthority) ||
        parent.get('mediaRecoveryJournalAttempt.stage') !== 'completed' ||
        parent.get('mediaRecoveryJournalAttempt.recordSHA256') !== armingSHA256) fail();
    if (pointer !== undefined || certificate.exists) {
      const published = hash(certificate.data() ?? null);
      if (!certificate.exists || !certificate.createTime?.isEqual(certificate.updateTime) ||
          hash(pointer ?? null) !== hash({ certificateSHA256: published }) || o.record) fail();
      assertTimely(certificate);
      return { armingSHA256, published };
    }
    if (!o.record) return { armingSHA256 };
    const workers = await Promise.all(['Kernel', 'Startup'].map(kind =>
      tx.get(o.firestore.doc(`_control/temporalMediaRecovery${kind}-${o.operationId}`))));
    if (parent.get('mediaRecoveryWorkflowStart') !== undefined || workers.some(worker => worker.exists) ||
        o.record.payload?.armingSHA256 !== armingSHA256) fail();
    if (window.version !== undefined) {
      const issuedAt = Date.parse(o.record.payload?.issuedAt);
      if (mediaRecoveryAttestedWorkExpiry(plan, o.record.payload) === undefined ||
          issuedAt > Date.now() || Date.now() - issuedAt > 5000) fail();
    }
    fresh();
    const next = { certificateSHA256: hash(o.record) };
    tx.create(ref, o.record);
    tx.update(o.lockRef, { mediaRecoveryTaskAttestation: next });
    return { parentDigest: hash({ ...parent.data(), mediaRecoveryTaskAttestation: next }) };
  }, o.record ? { maxAttempts: 1 } : { readOnly: true });
  if (!o.record) return observed;
  const [parent, certificate] = await o.firestore.getAll(o.lockRef, ref);
  const ownedOperation = assertNativeSnapshotSuccessor(o.ownedOperation, observed.parentDigest, parent);
  if (!certificate.exists || !certificate.createTime?.isEqual(certificate.updateTime) ||
      !certificate.createTime.isEqual(parent.updateTime) || hash(certificate.data()) !== hash(o.record)) fail();
  assertTimely(certificate);
  return { ownedOperation };
}

/** Private ARMING journal only. This grants no Workflow/Activity or restart
 * authority: the production runtime remains unavailable until its full protocol
 * is implemented. The only create is preceded by a durable attempt. */
export async function prepareMediaRecoveryJournal(o) {
  const plan = o.plan;
  const fresh = () => {
    if (
      !plan ||
      plan.schemaVersion !== 1 ||
      plan.role !== 'media' ||
      plan.operationId !== o.operationId ||
      plan.releaseId !== o.config.releaseId ||
      plan.bindingDigest !== o.bindingDigest ||
      !/^[a-f0-9]{40}$/.test(plan.buildId ?? '') ||
      plan.name !==
        `projects/urm-app-staging/locations/us-central1/workerPools/urm-worker-media-${plan.buildId.slice(0, 20)}` ||
      plan.runner !== `tw-m-${plan.buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com` ||
      !/^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/.test(
        plan.image ?? ''
      ) ||
      hash(plan.contract) !==
        hash({
          deploymentName: 'urm-worker-media-recovery-staging',
          queue: 'urm-media-kernel-recovery',
          workflowType: 'MediaRecoveryProbe',
          protocol: 'owned-media-recovery-v1',
        }) ||
      !Number.isFinite(Date.parse(plan.createdAt)) ||
      plan.expiresAt !== Date.parse(plan.createdAt) + 300000 ||
      Date.parse(plan.createdAt) > Date.now() + 5000 ||
      Date.now() >= plan.expiresAt
    )
      fail();
  };
  fresh();
  if (
    o.firestore.projectId !== 'urm-app-staging' ||
    o.firestore.databaseId !== '(default)' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(o.operationId ?? '') ||
    o.lockRef.path !== '_control/temporalReleaseOperation' ||
    o.controlRef.path !== '_control/temporalRelease' ||
    o.stateRef.path !== '_control/temporalReleaseState'
  )
    fail();
  const ref = o.firestore.doc(`_control/temporalMediaRecoveryJournal-${o.operationId}`);
  const record = {
    schemaVersion: 1,
    scope: 'arming-only-no-execution-authority',
    operationId: o.operationId,
    releaseId: o.config.releaseId,
    bindingDigest: o.bindingDigest,
    planSHA256: hash(plan),
    buildId: plan.buildId,
    image: plan.image,
    runner: plan.runner,
    pool: plan.name,
    contract: plan.contract,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    authority: o.expectedAuthority,
  };
  const matches = (parent) => {
    const state = parent.get('cloudMediaRecovery');
    if (
      state?.stage !== 'planned' ||
      hash(state.plan) !== hash(plan) ||
      state.prepared ||
      state.diagnostic ||
      state.start
    )
      fail();
  };
  let ownedOperation = o.ownedOperation;
  let attempt;
  await o.firestore.runTransaction(
    async (tx) => {
      const parent = await authority({ ...o, ownedOperation }, tx);
      matches(parent);
      fresh();
      attempt = parent.get('mediaRecoveryJournalAttempt');
    },
    { readOnly: true }
  );
  record.attemptedAt = attempt?.attemptedAt ?? new Date().toISOString();
  const recordSHA256 = hash(record);
  if (!attempt) {
    attempt = {
      schemaVersion: 1,
      stage: 'attempted',
      recordSHA256,
      planSHA256: hash(plan),
      attemptedAt: record.attemptedAt,
    };
    // Unknown checkpoint ACK cannot proceed to a create. A later invocation sees
    // the attempt and is GET-only; it cannot turn absence into retry authority.
    try {
      await o.firestore.runTransaction(
        async (tx) => {
          const parent = await authority({ ...o, ownedOperation }, tx);
          matches(parent);
          fresh();
          const current = await tx.get(ref);
          if (parent.get('mediaRecoveryJournalAttempt') !== undefined || current.exists) fail();
          tx.update(o.lockRef, { mediaRecoveryJournalAttempt: attempt });
        },
        { maxAttempts: 1 }
      );
    } catch {
      await o.lockRef.get();
      throw new Error('MEDIA_RECOVERY_JOURNAL_ATTEMPT_ACK_UNKNOWN');
    }
    ownedOperation = nativeSnapshotProof(await o.lockRef.get());
    try {
      await o.firestore.runTransaction(
        async (tx) => {
          const parent = await authority({ ...o, ownedOperation }, tx);
          matches(parent);
          fresh();
          const current = await tx.get(ref);
          if (hash(parent.get('mediaRecoveryJournalAttempt')) !== hash(attempt) || current.exists) fail();
          tx.create(ref, record);
          tx.update(o.lockRef, { mediaRecoveryJournalAttempt: { ...attempt, stage: 'completed' } });
        },
        { maxAttempts: 1 }
      );
    } catch {
      // Do not resend after any error, including definite rejection. Exact GET
      // reconciliation is allowed only on a later invocation over native state.
      await Promise.all([ref.get(), o.lockRef.get()]);
      throw new Error('MEDIA_RECOVERY_JOURNAL_CREATE_UNCONFIRMED');
    }
    ownedOperation = nativeSnapshotProof(await o.lockRef.get());
  }
  let parent;
  await o.firestore.runTransaction(
    async (tx) => {
      parent = await authority({ ...o, ownedOperation }, tx);
      matches(parent);
      const actual = parent.get('mediaRecoveryJournalAttempt'),
        current = await tx.get(ref);
      if (
        actual?.stage !== 'completed' ||
        Object.keys(actual).sort().join(',') !== 'attemptedAt,planSHA256,recordSHA256,schemaVersion,stage' ||
        actual.schemaVersion !== 1 ||
        actual.recordSHA256 !== recordSHA256 ||
        actual.planSHA256 !== hash(plan) ||
        !Number.isFinite(Date.parse(actual.attemptedAt)) ||
        Date.parse(actual.attemptedAt) < Date.parse(plan.createdAt) ||
        Date.parse(actual.attemptedAt) > Date.now() + 5000 ||
        !current.exists ||
        hash(current.data()) !== recordSHA256
      )
        fail();
      fresh();
    },
    { readOnly: true }
  );
  fresh();
  return {
    ownedOperation: nativeSnapshotProof(parent),
    prepared: {
      operationId: o.operationId,
      bindingDigest: o.bindingDigest,
      buildId: plan.buildId,
      image: plan.image,
      kind: 'prepared',
      proofSHA256: recordSHA256,
    },
  };
}
