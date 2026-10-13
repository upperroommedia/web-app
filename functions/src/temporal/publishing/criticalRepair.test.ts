jest.mock('./publishingZeroEffectsStop', () => ({
  preparePublishingZeroEffectsStop: jest.fn(),
  validatePublishingZeroEffectsStopOperation: jest.fn(),
  runPublishingZeroEffectsStop: jest.fn(),
}));
jest.mock('./criticalRepairCatalog', () => ({
  ...jest.requireActual('./criticalRepairCatalog'),
  prepareCriticalRepairCatalog: jest.fn(),
}));
jest.mock('../../helpers/sermonDeletionPartialStop', () => ({
  validateSermonDeletionPartialStopOperation: (op: any) =>
    op.kind === 'sermon_deletion_partial_stop' &&
    /^[a-f0-9]{64}$/.test(op.planId) &&
    /^[a-f0-9]{64}$/.test(op.sessionId),
  runSermonDeletionPartialStop: jest.fn(),
  prepareSermonDeletionPartialStop: jest.fn(),
}));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: () => ({ options: { projectId: 'urm-app' } }), firestore: () => ({}) },
}));
jest.mock('./localSermonDeletionRepair', () => ({
  runLocalSermonDeletionRepair: jest.fn(async () => ({ state: 'completed' })),
  prepareLocalSermonDeletionRepair: jest.fn(),
  validateLocalSermonDeletionRepairEvidence: jest.fn(),
}));
jest.mock('../../helpers/sermonDeletionMirrors', () => ({
  SERMON_DELETION_MIRROR_PLANS: 'temporalSermonDeletionMirrorPlans',
  prepareSermonRootRemovalCheckpointFromAcknowledgedRepair: jest.fn(),
}));
jest.mock('axios', () => ({ __esModule: true, default: Object.assign(jest.fn(), { get: jest.fn() }) }));
jest.mock('./providerMutationGuard', () => ({
  listProviderMutationSessionsForJob: jest.fn(async () => []),
  abortProvablyUnsentProviderMutationSessionsForJob: (...args: unknown[]) =>
    jest.requireMock('./providerMutationGuard').listProviderMutationSessionsForJob(...args),
}));
jest.mock('../../subsplashUtils', () => ({ authenticateSubsplash: jest.fn(), createAxiosConfig: jest.fn() }));
jest.mock('../../soundcloudSecrets', () => ({ runWithSoundCloudAccessToken: jest.fn() }));
jest.mock('../../soundcloudClient', () => ({ deleteTrack: jest.fn(), normalizeSoundCloudAccountId: jest.fn() }));
jest.mock('./providerDeletion', () => ({ PUBLISHING_DELETION_RECEIPTS: 'temporalPublishingDeletionReceipts' }));
jest.mock('./durableOperationContext', () => ({ PUBLISHING_EFFECT_PLANS: 'temporalPublishingEffectPlans' }));
jest.mock('./allocationBarrier', () => ({ preparePublishingAllocationRetirement: jest.fn() }));
import {
  preparePublishingCriticalRepair,
  prepareCertifiedCriticalDeleteTransport,
  criticalRepairDigest,
  validateCriticalRepairOperation,
  repairPublishingCritical,
  type CriticalRepairCertificate,
  type CriticalRepairDependencies,
} from './criticalRepair';
const ref = { projectId: 'urm-app', jobId: 'job-1' };
const readOp = {
  kind: 'provider_read' as const,
  provider: 'subsplash' as const,
  resourceType: 'media' as const,
  resourceId: 'remote-1',
  accountId: 'app:9XTSHD',
  method: 'GET' as const,
};
const certificate = (patch: Partial<CriticalRepairCertificate> = {}): CriticalRepairCertificate => ({
  schemaVersion: 1,
  ...ref,
  generation: 1,
  workflowId: 'workflow-1',
  acceptedUserCancellation: false,
  intentFingerprint: 'a'.repeat(64),
  criticalFingerprint: 'b'.repeat(64),
  operations: [readOp],
  sourceEvidenceDigests: [],
  ...patch,
});
describe('certificate repair safety', () => {
  beforeEach(() => jest.clearAllMocks());
  it('uses public timestamp and date APIs with sorted object keys', () => {
    const timestamp = { toMillis: () => 123, _seconds: 999 };
    expect(criticalRepairDigest({ b: new Date('2026-01-01'), a: timestamp })).toBe(
      criticalRepairDigest({ a: 123, b: '2026-01-01T00:00:00.000Z' })
    );
    expect(criticalRepairDigest([1, 2])).not.toBe(criticalRepairDigest([2, 1]));
  });
  it.each([
    { ...readOp, resourceId: 'bad/id' },
    { ...readOp, accountId: 'app:foreign' },
    { ...readOp, method: 'POST' },
    { ...readOp, body: { arbitrary: true } },
  ])('rejects arbitrary effect identities or transport fields', (op) =>
    expect(validateCriticalRepairOperation(op)).toBe(false)
  );
  it('revalidates authority immediately before each fixed read', async () => {
    const cert = certificate(),
      authorizeOperation = jest.fn().mockResolvedValue(undefined),
      readProvider = jest.fn().mockResolvedValue({ state: 'present', providerId: 'remote-1', accountId: 'app:9XTSHD' });
    const deps = {
      loadCertificate: async () => cert,
      authorizeOperation,
      readProvider,
      commitCurrent: jest.fn(),
    } as unknown as CriticalRepairDependencies;
    const result = await repairPublishingCritical(ref, criticalRepairDigest(cert), deps);
    expect(result.state).toBe('completed');
    expect(authorizeOperation).toHaveBeenCalledWith(readOp);
    expect(readProvider).toHaveBeenCalledTimes(1);
    expect(deps.commitCurrent).not.toHaveBeenCalled();
  });
  it('does not dispatch after repair administrator loses authority', async () => {
    const cert = certificate(),
      readProvider = jest.fn(),
      deps = {
        loadCertificate: async () => cert,
        authorizeOperation: async () => {
          throw new Error('revoked');
        },
        readProvider,
      } as unknown as CriticalRepairDependencies;
    await expect(repairPublishingCritical(ref, criticalRepairDigest(cert), deps)).rejects.toThrow('revoked');
    expect(readProvider).not.toHaveBeenCalled();
  });
  it('forbids certified deletes after original accepted cancellation', async () => {
    const cert = certificate({
        acceptedUserCancellation: true,
        operations: [readOp, { ...readOp, kind: 'provider_delete', method: 'DELETE' }],
      }),
      deleteProvider = jest.fn();
    await expect(
      repairPublishingCritical(ref, criticalRepairDigest(cert), {
        loadCertificate: async () => cert,
        deleteProvider,
      } as unknown as CriticalRepairDependencies)
    ).rejects.toThrow();
    expect(deleteProvider).not.toHaveBeenCalled();
  });
  it('does not settle an acknowledged but unprojected mutable session from a current GET', async () => {
    const cert = certificate(),
      readProvider = jest.fn();
    jest
      .requireMock('./providerMutationGuard')
      .listProviderMutationSessionsForJob.mockResolvedValueOnce([
        { state: 'active', sessionId: 'c'.repeat(64), requests: [{ state: 'acknowledged' }] },
      ]);
    expect(
      await repairPublishingCritical(ref, criticalRepairDigest(cert), {
        loadCertificate: async () => cert,
        readProvider,
      } as unknown as CriticalRepairDependencies)
    ).toEqual({
      state: 'blocked',
      code: 'PUBLISHING_CANCEL_MUTATION_REVIEW_REQUIRED',
      mutationSessionId: 'c'.repeat(64),
    });
    expect(readProvider).not.toHaveBeenCalled();
  });
});
it('allows a no-effect certificate only through fresh unsent-session proof and dispatches no provider request', async () => {
  const cert = certificate({ operations: [] }),
    readProvider = jest.fn(),
    authorizeOperation = jest.fn();
  expect(
    await repairPublishingCritical(ref, criticalRepairDigest(cert), {
      loadCertificate: async () => cert,
      readProvider,
      authorizeOperation,
    } as unknown as CriticalRepairDependencies)
  ).toEqual({ state: 'completed', mode: 'partial_stop', readsCompleted: 0, writesCompleted: 0, deletesCompleted: 0 });
  expect(readProvider).not.toHaveBeenCalled();
  expect(authorizeOperation).not.toHaveBeenCalled();
  expect(jest.requireMock('./providerMutationGuard').listProviderMutationSessionsForJob).toHaveBeenCalled();
});

