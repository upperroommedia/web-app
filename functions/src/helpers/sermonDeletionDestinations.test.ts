jest.mock('axios', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../subsplashUtils', () => ({
  createAxiosConfig: (url: string, _token: string, method: string, data: unknown) => ({ url, method, data }),
}));
import axios from 'axios';
import {
  deletionLogicalContentCount,
  fixedSermonListRowRemoval,
  originalSermonDeletionDestinationCountWrites,
  executeFrozenSermonDeletionDestinationRequest,
  type SermonDeletionDestinationNode,
} from './sermonDeletionDestinations';
import {
  runDurablePublishingOperation,
  beginProviderMutationPlan,
} from '../temporal/publishing/durableOperationContext';
const row = (rowId: string, listId = 'overflow', mediaId = 'media') => ({
  id: rowId,
  app_key: '9XTSHD',
  type: 'media-item',
  method: 'static',
  position: 1,
  _embedded: { 'source-list': { id: listId }, 'media-item': { id: mediaId } },
});
const operation = 'durable:project:job:sermon:provider-delete:delete';
const http = jest.mocked(axios);
const run = async <T>(task: () => Promise<T>, cached = false) =>
  runDurablePublishingOperation(
    'job',
    async () => {
      await beginProviderMutationPlan({ operation, resources: [] });
      return task();
    },
    undefined,
    {
      beginProviderMutationPlan: async () => {},
      runPublishingProviderMutation: async (request) =>
        cached
          ? (undefined as never)
          : (await request.send()).completion === 'acknowledged'
          ? (undefined as never)
          : Promise.reject(new Error('REJECTED')),
    }
  );
beforeEach(() => http.mockReset());

test('freezes exact physical overflow row target and never deletes the logical root row', () => {
  const original = row('fixed-row');
  const request = fixedSermonListRowRemoval('overflow', original, 'media');
  expect(request.target).toMatchObject({ resourceType: 'list-row', resourceId: 'fixed-row' });
  expect(request.payload).toEqual({ id: 'fixed-row', listId: 'overflow' });
  expect(original).toEqual(row('fixed-row'));
});
test.each([
  { ...row('fixed-row'), app_key: 'foreign' },
  row('fixed-row', 'foreign-list'),
  row('fixed-row', 'overflow', 'foreign-media'),
  { ...row('fixed-row'), method: 'most_recent' },
])('rejects foreign or dynamic placement without issuing provider HTTP: %j', (original) => {
  expect(() => fixedSermonListRowRemoval('overflow', original, 'media')).toThrow('PROOF_INVALID');
  expect(http).not.toHaveBeenCalled();
});
test('counts continuation only when the final row links the exact next overflow page', () => {
  const link = { id: 'more', type: 'list', _embedded: { list: { id: 'next' } } };
  expect(deletionLogicalContentCount([row('remaining'), link], 'next')).toBe(1);
  expect(deletionLogicalContentCount([link, row('remaining')], 'next')).toBe(2);
  expect(deletionLogicalContentCount([row('remaining'), link], 'foreign')).toBe(2);
});
test('projects truthful physical and logical counts across pages, preserving input canonical captures', () => {
  const nodes: SermonDeletionDestinationNode[] = [
    {
      path: 'lists/root',
      rootPath: 'lists/root',
      listId: 'remote-root',
      nextListId: 'remote-overflow',
      sourceDigest: 'original',
      remainingDigest: 'rows',
      count: 199,
      removedRowIds: [],
    },
    {
      path: 'lists/overflow',
      rootPath: 'lists/root',
      listId: 'remote-overflow',
      sourceDigest: 'original',
      remainingDigest: 'rows',
      count: 31,
      removedRowIds: ['removed'],
    },
  ];
  const before = JSON.stringify(nodes);
  expect(
    originalSermonDeletionDestinationCountWrites(nodes, {
      path: 'series/original',
      seriesId: 'remote-series',
      sourceDigest: 'series',
      remainingDigest: 'remaining',
      publishedCount: 3,
      subtitle: '3 part series',
    })
  ).toEqual([
    { path: 'lists/root', expectedFields: { subsplashId: 'remote-root' }, patch: { count: 199, logicalCount: 230 } },
    { path: 'lists/overflow', expectedFields: { subsplashId: 'remote-overflow' }, patch: { count: 31 } },
    {
      path: 'series/original',
      expectedFields: { subsplashId: 'remote-series' },
      patch: { publishedItemCount: 3, subtitle: '3 part series' },
    },
  ]);
  expect(JSON.stringify(nodes)).toBe(before);
});
test.each([200, 204])(
  'accepts original synchronous row DELETE %i with one fixed request and no redirect/retry',
  async (status) => {
    http.mockResolvedValueOnce({ status, data: {} });
    await run(() =>
      executeFrozenSermonDeletionDestinationRequest(
        operation,
        fixedSermonListRowRemoval('overflow', row('fixed-row'), 'media'),
        'private-token'
      )
    );
    expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0][0]).toMatchObject({
      url: 'https://core.subsplash.com/builder/v1/list-rows/fixed-row',
      method: 'DELETE',
      maxRedirects: 0,
      skipSubsplashEdgeRetry: true,
    });
  }
);
test.each([202, 307, 308])('keeps uncertain response %i unresolved without HTTP replay', async (status) => {
  http.mockResolvedValueOnce({ status, data: {} });
  await expect(
    run(() =>
      executeFrozenSermonDeletionDestinationRequest(
        operation,
        fixedSermonListRowRemoval('overflow', row('fixed-row'), 'media'),
        'private-token'
      )
    )
  ).rejects.toThrow();
  expect(http).toHaveBeenCalledTimes(1);
});
test('cached original ACK does not GET an already deleted row or resend DELETE', async () => {
  await run(
    () =>
      executeFrozenSermonDeletionDestinationRequest(
        operation,
        fixedSermonListRowRemoval('overflow', row('fixed-row'), 'media'),
        'private-token'
      ),
    true
  );
  expect(http).not.toHaveBeenCalled();
});
test('404 absence alone is not an original mutation completion', async () => {
  http.mockRejectedValueOnce(Object.assign(new Error('not found'), { response: { status: 404 } }));
  await expect(
    run(() =>
      executeFrozenSermonDeletionDestinationRequest(
        operation,
        fixedSermonListRowRemoval('overflow', row('fixed-row'), 'media'),
        'private-token'
      )
    )
  ).rejects.toThrow('not found');
  expect(http).toHaveBeenCalledTimes(1);
});
