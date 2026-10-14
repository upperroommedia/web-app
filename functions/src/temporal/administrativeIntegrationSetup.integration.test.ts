import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { withAdministrativeCredentialSetupLease, withLegacyAdmissionLease } from './legacyAdmissionLease';
import { TEMPORAL_RELEASE_CONTROL_PATH } from './releaseControl';

const db = firebaseAdmin.firestore();
const control = db.doc(TEMPORAL_RELEASE_CONTROL_PATH);
const options = {
  actorUid: 'admin-test',
  actorRole: 'admin',
  operation: 'exchangeSoundCloudAuthCode' as const,
  projectId: 'urm-app',
};
const release = (owner: string, admission = 'open') => ({
  schemaVersion: 1,
  revision: 1,
  releaseId: 'integration-test',
  updatedAt: Date.now(),
  admission,
  domains: { accounts: { owner, admission } },
});
beforeEach(async () => {
  await control.delete();
  await db.doc('_control/temporalProviderUsage').delete();
  await db.recursiveDelete(db.collection('legacyAdmissionLeases'));
});
afterAll(async () => {
  await control.delete();
  await db.doc('_control/temporalProviderUsage').delete();
});
it.each(['legacy', 'temporal', 'missing'])('preserves administrative setup for open %s ownership', async (owner) => {
  if (owner !== 'missing') await control.set(release(owner));
  await expect(
    withAdministrativeCredentialSetupLease(db, options, async (lease) => {
      await lease.markEffectsStarted();
      return 'connected';
    })
  ).resolves.toBe('connected');
  const leases = await db.collection('legacyAdmissionLeases').get();
  expect(leases.size).toBe(1);
  expect(leases.docs[0].data()).toMatchObject({
    domain: 'accounts',
    state: 'completed',
    effectsStarted: true,
    outcome: 'succeeded',
  });
});
it.each(['legacy', 'temporal'])('rejects paused %s ownership before callback or journal', async (owner) => {
  await control.set(release(owner, 'paused'));
  const effect = jest.fn();
  await expect(withAdministrativeCredentialSetupLease(db, options, effect)).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(effect).not.toHaveBeenCalled();
  expect((await db.collection('legacyAdmissionLeases').get()).empty).toBe(true);
});
it('does not let the administrative seam change ordinary legacy ownership policy', async () => {
  await control.set(release('temporal'));
  await expect(
    withLegacyAdmissionLease(db, { ...options, domain: 'accounts' }, async () => 'effect')
  ).rejects.toMatchObject({ code: 'failed-precondition' });
});
it('rejects malformed owners, non-admins, arbitrary operations and active provider usage inventory', async () => {
  await control.set(release('unexpected'));
  await expect(withAdministrativeCredentialSetupLease(db, options, jest.fn())).rejects.toMatchObject({
    code: 'failed-precondition',
  });
  await control.set(release('temporal'));
  await expect(
    withAdministrativeCredentialSetupLease(db, { ...options, actorRole: 'publisher' }, jest.fn())
  ).rejects.toMatchObject({ code: 'permission-denied' });
  await expect(
    withAdministrativeCredentialSetupLease(db, { ...options, operation: 'provider-delete' as never }, jest.fn())
  ).rejects.toMatchObject({ code: 'permission-denied' });
  await db.doc('_control/temporalProviderUsage').set({ releaseId: 'integration-test', status: 'building' });
  await expect(withAdministrativeCredentialSetupLease(db, options, jest.fn())).rejects.toMatchObject({
    code: 'unavailable',
  });
});
it('retains uncertain post-effect failures for operator drain and never records success', async () => {
  await control.set(release('temporal'));
  await expect(
    withAdministrativeCredentialSetupLease(db, options, async (lease) => {
      await lease.markEffectsStarted();
      throw new Error('Unconfirmed token grant');
    })
  ).rejects.toThrow('Unconfirmed');
  expect((await db.collection('legacyAdmissionLeases').get()).docs[0].data()).toMatchObject({
    state: 'needs_attention',
    outcome: 'unknown',
    effectsStarted: true,
  });
});
it.each(['legacy', 'temporal'])('fences only credential setup for %s media ownership', async (owner) => {
  await control.set({
    ...release('legacy'),
    domains: { accounts: { owner: 'legacy', admission: 'paused' }, media: { owner, admission: 'open' } },
  });
  await expect(
    withAdministrativeCredentialSetupLease(db, { ...options, operation: 'setYouTubeCookies' }, async (lease) => {
      await lease.markEffectsStarted();
      return 'cookies stored';
    })
  ).resolves.toBe('cookies stored');
  expect((await db.collection('legacyAdmissionLeases').get()).docs[0].get('domain')).toBe('media');
  await control.update({ 'domains.media.admission': 'paused' });
  const effects = jest.fn();
  await expect(
    withAdministrativeCredentialSetupLease(db, { ...options, operation: 'setYouTubeCookies' }, effects)
  ).rejects.toMatchObject({ code: 'unavailable' });
  expect(effects).not.toHaveBeenCalled();
  // This credential exception does not make legacy processing or probes valid under Temporal ownership.
  if (owner === 'temporal')
    await expect(
      withLegacyAdmissionLease(db, { ...options, domain: 'media', operation: 'process-audio' }, effects)
    ).rejects.toMatchObject({ code: 'failed-precondition' });
});
