import {
  verifyPublishingMutationTarget,
  assertPublishingMutationTargetProofForSession,
} from '../../../../functions/src/temporal/publishing/mutationTargetProof';
import { createProviderMutationRegistry } from './provider-mutations';
import {
  acquireProviderMutationSession,
  executeProviderMutationOnce,
  prepareProviderMutationSessionCommit,
  prepareProviderMutationSessionCommitFromClosedEvidence,
  providerMutationFingerprint,
} from '../../../../functions/src/temporal/publishing/providerMutationGuard';
import {
  assertAcknowledgedProjectionRequestPrepared,
  prepareOriginalAcknowledgedProjectionReplay,
  validateOriginalAcknowledgedMutation,
  prepareAcknowledgedProjectionPlan,
  acknowledgedProjectionDigest,
  ACKNOWLEDGED_PROJECTION_PLANS,
} from '../../../../functions/src/temporal/publishing/criticalAcknowledgedRepair';
import { publishingMutationRequestFingerprint } from '../../../../functions/src/temporal/publishing/durableOperationContext';
jest.mock('../../../../functions/src/temporal/publishing/criticalAcknowledgedRepair', () => ({
  ...jest.requireActual('../../../../functions/src/temporal/publishing/criticalAcknowledgedRepair'),
  prepareAcknowledgedProjectionSeal: jest.fn(async () => ({ commit: jest.fn() })),
  assertAcknowledgedProjectionRequestPrepared: jest.fn(),
  prepareOriginalAcknowledgedProjectionReplay: jest.fn(async () => undefined),
  validateOriginalAcknowledgedMutation: jest.fn(async () => undefined),
  prepareAcknowledgedProjectionPlan: jest.fn(async () => ({ projectionDigest: 'a'.repeat(64), commit: jest.fn() })),
}));
jest.mock('../../../../functions/src/temporal/publishing/providerMutationGuard', () => ({
  ...jest.requireActual('../../../../functions/src/temporal/publishing/providerMutationGuard'),
  acquireProviderMutationSession: jest.fn(),
  executeProviderMutationOnce: jest.fn(),
  prepareProviderMutationSessionCommit: jest.fn(),
  prepareProviderMutationSessionCommitFromClosedEvidence: jest.fn(async (tx, session, validator) => {
    await validator(tx, session, {
      sessionId: session.id,
      claimSetDigest: 'a'.repeat(64),
      actualRequestCount: 0,
      sourceDispositionValidated: true,
    });
    return { alreadyCommitted: false, commit: jest.fn() };
  }),
  validateProviderMutationOriginalCompletion: jest.fn(),
}));
jest.mock('../../../../functions/src/temporal/publishing/mutationTargetProof', () => ({
  verifyPublishingMutationTarget: jest.fn(async (options: any) => {
    if (!options.session.resources.some((resource: any) => JSON.stringify(resource) === JSON.stringify(options.target)))
      throw new Error('PROVIDER_MUTATION_TARGET_UNPROVEN');
    return { kind: 'planned', target: options.target };
  }),
  assertPublishingMutationTargetProofForSession: jest.fn(async () => {}),
}));
const setup = () => {
  const ref = { projectId: 'urm-app', jobId: 'job' };
  const records = new Map<string, any>();
  const tx: any = {
    get: async (doc: { path: string }) => ({
      get: (field: string) => records.get(doc.path)?.[field],
      data: () => records.get(doc.path),
      empty: !records.has(doc.path),
    }),
  };
  const collection = (path: string): any => ({
    path,
    doc: (id: string) => ({
      path: `${path}/${id}`,
      collection: (child: string) => collection(`${path}/${id}/${child}`),
    }),
  });
  const firestore: any = { runTransaction: async (fn: any) => fn(tx), collection };
  const execution: any = {
    workflowId: 'wf',
    runId: 'run',
    activityId: '1',
    scheduledAt: 100,
    attempt: 1,
    activityType: 'applyPublishingLists',
  };
  const fence = jest.fn(async () => {}),
    effectFence = jest.fn(async () => {});
  jest.mocked(acquireProviderMutationSession).mockImplementation(async (options: any) => {
    await options.assertCurrentInTransaction(tx);
    return {
      db: firestore,
      id: providerMutationFingerprint(options.scope),
      scope: options.scope,
      resources: options.resources,
    };
  });
  jest.mocked(executeProviderMutationOnce).mockImplementation(async (options: any) => {
    await options.assertCurrentInTransaction(tx);
    return (await options.send()).result;
  });
  jest.mocked(prepareProviderMutationSessionCommit).mockResolvedValue({ alreadyCommitted: false, commit: jest.fn() });
  const registry = createProviderMutationRegistry({
    firestore,
    projectId: ref.projectId,
    getExecution: () => execution,
    getUiStepIds: () => ['lists'],
    assertCurrentInTransaction: fence,
    assertNewProviderEffectInTransaction: effectFence,
  });
  const plan = {
    operation: 'lists',
    resources: [
      { provider: 'subsplash' as const, account: 'app:9XTSHD', resourceType: 'list', resourceId: 'root-list' },
    ],
  };
  const intent = { ...ref, schemaVersion: 1, generation: 1, payload: {} };
  records.set(`durableJobIntents/${ref.jobId}`, intent);
  jest
    .mocked(assertAcknowledgedProjectionRequestPrepared)
    .mockImplementation(async (_tx: any, session: any, request: any) => {
      const snapshot = records.get(`${ACKNOWLEDGED_PROJECTION_PLANS}/${session.id}`);
      if (
        !snapshot?.requests?.some(
          (value: any) =>
            value.step === request.step && value.method === request.method && value.fingerprint === request.fingerprint
        )
      )
        throw Object.assign(new Error('Frozen program required'), { code: 'PROVIDER_MUTATION_UNRESOLVED' });
    });
  const freeze = (step: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', payload: unknown) => {
    const sessionId = providerMutationFingerprint({ ...ref, operation: plan.operation });
    records.set(`${ACKNOWLEDGED_PROJECTION_PLANS}/${sessionId}`, {
      schemaVersion: 1,
      ...ref,
      sessionId,
      operation: plan.operation,
      intentFingerprint: acknowledgedProjectionDigest(intent),
      requests: [
        {
          step,
          method,
          fingerprint: publishingMutationRequestFingerprint({ method, target: plan.resources[0], payload }),
        },
      ],
    });
  };
  return { ref, records, tx, execution, fence, effectFence, registry, plan, freeze };
};
beforeEach(() => jest.clearAllMocks());
test('provider HTTP cannot run without a registered complete resource plan', async () => {
  const f = setup(),
    send = jest.fn(async () => ({ completion: 'acknowledged' as const, result: { updated: true } }));
  await expect(
    f.registry.runPublishingProviderMutation(f.ref, {
      operation: 'lists',
      step: 'patch',
      method: 'PATCH',
      target: f.plan.resources[0],
      payload: {},
      send,
    })
  ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
  expect(send).not.toHaveBeenCalled();
});
test('a held plan cannot grow or wait for another resource set', async () => {
  const f = setup();
  await f.registry.beginProviderMutationPlan(f.ref, f.plan);
  f.freeze('patch', 'PATCH', { position: 1 });
  await expect(
    f.registry.beginProviderMutationPlan(f.ref, {
      ...f.plan,
      resources: [...f.plan.resources, { ...f.plan.resources[0], resourceId: 'new-root' }],
    })
  ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
  await expect(
    f.registry.beginProviderMutationPlan(f.ref, {
      operation: 'other',
      resources: [{ ...f.plan.resources[0], resourceId: 'other' }],
    })
  ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
  expect(acquireProviderMutationSession).toHaveBeenCalledTimes(1);
});
test('each single-shot request and canonical prepare uses the actual current transaction fence', async () => {
  const f = setup();
  await f.registry.beginProviderMutationPlan(f.ref, f.plan);
  f.freeze('patch', 'PATCH', { position: 1 });
  const send = jest.fn(async () => ({ completion: 'acknowledged' as const, result: { updated: true } }));
  expect(
    await f.registry.runPublishingProviderMutation(f.ref, {
      operation: 'lists',
      step: 'patch',
      method: 'PATCH',
      target: f.plan.resources[0],
      payload: { position: 1 },
      send,
    })
  ).toEqual({ updated: true });
  await f.registry.prepareProviderMutationPlanCommit(f.tx, f.ref, { operation: 'lists' });
  expect(f.fence).toHaveBeenCalledWith(f.tx, f.ref);
  expect(f.fence).toHaveBeenCalledTimes(6);
  expect(send).toHaveBeenCalledTimes(1);
});
test('an unfrozen or changed request never reaches the provider send callback', async () => {
  const f = setup();
  await f.registry.beginProviderMutationPlan(f.ref, f.plan);
  const send = jest.fn(async () => ({ completion: 'acknowledged' as const, result: {} }));
  await expect(
    f.registry.runPublishingProviderMutation(f.ref, {
      operation: 'lists',
      step: 'patch',
      method: 'PATCH',
      target: f.plan.resources[0],
      payload: { position: 1 },
      send,
    })
  ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
  f.freeze('patch', 'PATCH', { position: 1 });
  await expect(
    f.registry.runPublishingProviderMutation(f.ref, {
      operation: 'lists',
      step: 'patch',
      method: 'PATCH',
      target: f.plan.resources[0],
      payload: { position: 2 },
      send,
    })
  ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
  expect(send).not.toHaveBeenCalled();
});
test('activity cache cleanup removes handles without releasing durable sessions', async () => {
  const f = setup();
  await f.registry.beginProviderMutationPlan(f.ref, f.plan);
  f.registry.clearCurrent();
  await expect(f.registry.prepareProviderMutationPlanCommit(f.tx, f.ref, { operation: 'lists' })).rejects.toMatchObject(
    { code: 'PROVIDER_MUTATION_UNRESOLVED' }
  );
  expect(prepareProviderMutationSessionCommit).not.toHaveBeenCalled();
});

test('a changed target proof blocks the original HTTP claim', async () => {
  const f = setup();
  await f.registry.beginProviderMutationPlan(f.ref, f.plan);
  f.freeze('patch', 'PATCH', { position: 1 });
  jest
    .mocked(assertPublishingMutationTargetProofForSession)
    .mockRejectedValueOnce(new Error('PROVIDER_MUTATION_TARGET_UNPROVEN'));
  const send = jest.fn(async () => ({ completion: 'acknowledged' as const, result: {} }));
  await expect(
    f.registry.runPublishingProviderMutation(f.ref, {
      operation: 'lists',
      step: 'patch',
      method: 'PATCH',
      target: f.plan.resources[0],
      payload: { position: 1 },
      send,
    })
  ).rejects.toThrow('PROVIDER_MUTATION_TARGET_UNPROVEN');
  expect(verifyPublishingMutationTarget).toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('dynamic frozen targets require issued root proofs and use authoritative SDK step IDs', async () => {
  const f = setup();
  await f.registry.beginProviderMutationPlan(f.ref, f.plan);
  const target = { ...f.plan.resources[0], resourceType: 'list-row', resourceId: 'verified-row' };
  const proof: any = {
    kind: 'list_row',
    target,
    rootResource: f.plan.resources[0],
    proofHash: 'b'.repeat(64),
    canonicalPaths: [],
  };
  jest.mocked(verifyPublishingMutationTarget).mockResolvedValueOnce(proof);
  await f.registry.prepareAcknowledgedProjectionPlan(f.tx, f.ref, {
    operation: 'lists',
    requests: [
      { step: 'delete-row', method: 'DELETE', target, payload: { listId: 'root-list' }, fingerprint: 'c'.repeat(64) },
    ],
    writes: [],
    verifications: [{ ...target, resourceType: 'list-row', expectedProviderFields: {} }],
    uiStepIds: ['caller-untrusted-step'],
  });
  expect(verifyPublishingMutationTarget).toHaveBeenCalledWith(
    expect.objectContaining({ target, parentHint: 'root-list' })
  );
  expect(prepareAcknowledgedProjectionPlan).toHaveBeenCalledWith(
    f.tx,
    expect.any(Object),
    expect.objectContaining({ uiStepIds: ['lists'] }),
    { targetProofs: [proof] }
  );
});

test('a deleted descendant acknowledged by the original request replays without a new destination GET or send', async () => {
  const f = setup();
  await f.registry.beginProviderMutationPlan(f.ref, f.plan);
  const target = { ...f.plan.resources[0], resourceType: 'list-row', resourceId: 'already-deleted-row' };
  jest.mocked(validateOriginalAcknowledgedMutation).mockResolvedValueOnce({ result: { deleted: true } });
  const send = jest.fn(async () => ({ completion: 'acknowledged' as const, result: {} }));
  await expect(
    f.registry.runPublishingProviderMutation(f.ref, {
      operation: 'lists',
      step: 'delete-row',
      method: 'DELETE',
      target,
      payload: { listId: 'root-list' },
      send,
    })
  ).resolves.toEqual({ deleted: true });
  expect(verifyPublishingMutationTarget).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
test('known acknowledged program replay preserves its original frozen projection without live descendant proofs', async () => {
  const f = setup();
  await f.registry.beginProviderMutationPlan(f.ref, f.plan);
  const original = { projectionDigest: 'd'.repeat(64), commit: jest.fn() };
  jest.mocked(prepareOriginalAcknowledgedProjectionReplay).mockResolvedValueOnce(original);
  const target = { ...f.plan.resources[0], resourceType: 'list-row', resourceId: 'already-deleted-row' };
  expect(
    await f.registry.prepareAcknowledgedProjectionPlan(f.tx, f.ref, {
      operation: 'lists',
      requests: [{ step: 'delete-row', method: 'DELETE', target, fingerprint: 'c'.repeat(64) }],
      writes: [],
      verifications: [],
    })
  ).toBe(original);
  expect(verifyPublishingMutationTarget).not.toHaveBeenCalled();
  expect(prepareAcknowledgedProjectionPlan).not.toHaveBeenCalled();
});

test('a root-removed cleanup phase can replay original ACKs but cannot claim another HTTP mutation', async () => {
  const f = setup();
  await f.registry.beginProviderMutationPlan(f.ref, f.plan);
  f.freeze('patch', 'PATCH', { position: 1 });
  f.effectFence.mockRejectedValue(
    Object.assign(new Error('frozen cleanup only'), { code: 'PUBLISHING_CANONICAL_DELETION_EFFECT_FORBIDDEN' })
  );
  const send = jest.fn(async () => ({ completion: 'acknowledged' as const, result: {} }));
  await expect(
    f.registry.runPublishingProviderMutation(f.ref, {
      operation: 'lists',
      step: 'patch',
      method: 'PATCH',
      target: f.plan.resources[0],
      payload: { position: 1 },
      send,
    })
  ).rejects.toMatchObject({ code: 'PUBLISHING_CANONICAL_DELETION_EFFECT_FORBIDDEN' });
  expect(send).not.toHaveBeenCalled();
  f.effectFence.mockClear();
  jest.mocked(validateOriginalAcknowledgedMutation).mockResolvedValueOnce({ result: { known: true } });
  await expect(
    f.registry.runPublishingProviderMutation(f.ref, {
      operation: 'lists',
      step: 'patch',
      method: 'PATCH',
      target: f.plan.resources[0],
      payload: { position: 1 },
      send,
    })
  ).resolves.toEqual({ known: true });
  expect(f.effectFence).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('final cleanup reconstructs only the effects-closed original session after activity restart', async () => {
  const f = setup(),
    scope = { ...f.ref, operation: f.plan.operation },
    id = providerMutationFingerprint(scope);
  f.records.set(`temporalProviderMutationSessions/${id}`, {
    scope,
    resources: f.plan.resources,
    state: 'active',
    effectsClosed: true,
  });
  const proof = jest.fn(async () => ({
    closedClaimSetDigest: 'a'.repeat(64),
    originalRequestCount: 0,
    immutableCatalogDigest: 'b'.repeat(64),
    canonicalCompletionDigest: 'c'.repeat(64),
    expectedCanonicalPageCount: 3,
    completedCanonicalPageCount: 3,
  }));
  await f.registry.prepareProviderMutationPlanCommit(f.tx, f.ref, {
    operation: f.plan.operation,
    validateSourceCompletion: proof,
  });
  expect(proof).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({ id, scope, resources: f.plan.resources }),
    expect.objectContaining({ sessionId: id, actualRequestCount: 0 })
  );
  expect(acquireProviderMutationSession).not.toHaveBeenCalled();
  expect(executeProviderMutationOnce).not.toHaveBeenCalled();
  expect(prepareProviderMutationSessionCommitFromClosedEvidence).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({ id }),
    expect.any(Function)
  );
  expect(prepareProviderMutationSessionCommit).not.toHaveBeenCalled();
});
test('restarted cleanup refuses an active session without closed effects or completed source proof', async () => {
  const f = setup(),
    scope = { ...f.ref, operation: f.plan.operation },
    id = providerMutationFingerprint(scope);
  f.records.set(`temporalProviderMutationSessions/${id}`, { scope, resources: f.plan.resources, state: 'active' });
  await expect(
    f.registry.prepareProviderMutationPlanCommit(f.tx, f.ref, {
      operation: f.plan.operation,
      validateSourceCompletion: jest.fn(),
    })
  ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
  f.records.get(`temporalProviderMutationSessions/${id}`).effectsClosed = true;
  await expect(
    f.registry.prepareProviderMutationPlanCommit(f.tx, f.ref, { operation: f.plan.operation })
  ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
  expect(prepareProviderMutationSessionCommit).not.toHaveBeenCalled();
});

test('closed effects cannot finalize from a void or missing source completion summary', async () => {
  const f = setup(),
    scope = { ...f.ref, operation: f.plan.operation },
    id = providerMutationFingerprint(scope);
  f.records.set(`temporalProviderMutationSessions/${id}`, {
    scope,
    resources: f.plan.resources,
    state: 'active',
    effectsClosed: true,
  });
  await expect(
    f.registry.prepareProviderMutationPlanCommit(f.tx, f.ref, {
      operation: f.plan.operation,
      validateSourceCompletion: async () => {},
    })
  ).rejects.toMatchObject({ code: 'PROVIDER_MUTATION_UNRESOLVED' });
  expect(prepareProviderMutationSessionCommit).not.toHaveBeenCalled();
});

test('a permission or SDK change during closed-source verification prevents its settlement closure', async () => {
  const f = setup(),
    scope = { ...f.ref, operation: f.plan.operation },
    id = providerMutationFingerprint(scope);
  f.records.set(`temporalProviderMutationSessions/${id}`, {
    scope,
    resources: f.plan.resources,
    state: 'active',
    effectsClosed: true,
  });
  const verify = async () => {
    f.fence.mockRejectedValue(Object.assign(new Error('Permission changed'), { code: 'PERMISSION_CHANGED' }));
    return {
      closedClaimSetDigest: 'a'.repeat(64),
      originalRequestCount: 0,
      immutableCatalogDigest: 'b'.repeat(64),
      canonicalCompletionDigest: 'c'.repeat(64),
      expectedCanonicalPageCount: 3,
      completedCanonicalPageCount: 3,
    };
  };
  await expect(
    f.registry.prepareProviderMutationPlanCommit(f.tx, f.ref, {
      operation: f.plan.operation,
      validateSourceCompletion: verify,
    })
  ).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  expect(prepareProviderMutationSessionCommit).not.toHaveBeenCalled();
});
