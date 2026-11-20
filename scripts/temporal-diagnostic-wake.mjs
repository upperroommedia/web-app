import { proofDigest, assertNativeSnapshot, nativeSnapshotProof } from './temporal-release-runtime.mjs';
import { assertDiagnosticWakeAuthority } from './temporal-diagnostic-authority.mjs';
const surfaceKey = (surface) => {
  if (!['outbox-trigger', 'commands-trigger', 'scheduler'].includes(surface))
    throw new Error('DIAGNOSTIC_WAKE_SURFACE_REQUIRED');
  return surface === 'outbox-trigger' ? 'outbox' : surface === 'commands-trigger' ? 'commands' : 'scheduler';
};
const wakeField = (key) =>
  key === 'outbox'
    ? 'cloudDispatchDiagnosticWake'
    : key === 'commands'
    ? 'cloudDispatchDiagnosticCommandsWake'
    : 'cloudDispatchDiagnosticSchedulerWake';
const fail = () => {
  throw new Error('DIAGNOSTIC_WAKE_CHECKPOINT_UNCONFIRMED');
};
/** Same original operation, with an immutable native creation receipt before observation/STOP. */
export async function saveDiagnosticWakeCheckpoint(o, state) {
  const { firestore, lockRef, controlRef, stateRef, ownedOperation, expectedAuthority, diagnostic, operatorPrincipal } =
    o;
  const m = diagnostic.manifest,
    key = surfaceKey(state.plan?.creation?.surface),
    field = wakeField(key),
    receipt = firestore.doc(`_control/temporalDispatchDiagnosticWakeCreation-${m.operationId}-${key}`);
  if (state.plan.creation.operationId !== m.operationId || state.plan.diagnosticManifestSHA256 !== proofDigest(m))
    fail();
  await firestore.runTransaction(async (tx) => {
    const [p, c, s, r] = await Promise.all([lockRef, controlRef, stateRef, receipt].map((ref) => tx.get(ref)));
    assertNativeSnapshot(ownedOperation, p);
    assertNativeSnapshot(expectedAuthority.control, c);
    assertNativeSnapshot(expectedAuthority.state, s);
    if (
      p.get('action') !== 'prepare-cloud-run-dispatch-diagnostic' ||
      p.get('operationId') !== m.operationId ||
      p.get('releaseId') !== m.releaseId ||
      p.get('bindingDigest') !== m.bindingDigest ||
      proofDigest(p.get('cloudDispatchDiagnostic')) !== proofDigest(m) ||
      c.get('admission') !== 'paused' ||
      s.get('phase') !== 'provider-usage-ready' ||
      c.get('releaseId') !== m.releaseId ||
      s.get('releaseId') !== m.releaseId ||
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
        (d) => c.get(`domains.${d}.admission`) !== 'paused'
      )
    )
      fail();
    if (
      key === 'commands' &&
      (p.get('cloudDispatchDiagnosticWake.stage') !== 'completed' ||
        p.get('cloudDispatchDiagnosticWake.stopState.stage') !== 'completed' ||
        !p.get('cloudDispatchDiagnosticWake.diagnosticObservation') ||
        p.get('cloudDispatchDiagnosticWake.diagnosticObservationFailed'))
    )
      fail();
    if (
      key === 'scheduler' &&
      (p.get('cloudDispatchDiagnosticCommandsWake.stage') !== 'completed' ||
        p.get('cloudDispatchDiagnosticCommandsWake.stopState.stage') !== 'completed' ||
        p.get('cloudDispatchDiagnosticCommandsWake.diagnosticObservation.recovery') !== 'retry' ||
        p.get('cloudDispatchDiagnosticCommandsWake.diagnosticObservationFailed'))
    )
      fail();
    const previous = p.get(field);
    if (previous?.plan && proofDigest(previous.plan) !== proofDigest(state.plan)) fail();
    const creation = state.creationState;
    if (['created', 'stopping', 'completed'].includes(state.stage) && !creation) fail();
    if (creation && (creation.stage !== 'completed' || proofDigest(creation.plan) !== proofDigest(state.plan.creation)))
      fail();
    const record = creation
      ? {
          operationId: m.operationId,
          releaseId: m.releaseId,
          bindingDigest: m.bindingDigest,
          operatorPrincipal,
          identityState: creation,
        }
      : undefined;
    if (r.exists && (!record || proofDigest(r.data()) !== proofDigest(record))) fail();
    tx.update(lockRef, { [field]: state });
    if (record && !r.exists) tx.create(receipt, record);
  });
  return nativeSnapshotProof(await lockRef.get());
}
/** One atomic, private post-trigger write. Unknown ACK resumes by reading the
 * original pulse, never by writing again. It does not assert event delivery. */
