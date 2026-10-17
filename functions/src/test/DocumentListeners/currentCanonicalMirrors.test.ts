import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MIRROR_PAGE_SIZE,
  canonicalMirrorPatch,
  reconcileCurrentCanonicalMirrors,
} from '../../DocumentListeners/currentCanonicalMirrors';

type Row = { data: Record<string, unknown>; path: string };
function fixture(size: number) {
  const documents = new Map<string, Row>();
  const ref = (path: string): any => ({
    path,
    id: path.split('/').at(-1),
    parent: { parent: path.split('/').length === 4 ? ref(path.split('/').slice(0, 2).join('/')) : null },
  });
  const snap = (path: string): any => ({
    ref: ref(path),
    id: ref(path).id,
    exists: documents.has(path),
    data: () => documents.get(path)?.data,
    get: (key: string) => documents.get(path)?.data[key],
  });
  const put = (path: string, data: Row['data']) => documents.set(path, { path, data });
  put('lists/list-1', { id: 'list-1', name: 'Current name' });
  for (let index = 0; index < size; index++) {
    put(`sermons/${String(index).padStart(4, '0')}`, { title: 'Sermon' });
    put(`sermons/${String(index).padStart(4, '0')}/sermonLists/list-1`, {
      id: 'list-1',
      name: 'Old',
      uploadStatus: { status: 'UPLOADED' },
    });
  }
  const committed: Array<Array<{ path: string; patch: Row['data'] }>> = [];
  let attempts = 0;
  let retryFirst = false;
  let failAt: number | undefined;
  let beforeCommit: (() => void) | undefined;
  const query = (cursor?: string) => ({
    where: () => query(cursor),
    orderBy: () => query(cursor),
    limit: () => query(cursor),
    startAfter: (row: any) => query(row.ref.path),
    cursor,
    query: true,
  });
  const db = {
    doc: ref,
    collectionGroup: () => query(),
    runTransaction: async (run: (tx: any) => Promise<any>) => {
      async function attempt() {
        attempts++;
        const writes: Array<{ path: string; patch: Row['data'] }> = [];
        const result = await run({
          get: async (target: any) => {
            if (!target.query) return snap(target.path);
            const rows = [...documents.keys()]
              .filter((path) => path.includes('/sermonLists/') && (!target.cursor || path > target.cursor))
              .sort()
              .slice(0, MIRROR_PAGE_SIZE)
              .map(snap);
            return { docs: rows, size: rows.length };
          },
          update: (target: any, patch: Row['data']) => writes.push({ path: target.path, patch }),
        });
        return { writes, result };
      }
      let value = await attempt();
      if (retryFirst && attempts === 1) {
        put('lists/list-1', { id: 'list-1', name: 'Changed during transaction' });
        value = await attempt();
      }
      if (committed.length + 1 === failAt) throw new Error('PAGE_FAILED');
      committed.push(value.writes);
      value.writes.forEach(({ path, patch }) => put(path, { ...documents.get(path)?.data, ...patch }));
      beforeCommit?.();
      return value.result;
    },
  } as unknown as Firestore;
  const run = () =>
    reconcileCurrentCanonicalMirrors(db, {
      sourcePath: 'lists/list-1',
      collectionGroup: 'sermonLists',
      id: 'list-1',
      parentCollection: 'sermons',
      project: (canonical) => canonical,
    });
  return {
    documents,
    committed,
    run,
    put,
    retry: () => {
      retryFirst = true;
    },
    fail: (page: number) => {
      failAt = page;
    },
    afterPage: (callback: () => void) => {
      beforeCommit = callback;
    },
  };
}

describe('bounded current canonical mirror reconciliation', () => {
  it('updates 1001 mirrors with bounded transactional pages and preserves placement fields', async () => {
    const f = fixture(1001);
    await f.run();
    expect(f.committed.map((page) => page.length)).toEqual([
      ...Array(Math.floor(1001 / MIRROR_PAGE_SIZE)).fill(MIRROR_PAGE_SIZE),
      1001 % MIRROR_PAGE_SIZE,
    ]);
    expect(f.documents.get('sermons/0000/sermonLists/list-1')?.data).toMatchObject({
      name: 'Current name',
      uploadStatus: { status: 'UPLOADED' },
    });
  });
  it('a retried transaction recomputes its patch from the newer canonical version', async () => {
    const f = fixture(3);
    f.retry();
    await f.run();
    expect(f.committed[0].every(({ patch }) => patch.name === 'Changed during transaction')).toBe(true);
  });
  it('an older replay reconciles current truth rather than overwriting a newer name', async () => {
    const f = fixture(3);
    await f.run();
    f.put('lists/list-1', { id: 'list-1', name: 'Newest' });
    await f.run();
    await f.run();
    expect(f.documents.get('sermons/0000/sermonLists/list-1')?.data.name).toBe('Newest');
    expect(f.committed.at(-1)).toEqual([]);
  });
  it('does not mutate mirrors after the canonical document is deleted', async () => {
    const f = fixture(3);
    f.documents.delete('lists/list-1');
    await f.run();
    expect(f.committed.flat()).toEqual([]);
  });
  it('does not update descendants of a missing parent', async () => {
    const f = fixture(3);
    f.documents.delete('sermons/0001');
    await f.run();
    expect(f.documents.get('sermons/0001/sermonLists/list-1')?.data.name).toBe('Old');
    expect(f.committed.flat()).toHaveLength(2);
  });
  it('stops after a failed page and retry converges without duplicating earlier writes', async () => {
    const f = fixture(501);
    f.fail(2);
    await expect(f.run()).rejects.toThrow('PAGE_FAILED');
    expect(f.committed).toHaveLength(1);
    f.fail(99);
    await f.run();
    expect(
      [...f.documents.values()]
        .filter((row) => row.path.includes('/sermonLists/'))
        .every((row) => row.data.name === 'Current name')
    ).toBe(true);
  });
  it('a canonical deletion between pages prevents subsequent projection writes', async () => {
    const f = fixture(401);
    f.afterPage(() => {
      f.documents.delete('lists/list-1');
    });
    await f.run();
    expect(f.committed.flat()).toHaveLength(MIRROR_PAGE_SIZE);
    expect(f.documents.get(`sermons/${String(MIRROR_PAGE_SIZE).padStart(4, '0')}/sermonLists/list-1`)?.data.name).toBe(
      'Old'
    );
  });
});

describe('canonical optional-field removal', () => {
  it('removes stale remote IDs while preserving mirror-only state', () => {
    const patch = canonicalMirrorPatch(
      { name: 'Current' },
      { name: 'Old', subsplashId: 'obsolete-provider-id', uploadStatus: { status: 'UPLOADED' }, position: 3 },
      ['subsplashId']
    );
    expect(patch).toEqual({ name: 'Current', subsplashId: FieldValue.delete() });
    expect(patch).not.toHaveProperty('uploadStatus');
    expect(patch).not.toHaveProperty('position');
  });
  it('does not keep generating delete writes once a stale optional field is gone', () => {
    expect(canonicalMirrorPatch({ name: 'Current' }, { name: 'Current' }, ['subsplashId'])).toEqual({
      name: 'Current',
    });
  });
});
