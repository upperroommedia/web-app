import type { Firestore, Transaction } from 'firebase-admin/firestore';
const mockEvents: string[] = [];
let mockRunner: ((fn: (tx: Transaction) => Promise<void>) => Promise<void>) | undefined;
const mockClosure = jest.fn(async (tx: any, _session: any, validate: any) => {
  await validate(tx);
  return { alreadyClosed: false, commit: () => mockEvents.push('close') };
});
const mockCompletion = jest.fn(async () => {}),
  mockEffects = jest.fn(async () => ({
    sourceProgramDigest: 'p'.repeat(64),
    expectedRequestSteps: ['sub', 'sc'],
    qualifiedNoSendSteps: ['sc'],
  }));
const mockRemove = jest.fn();
jest.mock('../../helpers/sermonDeletionMirrors', () => ({
  SERMON_DELETION_MIRROR_PLANS: 'plans',
  loadSermonDeletionMirrorPlan: async (db: any, _ref: any, _sermon: any, tx: any) => {
    const header = (await tx.get(db.doc('plans/plan'))).data();
    return { ...header, planId: 'plan' };
  },
  removeSermonDeletionMirrors: (...args: unknown[]) => mockRemove(...args),
  validateSermonDeletionEffectsForClosing: (...args: unknown[]) => mockEffects(...(args as [])),
  validateSermonDeletionCompletion: (...args: unknown[]) => mockCompletion(...(args as [])),
  readSermonDeletionRootMutationTargetsPage: async (tx: any, db: any) => {
    const header = (await tx.get(db.doc('plans/plan'))).data();
    return {
      targets: header.requests.map((request: any) => ({ target: request.target, requestStep: request.step })),
      sourceProgramDigest: 'd'.repeat(64),
      sourceRequestCount: header.requests.length,
    };
  },
  readSermonDeletionCanonicalInventoryPage: async () => ({
    pages: [
      { index: 0, digest: 'e'.repeat(64) },
      { index: 1, digest: 'f'.repeat(64) },
    ],
    immutableCatalogDigest: 'a'.repeat(64),
    expectedCanonicalPageCount: 2,
  }),
  validateSermonDeletionCanonicalInventoryPage: async () => {
    await mockCompletion();
    return { complete: true, completionDigest: 'e'.repeat(64) };
  },
  readSermonDeletionCanonicalCompletionSummary: async () => {
    await mockCompletion();
    return {
      immutableCatalogDigest: 'a'.repeat(64),
      expectedCanonicalPageCount: 2,
      completedCanonicalPageCount: 2,
      canonicalCompletionDigest: 'b'.repeat(64),
    };
  },
}));
jest.mock('./providerMutationGuard', () => ({
  ...jest.requireActual('./providerMutationGuard'),
  prepareProviderMutationEffectsClosed: (...args: unknown[]) => mockClosure(...(args as [any, any, any])),
  validateProviderMutationOriginalCompletion: jest.fn(async () => {}),
}));
jest.mock('./legacySoundCloudRetention', () => ({
  loadValidatedLegacySoundCloudRetentionCertificate: async () => ({
    projectId: 'project',
    jobId: 'job',
    sermonId: 'sermon',
    trackId: 'track',
    generation: 1,
    workflowId: 'workflow',
    intentFingerprint: 'a'.repeat(64),
  }),
  validateLegacySoundCloudRetentionDisposition: async () => ({
    certificateId: 'c'.repeat(64),
    sealedProofDigest: 'e'.repeat(64),
  }),
}));
jest.mock('./durableOperationContext', () => ({
  runCriticalPublishingRepair: async (_job: string, run: () => Promise<unknown>, commit: any) => {
    mockRunner = commit;
    try {
      return await run();
    } finally {
      mockRunner = undefined;
    }
  },
}));
jest.mock('./allocationBarrier', () => ({
  preparePublishingAllocationRetirement: async () => () => mockEvents.push('retireSub'),
}));
jest.mock('../../../../packages/orchestration/src/provider-usage', () => ({
  prepareDesiredProviderDeletionSettlement: async () => () => mockEvents.push('settleSubIndex'),
}));
import {
  finalizeRetainedSoundCloudSermonDeletion,
  type RetainedSoundCloudSermonDeletionDependencies,
} from './retainedSoundCloudSermonDeletion';
import { providerMutationFingerprint } from './providerMutationGuard';
import { acknowledgedProjectionDigest } from './criticalAcknowledgedRepair';
const ref = { projectId: 'project', jobId: 'job' },
  operation = { kind: 'legacy_soundcloud_retain' as const, certificateId: 'c'.repeat(64) };
