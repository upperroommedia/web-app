import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { withProviderIndexedTransaction } from './provider-transaction';
import * as usage from './provider-usage';
function setup() {
  const docs = new Map<string, Record<string, unknown>>([
    ['sermons/a', { subsplashId: 'audio1', images: [{ subsplashId: 'image1' }], title: 'before' }],
    ['lists/b', { subsplashId: 'list1' }],
  ]);
  const events: string[] = [],
    actual: unknown[][] = [];
  const ref = (path: string) => ({ path });
  const tx = {
    get: jest.fn(async (target: { path: string }) => {
      events.push(`read:${target.path}`);
      if (events.some((event) => event.startsWith('write:'))) throw new Error('Read after write');
      return { data: () => docs.get(target.path) };
    }),
    getAll: jest.fn(),
    set: jest.fn((...args) => {
      events.push('write:set');
      actual.push(args);
    }),
    create: jest.fn((...args) => {
      events.push('write:create');
      actual.push(args);
    }),
    update: jest.fn((...args) => {
      events.push('write:update');
      actual.push(args);
    }),
    delete: jest.fn((...args) => {
      events.push('write:delete');
      actual.push(args);
    }),
  } as unknown as Transaction;
  const prepare = jest.spyOn(usage, 'prepareProviderUsageChanges').mockImplementation(async (_tx, _db, changes) => {
    events.push('read:index');
    if (events.some((event) => event.startsWith('write:'))) throw new Error('Index read after write');
    return () => {
      events.push('write:index');
    };
  });
  return { docs, events, actual, ref, tx, prepare, db: {} as Firestore };
}
afterEach(() => jest.restoreAllMocks());
test('batches concrete edges for repeated canonical writes and performs all reads before any write', async () => {
  const { tx, db, ref, events, prepare } = setup();
  const result = await withProviderIndexedTransaction(tx, db, 'project', async (recording) => {
    recording.update(ref('sermons/a') as never, { images: [{ subsplashId: 'image2' }] });
    recording.set(ref('sermons/a') as never, { title: 'after' }, { merge: true });
    recording.delete(ref('lists/b') as never);
    await recording.get(ref('sermons/a') as never);
    return 7;
  });
  expect(result).toBe(7);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(prepare.mock.calls[0][2]).toEqual([
    {
      projectId: 'project',
      canonicalPath: 'sermons/a',
      before: { subsplashId: 'audio1', images: [{ subsplashId: 'image1' }], title: 'before' },
      after: { subsplashId: 'audio1', images: [{ subsplashId: 'image2' }], title: 'after' },
    },
    { projectId: 'project', canonicalPath: 'lists/b', before: { subsplashId: 'list1' }, after: undefined },
  ]);
  expect(events.slice(events.indexOf('write:index'))).toEqual([
    'write:index',
    'write:update',
    'write:set',
    'write:delete',
  ]);
});
test('rejects provider-reference array transforms before writes and preserves non-reference transforms', async () => {
  const { tx, db, ref, actual, prepare } = setup();
  await expect(
    withProviderIndexedTransaction(tx, db, 'project', async (recording) => {
      recording.update(ref('sermons/a') as never, { images: FieldValue.arrayUnion({ subsplashId: 'image2' }) });
    })
  ).rejects.toThrow('REQUIRES_CONCRETE_VALUE');
  expect(actual).toHaveLength(0);
  expect(prepare).not.toHaveBeenCalled();
  await withProviderIndexedTransaction(tx, db, 'project', async (recording) => {
    recording.update(ref('sermons/a') as never, { updatedAt: FieldValue.serverTimestamp() });
  });
  expect(prepare.mock.calls[0][2][0].after).toMatchObject({
    subsplashId: 'audio1',
    images: [{ subsplashId: 'image1' }],
  });
});
test('failed mutation or index reservation never flushes canonical writes', async () => {
  const { tx, db, ref, actual, prepare } = setup();
  await expect(
    withProviderIndexedTransaction(tx, db, 'project', async (recording) => {
      recording.set(ref('sermons/a') as never, { subsplashId: 'audio2' });
      throw new Error('domain failed');
    })
  ).rejects.toThrow('domain failed');
  expect(actual).toHaveLength(0);
  prepare.mockRejectedValue(new Error('PROVIDER_RESOURCE_CLEANUP_RESERVED'));
  await expect(
    withProviderIndexedTransaction(tx, db, 'project', async (recording) => {
      recording.set(ref('sermons/a') as never, { subsplashId: 'audio2' });
    })
  ).rejects.toThrow('PROVIDER_RESOURCE_CLEANUP_RESERVED');
  expect(actual).toHaveLength(0);
});
test('supports dotted updates and mergeFields without inventing remote IDs from local fields', async () => {
  const { tx, db, ref, prepare } = setup();
  await withProviderIndexedTransaction(tx, db, 'project', async (recording) => {
    recording.update(ref('sermons/a') as never, 'nested.subsplashId', 'remote2', 'title', 'new');
    recording.set(
      ref('sermons/a') as never,
      { nested: { subsplashId: 'remote3', other: 'ignored' } },
      { mergeFields: ['nested.subsplashId'] }
    );
  });
  expect(prepare.mock.calls[0][2][0].after).toEqual({
    subsplashId: 'audio1',
    images: [{ subsplashId: 'image1' }],
    title: 'new',
    nested: { subsplashId: 'remote3' },
  });
});

