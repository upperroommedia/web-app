import { proofDigest } from './temporal-release-runtime.mjs';
const fail = () => {
  throw new Error('DIAGNOSTIC_WAKE_AUTHORITY_UNCONFIRMED');
};
const version = (s) => (s.updateTime ? `${s.updateTime.seconds}:${s.updateTime.nanoseconds}` : fail());
/** Real current parent capability, not a flag allowing enabled-service preparation. */
export async function assertDiagnosticWakeAuthority(diagnostic, fresh = false) {
  if (!diagnostic?.firestore || !diagnostic.manifest || !diagnostic.activationReceipt) fail();
  const { firestore, manifest: m, activationReceipt } = diagnostic;
  if (proofDigest(activationReceipt) !== m.activationDigest || activationReceipt.identityState?.stage !== 'completed')
    fail();
  await firestore.runTransaction(async (tx) => {
    const refs = [
      '_control/temporalReleaseOperation',
      '_control/temporalRelease',
      '_control/temporalReleaseState',
      `_control/temporalDispatchDiagnosticAuthorization-${m.operationId}`,
    ].map((p) => firestore.doc(p));
    const [p, c, s, a] = await Promise.all(refs.map((r) => tx.get(r)));
    if (
      p.get('action') !== 'prepare-cloud-run-dispatch-diagnostic' ||
      p.get('operationId') !== m.operationId ||
      p.get('releaseId') !== m.releaseId ||
      p.get('bindingDigest') !== m.bindingDigest ||
      proofDigest(p.get('cloudDispatchDiagnostic')) !== proofDigest(m) ||
      version(c) !== m.controlVersion ||
      version(s) !== m.stateVersion ||
      c.get('releaseId') !== m.releaseId ||
      s.get('releaseId') !== m.releaseId ||
      c.get('admission') !== 'paused' ||
      s.get('phase') !== 'provider-usage-ready' ||
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
        (d) => c.get(`domains.${d}.admission`) !== 'paused'
      ) ||
      !a.exists ||
      proofDigest(a.data()) !== proofDigest(m) ||
      (fresh && (Date.now() >= m.expiresAt || c.readTime.toMillis() >= m.expiresAt))
    )
      fail();
  });
  return m;
}
