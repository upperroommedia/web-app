import { proofDigest, assertNativeSnapshot, nativeSnapshotProof } from './temporal-release-runtime.mjs';
import { assertDiagnosticWakeAuthority } from './temporal-diagnostic-authority.mjs';
const surfaceKey = (surface) => {
  if (!['outbox-trigger', 'commands-trigger', 'scheduler'].includes(surface)) throw new Error('DIAGNOSTIC_WAKE_SURFACE_REQUIRED');
  return surface === 'outbox-trigger' ? 'outbox' : surface === 'commands-trigger' ? 'commands' : 'scheduler';
};
const wakeField = (key) => key === 'outbox' ? 'cloudDispatchDiagnosticWake' : key === 'commands' ? 'cloudDispatchDiagnosticCommandsWake' : 'cloudDispatchDiagnosticSchedulerWake';
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
  if (
    state.plan.creation.operationId !== m.operationId ||
    state.plan.diagnosticManifestSHA256 !== proofDigest(m)
  )
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
    if (key === 'commands' && (p.get('cloudDispatchDiagnosticWake.stage') !== 'completed' ||
      p.get('cloudDispatchDiagnosticWake.stopState.stage') !== 'completed' ||
      !p.get('cloudDispatchDiagnosticWake.diagnosticObservation') || p.get('cloudDispatchDiagnosticWake.diagnosticObservationFailed'))) fail();
    if (key === 'scheduler' && (p.get('cloudDispatchDiagnosticCommandsWake.stage') !== 'completed' ||
      p.get('cloudDispatchDiagnosticCommandsWake.stopState.stage') !== 'completed' ||
      p.get('cloudDispatchDiagnosticCommandsWake.diagnosticObservation.recovery') !== 'retry' || p.get('cloudDispatchDiagnosticCommandsWake.diagnosticObservationFailed'))) fail();
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
  const key = surfaceKey(surface), field = wakeField(key), pulseField = `${key}Pulse`;
  const m = await assertDiagnosticWakeAuthority(diagnostic),
    { firestore } = diagnostic;
  const parent = firestore.doc('_control/temporalReleaseOperation'),
    journal = firestore.doc(`_control/temporalDispatchDiagnostic-${m.operationId}`);
  const record = firestore.doc(`${key === 'outbox' ? 'durableJobOutbox' : 'durableJobCommands'}/diagnostic-${m.operationId}-${key}`),
    receipt = firestore.doc(`_control/temporalDispatchDiagnosticWakeCreation-${m.operationId}-${key}`);
  await firestore.runTransaction(async (tx) => {
    const [p, j, r, c, control, state, auth] = await Promise.all(
      [
        parent,
        journal,
        record,
        receipt,
        firestore.doc('_control/temporalRelease'),
        firestore.doc('_control/temporalReleaseState'),
        firestore.doc(`_control/temporalDispatchDiagnosticAuthorization-${m.operationId}`),
      ].map((ref) => tx.get(ref))
    );
    const version = (s) => (s.updateTime ? `${s.updateTime.seconds}:${s.updateTime.nanoseconds}` : fail());
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
