import type { Firestore, Transaction } from 'firebase-admin/firestore';
let mockDb: Firestore;
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: () => mockDb, app: () => ({ options: { projectId: 'test-project' } }) },
}));
jest.mock('../../subsplashUtils', () => ({
  createAxiosConfig: (url: string, _token: string, method: string, data?: unknown) => ({ url, method, data }),
}));
jest.mock('../../temporal/publishing/providerAssociations', () => ({
  reserveSubsplashAssociation: jest.fn(async () => {}),
}));
jest.mock('axios', () => ({ __esModule: true, default: jest.fn() }));
import axios from 'axios';
import * as context from '../../temporal/publishing/durableOperationContext';
import type { PublishingAcknowledgedProjectionPlan } from '../../temporal/publishing/durableOperationContext';
import { patchListRows, deleteListRow, runWithListProjectionProgram } from '../../helpers/addToListHelpers';
import type { SubsplashListRow } from '../../types/Subsplash';
const row: SubsplashListRow = {
  id: 'new-row',
  type: 'media-item',
  method: 'static',
  position: 1,
  app_key: '9XTSHD',
  _embedded: { 'source-list': { id: 'remote' }, 'media-item': { id: 'media' } },
};
function fixture() {
  const records = new Map<string, Record<string, unknown>>([
    ['lists/root', { id: 'root', subsplashId: 'remote', count: 0, logicalCount: 0, name: 'Root' }],
    ['sermons/sermon', { id: 'sermon', subsplashId: 'media', title: 'Sermon' }],
  ]);
  const events: string[] = [],
    plans: PublishingAcknowledgedProjectionPlan[] = [];
  let actorActive = true;
  const getField = (data: unknown, path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>(
        (value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined),
        data
      );
  const setField = (data: Record<string, unknown>, path: string, value: unknown) => {
    const parts = path.split('.');
    let parent = data;
    for (const part of parts.slice(0, -1)) {
      parent[part] = { ...((parent[part] as Record<string, unknown>) ?? {}) };
      parent = parent[part] as Record<string, unknown>;
    }
    parent[parts[parts.length - 1]] = value;
  };
  const doc = (path: string): any => ({
    kind: 'doc',
    path,
    id: path.split('/').pop(),
    collection: (child: string) => query(`${path}/${child}`),
  });
  const snapshot = (path: string): any => ({
    id: path.split('/').pop(),
    ref: doc(path),
    exists: records.has(path),
    data: () => records.get(path),
    get: (field: string) => getField(records.get(path), field),
  });
  const query = (path: string, filters: Array<[string, string, unknown]> = []): any => ({
    kind: 'query',
    path,
    filters,
    doc: (id: string) => doc(`${path}/${id}`),
    where: (field: string, operator: string, value: unknown) => query(path, [...filters, [field, operator, value]]),
    limit: () => query(path, filters),
  });
  const tx = {
    get: async (target: any) => {
      events.push('read');
      if (target.kind === 'doc') return snapshot(target.path);
      const docs = [...records.entries()]
        .filter(
          ([p, data]) =>
            p.startsWith(`${target.path}/`) &&
            p.slice(target.path.length + 1).split('/').length === 1 &&
            target.filters.every(([field, op, value]: [string, string, unknown]) =>
              op === 'in' ? (value as unknown[]).includes(getField(data, field)) : getField(data, field) === value
            )
        )
        .map(([p]) => snapshot(p));
      return { docs, size: docs.length };
    },
    getAll: async (...refs: any[]) => refs.map((reference) => snapshot(reference.path)),
    set: (reference: any, data: Record<string, unknown>) => {
      events.push('write');
      records.set(reference.path, data);
    },
    update: (reference: any, patch: Record<string, unknown>) => {
      events.push('write');
      const data = { ...records.get(reference.path) };
      for (const [field, value] of Object.entries(patch)) setField(data, field, value);
      records.set(reference.path, data);
    },
  } as unknown as Transaction;
  mockDb = {
    collection: (path: string) => query(path),
    doc,
    runTransaction: async (mutate: (transaction: Transaction) => Promise<unknown>) => mutate(tx),
  } as unknown as Firestore;
  const run = async (operation: () => Promise<unknown>) =>
    context.runDurablePublishingOperation(
      'job',
      async () => {
        await context.beginProviderMutationPlan({
          operation: 'lists',
          resources: [{ provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'list', resourceId: 'remote' }],
        });
        return operation();
      },
      async (mutate) => {
        if (!actorActive) throw new Error('ACTOR_REVOKED');
        await mutate(tx);
      },
      {
        beginProviderMutationPlan: async () => {},
        prepareAcknowledgedProjectionPlan: async (_transaction, plan) => {
          events.push('freeze');
          return {
            projectionDigest: 'digest',
            commit: () => {
              plans.push(plan);
              events.push('frozen');
            },
          };
        },
        runPublishingProviderMutation: async (request) => {
          events.push('claim');
          const completion = await request.send();
          if (completion.completion !== 'acknowledged') throw new Error('unknown');
          events.push('ack');
          return completion.result;
        },
      }
    );
  return {
    records,
    events,
    plans,
    run,
    revoke: () => {
      actorActive = false;
    },
  };
}
beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(context, 'markPublishingCritical').mockResolvedValue(undefined);
  (axios as unknown as jest.Mock).mockReset();
});
test('source freezes exact list PATCH and typed row programs before HTTP, then commits canonical prefix', async () => {
  const f = fixture();
  (axios as unknown as jest.Mock).mockImplementation(async (config: { method: string }) => {
    if (config.method === 'GET') return { data: { id: 'remote', _embedded: { images: [] } } };
    f.events.push('http');
    return { status: 200, data: { _embedded: { 'list-rows': [row] } } };
  });
  await f.run(() => patchListRows('remote', [{ ...row, id: undefined }], 'token'));
  expect(f.events.indexOf('frozen')).toBeLessThan(f.events.indexOf('http'));
  expect(f.plans[0].completesActivity).toBe(false);
  expect(f.plans[0].requests[0].target).toMatchObject({ resourceType: 'list', resourceId: 'remote' });
  const projection = f.plans[0].writes.find((write) => write.path === 'lists/root/listItems/sermon')!;
  expect(projection.listRowBindings?.map((binding) => binding.field)).toContain('physicalPlacement.listItemId');
  expect((f.records.get('lists/root/listItems/sermon')!.physicalPlacement as { listItemId: string }).listItemId).toBe(
    'new-row'
  );
  expect((f.records.get('sermons/sermon/sermonLists/root')!.uploadStatus as { listItemId: string }).listItemId).toBe(
    'new-row'
  );
  expect(f.records.get('lists/root')!.count).toBe(1);
  const mutation = (axios as unknown as jest.Mock).mock.calls.find(([config]) => config.method === 'PATCH')![0];
  expect(mutation.maxRedirects).toBe(0);
});
test('actor loss after original ACK retains frozen program and does not project or retry', async () => {
  const f = fixture();
  let posts = 0;
  (axios as unknown as jest.Mock).mockImplementation(async (config: { method: string }) => {
    if (config.method === 'GET') return { data: { id: 'remote', _embedded: { images: [] } } };
    posts++;
    f.revoke();
    return { status: 200, data: { _embedded: { 'list-rows': [row] } } };
  });
  await expect(f.run(() => patchListRows('remote', [{ ...row, id: undefined }], 'token'))).rejects.toThrow(
    'ACTOR_REVOKED'
  );
  expect(posts).toBe(1);
  expect(f.events).toContain('ack');
  expect(f.plans).toHaveLength(1);
  expect(f.records.get('lists/root')!.count).toBe(0);
  expect(f.records.has('lists/root/listItems/sermon')).toBe(false);
});
test('lost PATCH response leaves desired frozen truth and sends exactly once', async () => {
  const f = fixture();
  let posts = 0;
  (axios as unknown as jest.Mock).mockImplementation(async (config: { method: string }) => {
    if (config.method === 'GET') return { data: { id: 'remote', _embedded: { images: [] } } };
    posts++;
    throw new Error('lost response');
  });
  await expect(f.run(() => patchListRows('remote', [row], 'token'))).rejects.toThrow('lost response');
  expect(posts).toBe(1);
  expect(f.plans).toHaveLength(1);
  expect(f.events).not.toContain('ack');
  expect(f.records.get('lists/root')!.count).toBe(0);
});
test('DELETE freezes authoritative parent hint and absent target proof before mutation', async () => {
  const f = fixture();
  (axios as unknown as jest.Mock).mockImplementation(async (config: { method: string }) =>
    config.method === 'GET' ? { data: { _embedded: { 'list-rows': [row] } } } : { status: 204 }
  );
  await f.run(() => deleteListRow('new-row', 'remote', 'token'));
  const plan = f.plans[0];
  expect(plan.requests[0].payload).toEqual({ id: 'new-row', listId: 'remote' });
  expect(plan.verifications.find((v) => v.resourceType === 'list-row')?.expectedState).toBe('absent');
  expect((axios as unknown as jest.Mock).mock.calls.filter(([config]) => config.method === 'DELETE')).toHaveLength(1);
});
test('new overflow routing is frozen before root PATCH and continuation is excluded from content count', async () => {
  const f = fixture();
  const link: SubsplashListRow = {
    id: 'link',
    type: 'list',
    method: 'static',
    position: 2,
    app_key: '9XTSHD',
    _embedded: { 'source-list': { id: 'remote' }, list: { id: 'child-remote' } },
  };
  (axios as unknown as jest.Mock).mockImplementation(async (config: { method: string }) =>
    config.method === 'GET'
      ? { data: { id: 'remote', _embedded: { images: [] } } }
      : { status: 200, data: { _embedded: { 'list-rows': [row, link] } } }
  );
  await f.run(() =>
    patchListRows('remote', [row, link], 'token', {
      continuationListId: 'child-remote',
      pendingCanonicalWrites: [
        {
          path: 'lists/child',
          data: { id: 'child', rootListId: 'root', subsplashId: 'child-remote', count: 0, overflowDepth: 1 },
        },
        {
          path: 'lists/root',
          data: { moreSermonsRef: 'child-remote', hasOverflowPages: true, logicalCount: 999 },
          merge: true,
        },
      ],
    })
  );
  expect(f.plans[0].writes.find((write) => write.path === 'lists/child')).toMatchObject({
    mode: 'set',
    expectedExists: false,
    patch: { rootListId: 'root', subsplashId: 'child-remote' },
  });
  expect(f.records.get('lists/root')).toMatchObject({ count: 1, logicalCount: 1, moreSermonsRef: 'child-remote' });
  expect(f.records.get('lists/child')).toMatchObject({ rootListId: 'root', subsplashId: 'child-remote' });
});
test('trusted parent hook freezes final desired writes before claim and defers their normal execution', async () => {
  const f = fixture();
  (axios as unknown as jest.Mock).mockImplementation(async (config: { method: string }) =>
    config.method === 'GET'
      ? { data: { id: 'remote', _embedded: { images: [] } } }
      : { status: 200, data: { _embedded: { 'list-rows': [row] } } }
  );
  await f.run(() =>
    runWithListProjectionProgram(
      async (_tx, prepared) => {
        expect(prepared.target).toMatchObject({ resourceType: 'list', resourceId: 'remote' });
        return [
          {
            path: 'lists/root',
            expectedFields: { subsplashId: 'remote' },
            requiredSteps: [prepared.step],
            patch: { name: 'Parent final intent' },
          },
        ];
      },
      () => patchListRows('remote', [row], 'token')
    )
  );
  expect(f.plans[0].writes.some((write) => write.patch.name === 'Parent final intent')).toBe(true);
  expect(f.records.get('lists/root')!.name).toBe('Root');
});
