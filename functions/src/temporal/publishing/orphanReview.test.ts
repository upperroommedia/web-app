import {
  providerAcknowledgementFingerprint,
  providerPayloadFingerprint,
  providerReceiptId,
  type ProviderAcknowledgementFact,
  type ProviderReceipt,
} from './providerReceipts';
import { providerOrphanReviewJobId, validateProviderOrphanAcknowledgement } from './orphanReview';
const ref = { projectId: 'test-project', jobId: 'original-job' };
const receipt: ProviderReceipt = {
  operationKey: 'durable:test-project:original-job:publish',
  ...ref,
  step: 'subsplash-media',
  fingerprint: 'immutable-payload',
  providerAccount: { provider: 'subsplash', account: 'app:9XTSHD' },
  state: 'confirmed',
  revision: 4,
  updatedAtMillis: 1000,
  result: { id: 'operator-adopted-other-resource' },
};
const fact: ProviderAcknowledgementFact = {
  schemaVersion: 1,
  ...ref,
  providerAccount: receipt.providerAccount,
  receiptId: providerReceiptId(receipt.operationKey, receipt.step),
  step: receipt.step,
  attemptOwner: 'original-attempt',
  claimRevision: 1,
  payloadFingerprint: receipt.fingerprint,
  remoteId: 'late-original-resource',
  disposition: 'orphaned',
  acknowledgedAtMillis: 1000,
};
const acknowledgementId = providerPayloadFingerprint([
  fact.receiptId,
  fact.attemptOwner,
  fact.claimRevision,
  fact.remoteId,
]);
describe('independent original provider ACK review proof', () => {
  test('valid original ACK survives adoption of another selected resource', () => {
    expect(() => validateProviderOrphanAcknowledgement(ref, acknowledgementId, fact, receipt)).not.toThrow();
    expect(providerOrphanReviewJobId(ref.projectId, acknowledgementId)).toBe(
      providerOrphanReviewJobId(ref.projectId, acknowledgementId)
    );
    expect(providerOrphanReviewJobId('other-project', acknowledgementId)).not.toBe(
      providerOrphanReviewJobId(ref.projectId, acknowledgementId)
    );
  });
  test.each([
    { projectId: 'another-project' },
    { jobId: 'another-job' },
    { claimRevision: 0 },
    { attemptOwner: 'tampered-owner' },
    { remoteId: 'different-asset' },
    { payloadFingerprint: 'tampered-payload' },
    { providerAccount: { provider: 'subsplash', account: 'different-account' } },
    { disposition: 'same_resource' },
  ])('rejects a mismatched immutable proof %j', (patch) => {
    expect(() =>
      validateProviderOrphanAcknowledgement(
        ref,
        acknowledgementId,
        { ...fact, ...patch } as ProviderAcknowledgementFact,
        receipt
      )
    ).toThrow();
  });
  test('review disposition never changes the source ACK fingerprint', () => {
    expect(
      providerAcknowledgementFingerprint({
        ...fact,
        review: {
          decision: 'retain_after_review',
          actorUid: 'admin',
          commandId: 'review',
          acknowledgementFingerprint: providerAcknowledgementFingerprint(fact),
          evidenceReference: 'review-case',
          reason: 'Retained additional original allocation',
          duplicateRiskAcknowledged: true,
          reviewedAtMillis: 2000,
        },
      })
    ).toBe(providerAcknowledgementFingerprint(fact));
  });
});
