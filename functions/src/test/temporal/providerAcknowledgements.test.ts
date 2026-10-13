jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({ __esModule: true, default: {} }));
import {
  acknowledgementHasReviewedDisposition,
  listProviderAcknowledgementsForJob,
  providerAcknowledgementFingerprint,
  providerPayloadFingerprint,
  providerReceiptId,
  sameResourceAcknowledgementProvesReceipt,
} from '../../temporal/publishing/providerReceipts';
import type { ProviderAcknowledgementFact, ProviderReceipt } from '../../temporal/publishing/providerReceipts';
const ref = { projectId: 'urm-app', jobId: 'job-1' };
const key = `durable:${ref.projectId}:${ref.jobId}:media-create`;
const receipt: ProviderReceipt = {
  ...ref,
  operationKey: key,
  step: 'subsplash-media-item',
  fingerprint: providerPayloadFingerprint({ title: 'Media' }),
  state: 'confirmed',
  result: { id: 'remote-1' },
  owner: 'attempt-1',
  revision: 3,
  updatedAtMillis: 1,
};
const fact: ProviderAcknowledgementFact = {
  schemaVersion: 1,
  ...ref,
  receiptId: providerReceiptId(key, receipt.step),
  step: receipt.step,
  attemptOwner: 'attempt-1',
  claimRevision: 1,
  payloadFingerprint: receipt.fingerprint,
  remoteId: 'remote-1',
  disposition: 'same_resource',
  acknowledgedAtMillis: 1,
};
const fakeQuery = () => {
  const query = { where: jest.fn(), orderBy: jest.fn(), limit: jest.fn(), startAfter: jest.fn(), get: jest.fn() };
  for (const method of [query.where, query.orderBy, query.limit, query.startAfter]) method.mockReturnValue(query);
  const db = { collection: jest.fn().mockReturnValue(query) } as unknown as Parameters<
    typeof listProviderAcknowledgementsForJob
  >[1];
  return { query, db };
};
describe('private acknowledgement proofs and review disposition', () => {
  it('matches only an exact original same-resource acknowledgement, without conferring deletion authority', () => {
    expect(sameResourceAcknowledgementProvesReceipt(fact, receipt)).toBe(true);
    for (const changed of [
      { ...fact, disposition: 'orphaned' as const },
      { ...fact, remoteId: 'other' },
      { ...fact, payloadFingerprint: 'changed' },
      { ...fact, jobId: 'other-job' },
      { ...fact, attemptOwner: 'other-attempt' },
    ])
      expect(sameResourceAcknowledgementProvesReceipt(changed, receipt)).toBe(false);
    expect(sameResourceAcknowledgementProvesReceipt(fact, { ...receipt, state: 'executing' })).toBe(false);
  });
  it('accepts a sealed privileged retention review and rejects subsequent immutable fact changes', () => {
    const reviewed: ProviderAcknowledgementFact = { ...fact, disposition: 'orphaned' };
    reviewed.review = {
      decision: 'retain_after_review',
      actorUid: 'admin',
      commandId: 'review-1',
      acknowledgementFingerprint: providerAcknowledgementFingerprint(reviewed),
      evidenceReference: 'provider-review-1',
      reason: 'Retain this exact orphan after reviewing its references and duplicate risk.',
      duplicateRiskAcknowledged: true,
      reviewedAtMillis: 2,
    };
    expect(acknowledgementHasReviewedDisposition(reviewed)).toBe(true);
    expect(acknowledgementHasReviewedDisposition({ ...reviewed, remoteId: 'different' })).toBe(false);
    expect(
      acknowledgementHasReviewedDisposition({
        ...reviewed,
        review: { ...reviewed.review, acknowledgementFingerprint: 'changed' },
      })
    ).toBe(false);
    expect(acknowledgementHasReviewedDisposition(fact)).toBe(false);
  });
  it('returns all 605 scoped acknowledgements, including unresolved orphaned facts', async () => {
    const docs = Array.from({ length: 605 }, (_, index) => {
      const acknowledgement: ProviderAcknowledgementFact = {
        ...fact,
        receiptId: providerReceiptId(`${key}:${index}`, fact.step),
        remoteId: `remote-${index}`,
        disposition: 'orphaned',
      };
      return {
        id: providerPayloadFingerprint([
          acknowledgement.receiptId,
          acknowledgement.attemptOwner,
          acknowledgement.claimRevision,
          acknowledgement.remoteId,
        ]),
        data: () => acknowledgement,
      };
    }).sort((a, b) => (a.id < b.id ? -1 : 1));
    const { query, db } = fakeQuery();
    query.get.mockResolvedValueOnce({ docs: docs.slice(0, 400) }).mockResolvedValueOnce({ docs: docs.slice(400) });
    const result = await listProviderAcknowledgementsForJob(ref, db);
    expect(result).toHaveLength(605);
    expect(result.every((row) => row.acknowledgement.disposition === 'orphaned')).toBe(true);
    expect(query.where.mock.calls).toEqual([
      ['projectId', '==', ref.projectId],
      ['jobId', '==', ref.jobId],
    ]);
    expect(query.startAfter).toHaveBeenCalledWith(docs[399]);
  });
  it('rejects a foreign or tampered fact rather than omitting unknown evidence', async () => {
    const { query, db } = fakeQuery();
    query.get.mockResolvedValue({
      docs: [{ id: 'not-the-claim-id', data: () => ({ ...fact, jobId: 'foreign-job' }) }],
    });
    await expect(listProviderAcknowledgementsForJob(ref, db)).rejects.toMatchObject({ code: 'failed-precondition' });
  });
  it('requires the immutable original account for SoundCloud source-fetch acknowledgement proof', () => {
    const soundcloudReceipt: ProviderReceipt = {
      ...receipt,
      step: 'soundcloud-track',
      result: { trackIdentifier: 'soundcloud:tracks:123' },
      providerAccount: { provider: 'soundcloud', account: 'soundcloud:users:42' },
    };
    const bound: ProviderAcknowledgementFact = {
      ...fact,
      step: soundcloudReceipt.step,
      receiptId: providerReceiptId(soundcloudReceipt.operationKey, soundcloudReceipt.step),
      remoteId: 'soundcloud:tracks:123',
      providerAccount: soundcloudReceipt.providerAccount,
    };
    expect(sameResourceAcknowledgementProvesReceipt(bound, soundcloudReceipt)).toBe(true);
    expect(
      sameResourceAcknowledgementProvesReceipt(
        { ...bound, providerAccount: undefined },
        { ...soundcloudReceipt, providerAccount: undefined }
      )
    ).toBe(false);
    expect(
      sameResourceAcknowledgementProvesReceipt(bound, {
        ...soundcloudReceipt,
        providerAccount: { provider: 'soundcloud', account: 'soundcloud:users:99' },
      })
    ).toBe(false);
  });
});
