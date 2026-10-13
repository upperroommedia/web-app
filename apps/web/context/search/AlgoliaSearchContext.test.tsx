const mockVendor = jest.fn();
jest.mock('algoliasearch', () => ({ algoliasearch: (...args: unknown[]) => mockVendor(...args) }));
jest.mock('../../utils/mockAlgoliaSearchClient', () => ({ createMockAlgoliaSearchClient: jest.fn() }));
jest.mock('../../firebase/firebase', () => ({ isDevelopment: false }));
jest.mock('../../utils/createFunction', () => ({ createFunction: jest.fn() }));
jest.mock('../user/UserContext', () => ({
  __esModule: true,
  default: () => ({ user: { uid: 'uploader', isAdmin: () => false, canUpload: () => true } }),
}));

test('disabled staging search renders an unavailable state from the first render without a vendor client or loading spinner', async () => {
  const env = { ...process.env };
  try {
    process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_ENABLED = 'false';
    process.env.NEXT_PUBLIC_ALGOLIA_APP_ID = 'dead-staging-app';
    process.env.NEXT_PUBLIC_ALGOLIA_API_KEY = 'staging-key';
    jest.resetModules();
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { AlgoliaSearchProvider, useAlgoliaSearch } = await import('./AlgoliaSearchContext');
    const State = () => {
      const state = useAlgoliaSearch();
      return React.createElement(
        'output',
        null,
        JSON.stringify({ error: state.error, loading: state.loading, client: state.searchClient })
      );
    };
    const html = renderToStaticMarkup(
      React.createElement(AlgoliaSearchProvider, null, React.createElement(State))
    );
    expect(html).toContain('Search is temporarily unavailable in staging');
    expect(html).toContain('&quot;loading&quot;:false');
    expect(html).toContain('&quot;client&quot;:null');
    expect(mockVendor).not.toHaveBeenCalled();
  } finally {
    process.env = env;
  }
});