describe('complete fixed series observations', () => {
  const seriesOp = { ...readOp, resourceType: 'series' as const, resourceId: 'series-1' };
  beforeEach(() => {
    jest.clearAllMocks();
    jest.requireMock('../../subsplashUtils').authenticateSubsplash.mockResolvedValue('token');
    jest.requireMock('../../subsplashUtils').createAxiosConfig.mockImplementation((url: string) => ({ url }));
  });
  it('verifies published, draft and scheduled members before exposing the complete observation', async () => {
    const axios = jest.requireMock('axios').default,
      observed: string[] = [];
    axios.mockImplementation(async (config: { url: string }) => {
      observed.push(config.url);
      const url = new URL(config.url);
      if (url.pathname.endsWith('/series-1'))
        return { data: { id: 'series-1', app_key: '9XTSHD', _embedded: { images: [] } } };
      const status = url.searchParams.get('filter[status]');
      return {
        data: {
          total: 1,
          _embedded: {
            'media-items': [
              {
                id: `media-${status}`,
                app_key: '9XTSHD',
                position: 3,
                _embedded: { 'media-series': { id: 'series-1' } },
              },
            ],
          },
        },
      };
    });
    const cert = certificate({ operations: [seriesOp] });
    expect(
      (
        await repairPublishingCritical(ref, criticalRepairDigest(cert), {
          loadCertificate: async () => cert,
          authorizeOperation: async () => {},
          commitCurrent: jest.fn(),
        } as unknown as CriticalRepairDependencies)
      ).state
    ).toBe('completed');
    expect(observed).toHaveLength(4);
    expect(observed[0]).toContain('include=images');
    expect(observed.slice(1).map((url) => new URL(url).searchParams.get('filter[status]'))).toEqual([
      'published',
      'draft',
      'scheduled',
    ]);
  });
  it('does not infer root absence from a member query 404', async () => {
    const axios = jest.requireMock('axios').default;
    axios
      .mockResolvedValueOnce({ data: { id: 'series-1', app_key: '9XTSHD' } })
      .mockRejectedValueOnce({ response: { status: 404 } });
    const cert = certificate({ operations: [seriesOp] });
    await expect(
      repairPublishingCritical(ref, criticalRepairDigest(cert), {
        loadCertificate: async () => cert,
        authorizeOperation: async () => {},
        commitCurrent: jest.fn(),
      } as unknown as CriticalRepairDependencies)
    ).rejects.toEqual({ response: { status: 404 } });
  });
  it('rejects members belonging to another application or series', async () => {
    const axios = jest.requireMock('axios').default;
    axios.mockResolvedValueOnce({ data: { id: 'series-1', app_key: '9XTSHD' } }).mockResolvedValueOnce({
      data: {
        _embedded: {
          'media-items': [{ id: 'foreign', app_key: 'OTHER', _embedded: { 'media-series': { id: 'series-1' } } }],
        },
      },
    });
    const cert = certificate({ operations: [seriesOp] });
    await expect(
      repairPublishingCritical(ref, criticalRepairDigest(cert), {
        loadCertificate: async () => cert,
        authorizeOperation: async () => {},
        commitCurrent: jest.fn(),
      } as unknown as CriticalRepairDependencies)
    ).rejects.toThrow();
  });
});

