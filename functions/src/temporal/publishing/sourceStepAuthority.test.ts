import type { Transaction } from 'firebase-admin/firestore';
const mockCreate = jest.fn(),
  mockAppend = jest.fn(),
  mockSources: Record<string, unknown>[] = [];
const mockDb = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      collection: (child: string) => ({ doc: (key: string) => ({ path: `${name}/${id}/${child}/${key}` }) }),
    }),
  }),
};
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: () => ({ options: { projectId: 'project' } }), firestore: () => mockDb },
}));
jest.mock('./criticalRepairCatalog', () => ({
  prepareCriticalRepairCatalogSourceAppend: jest.fn(
    async (_tx: unknown, _db: unknown, _ref: unknown, input: { source: Record<string, unknown> }) => {
      mockSources.push(input.source);
      return { commit: mockAppend };
    }
  ),
}));
import {
  getPublishingSourceStepIds,
  markPublishingCritical,
  runDurablePublishingOperation,
} from './durableOperationContext';
const effect = {
  provider: 'subsplash' as const,
  resourceType: 'media' as const,
  resourceId: 'media',
  accountId: 'app:9XTSHD',
  method: 'DELETE' as const,
};
const tx = { get: async () => ({ exists: false }), create: mockCreate } as unknown as Transaction;
beforeEach(() => {
  jest.clearAllMocks();
  mockSources.length = 0;
});
it('binds original source authority to actual parent SDK steps before catalogue enrollment', async () => {
  const critical = jest.fn();
  await runDurablePublishingOperation(
    'job',
    () => markPublishingCritical('PUBLISHING_DELETE_MEDIA', effect),
    async (run) => run(tx),
    { getSourceStepIds: () => ['entity', 'cleanup', 'entity'], markCritical: critical }
  );
  expect(mockSources).toHaveLength(1);
  expect(mockSources[0]).toMatchObject({
    sourceStepIds: ['cleanup', 'entity'],
    sourceParentRef: { projectId: 'project', jobId: 'job' },
  });
  expect(mockCreate).toHaveBeenCalledWith(expect.anything(), mockSources[0]);
  expect(mockAppend).toHaveBeenCalledTimes(1);
  expect(critical).toHaveBeenCalledTimes(1);
});
it('refuses a source descriptor without trusted SDK step authority before any write or critical phase', async () => {
  const critical = jest.fn();
  await expect(
    runDurablePublishingOperation(
      'job',
      () => markPublishingCritical('PUBLISHING_DELETE_MEDIA', effect),
      async (run) => run(tx),
      { markCritical: critical }
    )
  ).rejects.toThrow('PUBLISHING_SOURCE_STEP_AUTHORITY_REQUIRED');
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockAppend).not.toHaveBeenCalled();
  expect(critical).not.toHaveBeenCalled();
});

it('refuses to transfer step authority across parent jobs', async () => {
  await runDurablePublishingOperation(
    'job',
    async () => {
      expect(() => getPublishingSourceStepIds('different-job')).toThrow('PUBLISHING_SOURCE_STEP_SCOPE_MISMATCH');
      expect(getPublishingSourceStepIds('job')).toEqual(['entity']);
    },
    undefined,
    { getSourceStepIds: () => ['entity'] }
  );
});
