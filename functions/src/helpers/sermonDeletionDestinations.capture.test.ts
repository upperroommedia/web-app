jest.mock('axios', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../subsplashUtils', () => ({
  createAxiosConfig: (url: string, _token: string, method: string, data: unknown) => ({ url, method, data }),
}));
import axios from 'axios';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  captureSermonDeletionDestinations,
  executeSermonDeletionDestinations,
  readSermonDeletionDestinationProgramInTransaction,
  revalidateSermonDeletionDestinationSources,
  validateSermonDeletionDestinationCompletion,
  verifySermonDeletionDestinationCounts,
  readSermonDeletionPartialDestinationCounts,
  executeFrozenSermonDeletionDestinationRequest,
} from './sermonDeletionDestinations';
import {
  beginProviderMutationPlan,
  runDurablePublishingOperation,
} from '../temporal/publishing/durableOperationContext';
import { providerMutationFingerprint } from '../temporal/publishing/providerMutationGuard';

type Data = Record<string, any>;
class Document {
  constructor(readonly db: Memory, readonly path: string) {}
  get id() {
    return this.path.split('/').at(-1)!;
  }
  collection(name: string) {
    return new Query(this.db, `${this.path}/${name}`);
  }
  async get() {
    return new Snapshot(this);
  }
}
class Snapshot {
  constructor(readonly ref: Document) {}
  get id() {
    return this.ref.id;
  }
  get exists() {
    return this.ref.db.docs.has(this.ref.path);
  }
  data() {
    const data = this.ref.db.docs.get(this.ref.path);
    return data ? JSON.parse(JSON.stringify(data)) : undefined;
  }
  get(field: string) {
    return field.split('.').reduce((value, key) => value?.[key], this.data());
  }
}
class Query {
  filters: Array<[string, unknown]> = [];
  maximum = Infinity;
  cursor?: string;
  constructor(readonly db: Memory, readonly path: string, readonly group = false) {}
  doc(id: string) {
    return new Document(this.db, `${this.path}/${id}`);
  }
  private copy() {
    const next = new Query(this.db, this.path, this.group);
    next.filters = [...this.filters];
    next.maximum = this.maximum;
    next.cursor = this.cursor;
    return next;
  }
  where(field: string, _operator: string, value: unknown) {
    const next = this.copy();
    next.filters.push([field, value]);
    return next;
  }
  orderBy(_field: unknown) {
    return this.copy();
  }
  limit(count: number) {
    const next = this.copy();
    next.maximum = count;
    return next;
  }
  startAfter(snapshot: Snapshot) {
    const next = this.copy();
    next.cursor = snapshot.ref.path;
    return next;
  }
  async get() {
    const docs = [...this.db.docs.keys()]
      .sort()
      .filter((path) =>
        this.group
          ? path.split('/').at(-2) === this.path
          : path.startsWith(`${this.path}/`) && path.split('/').length === this.path.split('/').length + 1
      )
      .filter((path) => !this.cursor || path > this.cursor)
      .map((path) => new Snapshot(new Document(this.db, path)))
      .filter((snapshot) => this.filters.every(([field, value]) => snapshot.get(field) === value))
      .slice(0, this.maximum);
    return { docs, size: docs.length, empty: !docs.length };
  }
}
class Memory {
  docs = new Map<string, Data>();
  writes: string[] = [];
  failSealOnce = false;
  doc(path: string) {
    return new Document(this, path);
  }
  collection(path: string) {
    return new Query(this, path);
  }
  collectionGroup(name: string) {
    return new Query(this, name, true);
  }
  async runTransaction<T>(mutate: (tx: Transaction) => Promise<T>): Promise<T> {
    const writes: Array<[Document, Data]> = [];
    const tx = {
      get: (target: Document | Query) => target.get(),
      getAll: (...targets: Document[]) => Promise.all(targets.map((target) => target.get())),
      create: (target: Document, data: Data) => {
        if (this.failSealOnce && target.path.endsWith('/destinationPlan/header')) {
          this.failSealOnce = false;
          throw new Error('simulated interrupted seal');
        }
        if (this.docs.has(target.path)) throw new Error('already exists');
        writes.push([target, data]);
      },
      set: (target: Document, data: Data) => writes.push([target, data]),
    };
    const result = await mutate(tx as unknown as Transaction);
    for (const [target, data] of writes) {
      this.docs.set(target.path, JSON.parse(JSON.stringify(data)));
      this.writes.push(target.path);
    }
    return result;
  }
  asFirestore() {
    return this as unknown as Firestore;
  }
}
const http = jest.mocked(axios),
  input = { projectId: 'project', jobId: 'job', sermonId: 'sermon', mediaId: 'media' };