test('public delete sentinel removes dotted and merged reference fields while retaining actual SDK sentinel writes', async () => {
  const { tx, db, ref, docs, prepare, actual } = setup();
  docs.set('sermons/a', { subsplashId: 'audio1', nested: { tagId: 'speaker1', title: 'keep' }, title: 'before' });
  const deletion = FieldValue.delete();
  await withProviderIndexedTransaction(tx, db, 'project', async (recording) => {
    recording.update(ref('sermons/a') as never, { 'nested.tagId': deletion });
    recording.set(ref('sermons/a') as never, { subsplashId: deletion }, { merge: true });
  });
  expect(prepare.mock.calls[0][2][0].after).toEqual({ nested: { title: 'keep' }, title: 'before' });
  expect((actual[0][1] as Record<string, FieldValue>)['nested.tagId'].isEqual(deletion)).toBe(true);
  expect((actual[1][1] as Record<string, FieldValue>).subsplashId.isEqual(deletion)).toBe(true);
});

test('array transforms cannot hide explicit provider keys beneath otherwise unrelated container names', async () => {
  const { tx, db, ref, actual } = setup();
  await expect(
    withProviderIndexedTransaction(tx, db, 'project', async (recording) => {
      recording.update(ref('sermons/a') as never, { metadata: FieldValue.arrayUnion({ tagId: 'hidden-resource' }) });
    })
  ).rejects.toThrow('REQUIRES_CONCRETE_VALUE');
  expect(actual).toHaveLength(0);
});

test('explicitly excludes an independently prepared intent edge while indexing its canonical admission writes', async () => {
  const { tx, db, ref, prepare } = setup();
  await withProviderIndexedTransaction(
    tx,
    db,
    'project',
    async (recording) => {
      recording.create(ref('durableJobIntents/job1') as never, { payload: { subsplashId: 'audio1' } });
      recording.update(ref('sermons/a') as never, { title: 'admitted' });
    },
    { excludeCanonicalPaths: ['durableJobIntents/job1'] }
  );
  expect(prepare.mock.calls[0][2].map((change) => change.canonicalPath)).toEqual(['sermons/a']);
  expect(tx.create).toHaveBeenCalled();
});

test.each(['moreSermonsRef', 'manualOverflowTargetSubsplashId'])(
  'overflow list reference %s requires concrete values and supports exact deletion',
  async (field) => {
    const { tx, db, ref, docs, prepare, actual } = setup();
    docs.set('lists/b', { subsplashId: 'list1', [field]: 'overflow-list' });
    await expect(
      withProviderIndexedTransaction(tx, db, 'project', async (recording) => {
        recording.update(ref('lists/b') as never, { [field]: FieldValue.serverTimestamp() });
      })
    ).rejects.toThrow('REQUIRES_CONCRETE_VALUE');
    expect(actual).toHaveLength(0);
    await withProviderIndexedTransaction(tx, db, 'project', async (recording) => {
      recording.update(ref('lists/b') as never, { [field]: FieldValue.delete() });
    });
    expect(prepare.mock.calls[0][2][0]).toEqual({
      projectId: 'project',
      canonicalPath: 'lists/b',
      before: { subsplashId: 'list1', [field]: 'overflow-list' },
      after: { subsplashId: 'list1' },
    });
  }
);

test('forwards scoped reserved-reference authority and rechecks permission after index reads before all writes', async () => {
  const { tx, db, ref, events, prepare, actual } = setup(),
    authority = { jobId: 'job1', sourceProof: { private: true }, validate: jest.fn() };
  const beforeCommit = jest.fn(async (current) => {
    expect(current).toBe(tx);
    expect(events.at(-1)).toBe('read:index');
    events.push('read:fresh-permission');
  });
  await withProviderIndexedTransaction(
    tx,
    db,
    'project',
    async (recording) => {
      recording.update(ref('sermons/a') as never, { title: 'same provider' });
    },
    { reservedProjection: authority, beforeCommit }
  );
  expect(prepare.mock.calls[0][3]).toBe(authority);
  expect(beforeCommit).toHaveBeenCalledTimes(1);
  expect(events.indexOf('read:fresh-permission')).toBeLessThan(events.indexOf('write:index'));
  expect(actual).toHaveLength(1);
});
test('revocation during index preparation rolls back both canonical and index writes', async () => {
  const { tx, db, ref, events, actual } = setup();
  await expect(
    withProviderIndexedTransaction(
      tx,
      db,
      'project',
      async (recording) => {
        recording.update(ref('sermons/a') as never, { title: 'blocked' });
      },
      {
        beforeCommit: async () => {
          throw new Error('PERMISSION_CHANGED');
        },
      }
    )
  ).rejects.toThrow('PERMISSION_CHANGED');
  expect(actual).toHaveLength(0);
  expect(events.some((event) => event.startsWith('write:'))).toBe(false);
});
