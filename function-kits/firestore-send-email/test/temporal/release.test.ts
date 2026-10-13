import {
  assertLegacyEmailRelease,
  assertTemporalEmailRelease,
  countLegacyEmailDelivery,
  scanLegacyEmailDrain,
  LegacyEmailDrainCounts,
} from '../../src/temporal/release';
const control = () => ({
  schemaVersion: 1,
  revision: 2,
  admission: 'paused',
  domains: { emails: { owner: 'temporal', admission: 'paused' } },
  releaseId: 'r1',
  updatedAt: 1,
});
function harness(records: Record<string, any>) {
  const doc = (path: string): any => ({ path, get: async () => snapshot(path) });
  const snapshot = (path: string): any => ({
    exists: !!records[path],
    data: () => records[path],
    get: (key: string) => records[path]?.[key],
  });
  const tx: any = { get: async (ref: any) => snapshot(ref.path) };
  const db: any = { doc, collection: (path: string) => ({ doc: (id: string) => doc(`${path}/${id}`) }) };
  return { db, tx, records };
}
test('legacy continuation is compatible beforecontrol and rejects retiredowner despite staleenvironment', async () => {
  const h = harness({});
  await expect(assertLegacyEmailRelease(h.tx, h.db)).resolves.toBeUndefined();
  h.records['_control/temporalRelease'] = control();
  await expect(assertLegacyEmailRelease(h.tx, h.db)).rejects.toThrow('LEGACY_OWNER_RETIRED');
  h.records['_control/temporalRelease'].domains.emails.owner = 'legacy';
  await expect(assertLegacyEmailRelease(h.tx, h.db)).resolves.toBeUndefined();
});
test('new Temporalmail failclosedmissingcontrol oradmissionpaused', async () => {
  const h = harness({});
  await expect(assertTemporalEmailRelease(h.tx, h.db, 'p1')).rejects.toThrow('CONTROL_REQUIRED');
  h.records['_control/temporalRelease'] = control();
  await expect(assertTemporalEmailRelease(h.tx, h.db, 'p1')).rejects.toThrow('ADMISSION_PAUSED');
});
test('paused child requires matching canonicalprivateparentintent and publicjob', async () => {
  const h = harness({
    '_control/temporalRelease': control(),
    'durableJobIntents/parent': { projectId: 'p1', jobId: 'parent', kind: 'invite.create', actorUid: 'admin' },
    'durableJobs/parent': { projectId: 'p1', jobId: 'parent', kind: 'invite.create', requestedBy: 'admin' },
  });
  await expect(
    assertTemporalEmailRelease(h.tx, h.db, 'p1', { jobId: 'parent', projectId: 'p1' })
  ).resolves.toBeUndefined();
  h.records['durableJobIntents/parent'].actorUid = 'forged';
  await expect(assertTemporalEmailRelease(h.tx, h.db, 'p1', { jobId: 'parent', projectId: 'p1' })).rejects.toThrow(
    'PARENT_INTENT_INVALID'
  );
});
test('release importer must anchorpausedrevision and releaseidentity', async () => {
  const h = harness({ '_control/temporalRelease': control() });
  await expect(
    assertTemporalEmailRelease(h.tx, h.db, 'p1', undefined, { revision: 2, releaseId: 'r1' })
  ).resolves.toBeUndefined();
  await expect(
    assertTemporalEmailRelease(h.tx, h.db, 'p1', undefined, { revision: 1, releaseId: 'r1' })
  ).rejects.toThrow('IMPORT_STALE');
});
test('expired leases and previous retries are uncertainty, never proofunsent', () => {
  const counts: LegacyEmailDrainCounts = {
    pendingFresh: 0,
    retryWithPriorAttempts: 0,
    processingActive: 0,
    processingLeaseExpired: 0,
    terminalSuccess: 0,
    terminalError: 0,
    temporalOwned: 0,
    invalid: 0,
    total: 0,
  };
  countLegacyEmailDelivery(counts, undefined, 100);
  countLegacyEmailDelivery(counts, { state: 'RETRY', attempts: 1 }, 100);
  countLegacyEmailDelivery(counts, { state: 'PROCESSING', leaseExpireTime: { toMillis: () => 0 } }, 100);
  countLegacyEmailDelivery(counts, { state: 'PROCESSING', leaseExpireTime: { toMillis: () => 200 } }, 100);
  countLegacyEmailDelivery(counts, { state: 'SUCCESS' }, 100);
  countLegacyEmailDelivery(counts, { state: 'ERROR' }, 100);
  countLegacyEmailDelivery(counts, { orchestrator: 'temporal', state: 'PENDING' }, 100);
  expect(counts).toEqual({
    pendingFresh: 1,
    retryWithPriorAttempts: 1,
    processingActive: 1,
    processingLeaseExpired: 1,
    terminalSuccess: 1,
    terminalError: 1,
    temporalOwned: 1,
    invalid: 0,
    total: 7,
  });
});
test('drain scanner selects metadata only and rechecks fresh pausedcontrol', async () => {
  const h = harness({ '_control/temporalRelease': control() });
  const query: any = { orderBy: jest.fn(() => query), select: jest.fn(() => query), limit: jest.fn(() => query) };
  h.db.collection = () => query;
  h.db.runTransaction = async (operation: any, options: any) => {
    expect(options).toEqual({ readOnly: true });
    return operation({ get: async () => ({ docs: [{ get: () => ({ state: 'SUCCESS' }) }] }) });
  };
  expect(
    await scanLegacyEmailDrain(h.db, { mailCollection: 'mail', expectedControlRevision: 2, releaseId: 'r1' })
  ).toMatchObject({ drained: true, counts: { terminalSuccess: 1, total: 1 } });
  expect(query.select).toHaveBeenCalledWith(
    'delivery.state',
    'delivery.leaseExpireTime',
    'delivery.attempts',
    'delivery.orchestrator'
  );
  h.db.runTransaction = async (operation: any) => {
    await operation({ get: async () => ({ docs: [] }) });
    h.records['_control/temporalRelease'].revision = 3;
  };
  await expect(
    scanLegacyEmailDrain(h.db, { mailCollection: 'mail', expectedControlRevision: 2, releaseId: 'r1' })
  ).rejects.toThrow('CONTROL_STALE');
});