it('executes only the certified local deletion interpreter without any provider transport', async () => {
  const op = { kind: 'local_sermon_delete' as const, planId: 'f'.repeat(64) },
    cert = certificate({ operations: [op] }),
    authorizeOperation = jest.fn(),
    readProvider = jest.fn(),
    deleteProvider = jest.fn();
  const deps = {
    loadCertificate: async () => cert,
    authorizeOperation,
    readProvider,
    deleteProvider,
    commitCurrent: jest.fn(),
  } as unknown as CriticalRepairDependencies;
  expect(await repairPublishingCritical(ref, criticalRepairDigest(cert), deps)).toMatchObject({ state: 'completed' });
  expect(jest.requireMock('./localSermonDeletionRepair').runLocalSermonDeletionRepair).toHaveBeenCalledWith(
    ref,
    op,
    expect.any(Object)
  );
  expect(readProvider).not.toHaveBeenCalled();
  expect(deleteProvider).not.toHaveBeenCalled();
  expect(validateCriticalRepairOperation({ ...op, path: 'sermons/arbitrary' })).toBe(false);
});

describe('certified cleanup transport preflight', () => {
  const op = {
    kind: 'provider_delete' as const,
    provider: 'soundcloud' as const,
    resourceType: 'track' as const,
    resourceId: 'track-1',
    accountId: 'soundcloud:users:123',
    method: 'DELETE' as const,
  };
  const dependencies = () =>
    ({
      authorizeOperation: jest.fn(),
      firestore: {
        collection: () => ({
          doc: () => ({
            get: async () => ({
              data: () => ({
                ...ref,
                provider: 'soundcloud',
                remoteId: 'track-1',
                originalAccount: op.accountId,
                ownershipConfirmedBeforeDelete: true,
              }),
            }),
          }),
        }),
      },
    } as unknown as CriticalRepairDependencies);
  beforeEach(() => {
    jest.resetAllMocks();
    jest
      .requireMock('../../soundcloudSecrets')
      .runWithSoundCloudAccessToken.mockImplementation(async (run: (token: string) => Promise<unknown>) =>
        run('verified-token')
      );
    jest.requireMock('../../soundcloudClient').normalizeSoundCloudAccountId.mockReturnValue(op.accountId);
  });
  it('does not interpret an account lookup404 as track absence or start DELETE', async () => {
    const http = jest.requireMock('axios').default.get;
    http.mockRejectedValueOnce({ response: { status: 404 } });
    await expect(prepareCertifiedCriticalDeleteTransport(ref, op, dependencies())).rejects.toMatchObject({
      response: { status: 404 },
    });
    expect(http).toHaveBeenCalledTimes(1);
    expect(jest.requireMock('../../soundcloudClient').deleteTrack).not.toHaveBeenCalled();
  });
  it('captures the actual completed status using the exact verified account token', async () => {
    const http = jest.requireMock('axios').default.get;
    http
      .mockResolvedValueOnce({ status: 200, data: { id: 123 } })
      .mockResolvedValueOnce({ status: 200, data: { id: 'track-1', user: { id: 123 } } });
    const remove = jest.requireMock('../../soundcloudClient').deleteTrack;
    remove.mockImplementation(
      async (_token: string, _id: string, options: { onResponse: (value: { status: number }) => void }) =>
        options.onResponse({ status: 204 })
    );
    const send = await prepareCertifiedCriticalDeleteTransport(ref, op, dependencies());
    expect(remove).not.toHaveBeenCalled();
    expect(await send()).toEqual({ status: 204 });
    expect(remove).toHaveBeenCalledWith(
      'verified-token',
      'track-1',
      expect.objectContaining({ onResponse: expect.any(Function) })
    );
  });
  it('preserves original DELETE404 evidence instead of inventing a positive ACK', async () => {
    const http = jest.requireMock('axios').default.get;
    http
      .mockResolvedValueOnce({ status: 200, data: { id: 123 } })
      .mockResolvedValueOnce({ status: 200, data: { id: 'track-1', user: { id: 123 } } });
    jest.requireMock('../../soundcloudClient').deleteTrack.mockRejectedValue({ response: { status: 404 } });
    const send = await prepareCertifiedCriticalDeleteTransport(ref, op, dependencies());
    expect(await send()).toEqual({ status: 404 });
  });
});

