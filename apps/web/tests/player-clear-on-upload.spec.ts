import { routePlayableAudio } from './helpers/ownedAudioFixture';
import { createMediaTest, expect, test } from './helpers/mediaTest';
import { seedPlayableSermon, type SeededPlayableSermon } from './helpers/seedPlayableSermon';

const playingTest = createMediaTest<SeededPlayableSermon>(async (page, usePrepared) => {
  const seededSermon = await seedPlayableSermon();
  try {
    await routePlayableAudio(page, seededSermon.id);
    await usePrepared({ callbackPath: '/admin/sermons', data: seededSermon });
  } finally {
    await seededSermon.cleanup();
  }
});

async function playSermonFromSearch(page: import('@playwright/test').Page, sermonTitle: string) {
  const searchBox = page.getByRole('searchbox').first();
  await expect(searchBox).toBeVisible();
  await expect(page.getByText(sermonTitle, { exact: true })).toBeVisible();
  await searchBox.fill(sermonTitle);
  await expect(page.getByText(sermonTitle)).toBeVisible({ timeout: 10_000 });

  const card = page.locator('.MuiCard-root').filter({ has: page.getByText(sermonTitle, { exact: true }) });
  await expect(card).toHaveCount(1);
  const playButton = card.getByRole('button', { name: 'Play sermon', exact: true });
  await expect(playButton).toBeVisible();
  await playButton.click();
}

test.describe('Player clear on upload / edit routes', () => {
  test('bottom audio bar is not shown on upload page', async ({ authenticatedMedia: { page } }) => {
    await expect(page.getByRole('switch', { name: 'Upload from Youtube Url', exact: true })).toBeVisible();
    await expect(page.getByTestId('floating-audio-bar')).toHaveCount(0);
  });

  test('iPhone Safari fits the upload form and navigation at 320 pixels', async ({
    authenticatedMedia: { page },
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-safari', 'Run with the iPhone Safari project');
    await page.setViewportSize({ width: 320, height: 568 });

    const title = page.getByRole('textbox', { name: 'Title', exact: true });
    await expect(title).toBeVisible();
    expect((await title.boundingBox())?.width).toBeGreaterThanOrEqual(270);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

    await page.getByRole('button', { name: /choose date/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    const menu = page.getByRole('button', { name: 'open drawer' });
    expect((await menu.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await menu.click();
    const drawer = page.getByRole('dialog', { name: 'Main navigation' });
    await expect(drawer.getByRole('link', { name: 'Upload Sermon' })).toHaveAttribute('aria-current', 'page');
    await drawer.getByRole('link', { name: 'Sermons', exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Sermons', exact: true })).toBeVisible();
  });

  playingTest(
    'navigating to upload clears player when a sermon was playing',
    async ({ authenticatedMedia: { page, data: seededSermon } }) => {
      await page.waitForURL(/\/admin\/sermons$/);

      await playSermonFromSearch(page, seededSermon.title);

      await expect(page.getByTestId('floating-audio-bar')).toBeVisible({ timeout: 6000 });
      await expect(page.getByRole('region', { name: 'Sermon audio player' }).locator('audio')).toHaveCount(1);
      await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe(seededSermon.title);

      await page.evaluate(() => {
        Object.assign(window, { __mediaSpaNavigation: 'player-clear' });
      });
      const uploadLink = page.getByRole('link', { name: 'Upload Sermon', exact: true });
      if (!(await uploadLink.isVisible())) await page.getByRole('button', { name: 'open drawer', exact: true }).click();
      await uploadLink.click();
      await page.waitForURL((url) => url.pathname === '/');

      // The root route has an index title before its lazy uploader supplies the final title.
      // Verify independent media cleanup immediately rather than waiting for that form to load.
      await Promise.all([
        expect(page).toHaveTitle(/^(?:Upload Sermon \| Upper Room Media|Uploader)$/),
        expect(page.getByTestId('floating-audio-bar')).toHaveCount(0),
        expect(page.locator('audio')).toHaveCount(0),
        expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata)).toBeNull(),
      ]);
      expect(
        await page.evaluate(() => (window as unknown as { __mediaSpaNavigation?: string }).__mediaSpaNavigation)
      ).toBe('player-clear');
    }
  );
});
