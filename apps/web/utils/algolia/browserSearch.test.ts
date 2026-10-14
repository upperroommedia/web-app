import { readFileSync } from 'fs';
import { join } from 'path';

describe('browser search configuration', () => {
  const original = { ...process.env };
  beforeEach(() => jest.resetModules());
  afterEach(() => {
    process.env = { ...original };
  });
  test('disabling search hides even an inherited application ID', async () => {
    process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_ENABLED = 'false';
    process.env.NEXT_PUBLIC_ALGOLIA_APP_ID = 'disabled-app';
    const policy = await import('./browserSearch');
    expect(policy.browserAlgoliaAppId).toBeNull();
    expect(policy.browserSearchUnavailableMessage).toContain('staging');
  });
  test('enabled search publishes only the application ID', async () => {
    delete process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_ENABLED;
    process.env.NEXT_PUBLIC_ALGOLIA_APP_ID = 'staging-app';
    expect((await import('./browserSearch')).browserAlgoliaAppId).toBe('staging-app');
  });
  test('browser modules never read parent credentials or construct selector clients', () => {
    const web = join(__dirname, '../..');
    for (const path of [
      'utils/algolia/browserSearch.ts',
      'context/search/AlgoliaSearchContext.tsx',
      'components/ListSelector.tsx',
      'components/ImageSelector.tsx',
      'components/uploaderComponents/SpeakerSelector.tsx',
    ]) {
      const source = readFileSync(join(web, path), 'utf8');
      expect(source).not.toMatch(/process\.env\.(?:NEXT_PUBLIC_)?ALGOLIA_(?:API_KEY|SEARCH_API_KEY|ADMIN_API_KEY)/);
      expect(source).not.toContain('createBrowserSearchClient');
    }
  });
});
