const mockGetDocs = jest.fn();
jest.mock('../../firebase/firestore', () => ({
  __esModule: true,
  default: {},
  collection: (_db: unknown, name: string) => ({ withConverter: () => name }),
  query: (collection: string, ...constraints: unknown[]) => ({ collection, constraints }),
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
  limit: (value: number) => ({ limit: value }),
  orderBy: (field: string, direction?: string) => ({ field, direction }),
  where: (field: string, operation: string, value: string) => ({ field, operation, value }),
  startAfter: (cursor: unknown) => ({ cursor }),
}));
import { browseLists, browseSpeakers, BROWSE_PAGE_SIZE } from './browseRecords';

const page = (items: Array<Record<string, unknown>>) => ({
  size: items.length,
  docs: items.map((item) => ({ id: item.id, data: () => item })),
});
beforeEach(() => mockGetDocs.mockReset());
test('speaker browsing bounds each real Firestore request and resumes after the exact cursor', async () => {
  const rows = Array.from({ length: BROWSE_PAGE_SIZE }, (_, i) => ({ id: String(i), name: `Speaker ${i}` }));
  mockGetDocs.mockResolvedValueOnce(page(rows)).mockResolvedValueOnce(page([{ id: 'last', name: 'Last' }]));
  const first = await browseSpeakers();
  expect(first.items).toHaveLength(25);
  expect(first.hasMore).toBe(true);
  const next = await browseSpeakers(first.cursor);
  expect(next.hasMore).toBe(false);
  expect(mockGetDocs.mock.calls[1][0]).toEqual({
    collection: 'speakers',
    constraints: [{ field: 'name' }, { limit: 25 }, { cursor: first.cursor }],
  });
});
test('a full physical overflow page advances list browsing without scanning the whole collection', async () => {
  mockGetDocs.mockResolvedValueOnce(
    page(Array.from({ length: 25 }, (_, i) => ({ id: String(i), isMoreSermonsList: true })))
  );
  const first = await browseLists('series');
  expect(first.items).toEqual([]);
  expect(first.hasMore).toBe(true);
  expect(first.cursor).toBeDefined();
  expect(mockGetDocs).toHaveBeenCalledTimes(1);
  expect(mockGetDocs.mock.calls[0][0].constraints).toContainEqual({ field: 'type', operation: '==', value: 'series' });
});
test('browsing keeps discoverable roots and propagates failures so the UI can offer retry', async () => {
  mockGetDocs.mockResolvedValueOnce(
    page([
      { id: 'root', isRootList: true },
      { id: 'overflow', isRootList: false },
    ])
  );
  expect((await browseLists()).items.map((item) => item.id)).toEqual(['root']);
  mockGetDocs.mockRejectedValueOnce(new Error('Unavailable'));
  await expect(browseSpeakers()).rejects.toThrow('Unavailable');
});
