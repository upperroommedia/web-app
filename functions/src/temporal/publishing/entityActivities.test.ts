jest.mock('./providerMutationGuard', () => ({
  listProviderMutationSessionsForJob: jest.fn(async () => []),
  abortProvablyUnsentProviderMutationSessionsForJob: (...args: unknown[]) =>
    jest.requireMock('./providerMutationGuard').listProviderMutationSessionsForJob(...args),
}));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({ __esModule: true, default: { firestore: () => ({}) } }));
jest.mock('./allocationBarrier', () => ({ settleCancelledPublishingAllocations: jest.fn() }));
jest.mock('./cancellation', () => ({ cancelPublishingEffects: jest.fn().mockResolvedValue({ state: 'completed' }) }));
const mockReceipts = jest.fn();
jest.mock('./providerReceipts', () => ({ listProviderReceiptsForJob: (...args: unknown[]) => mockReceipts(...args) }));
const mockExecute = jest.fn();
jest.mock('./entityMutations', () => ({
  executePublishingEntityOperation: (...args: unknown[]) => mockExecute(...args),
}));
jest.mock('./maintenance', () => ({ executeMaintenancePage: jest.fn(), normalizeMaintenanceInput: jest.fn() }));
jest.mock('./durableOperationContext', () => ({
  runDurablePublishingOperation: (_id: unknown, run: () => Promise<unknown>) => run(),
}));
import { createPublishingEntityActivities } from './entityActivities';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
const ref = { projectId: 'test', jobId: 'job', generation: 1 } as DurableJobRef;
const store = () => ({
  loadIntent: jest.fn().mockResolvedValue({}),
  assertCurrent: jest.fn(),
  markCritical: jest.fn(),
  commitCurrent: jest.fn(),
  recordResult: jest.fn(),
  leaseAudio: jest.fn(),
  releaseAudio: jest.fn().mockResolvedValue({ released: true }),
});
beforeEach(() => jest.clearAllMocks());
it.each(['PUBLISHING_AUDIO_PROCESSING', 'unavailable'])(
  'releases audio before a workflow wait for %s',
  async (code) => {
    const deps = store();
    mockExecute.mockRejectedValue({ code });
    const outcome = await createPublishingEntityActivities(deps).executePublishingEntityActivity(ref);
    expect(outcome.code).toBe(code === 'unavailable' ? 'PUBLISHING_TRANSIENT' : code);
    expect(deps.releaseAudio).toHaveBeenCalledWith(ref);
    expect(deps.recordResult).toHaveBeenCalledWith(ref, outcome);
  }
);
it('retains audio admission when a provider create is unresolved', async () => {
  const deps = store();
  mockExecute.mockRejectedValue({
    details: { reason: 'PROVIDER_RESULT_AMBIGUOUS', receiptId: 'a'.repeat(64) },
    message: 'secret provider URL',
  });
  const outcome = await createPublishingEntityActivities(deps).executePublishingEntityActivity(ref);
  expect(outcome).toEqual({ state: 'needs_review', code: 'PROVIDER_CREATE_AMBIGUOUS', receiptId: 'a'.repeat(64) });
  expect(deps.releaseAudio).not.toHaveBeenCalled();
});
it('passes the exact admitted source path into audio lease acquisition', async () => {
  const deps = store();
  mockExecute.mockImplementation(async (_ref, _intent, options) => {
    await options.leaseAudio(ref, 'sermon', 'final/immutable.wav');
    return { seriesId: 'series' };
  });
  expect(await createPublishingEntityActivities(deps).executePublishingEntityActivity(ref)).toEqual({
    state: 'completed',
    result: { seriesId: 'series' },
  });
  expect(deps.leaseAudio).toHaveBeenCalledWith(ref, 'sermon', 'final/immutable.wav');
  expect(deps.releaseAudio).toHaveBeenCalledWith(ref);
});
it('projects bounded retry exhaustion using a safe code', async () => {
  const deps = store();
  await createPublishingEntityActivities(deps).projectPublishingEntityAttention(ref);
  expect(deps.recordResult).toHaveBeenCalledWith(ref, { state: 'failed', code: 'PUBLISHING_RETRY_EXHAUSTED' });
});