export async function pulseDiagnosticOutbox(diagnostic, signal) {
  return pulseDiagnosticWake(diagnostic, 'outbox-trigger', signal);
}
export async function pulseDiagnosticWake(diagnostic, surface, signal) {
  if (surface === 'scheduler') fail();
  const key = surfaceKey(surface),
    field = wakeField(key),
    pulseField = `${key}Pulse`;
  const m = await assertDiagnosticWakeAuthority(diagnostic),
    { firestore } = diagnostic;
  const parent = firestore.doc('_control/temporalReleaseOperation'),
    journal = firestore.doc(`_control/temporalDispatchDiagnostic-${m.operationId}`);
  const record = firestore.doc(
      `${key === 'outbox' ? 'durableJobOutbox' : 'durableJobCommands'}/diagnostic-${m.operationId}-${key}`
    ),
    receipt = firestore.doc(`_control/temporalDispatchDiagnosticWakeCreation-${m.operationId}-${key}`);
  await firestore.runTransaction(async (tx) => {
    const [p, j, r, c, control, state, auth, final] = await Promise.all(
      [
        parent,
        journal,
        record,
        receipt,
        firestore.doc('_control/temporalRelease'),
        firestore.doc('_control/temporalReleaseState'),
        firestore.doc(`_control/temporalDispatchDiagnosticAuthorization-${m.operationId}`),
        firestore.doc(`_control/temporalDispatchDiagnosticCompletion-${m.operationId}`),
      ].map((ref) => tx.get(ref))
    );
    if (
      signal?.aborted ||
      version(control) !== m.controlVersion ||
      version(state) !== m.stateVersion ||
      control.get('admission') !== 'paused' ||
      state.get('phase') !== 'provider-usage-ready' ||
      !auth.exists ||
      proofDigest(auth.data()) !== proofDigest(m)
    )
      fail();
    if (
      p.get('action') !== 'prepare-cloud-run-dispatch-diagnostic' ||
      p.get('operationId') !== m.operationId ||
      p.get('releaseId') !== m.releaseId ||
      p.get('bindingDigest') !== m.bindingDigest ||
      proofDigest(p.get('cloudDispatchDiagnostic')) !== proofDigest(m) ||
      j.get('manifestDigest') !== proofDigest(m) ||
      r.get('state') !== 'diagnostic' ||
      r.get('manifestDigest') !== proofDigest(m) ||
      !c.exists ||
      c.get('operationId') !== m.operationId ||
      c.get('releaseId') !== m.releaseId ||
      c.get('bindingDigest') !== m.bindingDigest ||
      c.get('identityState.plan.surface') !== surface ||
      c.get('identityState.plan.operationId') !== m.operationId ||
      c.get('identityState.stage') !== 'completed' ||
      proofDigest(c.get('identityState')) !== proofDigest(p.get(`${field}.creationState`)) ||
      !['created', 'stopping', 'completed'].includes(p.get(`${field}.stage`))
    )
      fail();
    const pulse = { operationId: m.operationId, nonce: m.nonce, creationReceiptDigest: proofDigest(c.data()) };
    if (j.get(pulseField) !== undefined) {
      if (
        proofDigest(j.get(pulseField)) !== proofDigest(pulse) ||
        proofDigest(r.get('diagnosticPulse')) !== proofDigest(pulse)
      )
        fail();
      return;
    }
    if (
      final.exists ||
      p.get(`${field}.stage`) !== 'created' ||
      Date.now() >= m.expiresAt ||
      control.readTime.toMillis() >= m.expiresAt ||
      ['startAttemptedAt', 'lease', 'runId', 'dispatchAcknowledged'].some((key) => r.get(key) !== undefined)
    )
      fail();
    tx.update(journal, { [pulseField]: pulse });
    tx.update(record, { diagnosticPulse: pulse });
  });
}

