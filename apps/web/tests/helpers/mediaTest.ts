import { expect, test as base, type Page } from '@playwright/test';
import { installMediaBackendFixtures } from './mediaBackendFixture';
import { assertMediaBrowserLoginEnvironment } from './mediaBrowserLogin';
import { mediaAuthenticatedTest } from './mediaAuthenticatedTest';

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
  login: async (page, callbackPath) => {
    assertMediaBrowserLoginEnvironment(process.env, callbackPath);
    await page.goto(callbackPath);
  },
  ready: async (page, callbackPath) => {
    if (callbackPath === '/')
      await expect(page.getByRole('switch', { name: 'Upload from Youtube Url', exact: true })).toBeVisible();
    else {
      await expect(page.getByRole('heading', { name: 'Sermons', exact: true })).toBeVisible();
      await expect(page.getByRole('searchbox').first()).toBeVisible();
    }
  },
};

/** Each fresh authenticated context prepares its own routes and data, then navigates
 * within ONE bounded setup budget. Real UI login has a separate worker budget;
 * the functional body keeps its original timeout. Injected Runtime contracts use
 * the plain base runner and never start the real browser authentication fixture.
 */
export function createMediaTest<T>(prepare: MediaPreparation<T>, operations?: Runtime) {
  const testBase = operations ? base : mediaAuthenticatedTest;
  const setup = operations ?? runtime;
  return testBase.extend<{ authenticatedMedia: { page: Page; data: T } }>({
    authenticatedMedia: [
      async ({ page }, use) => {
        if (!operations) assertMediaBrowserLoginEnvironment(process.env, '/');
        await setup.installBackend(page);
        let yielded = false;
        await prepare(page, async ({ callbackPath, data }) => {
          if (yielded) throw new Error('Media preparation must yield exactly once');
          yielded = true;
          await setup.login(page, callbackPath);
          await setup.ready(page, callbackPath);
          await use({ page, data });
        });
        if (!yielded) throw new Error('Media preparation did not yield an authenticated page');
      },
      { timeout: 30_000 },
    ],
  });
}
export const test = createMediaTest<void>(async (_page, usePrepared) => {
  await usePrepared({ callbackPath: '/', data: undefined });
});
export { expect };
