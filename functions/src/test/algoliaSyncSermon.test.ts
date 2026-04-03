jest.mock('algoliasearch', () => ({
  algoliasearch: jest.fn(),
}));

import { algoliasearch } from 'algoliasearch';
import { waitForSermonToReachAlgolia } from '../algoliaSyncSermon';

const mockedAlgoliaSearch = jest.mocked(algoliasearch);

describe('waitForSermonToReachAlgolia', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALGOLIA_APP_ID = 'test-app';
    process.env.ALGOLIA_SEARCH_API_KEY = 'test-key';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.useRealTimers();
  });

  it('returns true when Algolia already has the latest sermon version', async () => {
    mockedAlgoliaSearch.mockReturnValue({
      getObject: jest.fn().mockResolvedValue({
        objectID: 'sermon-1',
        editedAtMillis: 123,
      }),
    } as never);

    await expect(
      waitForSermonToReachAlgolia({
        sermonId: 'sermon-1',
        editedAtMillis: 123,
      })
    ).resolves.toBe(true);
  });

  it('returns false when Algolia credentials are unavailable', async () => {
    delete process.env.ALGOLIA_APP_ID;
    delete process.env.ALGOLIA_SEARCH_API_KEY;
    delete process.env.NEXT_PUBLIC_ALGOLIA_APP_ID;
    delete process.env.NEXT_PUBLIC_ALGOLIA_API_KEY;

    await expect(
      waitForSermonToReachAlgolia({
        sermonId: 'sermon-1',
        editedAtMillis: 123,
      })
    ).resolves.toBe(false);

    expect(mockedAlgoliaSearch).not.toHaveBeenCalled();
  });

  it('retries until the latest sermon version appears in Algolia', async () => {
    jest.useFakeTimers();

    const getObject = jest
      .fn()
      .mockResolvedValueOnce({
        objectID: 'sermon-1',
        editedAtMillis: 100,
      })
      .mockResolvedValueOnce({
        objectID: 'sermon-1',
        editedAtMillis: 123,
      });

    mockedAlgoliaSearch.mockReturnValue({ getObject } as never);

    const waitPromise = waitForSermonToReachAlgolia({
      sermonId: 'sermon-1',
      editedAtMillis: 123,
    });

    await jest.advanceTimersByTimeAsync(1500);

    await expect(waitPromise).resolves.toBe(true);
    expect(getObject).toHaveBeenCalledTimes(2);
  });
});