const version = (snap) => (snap.updateTime ? `${snap.updateTime.seconds}:${snap.updateTime.nanoseconds}` : fail());
const same = (left, right) => proofDigest(left) === proofDigest(right);
const immutable = (snap) => snap.exists && snap.createTime?.isEqual(snap.updateTime);
const digestPattern = /^[a-f0-9]{64}$/;
const runIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const surfaces = ['outbox-trigger', 'commands-trigger', 'scheduler'];

function completedDiagnosticWake({ parent, creation, manifest, surface, evidenceDigest }) {
  const key = surfaceKey(surface);
  const wake = parent.get(wakeField(key));
  const created = creation.data();
  const stop = wake?.stopState;
  if (
    !immutable(creation) ||
    created?.operationId !== manifest.operationId ||
    created.releaseId !== manifest.releaseId ||
    created.bindingDigest !== manifest.bindingDigest ||
    created.identityState?.stage !== 'completed' ||
    wake?.stage !== 'completed' ||
    wake.plan?.diagnosticManifestSHA256 !== proofDigest(manifest) ||
    wake.diagnosticObservationFailed ||
    !same(wake.creationState, created.identityState) ||
    !same(wake.plan.creation, created.identityState.plan) ||
    created.identityState.plan?.operationId !== manifest.operationId ||
    created.identityState.plan.releaseId !== manifest.releaseId ||
    created.identityState.plan.evidenceDigest !== evidenceDigest ||
    created.identityState.plan.surface !== surface ||
    stop?.stage !== 'completed' ||
    stop.plan?.surface !== surface ||
    stop.plan.operationId !== manifest.operationId ||
    stop.plan.releaseId !== manifest.releaseId ||
    stop.plan.evidenceDigest !== evidenceDigest ||
    stop.plan.diagnosticManifestSHA256 !== proofDigest(manifest) ||
    !same(stop.plan.creation, created.identityState.plan) ||
    stop.plan.wakeReceiptSHA256 !== proofDigest(created) ||
    ![
      'native-stop-acknowledged-and-observed',
      'stopped-observed-after-unknown-acknowledgement',
      'observed-already-stopped',
    ].includes(stop.outcome)
  )
    fail();
  return wake;
}