it.each([
  { code: 'ECONNRESET', message: 'secret' },
  { response: { status: 503 }, message: 'secret' },
])('classifies a raw readiness transport failure safely', async (error) => {
  const deps = store();
  mockExecute.mockRejectedValue(error);
  expect(await createPublishingEntityActivities(deps).executePublishingEntityActivity(ref)).toEqual({
    state: 'failed',
    code: 'PUBLISHING_TRANSIENT',
  });
  expect(deps.releaseAudio).toHaveBeenCalledWith(ref);
});
it('keeps ambiguous create classification ahead of transport retry signals', async () => {
  const deps = store();
  mockExecute.mockRejectedValue({
    code: 'ECONNRESET',
    response: { status: 503 },
    details: { reason: 'PROVIDER_RESULT_AMBIGUOUS' },
  });
  expect(await createPublishingEntityActivities(deps).executePublishingEntityActivity(ref)).toEqual({
    state: 'needs_review',
    code: 'PROVIDER_CREATE_AMBIGUOUS',
  });
  expect(deps.releaseAudio).not.toHaveBeenCalled();
});

it.each(['executing', 'needs_review'])(
  'recovers a hard worker failure into review for an unresolved %s receipt',
  async (state) => {
    const deps = store();
    mockReceipts.mockResolvedValue([
      { receiptId: 'b'.repeat(64), receipt: { state, result: { remoteUrl: 'private' } } },
    ]);
    expect(await createPublishingEntityActivities(deps).recoverPublishingEntityFailure(ref)).toEqual({
      state: 'needs_review',
      code: 'PROVIDER_CREATE_AMBIGUOUS',
      receiptId: 'b'.repeat(64),
    });
    expect(deps.releaseAudio).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  }
);
it('allows bounded same-job replay only when all provider allocations are prepared or confirmed', async () => {
  const deps = store();
  mockReceipts.mockResolvedValue([
    { receiptId: 'a'.repeat(64), receipt: { state: 'confirmed' } },
    { receiptId: 'b'.repeat(64), receipt: { state: 'prepared' } },
  ]);
  expect(await createPublishingEntityActivities(deps).recoverPublishingEntityFailure(ref)).toEqual({
    state: 'failed',
    code: 'PUBLISHING_TRANSIENT',
    receiptId: 'a'.repeat(64),
  });
  expect(deps.releaseAudio).toHaveBeenCalledWith(ref);
  expect(mockReceipts).toHaveBeenCalledWith(ref);
});
it('retains sources and stops replay if receipt inspection is unavailable', async () => {
  const deps = store();
  mockReceipts.mockRejectedValue(new Error('Private query failure'));
  expect(await createPublishingEntityActivities(deps).recoverPublishingEntityFailure(ref)).toEqual({
    state: 'blocked',
    code: 'PUBLISHING_PROVIDER_REPAIR_REQUIRED',
  });
  expect(deps.releaseAudio).not.toHaveBeenCalled();
});

it('reports cancellation failures without reauthorizing a revoked original actor or invoking mutations', async () => {
  const deps = store();
  deps.assertCurrent.mockRejectedValue(new Error('Original actor revoked'));
  mockReceipts.mockResolvedValue([
    { receiptId: 'c'.repeat(64), receipt: { state: 'confirmed' } },
    { receiptId: 'b'.repeat(64), receipt: { state: 'executing' } },
  ]);
  expect(await createPublishingEntityActivities(deps).reportPublishingEntityCancellationFailure(ref)).toEqual({
    state: 'blocked',
    code: 'PUBLISHING_CANCEL_REPAIR_REQUIRED',
    receiptId: 'b'.repeat(64),
    cancelOnly: true,
  });
  expect(deps.assertCurrent).not.toHaveBeenCalled();
  expect(mockExecute).not.toHaveBeenCalled();
  expect(deps.recordResult).toHaveBeenCalledWith(ref, expect.objectContaining({ cancelOnly: true }));
});

it('keeps a confirmed allocation visible when permission changes before canonical projection', async () => {
  const deps = store();
  deps.assertCurrent.mockRejectedValue({ code: 'PERMISSION_CHANGED' });
  mockReceipts.mockResolvedValue([{ receiptId: 'd'.repeat(64), receipt: { state: 'confirmed' } }]);
  expect(await createPublishingEntityActivities(deps).executePublishingEntityActivity(ref)).toEqual({
    state: 'blocked',
    code: 'PUBLISHING_PERMISSION_CHANGED',
    receiptId: 'd'.repeat(64),
  });
  expect(deps.releaseAudio).not.toHaveBeenCalled();
});
it('report-only recovery inspects unresolved receipts even after actor authorization is revoked', async () => {
  const deps = store();
  deps.assertCurrent.mockRejectedValue({ code: 'PERMISSION_CHANGED' });
  mockReceipts.mockResolvedValue([{ receiptId: 'e'.repeat(64), receipt: { state: 'executing' } }]);
  expect(await createPublishingEntityActivities(deps).recoverPublishingEntityFailure(ref)).toEqual({
    state: 'needs_review',
    code: 'PROVIDER_CREATE_AMBIGUOUS',
    receiptId: 'e'.repeat(64),
  });
  expect(deps.assertCurrent).not.toHaveBeenCalled();
});

