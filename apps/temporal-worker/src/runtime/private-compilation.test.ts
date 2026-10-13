import { createCriticalRepairCompilationActivities } from './private-compilation';
import { compilePublishingCriticalRepairEvidence } from '../../../../functions/src/temporal/publishing/criticalRepairCompilation';
import { ACKNOWLEDGED_REPAIR_CANDIDATES } from '../../../../functions/src/temporal/publishing/acknowledgedRepairCandidate';
jest.mock('../../../../functions/src/temporal/publishing/criticalRepairCompilation', () => ({
  compilePublishingCriticalRepairEvidence: jest.fn(),
}));
function setup() {
  const ref = { projectId: 'urm-app', jobId: 'job' },
    writes: string[] = [];
  const tx: any = {
    set: (doc: any) => {
      writes.push(doc.path);
      return tx;
    },
    get: jest.fn(),
  };
  const db: any = { runTransaction: async (fn: any) => fn(tx) };
  const store: any = {
    assertCurrentInTransaction: jest.fn(async () => ({ kind: 'sermon.publish' })),
    loadJob: jest.fn(async () => ({
      state: 'needs_attention',
      revision: 4,
      actions: [],
      error: { code: 'PROVIDER_MUTATION_UNRESOLVED' },
    })),
    project: jest.fn(),
  };
  const activities = createCriticalRepairCompilationActivities(db, store, ref.projectId);
  return { ref, writes, tx, db, store, activities };
}
beforeEach(() => jest.clearAllMocks());
test('revoked-actor evidence compiler writes only scoped private candidate pages with SDK fencing', async () => {
  const f = setup();
  jest.mocked(compilePublishingCriticalRepairEvidence).mockImplementation(async (ref, deps) => {
    await deps.commitCurrent(ref, async (tx) => {
      tx.set({ path: `${ACKNOWLEDGED_REPAIR_CANDIDATES}/${'a'.repeat(64)}/pages/1`, firestore: f.db } as any, {});
    });
    return { state: 'pending' };
  });
  expect(await f.activities.compilePublishingCriticalRepairEvidence(f.ref)).toEqual({ state: 'pending' });
  expect(f.store.assertCurrentInTransaction).toHaveBeenCalledWith(f.tx, f.ref);
  expect(f.writes).toHaveLength(1);
});
test.each(['sermons/sermon', 'durableJobs/job', `${ACKNOWLEDGED_REPAIR_CANDIDATES}/browser-value/pages/1`])(
  'compiler cannot change %s',
  async (path) => {
    const f = setup();
    jest.mocked(compilePublishingCriticalRepairEvidence).mockImplementation(async (ref, deps) => {
      await deps.commitCurrent(ref, async (tx) => {
        tx.set({ path, firestore: f.db } as any, {});
      });
      return { state: 'pending' };
    });
    await expect(f.activities.compilePublishingCriticalRepairEvidence(f.ref)).rejects.toMatchObject({
      code: 'PERMISSION_CHANGED',
    });
    expect(f.writes).toEqual([]);
  }
);
test('unknown original completion remains unavailable and never creates a certificate', async () => {
  const f = setup();
  jest
    .mocked(compilePublishingCriticalRepairEvidence)
    .mockRejectedValue(Object.assign(new Error('Unknown original request'), { code: 'PROVIDER_MUTATION_UNRESOLVED' }));
  expect(await f.activities.compilePublishingCriticalRepairEvidence(f.ref)).toEqual({ state: 'unavailable' });
  expect(f.store.project).not.toHaveBeenCalled();
});
test.each([undefined, true] as const)(
  'compiler forwards only the source committed-page progress flag (%s)',
  async (progressed) => {
    const f = setup();
    jest
      .mocked(compilePublishingCriticalRepairEvidence)
      .mockResolvedValue({ state: 'pending', ...(progressed ? { progressed } : {}) } as any);
    expect(await f.activities.compilePublishingCriticalRepairEvidence(f.ref)).toEqual({
      state: 'pending',
      ...(progressed ? { progressed } : {}),
    });
  }
);
