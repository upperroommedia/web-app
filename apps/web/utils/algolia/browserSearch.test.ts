const mockAlgolia = jest.fn(() => ({ search: jest.fn() }));
jest.mock('algoliasearch', () => ({ algoliasearch: (...args: unknown[]) => mockAlgolia(...args) }));

describe('browser search availability', () => {
  const original = { ...process.env };
  beforeEach(() => {
    jest.resetModules();
    mockAlgolia.mockClear();
  });
  afterEach(() => {
    process.env = { ...original };
  });
  test('staging disabled at build time cannot construct a vendor client even with inherited credentials', async () => {
    process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_ENABLED = 'false';
    process.env.NEXT_PUBLIC_ALGOLIA_APP_ID = 'dead-staging-app';
    process.env.NEXT_PUBLIC_ALGOLIA_API_KEY = 'staging-search-only-key';
    const policy = await import('./browserSearch');
    expect(policy.browserAlgoliaAppId).toBeNull();
    expect(policy.browserAlgoliaApiKey).toBeNull();
    expect(policy.createBrowserSearchClient()).toBeUndefined();
    expect(policy.browserSearchUnavailableMessage).toContain('staging');
    expect(mockAlgolia).not.toHaveBeenCalled();
  });
  test('production keeps its own configured search application', async () => {
    delete process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_ENABLED;
    process.env.NEXT_PUBLIC_ALGOLIA_APP_ID = 'production-app';
    process.env.NEXT_PUBLIC_ALGOLIA_API_KEY = 'production-search-only-key';
    expect((await import('./browserSearch')).createBrowserSearchClient()).toBeDefined();
    expect(mockAlgolia).toHaveBeenCalledWith('production-app', 'production-search-only-key');
  });
  test('missing credentials do not initialize a client or imply search is loading', async () => {
    delete process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_ENABLED;
    delete process.env.NEXT_PUBLIC_ALGOLIA_APP_ID;
    delete process.env.NEXT_PUBLIC_ALGOLIA_API_KEY;
    const policy = await import('./browserSearch');
    expect(policy.createBrowserSearchClient()).toBeUndefined();
    expect(policy.browserSearchUnavailableMessage).toContain('not configured');
    expect(mockAlgolia).not.toHaveBeenCalled();
  });
});
