import { expect, test } from '@playwright/test';
import { seedPlayableSermon } from './helpers/seedPlayableSermon';

async function loginAsDevAdmin(page: import('@playwright/test').Page) {
  await page.goto('/login?callbackurl=/');
  const devLoginButton = page.getByRole('button', { name: /Dev Login/i });
  await expect(devLoginButton).toBeVisible();
  await devLoginButton.click();
  await expect(page.getByLabel('Upload from Youtube Url toggle')).toBeVisible();
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

test.describe('Audio player (floating bar)', () => {
  test.setTimeout(30_000);

  test('player visible and main content has bottom padding when playing on admin sermons', async ({
    page,
  }) => {
    const seededSermon = await seedPlayableSermon();
    try {
      await loginAsDevAdmin(page);
      await page.goto('/admin/sermons');

      await expect(page.getByRole('heading', { name: 'Sermons' })).toBeVisible({
        timeout: 15_000,
      });

      await playSermonFromSearch(page, seededSermon.title);

      await expect(page.getByTestId('floating-audio-bar')).toBeVisible({ timeout: 10_000 });

      const mainScroll = page.getByTestId('main-content-scroll');
      await expect(mainScroll).toBeVisible();
      const paddingBottom = await mainScroll.evaluate((el) => {
        const v = getComputedStyle(el).paddingBottom;
        return parseFloat(v) || 0;
      });
      expect(paddingBottom).toBeGreaterThan(0);
    } finally {
      await seededSermon.cleanup();
    }
  });

  test('player visible and bottom spacing on mobile viewport', async ({
    page,
  }) => {
    const seededSermon = await seedPlayableSermon();
    try {
      await page.setViewportSize({ width: 375, height: 667 });
      await loginAsDevAdmin(page);
      await page.goto('/admin/sermons');

      await expect(page.getByRole('heading', { name: 'Sermons' })).toBeVisible({
        timeout: 15_000,
      });

      await playSermonFromSearch(page, seededSermon.title);

      await expect(page.getByTestId('floating-audio-bar')).toBeVisible({ timeout: 10_000 });

      const mainScroll = page.getByTestId('main-content-scroll');
      const paddingBottom = await mainScroll.evaluate((el) => {
        const v = getComputedStyle(el).paddingBottom;
        return parseFloat(v) || 0;
      });
      expect(paddingBottom).toBeGreaterThan(0);
    } finally {
      await seededSermon.cleanup();
    }
  });
});
