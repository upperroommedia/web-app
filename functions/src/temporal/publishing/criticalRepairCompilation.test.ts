jest.mock('../../helpers/sermonDeletionPartialStop', () => ({ compileSermonDeletionPartialStopPage: jest.fn() }));
jest.mock('./criticalRepairCatalog', () => ({
  prepareCriticalRepairCatalogSourceSeal: jest.fn(),
  compileCriticalRepairCatalogPage: jest.fn(),
}));
jest.mock('./acknowledgedRepairCandidate', () => ({ compileAcknowledgedRepairCandidatePage: jest.fn() }));
import {
  compilePublishingCriticalRepairEvidence,
  type CriticalRepairCompilationStore,
} from './criticalRepairCompilation';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
const ref = { projectId: 'urm-app', jobId: 'compile-job' };
const catalog = { catalogId: 'a'.repeat(64) };
const mocks = () => ({
  seal: jest.requireMock('./criticalRepairCatalog').prepareCriticalRepairCatalogSourceSeal as jest.Mock,
  catalog: jest.requireMock('./criticalRepairCatalog').compileCriticalRepairCatalogPage as jest.Mock,
  candidate: jest.requireMock('./acknowledgedRepairCandidate').compileAcknowledgedRepairCandidatePage as jest.Mock,
});
function fixture(
  states: { active?: boolean; positive?: boolean; unknown?: boolean; noEffect?: boolean; delete?: boolean } = {}
) {
  const requests = {
    where: jest.fn((_field: string, _operator: string, value: unknown) => ({
      limit: () => ({
        get: async () => ({
          empty: Array.isArray(value)
            ? !states.unknown
            : value === 'rejected_no_effect'
            ? !states.noEffect
            : !states.positive,
        }),
      }),
    })),
  };
  const page = {
    empty: !states.active,
    size: states.active ? 1 : 0,
    docs: states.active ? [{ id: 'b'.repeat(64), ref: { collection: () => requests } }] : [],
  };
  const query = { where: jest.fn(), orderBy: jest.fn(), limit: jest.fn(), get: jest.fn(async () => page) };
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  const db = {
      collection: () => query,
      doc: () => ({ get: async () => ({ get: () => (states.delete ? 'sermon.delete' : 'sermon.update') }) }),
    } as unknown as Firestore,
    tx = {} as Transaction;
  const store: CriticalRepairCompilationStore = {
    firestore: db,
    assertSourceProducerBarrier: jest.fn(async () => ({
      allSourceWritersEnrolled: true as const,
      originalSourceProgramsFrozen: true as const,
    })),
    commitCurrent: jest.fn(async (_ref, mutate) => mutate(tx)),
  };
  const commit = jest.fn();
  mocks().seal.mockImplementation(async (_tx, _db, _ref, barrier) => {
    await barrier(tx);
    return { commit };
  });
  return { store, commit, query };
}
beforeEach(() => {
  jest.resetAllMocks();
  mocks().catalog.mockResolvedValue({ state: 'ready', root: catalog });
});
it('requires the runtime source barrier before committing the catalog seal', async () => {
  const f = fixture();
  await expect(compilePublishingCriticalRepairEvidence(ref, f.store)).resolves.toEqual({ state: 'ready', catalog });
  expect(f.store.assertSourceProducerBarrier).toHaveBeenCalledWith(expect.anything(), ref);
  expect(f.commit).toHaveBeenCalledTimes(1);
  expect(mocks().candidate).not.toHaveBeenCalled();
});
it('leaves catalog pagination pending before inspecting mutable sessions', async () => {
  const f = fixture({ active: true, positive: true });
  mocks().catalog.mockResolvedValue({ state: 'pending', root: catalog });
  expect(await compilePublishingCriticalRepairEvidence(ref, f.store)).toEqual({
    state: 'pending',
    progressed: true,
    code: 'PUBLISHING_CRITICAL_REPAIR_PREPARING',
    catalog,
  });
  expect(f.query.get).not.toHaveBeenCalled();
  expect(mocks().candidate).not.toHaveBeenCalled();
});
it.each([{ active: true }, { active: true, positive: true, unknown: true }])(
  'does not manufacture an acknowledged candidate for no-effect or unknown original transports',
  async (state) => {
    const f = fixture(state);
    expect(await compilePublishingCriticalRepairEvidence(ref, f.store)).toEqual({ state: 'ready', catalog });
    expect(mocks().candidate).not.toHaveBeenCalled();
  }
);
it('waits for the actual bounded original acknowledgement candidate to become READY', async () => {
  const f = fixture({ active: true, positive: true }),
    candidate = { state: 'pending', candidateId: 'c'.repeat(64) };
  mocks().candidate.mockResolvedValue(candidate);
  expect(await compilePublishingCriticalRepairEvidence(ref, f.store)).toEqual({
    state: 'pending',
    progressed: true,
    code: 'PUBLISHING_CRITICAL_REPAIR_PREPARING',
    candidate,
    catalog,
  });
  expect(mocks().candidate).toHaveBeenCalledTimes(1);
});
it('a rejected source barrier cannot seal or compile any evidence', async () => {
  const f = fixture();
  jest.mocked(f.store.assertSourceProducerBarrier).mockRejectedValue(new Error('source first-claim freeze is missing'));
  await expect(compilePublishingCriticalRepairEvidence(ref, f.store)).rejects.toThrow(
    'source first-claim freeze is missing'
  );
  expect(f.commit).not.toHaveBeenCalled();
  expect(mocks().catalog).not.toHaveBeenCalled();
});

