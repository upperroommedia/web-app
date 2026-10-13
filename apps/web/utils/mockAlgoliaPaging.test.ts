const mockRecords = Array.from({ length: 51 }, (_, index) => ({
  id: `sermon-${index}`,
  title: index === 50 ? 'Last page sermon' : 'Earlier sermon',
  speakers: [{ name: 'Speaker' }],
  status: { subsplash: 'NOT_UPLOADED', soundCloud: 'NOT_UPLOADED' },
}));
const mockReads = jest.fn(async (constraints: { after?: number; count?: number; field?: string }[]) => {
  const start = (constraints.find((constraint) => constraint.after !== undefined)?.after ?? -1) + 1;
  const count = constraints.find((constraint) => constraint.count !== undefined)?.count ?? mockRecords.length;
  const docs = mockRecords
    .slice(start, start + count)
    .map((record, index) => ({ offset: start + index, data: () => record }));
  return { docs, size: docs.length };
});
jest.mock('../firebase/firestore', () => ({
  __esModule: true,
  default: {},
  collection: () => ({ withConverter: () => ({}) }),
  query: (_ref: unknown, ...constraints: unknown[]) => constraints,
  getDocs: (constraints: Parameters<typeof mockReads>[0]) => mockReads(constraints),
  where: (field: string, _operation: string, value: unknown) => ({ field, value }),
  orderBy: (field: string) => ({ field }),
  limit: (count: number) => ({ count }),
  startAfter: (cursor: { offset: number }) => ({ after: cursor.offset }),
}));
import { createMockAlgoliaSearchClient } from './mockAlgoliaSearchClient';
beforeEach(() => mockReads.mockClear());
it('searches beyond the first bounded page without dropping later matches', async () => {
  const client = createMockAlgoliaSearchClient({ userId: 'owner', canSearchAllSermons: true });
  const response = await client.search({ requests: [{ indexName: 'sermons', query: 'Last page' }] });
  expect(response.results[0]).toMatchObject({ nbHits: 1, hits: [{ objectID: 'sermon-50' }] });
  expect(mockReads).toHaveBeenCalledTimes(2);
  expect(mockReads.mock.calls.every(([constraints]) => constraints.some((constraint) => constraint.count === 50))).toBe(
    true
  );
  expect(mockReads.mock.calls[1][0]).toContainEqual({ after: 49 });
});
it('retains the owner constraint on every page', async () => {
  await createMockAlgoliaSearchClient({ userId: 'owner', canSearchAllSermons: false }).search({
    requests: [{ indexName: 'sermons', query: '' }],
  });
  expect(
    mockReads.mock.calls.every(([constraints]) =>
      constraints.some(
        (constraint) => constraint.field === 'uploaderId' && 'value' in constraint && constraint.value === 'owner'
      )
    )
  ).toBe(true);
});
it('shares concurrent scans and refreshes data on a later independent search', async () => {
  const client = createMockAlgoliaSearchClient({ userId: 'owner', canSearchAllSermons: true });
  await Promise.all([
    client.search({ requests: [{ indexName: 'sermons', query: 'Last page' }] }),
    client.search({ requests: [{ indexName: 'sermons', query: 'Earlier' }] }),
  ]);
  expect(mockReads).toHaveBeenCalledTimes(2);
  await client.search({ requests: [{ indexName: 'sermons', query: '' }] });
  expect(mockReads).toHaveBeenCalledTimes(4);
});
