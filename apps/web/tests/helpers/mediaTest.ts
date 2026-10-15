import { expect, test as base, type Page } from '@playwright/test';
import { installMediaBackendFixtures } from './mediaBackendFixture';
import { loginAsMediaBrowserAdmin } from './mediaBrowserLogin';

type Callback = '/' | '/admin/sermons';
type Prepared<T> = { callbackPath: Callback; data: T };
export type MediaPreparation<T> = (page: Page, usePrepared: (prepared: Prepared<T>) => Promise<void>) => Promise<void>;
type Runtime = {
  installBackend: (page: Page) => Promise<void>;
  login: (page: Page, callbackPath: Callback) => Promise<void>;
  ready: (page: Page, callbackPath: Callback) => Promise<void>;
};
const runtime: Runtime = {
  installBackend: installMediaBackendFixtures,
  login: loginAsMediaBrowserAdmin,
  ready: async (page, callbackPath) => {
    if (callbackPath === '/')
      await expect(page.getByRole('switch', { name: 'Upload from Youtube Url', exact: true })).toBeVisible();
    else await expect(page.getByRole('heading', { name: 'Sermons', exact: true })).toBeVisible();
  },
};

/** Preparation, real sign-in and route readiness share ONE bounded setup budget.
 * The test body keeps its existing functional timeout. Preparation owns resources
 * through usePrepared, so its finally also runs when authentication/body fails.
 * Runtime injection is only a process-fixture contract seam; media suites use the
 * real default backend routes and shipped Google authentication UI.
 */
export function createMediaTest<T>(prepare: MediaPreparation<T>, operations: Runtime = runtime) {
  return base.extend<{ authenticatedMedia: { page: Page; data: T } }>({
    authenticatedMedia: [
      async ({ page }, use) => {
        await operations.installBackend(page);
        let yielded = false;
        await prepare(page, async ({ callbackPath, data }) => {
          if (yielded) throw new Error('Media preparation must yield exactly once');
          yielded = true;
          await operations.login(page, callbackPath);
          await operations.ready(page, callbackPath);
          await use({ page, data });
        });
        if (!yielded) throw new Error('Media preparation did not yield an authenticated page');
      },
      { timeout: 10_000 },
    ],
  });
}
export const test = createMediaTest<void>(async (_page, usePrepared) => {
  await usePrepared({ callbackPath: '/', data: undefined });
});
export { expect };