describe('exclusive source partial stop', () => {
  const op = { kind: 'sermon_deletion_partial_stop' as const, planId: 'c'.repeat(64), sessionId: 'd'.repeat(64) };
  it('returns truthful partial preserved-content state before any catalog effect or generic cleanup', async () => {
    const cert = certificate({ operations: [op] }),
      run = jest.requireMock('../../helpers/sermonDeletionPartialStop').runSermonDeletionPartialStop;
    run.mockResolvedValue({
      state: 'completed',
      mode: 'partial_stop',
      contentPreserved: true,
      planId: op.planId,
      sessionId: op.sessionId,
      settledMutationSessionIds: [op.sessionId],
    });
    const deps = {
      loadCertificate: async () => cert,
      authorizeOperation: jest.fn(),
      authorizePartialStopInTransaction: jest.fn(),
      prepareUnclaimedReservationDisposition: jest.fn(),
      readProvider: jest.fn(),
      prepareDeleteProvider: jest.fn(),
      firestore: {},
      commitCurrent: jest.fn(),
    } as unknown as CriticalRepairDependencies;
    expect(await repairPublishingCritical(ref, criticalRepairDigest(cert), deps)).toMatchObject({
      state: 'completed',
      mode: 'partial_stop',
      providerEffects: 'partial',
      contentPreserved: true,
      settledMutationSessionIds: [op.sessionId],
    });
    expect(deps.readProvider).not.toHaveBeenCalled();
    expect(deps.prepareDeleteProvider).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      ref,
      op,
      expect.objectContaining({
        authorizeInTransaction: deps.authorizePartialStopInTransaction,
        prepareUnclaimedReservationDisposition: deps.prepareUnclaimedReservationDisposition,
      })
    );
  });
  it('rejects mixed partial-stop and vendor operations before dispatch', async () => {
    const cert = certificate({ operations: [op, readOp] }),
      run = jest.requireMock('../../helpers/sermonDeletionPartialStop').runSermonDeletionPartialStop;
    run.mockClear();
    await expect(
      repairPublishingCritical(ref, criticalRepairDigest(cert), {
        loadCertificate: async () => cert,
      } as unknown as CriticalRepairDependencies)
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});

it('prefers the exclusive known-effects stop over broad journal/session repair planning', async () => {
  const job = { ...ref, generation: 1, workflowId: 'workflow-1', revision: 7, state: 'blocked' },
    intent = { ...ref, generation: 1, kind: 'sermon.delete', payload: {} },
    critical = { ...ref, generation: 1, workflowId: 'workflow-1' };
  const op = { kind: 'sermon_deletion_partial_stop' as const, planId: 'c'.repeat(64), sessionId: 'd'.repeat(64) },
    commit = jest.fn();
  jest
    .requireMock('./publishingZeroEffectsStop')
    .preparePublishingZeroEffectsStop.mockRejectedValue(
      Object.assign(new Error('notzero'), { code: 'PUBLISHING_ZERO_EFFECTS_STOP_PROOF_REQUIRED' })
    );
  jest.requireMock('../../helpers/sermonDeletionPartialStop').prepareSermonDeletionPartialStop.mockResolvedValue({
    operation: op,
    sourceEvidence: { path: 'temporalSermonDeletionPartialStops/' + op.planId, digest: 'e'.repeat(64) },
    commit,
  });
  jest.requireMock('./criticalRepairCatalog').prepareCriticalRepairCatalog.mockResolvedValue({
    catalogId: 'f'.repeat(64),
    intentDigest: criticalRepairDigest(intent),
    criticalDigest: criticalRepairDigest(critical),
    acceptedUserCancellation: false,
  });
  const source: Record<string, unknown> = {
    ['durableJobs/' + ref.jobId]: job,
    ['durableJobIntents/' + ref.jobId]: intent,
    ['durableJobCriticalSections/' + ref.jobId]: critical,
  };
  const db = { collection: (name: string) => ({ doc: (id: string) => ({ path: name + '/' + id }) }) };
  const paths: string[] = [],
    tx = {
      get: async (document: { path: string }) => {
        paths.push(document.path);
        return { exists: source[document.path] !== undefined, data: () => source[document.path] };
      },
      set: jest.fn(),
      create: jest.fn(),
    };
  const planned = await preparePublishingCriticalRepair(
    tx as unknown as import('firebase-admin/firestore').Transaction,
    db as unknown as import('firebase-admin/firestore').Firestore,
    { ref, expectedRevision: 7 }
  );
  expect(planned.certificate.operations).toEqual([op]);
  expect(paths.some((path) => path.includes('temporalProviderMutationSessions'))).toBe(false);
  expect(jest.requireMock('./localSermonDeletionRepair').prepareLocalSermonDeletionRepair).not.toHaveBeenCalled();
  planned.commit();
  expect(commit).toHaveBeenCalledTimes(1);
});
