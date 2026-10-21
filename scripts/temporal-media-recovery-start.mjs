import { randomUUID } from 'node:crypto';
import { assertNativeSnapshot, nativeSnapshotProof, proofDigest as hash } from './temporal-release-runtime.mjs';
const fail = () => {
  throw new Error('MEDIA_RECOVERY_START_UNCONFIRMED');
};
const uuid = (x) => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const domains = ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'];
/** One native SDK START. The immutable producer intent stays on the original
 * parent; ACK facts use a separate journal so an early Activity sees no parent
 * drift when the START RPC returns. This is START proof, never recovery proof. */
export async function startMediaRecoveryWorkflow(o) {
  try {
    return await start(o);
  } catch {
    throw new Error('MEDIA_RECOVERY_START_UNCONFIRMED');
  }
}
async function start(o) {
  const { firestore: db, client, application, plan, pool, prepared } = o;
  if (
    db.projectId !== 'urm-app-staging' ||
    db.databaseId !== '(default)' ||
    o.lockRef.path !== '_control/temporalReleaseOperation' ||
    o.controlRef.path !== '_control/temporalRelease' ||
    o.stateRef.path !== '_control/temporalReleaseState' ||
    !uuid(o.operationId) ||
    plan?.operationId !== o.operationId ||
    plan.releaseId !== o.config.releaseId ||
    plan.bindingDigest !== o.bindingDigest ||
    plan.role !== 'media' ||
    !/^([a-f0-9]{40})$/.test(plan.buildId ?? '') ||
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
    typeof application.mediaRecoveryNativeStart !== 'function' ||
    typeof application.mediaRecoveryPinnedVersion !== 'function'
  )
    fail();
  const fresh = (requireUnexpired = true) => {
    if (
      !Number.isFinite(Date.parse(plan.createdAt)) ||
      plan.expiresAt !== Date.parse(plan.createdAt) + 300000 ||
      (requireUnexpired && Date.now() >= plan.expiresAt) ||
      Date.parse(plan.createdAt) > Date.now() + 5000
    )
      fail();
  };
  fresh(false);
  const journalRef = db.doc(`_control/temporalMediaRecoveryJournal-${o.operationId}`),
    receiptRef = db.doc(`_control/temporalMediaRecoveryStart-${o.operationId}`);
  let owned = o.ownedOperation,
    cycle,
    existing;
  const authority = async (tx) => {
    const [parent, control, state, journal] = await Promise.all(
      [o.lockRef, o.controlRef, o.stateRef, journalRef].map((r) => tx.get(r))
    );
    assertNativeSnapshot(owned, parent);
    assertNativeSnapshot(o.expectedAuthority.control, control);
    assertNativeSnapshot(o.expectedAuthority.state, state);
    const c = parent.get('cloudMediaRecovery'),
      j = journal.data(),
      a = parent.get('mediaRecoveryJournalAttempt');
    if (
      parent.get('action') !== 'diagnose-cloud-run-media-recovery' ||
      parent.get('operationId') !== o.operationId ||
      parent.get('bindingDigest') !== o.bindingDigest ||
      parent.get('releaseId') !== plan.releaseId ||
      hash(c?.plan) !== hash(plan) ||
      c.stage !== 'prepared' ||
      c.diagnostic?.stage !== 'completed' ||
      c.start?.stage !== 'completed' ||
      c.stop ||
      c.recovery ||
      c.recoveryFailed ||
      c.drained ||
      hash(c.start.pool) !== hash(pool) ||
      hash(c.prepared) !== hash(prepared) ||
      typeof pool.uid !== 'string' ||
      typeof pool.revisionUid !== 'string' ||
      !pool.revision?.startsWith(plan.name + '/revisions/') ||
      pool.desiredManualInstanceCount !== 1 ||
      !j ||
      j.schemaVersion !== 1 ||
      j.scope !== 'arming-only-no-execution-authority' ||
      j.planSHA256 !== hash(plan) ||
      j.operationId !== o.operationId ||
      j.releaseId !== plan.releaseId ||
      j.bindingDigest !== o.bindingDigest ||
      j.image !== plan.image ||
      j.buildId !== plan.buildId ||
      j.runner !== plan.runner ||
      j.pool !== plan.name ||
      hash(j.contract) !== hash(plan.contract) ||
      j.createdAt !== plan.createdAt ||
      j.expiresAt !== plan.expiresAt ||
      hash(j.authority) !== hash(o.expectedAuthority) ||
      a?.stage !== 'completed' ||
      a.planSHA256 !== hash(plan) ||
      a.recordSHA256 !== hash(j) ||
      a.attemptedAt !== j.attemptedAt ||
      prepared?.kind !== 'prepared' ||
      prepared.operationId !== o.operationId ||
      prepared.bindingDigest !== o.bindingDigest ||
      prepared.buildId !== plan.buildId ||
      prepared.image !== plan.image ||
      prepared.proofSHA256 !== hash(j) ||
      control.get('releaseId') !== plan.releaseId ||
      state.get('releaseId') !== plan.releaseId ||
      control.get('admission') !== 'paused' ||
      state.get('phase') !== 'provider-usage-ready' ||
      domains.some((d) => control.get(`domains.${d}.admission`) !== 'paused')
    )
      fail();
    if (cycle && hash(cycle) !== hash(c)) fail();
    cycle = c;
    fresh(false);
    return parent;
  };
  await db.runTransaction(
    async (tx) => {
      const p = await authority(tx);
      existing = p.get('mediaRecoveryWorkflowStart');
    },
    { readOnly: true }
  );
  const input = { operationId: o.operationId, startNonce: existing?.nonce ?? randomUUID() },
    intent = {
      schemaVersion: 1,
      stage: 'attempted',
      operationId: o.operationId,
      planSHA256: hash(plan),
      cycleSHA256: hash(cycle),
      poolSHA256: hash(pool),
      preparedSHA256: hash(prepared),
      workflowId: `media-recovery-${o.operationId}`,
      workflowType: 'MediaRecoveryProbe',
      taskQueue: 'urm-media-kernel-recovery',
      inputSHA256: hash(input),
      nonce: input.startNonce,
      deploymentVersion: { deploymentName: 'urm-worker-media-recovery-staging', buildId: plan.buildId },
      attemptedAt: existing?.attemptedAt ?? new Date().toISOString(),
      expiresAt: plan.expiresAt,
    };
  if (
    !uuid(intent.nonce) ||
    !Number.isFinite(Date.parse(intent.attemptedAt)) ||
    Date.parse(intent.attemptedAt) < Date.parse(plan.createdAt) ||
    Date.parse(intent.attemptedAt) >= plan.expiresAt ||
    (existing && hash(existing) !== hash(intent))
  )
    fail();
  let send = false;
  if (!existing) {
    fresh();
    await livePool(o, plan, pool);
    fresh();
    // Lost intent ACK cannot authorize a START, even if readback finds our intent.
    await db.runTransaction(
      async (tx) => {
        const parent = await authority(tx);
        fresh();
        if (parent.get('mediaRecoveryWorkflowStart') !== undefined || (await tx.get(receiptRef)).exists) fail();
        tx.update(o.lockRef, { mediaRecoveryWorkflowStart: intent });
      },
      { maxAttempts: 1 }
    );
    owned = nativeSnapshotProof(await o.lockRef.get());
    o.onOwnedOperation?.(owned);
    await db.runTransaction(
      async (tx) => {
        const p = await authority(tx);
        if (hash(p.get('mediaRecoveryWorkflowStart')) !== hash(intent)) fail();
      },
      { readOnly: true }
    );
    send = true;
  }
  const receipt = async () => {
    const value = (await receiptRef.get()).data();
    if (!value) return undefined;
    if (
      value.schemaVersion !== 1 ||
      value.operationId !== o.operationId ||
      value.intentSHA256 !== hash(intent) ||
      value.poolSHA256 !== hash(pool) ||
      (value.stage !== 'rejected' && !uuid(value.runId)) ||
      !['acknowledged', 'confirmed', 'rejected'].includes(value.stage) ||
      !Number.isFinite(Date.parse(value.recordedAt)) ||
      Date.parse(value.recordedAt) < Date.parse(intent.attemptedAt) ||
      Date.parse(value.recordedAt) > Date.now() + 5000 ||
      Object.keys(value).sort().join(',') !==
        [
          ...['schemaVersion', 'stage', 'operationId', 'intentSHA256', 'poolSHA256', 'runId', 'recordedAt'],
          ...(value.stage === 'rejected' ? ['status'] : ['ack']),
          ...(value.stage === 'confirmed' ? ['nativeStartSHA256', 'confirmedAt'] : []),
        ]
          .sort()
          .join(',') ||
      (value.stage === 'rejected'
        ? value.runId !== null || ![3, 5, 6, 7, 9, 11, 12, 16].includes(value.status)
        : !['native-start-response', 'unknown-ack-native-get-only'].includes(value.ack)) ||
      (value.stage === 'acknowledged' && value.ack !== 'native-start-response') ||
      (value.stage === 'confirmed' &&
        (!/^[a-f0-9]{64}$/.test(value.nativeStartSHA256) ||
          !Number.isFinite(Date.parse(value.confirmedAt)) ||
          Date.parse(value.confirmedAt) < Date.parse(value.recordedAt) ||
          Date.parse(value.confirmedAt) > Date.now() + 5000))
    )
      fail();
    return value;
  };
  const write = async (before, next) => {
    try {
      await db.runTransaction(
        async (tx) => {
          const p = await authority(tx);
          if (hash(p.get('mediaRecoveryWorkflowStart')) !== hash(intent)) fail();
          const current = await tx.get(receiptRef);
          if (hash(current.data() ?? null) !== hash(before ?? null)) fail();
          if (current.exists) tx.set(receiptRef, next);
          else tx.create(receiptRef, next);
        },
        { maxAttempts: 1 }
      );
    } catch {
      if (hash((await receiptRef.get()).data() ?? null) !== hash(next)) fail();
    }
  };
  let fact = await receipt();
  if (fact && send) fail();
  if (send) {
    // The fixed canonical client purpose disables both SDK and gRPC retries.
    // Recheck exact native authority immediately before this sole call.
    const poolObservation = await livePool(o, plan, pool);
    await db.runTransaction(
      async (tx) => {
        const p = await authority(tx);
        if (hash(p.get('mediaRecoveryWorkflowStart')) !== hash(intent)) fail();
      },
      { readOnly: true }
    );
    fresh();
    if (
      Date.now() > poolObservation.deadline ||
      Date.now() < poolObservation.sampledAt - 5000 ||
      performance.now() - poolObservation.sampledMonotonic > 5000
    )
      fail();
    let handle;
    try {
      handle = await client.connection.withDeadline(Date.now() + 5000, () =>
        client.workflow.start(intent.workflowType, {
          workflowId: intent.workflowId,
          taskQueue: intent.taskQueue,
          args: [input],
          versioningOverride: { pinnedTo: intent.deploymentVersion },
          workflowExecutionTimeout: '2 minutes',
          workflowIdReusePolicy: 'REJECT_DUPLICATE',
          workflowIdConflictPolicy: 'FAIL',
        })
      );
    } catch (error) {
      // A definite rejection must never become success by observing an existing name.
      const code = Number(error?.code ?? error?.cause?.code);
      if ([3, 5, 6, 7, 9, 11, 12, 16].includes(code) || error?.name === 'WorkflowExecutionAlreadyStartedError') {
        fact = {
          schemaVersion: 1,
          stage: 'rejected',
          operationId: o.operationId,
          intentSHA256: hash(intent),
          poolSHA256: hash(pool),
          runId: null,
          recordedAt: new Date().toISOString(),
          status: Number.isInteger(code) ? code : 6,
        };
        await write(undefined, fact);
        fail();
      }
    }
    if (handle) {
      if (!uuid(handle.firstExecutionRunId)) fail();
      fact = {
        schemaVersion: 1,
        stage: 'acknowledged',
        operationId: o.operationId,
        intentSHA256: hash(intent),
        poolSHA256: hash(pool),
        runId: handle.firstExecutionRunId,
        recordedAt: new Date().toISOString(),
        ack: 'native-start-response',
      };
      await write(undefined, fact);
    }
  }
  if (fact?.stage === 'rejected') fail();
  fresh(false);
  const observeUntil = Date.now() + 10000;
  let wi, runId, vi;
  do {
    fresh(false);
    const observed = await client.connection.withDeadline(Math.min(observeUntil, Date.now() + 5000), () =>
      client.workflow.getHandle(intent.workflowId, fact?.runId, { followRuns: false }).describe()
    );
    wi = observed.raw.workflowExecutionInfo;
    runId = wi?.execution?.runId;
    vi = wi?.versioningInfo;
    if (
      !uuid(runId) ||
      (fact && fact.runId !== runId) ||
      wi.execution.workflowId !== intent.workflowId ||
      ![1, 2].includes(wi.status)
    )
      fail();
    if (vi?.behavior === 1 && hash(vi.deploymentVersion) === hash(intent.deploymentVersion)) {
      application.mediaRecoveryPinnedVersion(vi.versioningOverride, intent.deploymentVersion);
      break;
    }
    // START acceptance can precede the first Workflow task applying the pin.
    // Wait only with GET over this original execution, never another START.
    if (Date.now() >= observeUntil || wi.status !== 1 || vi?.behavior === 1) fail();
    await new Promise((done) => setTimeout(done, 100));
  } while (true);
  const history = await client.connection.withDeadline(Date.now() + 5000, () =>
    client.workflowService.getWorkflowExecutionHistory({
      namespace: 'urm-app-staging.qwejt',
      execution: { workflowId: intent.workflowId, runId },
      maximumPageSize: 32,
      waitNewEvent: false,
    })
  );
  if (!history.history?.events?.length || history.history.events.length > 32 || history.nextPageToken?.length) fail();
  const nativeStartSHA256 = application.mediaRecoveryNativeStart(history.history.events[0], intent, input, runId);
  const at = history.history.events[0].eventTime;
  if (
    BigInt(String(at.seconds)) * 1000000000n + BigInt(at.nanos ?? 0) >= BigInt(plan.expiresAt) * 1000000n ||
    !/^[a-f0-9]{64}$/.test(nativeStartSHA256)
  )
    fail();
  if (fact?.stage === 'confirmed') {
    if (fact.nativeStartSHA256 !== nativeStartSHA256) fail();
  } else {
    const confirmed = {
      schemaVersion: 1,
      stage: 'confirmed',
      operationId: o.operationId,
      intentSHA256: hash(intent),
      poolSHA256: hash(pool),
      runId,
      recordedAt: fact?.recordedAt ?? new Date().toISOString(),
      ack: fact?.ack ?? 'unknown-ack-native-get-only',
      nativeStartSHA256,
      confirmedAt: new Date().toISOString(),
    };
    await write(fact, confirmed);
    fact = confirmed;
  }
  await db.runTransaction(
    async (tx) => {
      const parent = await authority(tx);
      const current = await tx.get(receiptRef);
      if (
        hash(parent.get('mediaRecoveryWorkflowStart')) !== hash(intent) ||
        hash(current.data() ?? null) !== hash(fact)
      )
        fail();
    },
    { readOnly: true }
  );
  fresh(false);
  return { ownedOperation: owned, start: fact, authorizationExpired: Date.now() >= plan.expiresAt };
}

