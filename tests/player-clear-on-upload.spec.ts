import { expect, test } from '@playwright/test';

async function loginAsDevAdmin(page: import('@playwright/test').Page, callbackPath = '/') {
  await page.goto(`/login?callbackurl=${encodeURIComponent(callbackPath)}`);
  const devLoginButton = page.getByRole('button', { name: /Dev Login/i });
  await expect(devLoginButton).toBeVisible();
  await devLoginButton.click();
  await page.waitForURL(/^(?!.*\/login)/);
}

test.describe('Player clear on upload / edit routes', () => {
  test('bottom audio bar is not shown on upload page', async ({ page }) => {
    await loginAsDevAdmin(page, '/');
    await expect(page.getByLabel('Upload from Youtube Url toggle')).toBeVisible();
    await expect(page.getByTestId('floating-audio-bar')).toHaveCount(0);
  });

  test('navigating to upload clears player when a sermon was playing', async ({ page }) => {
    await loginAsDevAdmin(page, '/admin/sermons');
    await page.waitForURL(/\/admin\/sermons$/);

    const playButton = page.getByRole('button', { name: /toggle play\/pause/i }).first();
    if ((await playButton.count()) === 0) {
      test.skip();
      return;
    }
    await playButton.click();

    await expect(page.getByTestId('floating-audio-bar')).toBeVisible({ timeout: 6000 });

    await page.goto('/');
    await page.waitForURL(/\/(\?|$)/);

    await expect(page.getByTestId('floating-audio-bar')).toHaveCount(0);
  });
});