it('compiles genuine original no-effect-only facts for source review without fabricating ACKs', async () => {
  const f = fixture({ active: true, noEffect: true });
  const candidate = { state: 'ready', candidateId: 'c'.repeat(64) };
  mocks().candidate.mockResolvedValue(candidate);
  expect(await compilePublishingCriticalRepairEvidence(ref, f.store)).toEqual({ state: 'ready', candidate, catalog });
});
it('keeps deletion partial evidence pending after the original terminal candidate is ready', async () => {
  const f = fixture({ active: true, positive: true, delete: true }),
    candidate = { state: 'ready', candidateId: 'c'.repeat(64) };
  mocks().candidate.mockResolvedValue(candidate);
  const compile = jest.requireMock('../../helpers/sermonDeletionPartialStop').compileSermonDeletionPartialStopPage;
  compile.mockResolvedValue({ state: 'pending' });
  expect(await compilePublishingCriticalRepairEvidence(ref, f.store)).toEqual({
    state: 'pending',
    progressed: true,
    code: 'PUBLISHING_CRITICAL_REPAIR_PREPARING',
    candidate,
    catalog,
  });
  expect(compile).toHaveBeenCalledWith(
    f.store.firestore,
    ref,
    'b'.repeat(64),
    expect.objectContaining({ commitCurrent: expect.any(Function) })
  );
});

it.each(['catalog', 'candidate', 'partial'] as const)(
  'does not report progress when the %s page commit fails',
  async (stage) => {
    const f = fixture({ active: true, positive: true, delete: stage === 'partial' });
    const failure = new Error('Generation changed before evidence page commit');
    if (stage === 'catalog') mocks().catalog.mockRejectedValue(failure);
    else if (stage === 'candidate') mocks().candidate.mockRejectedValue(failure);
    else {
      mocks().candidate.mockResolvedValue({ state: 'ready', candidateId: 'c'.repeat(64) });
      jest
        .requireMock('../../helpers/sermonDeletionPartialStop')
        .compileSermonDeletionPartialStopPage.mockRejectedValue(failure);
    }
    await expect(compilePublishingCriticalRepairEvidence(ref, f.store)).rejects.toThrow(failure.message);
  }
);
