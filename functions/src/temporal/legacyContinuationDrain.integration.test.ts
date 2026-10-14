import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { withLegacyAdmissionLease } from './legacyAdmissionLease';
import { assertLegacyAdmissionInTransaction } from './releaseControl';
const db = getFirestore(firebaseAdmin.app());
const controlRef = db.doc('_control/temporalRelease');
const stateRef = db.doc('_control/temporalReleaseState');
async function authority(secondsAgo: number) {
  const now = (await controlRef.get()).readTime;
  const cutoff = new Timestamp(now.seconds - secondsAgo, now.nanoseconds);
  await controlRef.set({
    schemaVersion: 1,
    revision: 1,
    releaseId: 'continuation-window-test',
    admission: 'paused',
    updatedAt: 1,
    legacyAdmissionCutoff: cutoff,
    domains: { publishing: { owner: 'legacy', admission: 'paused' } },
  });
  await stateRef.set({
    releaseId: 'continuation-window-test',
    mode: 'initial-cutover',
    legacySettlingCutoff: cutoff,
    compatibilityVerifiedAt: cutoff,
    legacySettlingGraceSeconds: 3600,
    maximumLegacyExecutionSeconds: 3570,
  });
}
const options = {
  domain: 'publishing',
  actorUid: 'system:firebase-event',
  operation: 'provider-event',
  continuation: true,
  projectId: 'urm-app',
};
beforeEach(async () => {
  await db.recursiveDelete(db.collection('legacyAdmissionLeases'));
  await db.doc('_control/temporalProviderUsage').delete();
});
afterAll(async () => {
  await Promise.all([
    controlRef.delete(),
    stateRef.delete(),
    db.recursiveDelete(db.collection('legacyAdmissionLeases')),
  ]);
});
it('a delayed pre-cutoff event cannot acquire a new lease after the actual server grace', async () => {
  await authority(3601);
  const transport = jest.fn();
  await expect(withLegacyAdmissionLease(db, options, transport)).rejects.toMatchObject({ code: 'unavailable' });
  expect(transport).not.toHaveBeenCalled();
  expect((await db.collection('legacyAdmissionLeases').get()).empty).toBe(true);
});
it('a known accepted callback may record effects and terminal completion after the boundary', async () => {
  await authority(1);
  await withLegacyAdmissionLease(db, options, async (lease) => {
    await authority(3601);
    await db.runTransaction((tx) => assertLegacyAdmissionInTransaction(tx, db, 'publishing', { continuation: true }));
    await lease.markEffectsStarted();
    return 'provider-completed';
  });
  const leases = await db.collection('legacyAdmissionLeases').get();
  expect(leases.size).toBe(1);
  expect(leases.docs[0].get('state')).toBe('completed');
  expect(leases.docs[0].get('outcome')).toBe('succeeded');
});
