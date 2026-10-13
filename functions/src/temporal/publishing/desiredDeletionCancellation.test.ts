jest.mock('./providerMutationGuard', () => ({ listProviderMutationSessionsForJob: jest.fn() }));
jest.mock('../../../../packages/orchestration/src/provider-usage', () => ({
  PROVIDER_USAGE_COLLECTION: 'usage',
  PROVIDER_USAGE_CONTROL: '_control/usage',
  assertProviderUsageMarker: jest.fn((value) => value),
  providerResourceKey: jest.fn((resource) => `${resource.provider}:${resource.remoteId}`),
  prepareDesiredProviderDeletionAbort: jest.fn(),
}));
import { abortCancelledDesiredProviderDeletions } from './desiredDeletionCancellation';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
const ref = { projectId: 'project', jobId: 'job' };
const guard = jest.requireMock('./providerMutationGuard'),
  index = jest.requireMock('../../../../packages/orchestration/src/provider-usage');
const path = (value: string) => ({
  path: value,
  collection: (name: string) => ({ doc: (id: string) => path(`${value}/${name}/${id}`) }),
});
const db = {
  doc: (name: string) => path(name),
  collection: (name: string) => ({ doc: (id: string) => path(`${name}/${id}`) }),
} as unknown as Firestore;
const target = { provider: 'soundcloud', account: 'soundcloud:users:1', resourceType: 'track', resourceId: 'track' };
let aggregate: Record<string, unknown>, controlExists: boolean;
const tx = {
  get: jest.fn(async (resource: { path: string }) =>
    resource.path === '_control/usage'
      ? { exists: controlExists, data: () => ({ epoch: 'epoch' }) }
      : { get: (field: string) => aggregate[field] }
  ),
} as unknown as Transaction;
const store = { commitCurrent: jest.fn(async (_ref: unknown, run: (tx: Transaction) => Promise<void>) => run(tx)) };
beforeEach(() => {
  jest.clearAllMocks();
  aggregate = { state: 'reserved', desiredDeletionProof: { jobId: 'job', resourceType: 'track' } };
  controlExists = true;
  guard.listProviderMutationSessionsForJob.mockResolvedValue([{ state: 'aborted', resources: [target] }]);
  index.prepareDesiredProviderDeletionAbort.mockResolvedValue(jest.fn());
});
it('passes exact index account alias and fresh transaction authority for a permanently aborted target', async () => {
  await abortCancelledDesiredProviderDeletions(db, ref, store);
  expect(index.prepareDesiredProviderDeletionAbort).toHaveBeenCalledWith(tx, db, {
    jobId: 'job',
    resourceType: 'track',
    resource: { projectId: 'project', provider: 'soundcloud', account: 'configured-account', remoteId: 'track' },
  });
  expect(await index.prepareDesiredProviderDeletionAbort.mock.results[0].value).toHaveBeenCalledTimes(1);
});
it('never releases a positive or uncertain active original session', async () => {
  guard.listProviderMutationSessionsForJob.mockResolvedValue([{ state: 'active', resources: [target] }]);
  await abortCancelledDesiredProviderDeletions(db, ref, store);
  expect(store.commitCurrent).not.toHaveBeenCalled();
  expect(index.prepareDesiredProviderDeletionAbort).not.toHaveBeenCalled();
});
it('does not release another job reservation', async () => {
  aggregate.desiredDeletionProof = { jobId: 'other', resourceType: 'track' };
  await abortCancelledDesiredProviderDeletions(db, ref, store);
  expect(index.prepareDesiredProviderDeletionAbort).not.toHaveBeenCalled();
});
it('retains the claim when original completion proof is unavailable', async () => {
  index.prepareDesiredProviderDeletionAbort.mockRejectedValueOnce(
    new Error('PROVIDER_DESIRED_DELETION_ABORT_UNPROVEN')
  );
  await expect(abortCancelledDesiredProviderDeletions(db, ref, store)).rejects.toThrow('UNPROVEN');
});
it('does not invent a preflight claim before the authoritative usage index exists', async () => {
  controlExists = false;
  await abortCancelledDesiredProviderDeletions(db, ref, store);
  expect(index.prepareDesiredProviderDeletionAbort).not.toHaveBeenCalled();
});
