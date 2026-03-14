import { expect, test } from '@playwright/test';
import { seedPlayableSermon } from './helpers/seedPlayableSermon';

async function loginAsDevAdmin(page: import('@playwright/test').Page, callbackPath = '/') {
  await page.goto(`/login?callbackurl=${encodeURIComponent(callbackPath)}`);
  const devLoginButton = page.getByRole('button', { name: /Dev Login/i });
  await expect(devLoginButton).toBeVisible();
  await devLoginButton.click();
  await page.waitForURL(/^(?!.*\/login)/);
}

async function playSermonFromSearch(page: import('@playwright/test').Page, sermonTitle: string) {
  const searchBox = page.getByRole('searchbox').first();
  await expect(searchBox).toBeVisible();
  await searchBox.fill(sermonTitle);
  await expect(page.getByText(sermonTitle)).toBeVisible({ timeout: 10_000 });

  const playButton = page.locator('button:has([data-testid="PlayArrowIcon"])').first();
  await expect(playButton).toBeVisible();
  await playButton.click();
}

test.describe('Player clear on upload / edit routes', () => {
  test('bottom audio bar is not shown on upload page', async ({ page }) => {
    await loginAsDevAdmin(page, '/');
    await expect(page.getByLabel('Upload from Youtube Url toggle')).toBeVisible();
    await expect(page.getByTestId('floating-audio-bar')).toHaveCount(0);
  });

  test('navigating to upload clears player when a sermon was playing', async ({ page }) => {
    const seededSermon = await seedPlayableSermon();
    try {
      await loginAsDevAdmin(page, '/admin/sermons');
      await page.waitForURL(/\/admin\/sermons$/);

      await playSermonFromSearch(page, seededSermon.title);

      await expect(page.getByTestId('floating-audio-bar')).toBeVisible({ timeout: 6000 });

      await page.goto('/');
      await page.waitForURL(/\/(\?|$)/);

      await expect(page.getByTestId('floating-audio-bar')).toHaveCount(0);
    } finally {
      await seededSermon.cleanup();
    }
  });
});
