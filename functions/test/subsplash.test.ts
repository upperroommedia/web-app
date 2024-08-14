import { mockedAxios } from './jest.setup';
import { getListCount, removeNOldestItems, SubsplashListRow } from '../src/helpers/addToListHelpers';

describe('Subsplash Functions', () => {
  beforeEach(() => {
    (mockedAxios as unknown as typeof mockedAxios.request).mockImplementation((config) => {
      if (!config.url) {
        throw new Error(`Config had no url: ${config}`);
      }
      const url = new URL(config.url);
      const pathname = url.pathname;
      console.log(`mockedAxios called method: '${config.method}' with url`, url);
      if (config.method === 'DELETE' || config.method === 'delete') {
        return Promise.resolve();
      }

      if (config.method === 'GET' || config.method === 'get') {
        if (url.pathname.startsWith('/builder/v1/lists/')) {
          return Promise.resolve({ data: { list_rows_count: 10 } });
        } else if (url.pathname.startsWith('/builder/v1/list-rows')) {
          const subsplashListRows: SubsplashListRow[] = [];
          const pageSize = parseInt(url.searchParams.get('page[size]') || '100');
          const list = url.searchParams.get('filter[source_list]');
          for (let i = 0; i < pageSize; i++) {
            const subsplashListRow: SubsplashListRow = {
              id: `${list}-list-row-${i + 1}`,
              position: i + 1,
              created_at: '',
              updated_at: '',
              _embedded: {
                'media-item': {
                  id: `${list}-media-item-id-${i + 1}`,
                  title: `Media Item ${i + 1}`,
                },
              },
            };
            subsplashListRows.push(subsplashListRow);
          }
          return Promise.resolve({ data: { _embedded: { 'list-rows': subsplashListRows } } });
        }
      }
      throw new Error(`No mocked case for pathname ${pathname}`);
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('Get List Count', async () => {
    await getListCount('abc', 'token');
  });

  test('Remove 10 oldest Items', async () => {
    const n = 10;
    await removeNOldestItems(10, 'abc', 'token', 'created_at');
  });
});
