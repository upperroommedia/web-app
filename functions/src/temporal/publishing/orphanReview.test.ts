jest.mock('../../../../packages/orchestration/src/job-store', () => ({ createDurableJobStore: jest.fn() }));
jest.mock('../../../../packages/orchestration/src/provider-usage', () => ({
  prepareProviderBinding: jest.fn(async () => () => {}),
}));
jest.mock('../releaseControl', () => ({ assertAdmissionReleaseInTransaction: jest.fn(async () => {}) }));
jest.mock('../../providerSandbox/admission', () => ({ assertProviderAdmissionCatalog: jest.fn(async () => {}) }));
import { createDurableJobStore } from '../../../../packages/orchestration/src/job-store';
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: () => ({ options: { projectId: 'urm-app-staging' } }) },
}));
import {
  providerAcknowledgementFingerprint,
  providerPayloadFingerprint,
  providerReceiptId,
  type ProviderAcknowledgementFact,
  type ProviderReceipt,
} from './providerReceipts';
import {
  providerOrphanReviewJobId,
  validateProviderOrphanAcknowledgement,
  providerOrphanReviewPayload,
  ensureProviderOrphanReview,
} from './orphanReview';
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

test('late virtual ACK child inherits exact original immutable profile and scenario, rejecting missing or divergent provenance', () => {
  process.env.STAGING_PROVIDER_MODE = 'sandbox';
  const stage = { projectId: 'urm-app-staging', jobId: 'original-job' };
  const providerExecution = {
    mode: 'sandbox' as const,
    profileId: 'urm-app-staging-publishing-v1',
    version: 1 as const,
    scenario: 'commit-then-lost-response' as const,
  };
  const { scenario, ...profile } = providerExecution;
  const virtualFact = { ...fact, ...stage, providerExecutionProfile: profile };
  const original = { ...stage, payload: { providerExecution } };
  const child = providerOrphanReviewPayload(stage, acknowledgementId, virtualFact, original);
  expect(child.providerExecution).toEqual(providerExecution);
  expect(child.sourceJobId).toBe(stage.jobId);
  expect(child.acknowledgementFingerprint).toBe(providerAcknowledgementFingerprint(virtualFact));
  for (const pin of [undefined, { ...providerExecution, profileId: 'different' }])
    expect(() =>
      providerOrphanReviewPayload(stage, acknowledgementId, virtualFact, {
        ...original,
        payload: { providerExecution: pin },
      })
    ).toThrow();
  expect(() =>
    providerOrphanReviewPayload(
      stage,
      acknowledgementId,
      { ...virtualFact, providerExecutionProfile: undefined },
      original
    )
  ).toThrow();
  expect(() => providerOrphanReviewPayload(ref, acknowledgementId, virtualFact, original)).toThrow();
  expect(() =>
    validateProviderOrphanAcknowledgement(
      ref,
      acknowledgementId,
      { ...fact, providerExecutionProfile: profile },
      receipt
    )
  ).toThrow();
  delete process.env.STAGING_PROVIDER_MODE;
});

test('ACK trigger admission authors a distinct child with original lost-response scenario and immutable virtual proof', async () => {
  process.env.STAGING_PROVIDER_MODE = 'sandbox';
  try {
    const stage = { projectId: 'urm-app-staging', jobId: 'original-job' };
    const providerExecution = {
      mode: 'sandbox' as const,
      profileId: 'urm-app-staging-publishing-v1',
      version: 1 as const,
      scenario: 'commit-then-lost-response' as const,
    };
    const { scenario, ...profile } = providerExecution;
    const stageReceipt = {
      ...receipt,
      ...stage,
      operationKey: 'durable:urm-app-staging:original-job:publish',
      providerExecutionProfile: profile,
    };
    const stageFact = {
      ...fact,
      ...stage,
      receiptId: providerReceiptId(stageReceipt.operationKey, stageReceipt.step),
      providerExecutionProfile: profile,
    };
    const ackId = providerPayloadFingerprint([
      stageFact.receiptId,
      stageFact.attemptOwner,
      stageFact.claimRevision,
      stageFact.remoteId,
    ]);
    const original = {
      ...stage,
      actorUid: 'original-uploader',
      entity: { type: 'sermon', id: 'original-sermon' },
      payload: { providerExecution },
    };
    const rows: Record<string, any> = {
      ['temporalProviderAcknowledgements/' + ackId]: stageFact,
      ['durableJobIntents/' + stage.jobId]: original,
      ['temporalProviderReceipts/' + stageFact.receiptId]: stageReceipt,
    };
    const tx = {
      get: jest.fn(async (ref: any) => ({
        exists: rows[ref.path] !== undefined,
        data: () => rows[ref.path],
        get: (key: string) => rows[ref.path]?.[key],
      })),
      update: jest.fn(),
    };
    const db: any = {
      collection: (name: string) => ({ doc: (id: string) => ({ path: name + '/' + id }) }),
      runTransaction: async (fn: any) => fn(tx),
    };
    const store = { prepareCreateInTransaction: jest.fn(async () => () => {}), createInTransaction: jest.fn() };
    (createDurableJobStore as jest.Mock).mockReturnValue(store);
    const child = await ensureProviderOrphanReview(db, stage, ackId);
    expect(child.jobId).not.toBe(stage.jobId);
    const input = store.createInTransaction.mock.calls[0][1];
    expect(input.payload.providerExecution).toEqual(providerExecution);
    expect(input.payload.sourceAcknowledgementId).toBe(ackId);
    expect(input.actorUid).toBe(original.actorUid);
    expect(input.kind).toBe('provider.orphan_review');
    expect(original.payload.providerExecution.scenario).toBe('commit-then-lost-response');
  } finally {
    delete process.env.STAGING_PROVIDER_MODE;
  }
});
