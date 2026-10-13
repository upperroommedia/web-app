import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createDurableJobStore } from '../../../../packages/orchestration/src/job-store';
import { providerResourceKey, PROVIDER_USAGE_CONTROL } from '../../../../packages/orchestration/src/provider-usage';
import { ensureProviderOrphanReview, createProviderOrphanReviewActivities } from './orphanReview';
import {
  providerAcknowledgementFingerprint,
  providerPayloadFingerprint,
  providerReceiptId,
  type ProviderAcknowledgementFact,
  type ProviderReceipt,
} from './providerReceipts';
const describeWithEmulator = process.env.FIRESTORE_EMULATOR_HOST?.endsWith(':18081') ? describe : describe.skip;
describeWithEmulator('independent provider orphan review actual Firestore admission', () => {
  const projectId = process.env.GCLOUD_PROJECT ?? 'urm-app',
    nonce = randomUUID();
  const app = initializeApp({ projectId }, `orphan-review-${nonce}`),
    db = getFirestore(app);
  const marker = db.doc(PROVIDER_USAGE_CONTROL),
    release = db.doc('_control/temporalRelease');
  const epoch = `orphan-review-${nonce}`;
  let oldMarker: Record<string, unknown> | undefined, oldRelease: Record<string, unknown> | undefined;
  beforeAll(async () => {
    [oldMarker, oldRelease] = await Promise.all([
      marker.get().then((x) => x.data()),
      release.get().then((x) => x.data()),
    ]);
    await marker.set({ schemaVersion: 1, projectId, epoch, status: 'ready', releaseId: 'test', controlRevision: 1 });
    await release.set({
      schemaVersion: 1,
      revision: 1,
      admission: 'paused',
      domains: { publishing: { owner: 'temporal', admission: 'paused' } },
      releaseId: 'test',
      updatedAt: Date.now(),
    });
  });
  afterAll(async () => {
    if (oldMarker) await marker.set(oldMarker);
    else await marker.delete();
    if (oldRelease) await release.set(oldRelease);
    else await release.delete();
    await deleteApp(app);
  });
  async function setup() {
    const sourceRef = { projectId, jobId: `original-${randomUUID()}` };
    const receipt: ProviderReceipt = {
      ...sourceRef,
      operationKey: `durable:${projectId}:${sourceRef.jobId}:publish`,
      step: 'subsplash-media',
      fingerprint: 'original-payload',
      providerAccount: { provider: 'subsplash', account: 'app:9XTSHD' },
      state: 'confirmed',
      revision: 4,
      updatedAtMillis: 1000,
      result: { id: 'operator-adopted-different-asset' },
    };
    const fact: ProviderAcknowledgementFact = {
      schemaVersion: 1,
      ...sourceRef,
      providerAccount: receipt.providerAccount,
      receiptId: providerReceiptId(receipt.operationKey, receipt.step),
      step: receipt.step,
      attemptOwner: 'original-attempt',
      claimRevision: 1,
      payloadFingerprint: receipt.fingerprint,
      remoteId: `orphan-${randomUUID()}`,
      disposition: 'orphaned',
      acknowledgedAtMillis: 1000,
    };
    const ackId = providerPayloadFingerprint([fact.receiptId, fact.attemptOwner, fact.claimRevision, fact.remoteId]);
    await Promise.all([
      db
        .collection('durableJobIntents')
        .doc(sourceRef.jobId)
        .set({
          schemaVersion: 1,
          ...sourceRef,
          kind: 'sermon.publish',
          entity: { type: 'sermon', id: `sermon-${nonce}` },
          actorUid: `owner-${nonce}`,
          payload: {},
          generation: 1,
          createdAt: 1000,
        }),
      db
        .collection('durableJobs')
        .doc(sourceRef.jobId)
        .set({ ...sourceRef, state: 'succeeded', revision: 9, finishedAt: 2000 }),
      db.collection('temporalProviderReceipts').doc(fact.receiptId).set(receipt),
      db.collection('temporalProviderAcknowledgements').doc(ackId).set(fact),
    ]);
    return { sourceRef, receipt, fact, ackId };
  }
  test('late original ACK creates one independently owned case without touching terminal parent', async () => {
    const { sourceRef, fact, ackId } = await setup(),
      before = (await db.collection('durableJobs').doc(sourceRef.jobId).get()).data();
    const [a, b] = await Promise.all([
      ensureProviderOrphanReview(db, sourceRef, ackId),
      ensureProviderOrphanReview(db, sourceRef, ackId),
    ]);
    expect(a).toEqual(b);
    const job = await db.collection('durableJobs').doc(a.jobId).get();
    expect(job.get('actions')).toEqual([]);
    expect(job.get('requestedBy')).toBe(`owner-${nonce}`);
    expect(job.get('result.sourceJobId')).toBe(sourceRef.jobId);
    expect((await db.collection('durableJobs').doc(sourceRef.jobId).get()).data()).toEqual(before);
    const aggregate = db.doc(
      `temporalProviderUsage/${providerResourceKey({
        projectId,
        provider: 'subsplash',
        account: 'app:9XTSHD',
        remoteId: fact.remoteId,
      })}/epochs/${epoch}`
    );
    expect((await aggregate.get()).get('referenceCount')).toBe(1);
    const store = createDurableJobStore({ firestore: db, projectId });
    expect(
      await createProviderOrphanReviewActivities(db, projectId, store.project).reviewProviderOrphanAcknowledgement(a)
    ).toBe('pending');
    expect((await job.ref.get()).get('actions')).toEqual(['resolve']);
  });
  test('two original ACKs for the same sermon remain simultaneously current', async () => {
    const a = await setup(),
      b = await setup();
    const first = await ensureProviderOrphanReview(db, a.sourceRef, a.ackId),
      second = await ensureProviderOrphanReview(db, b.sourceRef, b.ackId);
    const store = createDurableJobStore({ firestore: db, projectId });
    await expect(store.assertCurrent(first)).resolves.toBeDefined();
    await expect(store.assertCurrent(second)).resolves.toBeDefined();
  });
  test('a source-sealed review creates an auto-finishable case with no new pending binding', async () => {
    const { sourceRef, fact, ackId } = await setup();
    const review = {
      decision: 'retain_after_review' as const,
      actorUid: 'admin',
      commandId: 'review',
      acknowledgementFingerprint: providerAcknowledgementFingerprint(fact),
      evidenceReference: 'review-case',
      reason: 'Retain separately verified additional original allocation',
      duplicateRiskAcknowledged: true as const,
      reviewedAtMillis: 2000,
    };
    await db.collection('temporalProviderAcknowledgements').doc(ackId).update({ review });
    await db
      .collection('temporalProviderAcknowledgementReviews')
      .doc(ackId)
      .set({ schemaVersion: 1, ...sourceRef, acknowledgementId: ackId, ...review });
    const child = await ensureProviderOrphanReview(db, sourceRef, ackId);
    const store = createDurableJobStore({ firestore: db, projectId });
    expect(
      await createProviderOrphanReviewActivities(db, projectId, store.project).reviewProviderOrphanAcknowledgement(
        child
      )
    ).toBe('complete');
    const before = (await db.collection('durableJobs').doc(child.jobId).get()).data();
    expect(before?.state).toBe('succeeded');
    expect(
      await createProviderOrphanReviewActivities(db, projectId, store.project).reviewProviderOrphanAcknowledgement(
        child
      )
    ).toBe('complete');
    expect((await db.collection('durableJobs').doc(child.jobId).get()).data()).toEqual(before);
  });
});