it('holds a new allocation while the earlier job remains unsettled and exposes only the validated blocking job ID', async () => {
  const deps = store();
  mockExecute.mockRejectedValue({
    code: 'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
    details: { blockingJobId: 'earlier-job' },
  });
  expect(await createPublishingEntityActivities(deps).executePublishingEntityActivity(ref)).toEqual({
    state: 'blocked',
    code: 'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
    blockingJobId: 'earlier-job',
  });
  expect(deps.releaseAudio).toHaveBeenCalledWith(ref);
});
it('does not expose untrusted arbitrary error details as a blocking job ID', async () => {
  const deps = store();
  mockExecute.mockRejectedValue({
    code: 'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
    details: { blockingJobId: 'https://secret/key' },
  });
  expect(await createPublishingEntityActivities(deps).executePublishingEntityActivity(ref)).toEqual({
    state: 'blocked',
    code: 'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
  });
});
it('settles allocation ownership only after completed cancellation, before releasing the audio source', async () => {
  const deps = store();
  const settle = jest.requireMock('./allocationBarrier').settleCancelledPublishingAllocations;
  await createPublishingEntityActivities(deps).cleanupCancelledPublishingEntity(ref);
  expect(settle).toHaveBeenCalledWith({}, deps, ref);
  expect(settle.mock.invocationCallOrder[0]).toBeLessThan(deps.releaseAudio.mock.invocationCallOrder[0]);
});
it('holds allocation ownership and sources when cancellation still needs operator review', async () => {
  const deps = store();
  jest.requireMock('./cancellation').cancelPublishingEffects.mockResolvedValueOnce({
    state: 'blocked',
    code: 'PUBLISHING_CANCEL_EXTERNAL_REFERENCE_REVIEW_REQUIRED',
  });
  expect(await createPublishingEntityActivities(deps).cleanupCancelledPublishingEntity(ref)).toMatchObject({
    state: 'blocked',
    cancelOnly: true,
  });
  expect(jest.requireMock('./allocationBarrier').settleCancelledPublishingAllocations).not.toHaveBeenCalled();
  expect(deps.releaseAudio).not.toHaveBeenCalled();
});

it('holds cancellation while acknowledged provider changes await canonical settlement', async () => {
  const deps = store();
  jest
    .requireMock('./providerMutationGuard')
    .listProviderMutationSessionsForJob.mockResolvedValueOnce([
      { sessionId: 'f'.repeat(64), state: 'active', requests: [{ state: 'acknowledged' }] },
    ]);
  expect(await createPublishingEntityActivities(deps).cleanupCancelledPublishingEntity(ref)).toEqual({
    state: 'blocked',
    code: 'PUBLISHING_CANCEL_MUTATION_REVIEW_REQUIRED',
    mutationSessionId: 'f'.repeat(64),
    cancelOnly: true,
  });
  expect(jest.requireMock('./cancellation').cancelPublishingEffects).not.toHaveBeenCalled();
  expect(deps.releaseAudio).not.toHaveBeenCalled();
});
it.each([
  { code: 'PROVIDER_MUTATION_UNRESOLVED', mutationSessionId: 'a'.repeat(64) },
  {
    code: 'failed-precondition',
    details: { code: 'PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED', mutationSessionId: 'a'.repeat(64) },
  },
])('preserves desired mutation review codes and scoped session proof without releasing source', async (error) => {
  const deps = store();
  mockExecute.mockRejectedValueOnce(error);
  const outcome = await createPublishingEntityActivities(deps).executePublishingEntityActivity(ref);
  expect(outcome).toEqual({
    state: 'blocked',
    code: error.details?.code ?? error.code,
    mutationSessionId: 'a'.repeat(64),
  });
  expect(deps.releaseAudio).not.toHaveBeenCalled();
});

it('preserves the bounded settlement exhaustion code for operator review', async () => {
  const deps = store();
  await createPublishingEntityActivities(deps).projectPublishingEntityAttention(
    ref,
    'PUBLISHING_DELETION_SETTLEMENT_REVIEW_REQUIRED'
  );
  expect(deps.recordResult).toHaveBeenCalledWith(ref, {
    state: 'failed',
    code: 'PUBLISHING_DELETION_SETTLEMENT_REVIEW_REQUIRED',
  });
});
