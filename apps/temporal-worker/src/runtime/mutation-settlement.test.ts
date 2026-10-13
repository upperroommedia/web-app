import { createMutationSettlementProjection } from './mutation-settlement';
const job = () =>
  ({
    revision: 4,
    result: { resolutionPurpose: 'cleanup', mutationSessionId: 'a'.repeat(64) },
    error: { code: 'PROVIDER_MUTATION_UNRESOLVED' },
    attention: { kind: 'external_result_unknown', stepId: 'projection' },
    steps: [
      {
        id: 'projection',
        state: 'waiting',
        attempt: 3,
        error: { code: 'PROVIDER_MUTATION_UNRESOLVED' },
        nextRetryAt: 123,
      },
    ],
  } as any);
test('actual full acknowledged canonical commit settles only its bound UIstep and matching session', () => {
  const patch = createMutationSettlementProjection(
    job(),
    { state: 'completed', settledUiStepIds: ['projection'], settledMutationSessionIds: ['a'.repeat(64)] },
    200
  );
  expect(patch).toMatchObject({
    expectedRevision: 4,
    result: { resolutionPurpose: 'cleanup' },
    steps: [{ id: 'projection', state: 'succeeded', attempt: 3, finishedAt: 200 }],
    error: undefined,
    attention: undefined,
  });
  expect(patch?.result).not.toHaveProperty('mutationSessionId');
  expect(patch?.steps?.[0]).not.toHaveProperty('error');
  expect(patch?.steps?.[0]).not.toHaveProperty('nextRetryAt');
});
test('pending pages and unrelated sessions cannot hide an active barrier', () => {
  expect(
    createMutationSettlementProjection(
      job(),
      { state: 'running', settledUiStepIds: ['projection'], settledMutationSessionIds: ['a'.repeat(64)] },
      200
    )
  ).toBeUndefined();
  expect(
    createMutationSettlementProjection(job(), { state: 'completed', settledMutationSessionIds: ['b'.repeat(64)] }, 200)
  ).toBeUndefined();
});
test('partialstop can clear a truly committed session without falsely completing the whole activity', () => {
  const patch = createMutationSettlementProjection(
    job(),
    { state: 'completed', settledMutationSessionIds: ['a'.repeat(64)] },
    200
  );
  expect(patch).not.toHaveProperty('steps');
  expect(patch?.result).not.toHaveProperty('mutationSessionId');
});
test('settled canonical metadata cannot hide a different provider acknowledgement review', () => {
  const current = job();
  current.attention.acknowledgementId = 'b'.repeat(64);
  const patch = createMutationSettlementProjection(
    current,
    { state: 'completed', settledUiStepIds: ['projection'], settledMutationSessionIds: ['a'.repeat(64)] },
    200
  );
  expect(patch).not.toHaveProperty('attention');
});
