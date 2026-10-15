import { expect, test as base, type BrowserContext } from '@playwright/test';
import { installMediaBackendFixtures } from './mediaBackendFixture';
import { assertMediaBrowserLoginEnvironment, loginAsMediaBrowserAdmin } from './mediaBrowserLogin';

type MediaStorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

// BundleManager's six catalog caches must start cold in every independent test.
const catalogPrefixes = ['topic', 'subtitle', 'bible-chapter', 'sunday-homily', 'holy-week', 'latest-list'];
const catalogKeys = new Set(catalogPrefixes.flatMap((prefix) => [`${prefix}-bundle-timestamp`, `cached-${prefix}`]));
export function withoutMediaCatalogCache(state: MediaStorageState): MediaStorageState {
  return {
    ...state,
    origins: state.origins.map((origin) =>
      origin.origin !== 'http://127.0.0.1:3004'
        ? origin
        : {
            ...origin,
            localStorage: origin.localStorage.filter((entry) => !catalogKeys.has(entry.name)),
          }
    ),
  };
}

/** One real UI login per serial worker; credentials never leave process memory. */
export const mediaAuthenticatedTest = base.extend<{}, { mediaWorkerStorageState: MediaStorageState }>({
  mediaWorkerStorageState: [
    async ({ browser }, use, workerInfo) => {
      assertMediaBrowserLoginEnvironment(process.env, '/');
      if (workerInfo.config.workers !== 1 || workerInfo.parallelIndex !== 0)
        throw new Error('Media browser authentication requires one serial worker');
      const started = performance.now();
      const context = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL, storageState: undefined });
      let state: MediaStorageState;
      let authenticated = false;
      try {
        const page = await context.newPage();
        await installMediaBackendFixtures(page);
        await loginAsMediaBrowserAdmin(page, '/');
        await expect(page.getByRole('switch', { name: 'Upload from Youtube Url', exact: true })).toBeVisible();
        state = withoutMediaCatalogCache(await context.storageState({ indexedDB: true }));
        authenticated = true;
        console.info(`[media-auth] real UI login completed in ${Math.round(performance.now() - started)}ms`);
      } finally {
        await context.close();
        if (!authenticated)
          console.info(`[media-auth] real UI login failed after ${Math.round(performance.now() - started)}ms`);
      }
      await use(state);
    },
    { scope: 'worker', timeout: 30_000 },
  ],
  // Playwright creates a fresh context for every test from this in-memory state.
  storageState: async ({ mediaWorkerStorageState }, use) => {
    assertMediaBrowserLoginEnvironment(process.env, '/');
    await use(mediaWorkerStorageState);
  },
});