function assertDiagnosticObservation({ manifest, journal, record, creation, wake, surface, recovery }) {
  const observed = wake.diagnosticObservation;
  const created = creation.data();
  const pulse = {
    operationId: manifest.operationId,
    nonce: manifest.nonce,
    creationReceiptDigest: proofDigest(created),
  };
  const delivery = recovery === 'retry' ? record.get('firstEventDelivery') : record.get('delivery');
  if (
    !record.exists ||
    record.get('state') !== 'diagnostic' ||
    record.get('surface') !== surface ||
    record.get('manifestDigest') !== proofDigest(manifest) ||
    record.get('dispatchAcknowledged') !== true ||
    !same(journal.get(`${surface}Pulse`), pulse) ||
    !same(record.get('diagnosticPulse'), pulse) ||
    record.get('startPulseDigest') !== proofDigest(pulse) ||
    observed?.schemaVersion !== 1 ||
    observed.operationId !== manifest.operationId ||
    observed.manifestDigest !== proofDigest(manifest) ||
    observed.workflowId !== `dispatch-diagnostic-${manifest.operationId}-${surface}` ||
    !runIdPattern.test(observed.runId ?? '') ||
    observed.runId !== record.get('runId') ||
    observed.surface !== surface ||
    observed.recovery !== recovery ||
    observed.serviceRevision !== manifest.serviceRevision ||
    observed.creationReceiptDigest !== proofDigest(created) ||
    (surface === 'outbox' &&
      (record.get('caller.kind') !== 'event' || record.get('caller.subject') !== manifest.eventSubject)) ||
    observed.pulseDigest !== proofDigest(pulse) ||
    !digestPattern.test(observed.historyDigest ?? '') ||
    (recovery === 'scheduler'
      ? observed.callerKind !== 'scheduler' ||
        observed.callerSubject !== manifest.schedulerSubject ||
        record.get('caller.kind') !== 'scheduler' ||
        record.get('caller.subject') !== manifest.schedulerSubject ||
        delivery?.kind !== 'scheduler' ||
        observed.job !== delivery.job
      : observed.callerKind !== 'event' ||
        observed.callerSubject !== manifest.eventSubject ||
        delivery?.kind !== 'event' ||
        typeof delivery.id !== 'string' ||
        !delivery.id ||
        observed.deliveryId !== delivery.id)
  )
    fail();
  if (surface === 'commands') {
    const retry = journal.get('commandsRetry');
    if (
      retry?.runId !== observed.runId ||
      retry.pulseDigest !== observed.pulseDigest ||
      retry.leaseExpiresAt !== record.get('firstLeaseExpiresAt') ||
      !Number.isSafeInteger(retry.leaseExpiresAt) ||
      !Number.isSafeInteger(record.get('retryFaultAppliedAt')) ||
      record.get('retryFaultAppliedAt') >= retry.leaseExpiresAt ||
      !same(retry.delivery, record.get('firstEventDelivery')) ||
      observed.retryWitnessDigest !== proofDigest(retry)
    )
      fail();
  }
  return observed;
}

/** Join the original diagnostic's three completed observations and native
 * cleanup receipts. The result is historical evidence and grants no admission. */
export const dispatchDiagnosticCompletionPath = (operationId) => {
  if (!runIdPattern.test(operationId ?? '')) fail();
  return `_control/temporalDispatchDiagnosticCompletion-${operationId}`;
};

