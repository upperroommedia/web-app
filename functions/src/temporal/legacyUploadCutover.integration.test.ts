import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { withLegacyAdmissionLease } from './legacyAdmissionLease';
import sermonAudioCreateTrigger from '../../../functions-media/src/sermonAudioCreateTrigger';
import { FieldValue } from 'firebase-admin/firestore';

const db = firebaseAdmin.firestore();
const projectId = firebaseAdmin.app().options.projectId!;
const source = {
  sermonId: 'legacy-pending-source',
  uploaderId: 'legacy-owner',
  sourceStartTime: 0,
  trimDurationSeconds: 30,
};
const options = {
  projectId,
  domain: 'media',
  actorUid: 'system:firebase-event',
  operation: 'sermonaudiocreatetrigger',
  legacySourceUpload: source,
};
async function freeze() {
  const batch = db.batch(),
    cutoff = FieldValue.serverTimestamp();
  batch.update(db.doc('_control/temporalRelease'), { legacyAdmissionCutoff: cutoff });
  batch.set(db.doc('_control/temporalReleaseState'), {
    releaseId: 'legacy-source-test',
    mode: 'initial-cutover',
    legacySettlingCutoff: cutoff,
    compatibilityVerifiedAt: cutoff,
    legacySettlingGraceSeconds: 3600,
    maximumLegacyExecutionSeconds: 3570,
  });
  await batch.commit();
}
beforeEach(async () => {
  await db.recursiveDelete(db.collection('legacyAdmissionLeases'));
  await db.doc('_control/temporalProviderUsage').delete();
  await db.doc('_control/temporalReleaseState').delete();
  await db.doc('_control/temporalRelease').set({
    schemaVersion: 1,
    revision: 1,
    releaseId: 'legacy-source-test',
    admission: 'paused',
    domains: { media: { owner: 'legacy', admission: 'paused' } },
    updatedAt: Date.now(),
  });
  await db
    .doc(`sermons/${source.sermonId}`)
    .set({ ...source, uploaderId: source.uploaderId, subtitle: '', status: { audioStatus: 'PENDING' } });
});
afterAll(async () => {
  await db.doc(`sermons/${source.sermonId}`).delete();
  await db.doc('_control/temporalRelease').delete();
  await db.doc('_control/temporalReleaseState').delete();
});
describe('previously admitted legacy source continuation', () => {
  it('registers and finishes verified work during pause without opening generic admissions', async () => {
    // Source created during the compatibility window after initial freeze remains admitted.
    await freeze();
    const result = await withLegacyAdmissionLease(db, options, async (lease) => {
      await lease.markEffectsStarted();
      await db.doc(`sermons/${source.sermonId}`).update({ 'status.audioStatus': 'PROCESSING' });
      return 'queued';
    });
    expect(result).toBe('queued');
    const lease = (await db.collection('legacyAdmissionLeases').get()).docs[0];
    expect(lease.data()).toMatchObject({
      state: 'completed',
      legacySourceSermonId: source.sermonId,
      legacySourceOwnerUid: source.uploaderId,
      effectsStarted: true,
    });
    await expect(
      withLegacyAdmissionLease(db, { ...options, legacySourceUpload: undefined }, async () => 'unapproved')
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('rejects sources created after the verified compatibility cutoff even if updatedAt advances', async () => {
    await freeze();
    await db.doc(`sermons/${source.sermonId}`).delete();
    await db.doc(`sermons/${source.sermonId}`).create({ ...source, status: { audioStatus: 'PENDING' } });
    await db.doc('_control/temporalRelease').update({ updatedAt: Date.now() + 86400000, revision: 2 });
    const effects = jest.fn(async () => 'never');
    await expect(withLegacyAdmissionLease(db, options, effects)).rejects.toMatchObject({ code: 'aborted' });
    expect(effects).not.toHaveBeenCalled();
    expect((await db.collection('legacyAdmissionLeases').get()).size).toBe(0);
    expect((await db.doc(`sermons/${source.sermonId}`).get()).get('status.audioStatus')).toBe('PENDING');
  });
  it('rejects forged source owner or changed audio selection before effects', async () => {
    const effect = jest.fn(async () => 'never');
    await expect(
      withLegacyAdmissionLease(
        db,
        { ...options, legacySourceUpload: { ...source, uploaderId: 'foreign-owner' } },
        effect
      )
    ).rejects.toMatchObject({ code: 'aborted' });
    await db.doc(`sermons/${source.sermonId}`).update({ trimDurationSeconds: 40 });
    await expect(withLegacyAdmissionLease(db, options, effect)).rejects.toMatchObject({ code: 'aborted' });
    expect(effect).not.toHaveBeenCalled();
    expect((await db.collection('legacyAdmissionLeases').get()).size).toBe(0);
  });
  it('does not grant the source exception to another callable or Temporal ownership', async () => {
    await expect(
      withLegacyAdmissionLease(db, { ...options, operation: 'arbitrary-callable' }, async () => 'never')
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await db.doc('_control/temporalRelease').update({ 'domains.media.owner': 'temporal' });
    await expect(withLegacyAdmissionLease(db, options, async () => 'never')).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
  it('keeps an abandoned pending source visible and never clears it by lease expiry', async () => {
    await expect(
      withLegacyAdmissionLease(db, options, async () => {
        throw new Error('source still unavailable');
      })
    ).rejects.toThrow('source still unavailable');
    expect((await db.doc(`sermons/${source.sermonId}`).get()).get('status.audioStatus')).toBe('PENDING');
    expect((await db.collection('legacyAdmissionLeases').get()).docs[0].get('outcome')).toBe('rejected_no_effect');
  });
  it('does not requeue a stale pending create event after canonical processing finished', async () => {
    await db.doc(`sermons/${source.sermonId}`).update({ 'status.audioStatus': 'PROCESSED' });
    const event = {
      specversion: '1.0',
      type: 'google.cloud.firestore.document.v1.created',
      source: `//firestore.googleapis.com/projects/${projectId}/databases/(default)`,
      id: 'stale-pending-source',
      time: '2026-10-13T00:14:28Z',
      subject: `documents/sermons/${source.sermonId}`,
      document: `sermons/${source.sermonId}`,
      project: projectId,
      database: '(default)',
      namespace: '(default)',
      datacontenttype: 'application/json',
      data: {
        value: {
          name: `projects/${projectId}/databases/(default)/documents/sermons/${source.sermonId}`,
          createTime: '2026-10-13T00:14:28Z',
          updateTime: '2026-10-13T00:14:28Z',
          fields: {
            uploaderId: { stringValue: source.uploaderId },
            sourceStartTime: { integerValue: '0' },
            trimDurationSeconds: { integerValue: '30' },
            status: { mapValue: { fields: { audioStatus: { stringValue: 'PENDING' } } } },
          },
        },
      },
    };
    await expect(
      sermonAudioCreateTrigger(event as Parameters<typeof sermonAudioCreateTrigger>[0])
    ).resolves.toBeUndefined();
    expect((await db.collection('legacyAdmissionLeases').get()).size).toBe(0);
  });
});