/** Native reads are mandatory for a new send, never for historical GET-only
 * reconciliation. Exact generation/etag/template/UID joins fence pool drift. */
async function livePool(o, plan, pool) {
  if (typeof o.api !== 'function') fail();
  const sampled = Date.now(),
    sampledMonotonic = performance.now();
  const actual = await o.api(`https://run.googleapis.com/v2/${plan.name}`),
    revision = await o.api(`https://run.googleapis.com/v2/${pool.revision}`);
  const same = (expected, value) =>
    Array.isArray(expected)
      ? Array.isArray(value) && expected.length === value.length && expected.every((v, i) => same(v, value[i]))
      : expected && typeof expected === 'object'
      ? value && typeof value === 'object' && Object.entries(expected).every(([k, v]) => same(v, value[k]))
      : expected === value;
  const norm = (x) => (typeof x === 'string' ? x.replace('projects/251680231116/', 'projects/urm-app-staging/') : x);
  if (
    Date.now() - sampled > 5000 ||
    norm(actual?.name) !== plan.name ||
    actual.uid !== pool.uid ||
    String(actual.generation) !== pool.generation ||
    String(actual.observedGeneration) !== pool.generation ||
    actual.etag !== pool.etag ||
    actual.deleteTime ||
    actual.reconciling === true ||
    actual.scaling?.manualInstanceCount !== 1 ||
    actual.terminalCondition?.state !== 'CONDITION_SUCCEEDED' ||
    norm(actual.latestCreatedRevision) !== pool.revision ||
    norm(actual.latestReadyRevision) !== pool.revision ||
    !same(plan.diagnosticTemplate, actual.template) ||
    norm(revision?.name) !== pool.revision ||
    revision.uid !== pool.revisionUid ||
    revision.deleteTime ||
    !same(plan.diagnosticTemplate, revision)
  )
    fail();
  return { sampledAt: sampled, deadline: sampled + 5000, sampledMonotonic };
}
