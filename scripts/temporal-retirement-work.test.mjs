import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTraditionalRetirementWorkIdle, readTraditionalRetirementWork } from './temporal-retirement-work.mjs';

function fixture() {
  const dispatched = { state: 'dispatched', leaseExpiresAt: 0, leaseToken: 'old', leaseOwner: 'old' };
  const collections = {
    durableJobOutbox: Array(4204).fill(dispatched),
    durableJobCommands: [{ state: 'dispatched', leaseExpiresAt: 0 }],
    temporalProviderMutationSessions: [{ state: 'committed' }, { state: 'aborted' }],
    durableJobCriticalSections: [],
    temporalProviderMutationLocks: [],
  };
  function query(name, filters = []) {
    return {
      where: (...filter) => query(name, [...filters, filter]),
      count: () => ({
        count: collections[name].filter((row) =>
          filters.every(([key, op, value]) => (op === '==' ? row[key] === value : value.includes(row[key])))
        ).length,
      }),
    };
  }
  const slot = { exists: false };
  const db = { projectId: 'urm-app-staging', databaseId: '(default)', collection: query, doc: () => slot };
  const tx = { get: async (ref) => ('exists' in ref ? ref : { data: () => ({ count: ref.count }) }) };
  return { collections, slot, read: () => readTraditionalRetirementWork(db, tx) };
}

test('indexed retirement inventory tolerates historical lease metadata only after zero-expiry dispatch', async () => {
  const f = fixture();
  const result = await f.read();
  assert.deepEqual(result.outbox, { total: 4204, settled: 4204 });
  assert.match(assertTraditionalRetirementWorkIdle(result), /^[a-f0-9]{64}$/);
  f.collections.durableJobOutbox.push({ state: 'dispatched', leaseExpiresAt: 1 });
  const changed = await f.read();
  assert.throws(() => assertTraditionalRetirementWorkIdle(changed), /TRADITIONAL_RETIREMENT_WORK_UNCONFIRMED/);
});

test('retirement denies pending or unknown work, active provider locks and reserved YouTube work', async () => {
  const changes = [
    (f) => f.collections.durableJobCommands.push({ state: 'pending', leaseExpiresAt: 0 }),
    (f) => f.collections.durableJobCommands.push({ state: 'dispatching', leaseExpiresAt: 0 }),
    (f) => f.collections.durableJobCommands.push({ leaseExpiresAt: 0 }),
    (f) => f.collections.temporalProviderMutationSessions.push({ state: 'active' }),
    (f) => f.collections.temporalProviderMutationLocks.push({}),
    (f) => f.collections.durableJobCriticalSections.push({}),
    (f) => {
      f.slot.exists = true;
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    const result = await f.read();
    assert.throws(() => assertTraditionalRetirementWorkIdle(result), /TRADITIONAL_RETIREMENT_WORK_UNCONFIRMED/);
  }
});
