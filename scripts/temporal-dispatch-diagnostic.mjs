import { randomBytes } from 'node:crypto';
import { assertNativeSnapshot, nativeSnapshotProof, proofDigest } from './temporal-release-runtime.mjs';
const fail = () => {
  throw new Error('DISPATCH_DIAGNOSTIC_ARM_UNCONFIRMED');
};
const version = (snapshot) =>
  snapshot.updateTime ? `${snapshot.updateTime.seconds}:${snapshot.updateTime.nanoseconds}` : fail();
const domains = ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'];
/** Atomic private authorization + journal + two inert watched records. No wake,
 * Workflow start, application admission, phase, routing or successful proof is created.
 * The same parent operation remains held until native provenance and owned wake cleanup.
 */
export async function armCloudRunDispatchDiagnostic({
  firestore,
  lockRef,
  controlRef,
  stateRef,
  ownedOperation,
  expectedAuthority,
  operationId,
  bindingDigest,
  config,
  platform,
  activationReceipt,
  nativeActivation,
}) {
  if (
    config.environment !== 'staging' ||
    !/^[a-f0-9-]{36}$/.test(operationId) ||
    activationReceipt?.releaseId !== config.releaseId ||
    !/^[a-f0-9]{64}$/.test(activationReceipt?.bindingDigest ?? '') ||
    activationReceipt?.operationId !== nativeActivation?.plan?.operationId ||
    activationReceipt?.identityState?.stage !== 'completed' ||
    proofDigest(activationReceipt.identityState) !== proofDigest(nativeActivation) ||
    nativeActivation.plan?.buildId !== platform.workerBuildId ||
    nativeActivation.plan?.desired?.template?.containers?.[0]?.image !== platform.workerImage ||
    nativeActivation.service?.admission !== 'enabled'
  )
    fail();
  await firestore.runTransaction(async (tx) => {
    const [parent, control, state] = await Promise.all([tx.get(lockRef), tx.get(controlRef), tx.get(stateRef)]);
    assertNativeSnapshot(ownedOperation, parent);
    assertNativeSnapshot(expectedAuthority.control, control);
    assertNativeSnapshot(expectedAuthority.state, state);
    if (
      parent.get('action') !== 'prepare-cloud-run-dispatch-diagnostic' ||
      parent.get('operationId') !== operationId ||
      parent.get('bindingDigest') !== bindingDigest ||
      parent.get('releaseId') !== config.releaseId ||
      control.get('releaseId') !== config.releaseId ||
      state.get('releaseId') !== config.releaseId ||
      control.get('admission') !== 'paused' ||
      state.get('phase') !== 'provider-usage-ready' ||
      domains.some((d) => control.get(`domains.${d}.admission`) !== 'paused')
    )
      fail();
    const saved = parent.get('cloudDispatchDiagnostic');
    const createdAt = saved?.createdAt ?? control.readTime.toMillis();
    const manifest = {
      schemaVersion: 2,
      commandsRecovery: 'scheduler',
      operationId,
      releaseId: config.releaseId,
      bindingDigest,
      buildId: platform.workerBuildId,
      image: platform.workerImage,
      nonce: saved?.nonce ?? randomBytes(16).toString('hex'),
      createdAt,
      expiresAt: createdAt + 300000,
      controlVersion: version(control),
      stateVersion: version(state),
      activationDigest: proofDigest(activationReceipt),
      eventSubject: nativeActivation.prerequisites.eventUniqueId,
      schedulerSubject: nativeActivation.prerequisites.schedulerUniqueId,
      serviceRevision: nativeActivation.service.revision,
    };
    if (saved !== undefined && proofDigest(saved) !== proofDigest(manifest)) fail();
    const digest = proofDigest(manifest);
    const authorization = firestore.doc(`_control/temporalDispatchDiagnosticAuthorization-${operationId}`);
    const journal = firestore.doc(`_control/temporalDispatchDiagnostic-${operationId}`);
    const records = ['outbox', 'commands'].map((surface) =>
      firestore.doc(
        `${surface === 'outbox' ? 'durableJobOutbox' : 'durableJobCommands'}/diagnostic-${operationId}-${surface}`
      )
    );
    const [a, j, ...r] = await Promise.all([authorization, journal, ...records].map((ref) => tx.get(ref)));
    if (saved !== undefined) {
      if (
        !a.exists ||
        proofDigest(a.data()) !== digest ||
        j.get('manifestDigest') !== digest ||
        r.some(
          (record, i) =>
            record.get('manifestDigest') !== digest ||
            record.get('state') !== 'diagnostic' ||
            record.get('surface') !== ['outbox', 'commands'][i]
        )
      )
        fail();
      return; // No expiry extension, replacement nonce, record rewrite or new event on resume.
    }
    if ([a, j, ...r].some((s) => s.exists) || Date.now() >= manifest.expiresAt) fail();
    tx.update(lockRef, { cloudDispatchDiagnostic: manifest });
    tx.create(authorization, manifest);
    tx.create(journal, {
      manifestDigest: digest,
      scope: 'inert diagnostic authorization; delivery and cleanup pending',
    });
    records.forEach((ref, i) =>
      tx.create(ref, { state: 'diagnostic', manifestDigest: digest, surface: ['outbox', 'commands'][i] })
    );
  });
  return nativeSnapshotProof(await lockRef.get());
}