type Data = Record<string, any>;
const field = (data: Data | undefined, path: string) => path.split('.').reduce((value, key) => value?.[key], data);
function fixture() {
  const data = new Map<string, Data>(),
    scope = { ...ref, operation: 'originalDelete' },
    sessionId = providerMutationFingerprint(scope);
  const originalRoot = {
    id: 'sermon',
    subsplashId: 'media',
    soundCloudTrackId: 'track',
    status: { subsplash: 'UPLOADED', soundCloud: 'UPLOADED' },
  };
  data.set('durableJobIntents/job', { kind: 'sermon.delete', payload: { action: 'delete' }, entity: { id: 'sermon' } });
  data.set('plans/plan', {
    ...ref,
    sermonId: 'sermon',
    generation: 1,
    workflowId: 'workflow',
    operation: scope.operation,
    originalRoot,
    state: 'prepared',
    pointerClearRootDigest: acknowledgedProjectionDigest({
      id: 'sermon',
      status: { subsplash: 'NOT_UPLOADED', soundCloud: 'NOT_UPLOADED' },
    }),
    requests: [
      {
        step: 'sub',
        method: 'DELETE',
        fingerprint: 'f'.repeat(64),
        target: { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'media', resourceId: 'media' },
      },
      {
        step: 'sc',
        method: 'DELETE',
        fingerprint: 'a'.repeat(64),
        target: { provider: 'soundcloud', account: 'configured-account', resourceType: 'track', resourceId: 'track' },
      },
    ],
    verifications: [
      { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'media', resourceId: 'media' },
      { provider: 'soundcloud', account: 'configured-account', resourceType: 'track', resourceId: 'track' },
    ],
  });
  data.set(`temporalProviderMutationSessions/${sessionId}`, { scope, state: 'active', resources: [] });
  data.set(`temporalProviderMutationSessions/${sessionId}/requests/${providerMutationFingerprint('sub')}`, {
    step: 'sub',
    method: 'DELETE',
    fingerprint: 'f'.repeat(64),
    state: 'acknowledged',
    claim: 'claim',
    executionId: 'execution',
  });
  for (const request of data.get('plans/plan')!.requests)
    data.set(
      `temporalPublishingAcknowledgedProjections/${sessionId}/requestIndex/${providerMutationFingerprint(
        request.step
      )}`,
      { request }
    );
  data.set('sermons/sermon', {
    id: 'sermon',
    subsplashId: 'media',
    status: { subsplash: 'UPLOADED', soundCloud: 'NOT_UPLOADED' },
  });
  const reference = (path: string): any => ({ path, collection: (name: string) => query(`${path}/${name}`) });
  const snapshot = (path: string): any => ({
    id: path.split('/').at(-1),
    ref: reference(path),
    exists: data.has(path),
    data: () => data.get(path),
    get: (key: string) => field(data.get(path), key),
  });
  const query = (path: string, cursor = '', limit = Infinity): any => ({
    orderBy: () => query(path, cursor, limit),
    limit: (next: number) => query(path, cursor, next),
    startAfter: (next: string) => query(path, next, limit),
    fetch: () => {
      const docs = [...data.keys()]
        .filter(
          (key) =>
            key.startsWith(path + '/') &&
            key.split('/').length === path.split('/').length + 1 &&
            key.split('/').at(-1)! > cursor
        )
        .sort()
        .slice(0, limit)
        .map(snapshot);
      return { docs, size: docs.length, empty: !docs.length };
    },
    doc: (id: string) => reference(`${path}/${id}`),
  });
  const tx: any = {
    get: async (target: any) => (target.fetch ? target.fetch() : snapshot(target.path)),
    getAll: async (...targets: any[]) => targets.map((target) => snapshot(target.path)),
    create: (target: any, row: Data) => data.set(target.path, row),
    update: (target: any, patch: Data) => {
      if (target.path !== 'sermons/sermon') {
        data.set(target.path, { ...data.get(target.path), ...patch });
        return;
      }
      mockEvents.push('clearSubPointer');
      const row = { ...data.get(target.path) };
      delete row.subsplashId;
      row.status = { ...row.status, subsplash: patch['status.subsplash'] };
      data.set(target.path, row);
    },
  };
  const db: any = {
    doc: reference,
    collection: (name: string) => ({ doc: (id: string) => reference(`${name}/${id}`) }),
  };
  const deps: RetainedSoundCloudSermonDeletionDependencies = {
    firestore: db,
    commitCurrent: async (_ref, fn) => fn(tx),
    authorizeInTransaction: async () => {
      mockEvents.push('authorize');
    },
    verifyOtherProviderAbsent: async (target) => {
      mockEvents.push(`verify:${target.provider}`);
    },
    prepareFinalSettlement: async (transaction, _session, validate) => {
      const root = data.get(`temporalRetainedDeletionReady/${_session.id}`)!;
      await validate(transaction, _session, {
        sessionId: _session.id,
        claimSetDigestVersion: 2,
        claimSetDigest: root.closedClaimSetDigest,
        actualRequestCount: root.originalRequestCount,
        sourceDispositionValidated: true,
        sourceProgramDigest: root.sourceProgramDigest,
        expectedRequestCount: root.expectedRequestCount,
      });
      mockEvents.push('prepareFinal');
      return { alreadyCommitted: false, commit: () => mockEvents.push('release') };
    },
  };
  mockCompletion.mockImplementation(async () => {
    if (data.get('plans/plan')?.state !== 'completed' || data.has('sermons/sermon')) throw Error('unfinished');
  });
  mockRemove.mockImplementation(async (_db: any, plan: any, options: any) => {
    await mockRunner!(async (transaction) => {
      await options.assertOriginalProviderEffects(transaction, plan);
      mockEvents.push('rootDelete');
      data.delete('sermons/sermon');
      data.get('plans/plan')!.state = 'root_removed';
    });
    await mockRunner!(async (transaction) => {
      await options.assertOriginalProviderEffects(transaction, plan);
      mockEvents.push('mirrorDelete');
      data.get('plans/plan')!.state = 'completed';
    });
  });
  return { data, db: db as Firestore, tx: tx as Transaction, deps, sessionId };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockEvents.length = 0;
  mockRunner = undefined;
});
it('holds original mixed session through retained NoSEND closure, root-first mirrors and exact final source settlement', async () => {
  const f = fixture();
  expect(await finalizeRetainedSoundCloudSermonDeletion(ref, operation, f.deps)).toEqual({
    state: 'completed',
    planId: 'plan',
    settledMutationSessionId: f.sessionId,
  });
  expect(mockEvents.filter((event) => event.startsWith('verify:'))).toEqual(['verify:subsplash']);
  expect(mockEvents.indexOf('close')).toBeLessThan(mockEvents.indexOf('rootDelete'));
  expect(mockEvents.indexOf('rootDelete')).toBeLessThan(mockEvents.indexOf('mirrorDelete'));
  expect(mockEvents.indexOf('mirrorDelete')).toBeLessThan(mockEvents.indexOf('prepareFinal'));
  expect(mockEvents.slice(-2)).toEqual(['settleSubIndex', 'release']);
  expect(mockEvents.filter((event) => event === 'authorize').length).toBeGreaterThanOrEqual(6);
});
it('requires dedicated final settlement capability before any action', async () => {
  const f = fixture();
  delete (f.deps as Partial<RetainedSoundCloudSermonDeletionDependencies>).prepareFinalSettlement;
  await expect(finalizeRetainedSoundCloudSermonDeletion(ref, operation, f.deps)).rejects.toThrow();
  expect(mockEvents).toEqual([]);
});
it.each(['unknown', 'rejected_no_effect'])(
  'rejects non-retained original %s before cleanup or release',
  async (state) => {
    const f = fixture();
    f.data.get(
      `temporalProviderMutationSessions/${f.sessionId}/requests/${providerMutationFingerprint('sub')}`
    )!.state = state;
    await expect(finalizeRetainedSoundCloudSermonDeletion(ref, operation, f.deps)).rejects.toThrow();
    expect(mockEvents).not.toContain('close');
    expect(mockEvents).not.toContain('release');
  }
);
it('rejects any actual retained SC send instead of qualifying it as NoSEND', async () => {
  const f = fixture();
  f.data.set(`temporalProviderMutationSessions/${f.sessionId}/requests/sc`, {
    step: 'sc',
    state: 'acknowledged',
    claim: 'claim',
    executionId: 'execution',
  });
  await expect(finalizeRetainedSoundCloudSermonDeletion(ref, operation, f.deps)).rejects.toThrow();
  expect(mockEvents).not.toContain('close');
});
it('failed fresh fixed other-provider absence blocks canonical deletion', async () => {
  const f = fixture();
  f.deps.verifyOtherProviderAbsent = async () => {
    throw Error('provider still present');
  };
  await expect(finalizeRetainedSoundCloudSermonDeletion(ref, operation, f.deps)).rejects.toThrow(
    'provider still present'
  );
  expect(mockEvents).not.toContain('close');
});
it('revoked authority during later mirror page never releases the original session', async () => {
  const f = fixture();
  f.deps.authorizeInTransaction = async () => {
    if (mockEvents.includes('rootDelete')) throw Error('admin revoked');
  };
  await expect(finalizeRetainedSoundCloudSermonDeletion(ref, operation, f.deps)).rejects.toThrow('admin revoked');
  expect(mockEvents).toContain('rootDelete');
  expect(mockEvents).not.toContain('release');
});
it('unfinished source cleanup never releases original session or final index claim', async () => {
  const f = fixture();
  mockRemove.mockImplementationOnce(async () => {});
  await expect(finalizeRetainedSoundCloudSermonDeletion(ref, operation, f.deps)).rejects.toThrow('unfinished');
  expect(mockEvents).not.toContain('release');
  expect(mockEvents).not.toContain('settleSubIndex');
});
it('rejects a changed canonical root outside the captured retained pointer-clear shape', async () => {
  const f = fixture();
  f.data.get('sermons/sermon')!.title = 'changed';
  await expect(finalizeRetainedSoundCloudSermonDeletion(ref, operation, f.deps)).rejects.toThrow();
  expect(mockEvents).not.toContain('close');
  expect(mockEvents).not.toContain('rootDelete');
});