const listRow = (id: string, source: string, media: string) => ({
  id,
  app_key: '9XTSHD',
  type: 'media-item',
  method: 'static',
  position: 1,
  _embedded: { 'source-list': { id: source }, 'media-item': { id: media } },
});
function fixture() {
  const db = new Memory();
  for (const [path, data] of Object.entries({
    'durableJobIntents/job': {
      schemaVersion: 1,
      projectId: 'project',
      jobId: 'job',
      kind: 'sermon.delete',
      entity: { type: 'sermon', id: 'sermon' },
      payload: { sermonId: 'sermon', action: 'delete', generation: 1 },
      generation: 1,
    },
    'sermons/sermon': { subsplashId: 'media', seriesId: 'series', title: 'original' },
    'sermons/sermon/sermonLists/root': {
      physicalPlacement: { firestoreListId: 'overflow', subsplashListId: 'remote-overflow', listItemId: 'fixed-row' },
    },
    'lists/root': { subsplashId: 'remote-root', moreSermonsRef: 'remote-overflow', count: 1, logicalCount: 3 },
    'lists/overflow': { subsplashId: 'remote-overflow', rootListId: 'root', count: 2 },
    'lists/root/listItems/sermon': { subsplashId: 'media' },
    'series/series': { subsplashId: 'remote-series', publishedItemCount: 2, itemCount: 3 },
    'series/series/seriesItems/sermon': { publishedToSubsplash: true },
  }))
    db.docs.set(path, data);
  const rows: Record<string, Data[]> = {
    'remote-root': [
      listRow('other-root', 'remote-root', 'other'),
      {
        id: 'continuation',
        app_key: '9XTSHD',
        type: 'list',
        method: 'static',
        position: 2,
        _embedded: { 'source-list': { id: 'remote-root' }, list: { id: 'remote-overflow' } },
      },
    ],
    'remote-overflow': [
      listRow('fixed-row', 'remote-overflow', 'media'),
      listRow('other-overflow', 'remote-overflow', 'other-2'),
    ],
  };
  let mediaSeries: string | null = 'remote-series';
  let seriesSubtitle = '2 part series';
  const items: Data[] = [
    { id: 'media', app_key: '9XTSHD', status: 'published', _embedded: { 'media-series': { id: 'remote-series' } } },
    { id: 'other', app_key: '9XTSHD', status: 'published', _embedded: { 'media-series': { id: 'remote-series' } } },
    { id: 'draft', app_key: '9XTSHD', status: 'draft', _embedded: { 'media-series': { id: 'remote-series' } } },
  ];
  const canonicalBefore = JSON.parse(JSON.stringify([...db.docs]));
  const transport = async (config: any): Promise<any> => {
    const url = new URL(config.url);
    if (config.method === 'GET' && url.pathname === '/media/v1/media-items/media')
      return {
        status: 200,
        data: {
          id: 'media',
          app_key: '9XTSHD',
          _embedded: { 'media-series': mediaSeries ? { id: mediaSeries } : null },
        },
      };
    if (config.method === 'GET' && url.pathname === '/media/v1/media-series/remote-series')
      return { status: 200, data: { id: 'remote-series', app_key: '9XTSHD', subtitle: seriesSubtitle } };
    if (config.method === 'GET' && url.pathname.startsWith('/builder/v1/lists/'))
      return { status: 200, data: { id: url.pathname.split('/').at(-1), app_key: '9XTSHD', type: 'standard' } };
    if (config.method === 'GET' && url.pathname === '/builder/v1/list-rows') {
      const source = url.searchParams.get('filter[source_list]')!;
      const all = rows[source],
        page = Number(url.searchParams.get('page[number]'));
      return {
        status: 200,
        data: { total: all.length, _embedded: { 'list-rows': all.slice((page - 1) * 200, page * 200) } },
      };
    }
    if (config.method === 'GET' && url.pathname === '/media/v1/media-items') {
      const status = url.searchParams.get('filter[status]');
      const all = items.filter(
        (item) => item.status === status && (item.id !== 'media' || mediaSeries === 'remote-series')
      );
      const page = Number(url.searchParams.get('page[number]'));
      return {
        status: 200,
        data: { total: all.length, _embedded: { 'media-items': all.slice((page - 1) * 200, page * 200) } },
      };
    }
    if (config.method === 'DELETE' && url.pathname === '/builder/v1/list-rows/fixed-row') {
      rows['remote-overflow'] = rows['remote-overflow'].filter((row) => row.id !== 'fixed-row');
      return { status: 204, data: undefined };
    }
    if (config.method === 'PATCH' && url.pathname === '/media/v1/media-series/remote-series') {
      expect(config.data).toEqual({ id: 'remote-series', subtitle: '1 part series' });
      seriesSubtitle = config.data.subtitle;
      return { status: 200, data: { id: 'remote-series' } };
    }
    if (config.method === 'PATCH' && url.pathname === '/media/v1/media-items/media') {
      expect(config.data).toEqual({ id: 'media', app_key: '9XTSHD', _embedded: { 'media-series': null } });
      mediaSeries = null;
      return { status: 200, data: { id: 'media' } };
    }
    throw new Error(`Unexpected provider call ${config.method} ${url.pathname}`);
  };
  http.mockImplementation(transport);
  const context = async <T>(task: () => Promise<T>, cached = false) =>
    runDurablePublishingOperation('job', task, undefined, {
      beginProviderMutationPlan: async () => {},
      runPublishingProviderMutation: async (request) => {
        const scope = { projectId: 'project', jobId: 'job', operation: request.operation },
          sessionId = providerMutationFingerprint(scope),
          path = `temporalProviderMutationSessions/${sessionId}/requests/${providerMutationFingerprint(request.step)}`;
        if (cached || db.docs.get(path)?.state === 'acknowledged') return null as never;
        if (db.docs.get(path)?.state === 'unknown')
          throw Object.assign(new Error('PROVIDER_MUTATION_UNRESOLVED'), { code: 'PROVIDER_MUTATION_UNRESOLVED' });
        let completion;
        try {
          completion = await request.send();
        } catch (error) {
          db.docs.set(path, { state: 'unknown' });
          throw error;
        }

        const claim = `claim-${request.step}`,
          executionId = 'original-execution',
          fingerprint = providerMutationFingerprint([
            request.method,
            { target: request.target, body: request.payload },
          ]);
        db.docs.set(path, {
          step: request.step,
          state: completion.completion,
          fingerprint,
          method: request.method,
          claim,
          executionId,
          ...(completion.completion === 'acknowledged' ? { result: completion.result } : {}),
        });
        db.docs.set(`temporalProviderMutationFacts/${providerMutationFingerprint([sessionId, request.step, claim])}`, {
          sessionId,
          step: request.step,
          claim,
          executionId,
          fingerprint,
          completion: completion.completion,
          ...(completion.completion === 'acknowledged'
            ? { result: completion.result }
            : { evidence: completion.evidence }),
        });
        if (completion.completion === 'rejected_no_effect')
          throw Object.assign(new Error('PROVIDER_MUTATION_REJECTED_NO_EFFECT'), {
            code: 'PROVIDER_MUTATION_REJECTED_NO_EFFECT',
          });
        return completion.result;
      },
    });
  return {
    db,
    rows,
    items,
    canonicalBefore,
    context,
    transport,
    setMediaSeries: (series: string) => {
      mediaSeries = series;
    },
  };
}
beforeEach(() => http.mockReset());
test('captures mixed logical root, physical overflow and series, then remote-only cleanup with exact original factual counts', async () => {
  const f = fixture();
  await f.context(async () => {
    const program = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
    expect(program.resources.map((r) => [r.resourceType, r.resourceId])).toEqual(
      expect.arrayContaining([
        ['media', 'media'],
        ['list', 'remote-root'],
        ['list', 'remote-overflow'],
        ['list-row', 'fixed-row'],
        ['series', 'remote-series'],
      ])
    );
    expect(http.mock.calls.every((call) => (call[0] as any).method === 'GET')).toBe(true);
    await beginProviderMutationPlan({ operation: program.operation, resources: program.resources });
    await revalidateSermonDeletionDestinationSources(f.db.asFirestore(), program.ref);
    await executeSermonDeletionDestinations(f.db.asFirestore(), program.ref, 'private');
    const completion = await f.db.runTransaction((tx) =>
      validateSermonDeletionDestinationCompletion(tx, f.db.asFirestore(), program.ref)
    );
    expect(completion.countWrites).toEqual(
      expect.arrayContaining([
        { path: 'lists/root', expectedFields: { subsplashId: 'remote-root' }, patch: { count: 1, logicalCount: 2 } },
        { path: 'lists/overflow', expectedFields: { subsplashId: 'remote-overflow' }, patch: { count: 1 } },
        {
          path: 'series/series',
          expectedFields: { subsplashId: 'remote-series' },
          patch: { publishedItemCount: 1, subtitle: '1 part series' },
        },
      ])
    );
    const frozen = await f.db.runTransaction((tx) =>
      readSermonDeletionDestinationProgramInTransaction(tx, f.db.asFirestore(), program.ref)
    );
    expect(frozen.countWrites).toEqual(expect.arrayContaining(completion.countWrites));
    expect([...f.db.docs].filter(([path]) => !path.startsWith('temporal'))).toEqual(f.canonicalBefore);
    expect(f.db.writes.every((path) => path.startsWith('temporalSermonDeletionMirrorPlans/'))).toBe(true);
  });
});
test('reuses original capture after interrupted private seal without changing canonical records', async () => {
  const f = fixture();
  f.db.failSealOnce = true;
  await f.context(async () => {
    await expect(captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private')).rejects.toThrow(
      'interrupted seal'
    );
    const program = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
    expect(program.requests).toHaveLength(3);
    expect([...f.db.docs].filter(([path]) => !path.startsWith('temporal'))).toEqual(f.canonicalBefore);
  });
});
test('cached capture/ACK replay performs no deleted-row lookup or mutation HTTP', async () => {
  const f = fixture();
  await f.context(async () => {
    const program = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
    await beginProviderMutationPlan({ operation: program.operation, resources: program.resources });
    await executeSermonDeletionDestinations(f.db.asFirestore(), program.ref, 'private');
    http.mockClear();
    const replay = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
    expect(replay.ref).toEqual(program.ref);
    expect(http).not.toHaveBeenCalled();
    await executeSermonDeletionDestinations(f.db.asFirestore(), program.ref, 'private');
    expect(
      http.mock.calls.every(
        (call) => (call[0] as any).method === 'GET' && !(call[0] as any).url.includes('/list-rows/fixed-row')
      )
    ).toBe(true);
  });
});
test('canonical graph drift after whole-resource acquisition stops before any provider mutation', async () => {
  const f = fixture();
  await f.context(async () => {
    const program = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
    await beginProviderMutationPlan({ operation: program.operation, resources: program.resources });
    f.db.docs.get('lists/overflow')!.moreSermonsRef = 'foreign';
    await expect(revalidateSermonDeletionDestinationSources(f.db.asFirestore(), program.ref)).rejects.toThrow(
      'GRAPH_CHANGED_UNSENT'
    );
    expect(http.mock.calls.every((call) => (call[0] as any).method === 'GET')).toBe(true);
  });
});
test('foreign series appearing after capture is never unlinked by the original sparse program', async () => {
  const f = fixture();
  await f.context(async () => {
    const program = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
    await beginProviderMutationPlan({ operation: program.operation, resources: program.resources });
    f.setMediaSeries('foreign-series');
    await expect(executeSermonDeletionDestinations(f.db.asFirestore(), program.ref, 'private')).rejects.toThrow(
      'PROOF_INVALID'
    );
    expect(http.mock.calls.filter((call) => (call[0] as any).method === 'PATCH')).toHaveLength(0);
    expect(f.db.docs.get('sermons/sermon')!.subsplashId).toBe('media');
  });
});
test('foreign source-list placement prevents capture and every effect', async () => {
  const f = fixture();
  f.rows['remote-overflow'][0]._embedded['source-list'].id = 'foreign';
  await f.context(async () => {
    await expect(captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private')).rejects.toThrow(
      'PROOF_INVALID'
    );
    expect(http.mock.calls.every((call) => (call[0] as any).method === 'GET')).toBe(true);
  });
});
test('an exact full 200-row page is followed to its explicit empty completion page', async () => {
  const f = fixture();
  f.rows['remote-overflow'] = Array.from({ length: 200 }, (_, index) =>
    listRow(`row-${index}`, 'remote-overflow', index === 0 ? 'media' : `other-${index}`)
  );
  await f.context(async () => {
    const program = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
    expect(program.requests).toHaveLength(3);
    expect(
      http.mock.calls.some(
        (call) =>
          (call[0] as any).url.includes('filter[source_list]=remote-overflow') &&
          (call[0] as any).url.includes('page[number]=2')
      )
    ).toBe(true);
  });
});
test('zero destinations is a valid complete private program, without guessed remote mutations', async () => {
  const f = fixture();
  for (const path of [...f.db.docs.keys()])
    if (path.includes('/sermonLists/') || path.endsWith('/listItems/sermon') || path.endsWith('/seriesItems/sermon'))
      f.db.docs.delete(path);
  delete f.db.docs.get('sermons/sermon')!.seriesId;
  f.setMediaSeries('');
  await f.context(async () => {
    const program = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
    expect(program.requests).toEqual([]);
    expect(program.resources).toHaveLength(1);
    await beginProviderMutationPlan({ operation: program.operation, resources: program.resources });
    await executeSermonDeletionDestinations(f.db.asFirestore(), program.ref, 'private');
    const result = await f.db.runTransaction((tx) =>
      validateSermonDeletionDestinationCompletion(tx, f.db.asFirestore(), program.ref)
    );
    expect(result.countWrites).toEqual([]);
  });
});
test('unknown original row DELETE cannot be resent or completed by a fresh apparent absence', async () => {
  const f = fixture();
  await f.context(async () => {
    const program = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
    await beginProviderMutationPlan({ operation: program.operation, resources: program.resources });
    http.mockImplementation(async (config: any) => {
      if (config.method === 'DELETE') throw new Error('connection disappeared');
      return f.transport(config);
    });
    await expect(executeSermonDeletionDestinations(f.db.asFirestore(), program.ref, 'private')).rejects.toThrow(
      'connection disappeared'
    );
    f.rows['remote-overflow'] = f.rows['remote-overflow'].filter((row) => row.id !== 'fixed-row');
    http.mockClear();
    await expect(executeSermonDeletionDestinations(f.db.asFirestore(), program.ref, 'private')).rejects.toThrow(
      'UNRESOLVED'
    );
    expect(http).not.toHaveBeenCalled();
    await expect(
      f.db.runTransaction((tx) => validateSermonDeletionDestinationCompletion(tx, f.db.asFirestore(), program.ref))
    ).rejects.toThrow('PROOF_INVALID');
    expect(f.db.docs.get('sermons/sermon')!.subsplashId).toBe('media');
  });
});
test.each([404, 410])(
  'structured original row DELETE rejection %i plus exact remaining membership is sealed without fake ACK',
  async (status) => {
    const f = fixture();
    await f.context(async () => {
      const program = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
      await beginProviderMutationPlan({ operation: program.operation, resources: program.resources });
      http.mockImplementation(async (config: any) => {
        if (config.method === 'DELETE') {
          f.rows['remote-overflow'] = f.rows['remote-overflow'].filter((row) => row.id !== 'fixed-row');
          throw Object.assign(new Error('resource absent'), {
            response: {
              status,
              headers: { 'content-type': 'application/json' },
              data: { errors: [{ code: 'resource_not_found' }] },
            },
          });
        }
        return f.transport(config);
      });
      await executeSermonDeletionDestinations(f.db.asFirestore(), program.ref, 'private');
      const completion = await f.db.runTransaction((tx) =>
        validateSermonDeletionDestinationCompletion(tx, f.db.asFirestore(), program.ref)
      );
      expect(completion.countWrites).toHaveLength(3);
      expect(
        [...f.db.docs].some(
          ([path, data]) =>
            path.startsWith('temporalProviderMutationFacts/') && data.completion === 'rejected_no_effect'
        )
      ).toBe(true);
      http.mockClear();
      await executeSermonDeletionDestinations(f.db.asFirestore(), program.ref, 'private');
      expect(http.mock.calls.every((call) => (call[0] as any).method === 'GET')).toBe(true);
    });
  }
);
test('unexpected remote membership drift blocks final provider root deletion and count projection', async () => {
  const f = fixture();
  await f.context(async () => {
    const program = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
    await beginProviderMutationPlan({ operation: program.operation, resources: program.resources });
    f.rows['remote-root'].push(listRow('new-foreign-row', 'remote-root', 'new-foreign-content'));
    await expect(executeSermonDeletionDestinations(f.db.asFirestore(), program.ref, 'private')).rejects.toThrow(
      'PROOF_INVALID'
    );
    await expect(
      f.db.runTransaction((tx) => validateSermonDeletionDestinationCompletion(tx, f.db.asFirestore(), program.ref))
    ).rejects.toThrow('PROOF_INVALID');
    expect(f.db.docs.get('lists/root')!.logicalCount).toBe(3);
    expect(f.db.docs.get('sermons/sermon')!.subsplashId).toBe('media');
  });
});
test('fresh qualified count proof can be recovered by administrator after original ACKs without resending a mutation', async () => {
  const f = fixture();
  await f.context(async () => {
    const program = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
    await beginProviderMutationPlan({ operation: program.operation, resources: program.resources });
    await executeSermonDeletionDestinations(f.db.asFirestore(), program.ref, 'private');
    const outcome = [...f.db.docs.keys()].find((path) => path.endsWith('/outcome/verified'))!;
    f.db.docs.delete(outcome);
    http.mockClear();
    await verifySermonDeletionDestinationCounts(f.db.asFirestore(), program.ref, 'private');
    await f.db.runTransaction((tx) => validateSermonDeletionDestinationCompletion(tx, f.db.asFirestore(), program.ref));
    expect(http.mock.calls.every((call) => (call[0] as any).method === 'GET')).toBe(true);
  });
});
test('unqualified series catalog item is never treated as membership/count proof', async () => {
  const f = fixture();
  delete f.items[1]._embedded['media-series'];
  await f.context(async () => {
    await expect(captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private')).rejects.toThrow(
      'PROOF_INVALID'
    );
    expect(http.mock.calls.every((call) => (call[0] as any).method === 'GET')).toBe(true);
  });
});
test('partial row-only stop reports actual counts and preserves still-linked series and canonical records', async () => {
  const f = fixture();
  await f.context(async () => {
    const program = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
    await beginProviderMutationPlan({ operation: program.operation, resources: program.resources });
    const first = program.requests[0];
    await executeFrozenSermonDeletionDestinationRequest(program.operation, first, 'private', f.db.asFirestore());
    const before = JSON.stringify([...f.db.docs]);
    http.mockClear();
    const authorizeRead = jest.fn(async () => {});
    const result = await readSermonDeletionPartialDestinationCounts(f.db.asFirestore(), program.ref, 'private', {
      knownRequestSteps: [first.step],
      authorizeRead,
    });
    expect(result.observations).toEqual([
      { step: first.step, target: first.target, state: 'absent', matchesFrozenRequest: true },
    ]);
    expect(result.countWrites).toEqual(
      expect.arrayContaining([
        {
          path: 'series/series',
          expectedFields: { subsplashId: 'remote-series' },
          patch: { publishedItemCount: 2, subtitle: '2 part series' },
        },
      ])
    );
    expect(http.mock.calls.every((call) => (call[0] as any).method === 'GET')).toBe(true);
    expect(JSON.stringify([...f.db.docs])).toBe(before);
    expect(authorizeRead).toHaveBeenCalledWith({
      provider: 'subsplash',
      account: 'app:9XTSHD',
      resourceType: 'list',
      resourceId: 'remote-overflow',
    });
  });
});
test('partial unlink stop exposes confirmed absence and actual unsynchronized provider subtitle', async () => {
  const f = fixture();
  await f.context(async () => {
    const program = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
    await beginProviderMutationPlan({ operation: program.operation, resources: program.resources });
    const unlink = program.requests.find((request) => request.target?.resourceType === 'media')!;
    await executeFrozenSermonDeletionDestinationRequest(program.operation, unlink, 'private', f.db.asFirestore());
    const result = await readSermonDeletionPartialDestinationCounts(f.db.asFirestore(), program.ref, 'private', {
      knownRequestSteps: [unlink.step],
      authorizeRead: async () => {},
    });
    expect(result.observations).toEqual([
      {
        step: unlink.step,
        target: unlink.target,
        state: 'unlinked',
        observedFields: { seriesId: null },
        matchesFrozenRequest: true,
      },
    ]);
    expect(result.countWrites).toEqual(
      expect.arrayContaining([
        {
          path: 'series/series',
          expectedFields: { subsplashId: 'remote-series' },
          patch: { publishedItemCount: 1, subtitle: '2 part series' },
        },
      ])
    );
  });
});
test('partial read checks fresh target authorization before any provider GET', async () => {
  const f = fixture();
  await f.context(async () => {
    const program = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
    http.mockClear();
    await expect(
      readSermonDeletionPartialDestinationCounts(f.db.asFirestore(), program.ref, 'private', {
        knownRequestSteps: [program.requests[0].step],
        authorizeRead: async () => {
          throw new Error('PERMISSION_CHANGED');
        },
      })
    ).rejects.toThrow('PERMISSION_CHANGED');
    expect(http).not.toHaveBeenCalled();
  });
});
test('partial snapshot refuses a step outside the original immutable destination program', async () => {
  const f = fixture();
  await f.context(async () => {
    const program = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
    http.mockClear();
    await expect(
      readSermonDeletionPartialDestinationCounts(f.db.asFirestore(), program.ref, 'private', {
        knownRequestSteps: ['foreign-step'],
        authorizeRead: async () => {},
      })
    ).rejects.toThrow('PROOF_INVALID');
    expect(http).not.toHaveBeenCalled();
  });
});
test('count recovery rechecks the exact fixed resource before every read and stops on revoked authority', async () => {
  const f = fixture();
  await f.context(async () => {
    const program = await captureSermonDeletionDestinations(f.db.asFirestore(), input, 'private');
    await beginProviderMutationPlan({ operation: program.operation, resources: program.resources });
    await executeSermonDeletionDestinations(f.db.asFirestore(), program.ref, 'private');
    const outcome = [...f.db.docs.keys()].find((path) => path.endsWith('/outcome/verified'))!;
    f.db.docs.delete(outcome);
    http.mockClear();
    const authorizeRead = jest.fn(async () => {
      throw new Error('ADMIN_REVOKED');
    });
    await expect(
      verifySermonDeletionDestinationCounts(f.db.asFirestore(), program.ref, 'private', { authorizeRead })
    ).rejects.toThrow('ADMIN_REVOKED');
    expect(authorizeRead).toHaveBeenCalledWith({
      provider: 'subsplash',
      account: 'app:9XTSHD',
      resourceType: 'list',
      resourceId: 'remote-root',
    });
    expect(http).not.toHaveBeenCalled();
    expect(f.db.docs.has(outcome)).toBe(false);
  });
});