export async function saveDispatchDiagnosticCompletion({
  diagnostic,
  lockRef,
  controlRef,
  stateRef,
  ownedOperation,
  expectedAuthority,
  evidenceDigest,
}) {
  const { firestore, manifest: m, activationReceipt } = diagnostic;
  if (
    firestore.projectId !== 'urm-app-staging' ||
    firestore.databaseId !== '(default)' ||
    !digestPattern.test(evidenceDigest ?? '') ||
    !runIdPattern.test(m.operationId ?? '') ||
    !runIdPattern.test(activationReceipt?.operationId ?? '')
  )
    fail();
  const doc = (path) => firestore.doc(path);
  const final = doc(dispatchDiagnosticCompletionPath(m.operationId));
  const result = await firestore.runTransaction(async (tx) => {
    const [parent, control, state, authorization, activation, journal, outbox, commands, old, ...creations] =
      await Promise.all(
        [
          lockRef,
          controlRef,
          stateRef,
          doc(`_control/temporalDispatchDiagnosticAuthorization-${m.operationId}`),
          doc(`_control/temporalCloudDispatchActivation-${activationReceipt.operationId}`),
          doc(`_control/temporalDispatchDiagnostic-${m.operationId}`),
          doc(`durableJobOutbox/diagnostic-${m.operationId}-outbox`),
          doc(`durableJobCommands/diagnostic-${m.operationId}-commands`),
          final,
          ...surfaces.map((surface) =>
            doc(`_control/temporalDispatchDiagnosticWakeCreation-${m.operationId}-${surfaceKey(surface)}`)
          ),
        ].map((ref) => tx.get(ref))
      );
    assertNativeSnapshot(ownedOperation, parent);
    assertNativeSnapshot(expectedAuthority.control, control);
    assertNativeSnapshot(expectedAuthority.state, state);
    if (
      m.schemaVersion !== 2 ||
      m.commandsRecovery !== 'scheduler' ||
      parent.get('action') !== 'prepare-cloud-run-dispatch-diagnostic' ||
      parent.get('operationId') !== m.operationId ||
      parent.get('bindingDigest') !== m.bindingDigest ||
      parent.get('releaseId') !== m.releaseId ||
      !same(parent.get('cloudDispatchDiagnostic'), m) ||
      version(control) !== m.controlVersion ||
      version(state) !== m.stateVersion ||
      control.get('releaseId') !== m.releaseId ||
      state.get('releaseId') !== m.releaseId ||
      control.get('admission') !== 'paused' ||
      state.get('phase') !== 'provider-usage-ready' ||
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
        (d) => control.get(`domains.${d}.admission`) !== 'paused'
      ) ||
      !immutable(authorization) ||
      !same(authorization.data(), m) ||
      !immutable(activation) ||
      !same(activation.data(), activationReceipt) ||
      activationReceipt.releaseId !== m.releaseId ||
      activationReceipt.identityState?.stage !== 'completed' ||
      activationReceipt.identityState.plan?.evidenceDigest !== evidenceDigest ||
      activationReceipt.identityState.plan.buildId !== m.buildId ||
      activationReceipt.identityState.plan.desired?.template?.containers?.[0]?.image !== m.image ||
      activationReceipt.identityState.service?.revision !== m.serviceRevision ||
      proofDigest(activationReceipt) !== m.activationDigest ||
      journal.get('manifestDigest') !== proofDigest(m)
    )
      fail();

    const wakes = surfaces.map((surface, index) =>
      completedDiagnosticWake({
        parent,
        creation: creations[index],
        manifest: m,
        surface,
        evidenceDigest,
      })
    );
    const observations = [
      assertDiagnosticObservation({
        manifest: m,
        journal,
        record: outbox,
        creation: creations[0],
        wake: wakes[0],
        surface: 'outbox',
      }),
      assertDiagnosticObservation({
        manifest: m,
        journal,
        record: commands,
        creation: creations[1],
        wake: wakes[1],
        surface: 'commands',
        recovery: 'retry',
      }),
      assertDiagnosticObservation({
        manifest: m,
        journal,
        record: commands,
        creation: creations[1],
        wake: wakes[2],
        surface: 'commands',
        recovery: 'scheduler',
      }),
    ];
    const [event, retry, scheduler] = observations;
    if (
      event.runId === retry.runId ||
      event.deliveryId === retry.deliveryId ||
      retry.runId !== scheduler.runId ||
      retry.historyDigest !== scheduler.historyDigest ||
      scheduler.schedulerReceiptDigest !== proofDigest(creations[2].data()) ||
      scheduler.job !== creations[2].get('identityState.plan.body.name') ||
      !Number.isSafeInteger(commands.get('lease.attempt')) ||
      commands.get('lease.attempt') < 2 ||
      !Number.isSafeInteger(commands.get('claimedAt')) ||
      commands.get('claimedAt') < journal.get('commandsRetry.leaseExpiresAt')
    )
      fail();

    const receipt = {
      schemaVersion: 1,
      operationId: m.operationId,
      releaseId: m.releaseId,
      bindingDigest: m.bindingDigest,
      evidenceDigest,
      buildId: m.buildId,
      image: m.image,
      manifestSHA256: proofDigest(m),
      activationOperationId: activationReceipt.operationId,
      activation: nativeSnapshotProof(activation),
      checkpoint: nativeSnapshotProof(parent),
      observations,
      wakes: creations.map((creation, index) => ({
        surface: surfaces[index],
        creation: nativeSnapshotProof(creation),
        cleanupSHA256: proofDigest(wakes[index].stopState),
      })),
      scope: 'original diagnostic delivery, retry reconciliation and resource cleanup only',
    };
    if (old.exists) {
      if (!immutable(old) || !same(old.data(), receipt)) fail();
    } else tx.create(final, receipt);
    return receipt;
  });
  const persisted = await final.get();
  if (!immutable(persisted) || !same(persisted.data(), result)) fail();
  return nativeSnapshotProof(persisted);
}
