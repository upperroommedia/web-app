import { expect, test } from '@playwright/test';

test('production cold navigation loads protected page dependencies before redirecting safely to login', async ({
  page,
  baseURL,
}) => {
  test.skip(process.env.PLAYWRIGHT_PRODUCTION_SMOKE !== '1', 'Run against the compiled production server.');
  test.setTimeout(30_000);
  if (!baseURL) throw new Error('A local production server base URL is required.');
  const server = new URL(baseURL);
  if (!['localhost', '127.0.0.1'].includes(server.hostname)) {
    throw new Error('Production browser smoke tests require a local server.');
  }
  const errors: string[] = [];
  const detailChunks: number[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (/\/_next\/static\/chunks\/pages\/admin\/sermons\//.test(response.url())) {
      detailChunks.push(response.status());
    }
  });
  // This includes Firebase, Sentry and publishing providers. An empty browser
  // session can initialize and resolve as signed out without contacting them.
  await page.route('**/*', (route) => {
    return new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort();
  });
  await page.goto('/login');
  await expect(page.getByRole('button', { name: /google/i }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /dev login/i })).toHaveCount(0);
  await page.evaluate(() => {
    const next = 'next' in window ? window.next : undefined;
    if (!next || typeof next !== 'object' || !('router' in next))
      throw new Error('The production client router is unavailable');
    const router = next.router;
    if (!router || typeof router !== 'object' || !('push' in router) || typeof router.push !== 'function')
      throw new Error('The production client router cannot navigate');
    return router.push('/admin/sermons/pw-production-cold-navigation');
  });
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await expect(page.getByRole('button', { name: /google/i }).first()).toBeVisible();
  expect(detailChunks).toContain(200);
  expect(errors).toEqual([]);
});
