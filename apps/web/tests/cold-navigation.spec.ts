import { expect, test } from '@playwright/test';
import { seedPlayableSermon } from './helpers/seedPlayableSermon';

for (const interceptNetwork of [false, true]) {
  test(`cold authenticated navigation renders publishing controls (routing=${interceptNetwork})`, async ({ page }) => {
    test.setTimeout(60_000);
    const sermon = await seedPlayableSermon();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      if (interceptNetwork) {
        // Routing disables the HTTP cache in Playwright. Exercise this supported
        // browser mode without changing any application's network responses.
        await page.route('**/*', (route) => route.continue());
      }
      const target = `/admin/sermons/${sermon.id}`;
      await page.goto(`/login?callbackurl=${encodeURIComponent(target)}`);
      await page.getByRole('button', { name: /Dev Login/i }).click();
      await expect(page).toHaveURL(new RegExp(`/admin/sermons/${sermon.id}$`));
      await expect(page.getByRole('button', { name: 'Publish everywhere', exact: true })).toBeVisible();
      expect(
        errors.filter((error) => /module factory is not available|Multiple Sentry Session Replay/i.test(error))
      ).toEqual([]);
    } finally {
      await sermon.cleanup();
    }
  });
}
