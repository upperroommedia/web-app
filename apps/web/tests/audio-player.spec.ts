import { routePlayableAudio } from './helpers/ownedAudioFixture';
import { createMediaTest, expect } from './helpers/mediaTest';
import { seedPlayableSermon, type SeededPlayableSermon } from './helpers/seedPlayableSermon';

const playableTest = (viewport?: { width: number; height: number }, failFirst = false) =>
  createMediaTest<SeededPlayableSermon>(async (page, usePrepared) => {
    const seeded = await seedPlayableSermon();
    try {
      if (viewport) await page.setViewportSize(viewport);
      await routePlayableAudio(page, seeded.id, failFirst);
      await usePrepared({ callbackPath: '/', data: seeded });
    } finally {
      await seeded.cleanup();
    }
  });
const test = playableTest();
const mobileTest = playableTest({ width: 375, height: 667 });
// The app's desktop volume controls begin at its 1300px lg breakpoint.
const desktopControlsTest = playableTest({ width: 1440, height: 800 });
const failedSourceTest = playableTest(undefined, true);

async function playSermonFromSearch(page: import('@playwright/test').Page, sermonTitle: string) {
  const searchBox = page.getByRole('searchbox').first();
  await expect(searchBox).toBeVisible();
  // Wait for the authenticated initial query before exercising a refinement.
  // The seeded newest sermon must be visible; a stalled or denied query still fails here.
  await expect(page.getByText(sermonTitle)).toBeVisible({ timeout: 15_000 });
  await searchBox.fill(sermonTitle);
  await expect(page.getByText(sermonTitle)).toBeVisible({ timeout: 10_000 });

  const card = page.locator('.MuiCard-root').filter({ has: page.getByText(sermonTitle, { exact: true }) });
  await expect(card).toHaveCount(1);
  const playButton = card.getByRole('button', { name: 'Play sermon', exact: true });
  await expect(playButton).toBeVisible();
  await playButton.click();
}

test.describe('Audio player (floating bar)', () => {
  test.setTimeout(30_000);

  test('player visible and main content has bottom padding when playing on admin sermons', async ({
    authenticatedMedia: { page, data: seededSermon },
  }) => {
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
  });

  mobileTest(
    'player visible and bottom spacing on mobile viewport',
    async ({ authenticatedMedia: { page, data: seededSermon } }) => {
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
    }
  );
});

desktopControlsTest(
  'real audio controls support pause, keyboard seek/volume, mute and close with local media',
  async ({ authenticatedMedia: { page, data: seeded } }) => {
    await page.goto('/admin/sermons');
    await playSermonFromSearch(page, seeded.title);
    const bar = page.getByRole('region', { name: 'Sermon audio player' });
    const audio = bar.locator('audio');
    await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.readyState)).toBeGreaterThanOrEqual(3);
    await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe(seeded.title);
    await expect(bar.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
    await bar.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.paused)).toBe(true);
    // A decoded duration alone does not prove the HTTP resource is seekable.
    // Keep the real keyboard assertion below; fail at readiness if the media transport regresses.
    await expect
      .poll(() =>
        audio.evaluate((node: HTMLAudioElement) =>
          node.seekable.length ? node.seekable.end(node.seekable.length - 1) : 0
        )
      )
      .toBeGreaterThan(50);
    const position = bar.getByRole('slider', { name: 'Playback position' }).first();
    await position.focus();
    await position.press('End');
    await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.currentTime)).toBeGreaterThan(50);
    await position.press('Home');
    await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.currentTime)).toBeLessThan(1);
    const volume = bar.getByRole('slider', { name: 'Volume' });
    await volume.focus();
    await volume.press('Home');
    await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.volume)).toBe(0);
    await bar.getByRole('button', { name: 'Unmute', exact: true }).click();
    await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.volume)).toBeGreaterThan(0);
    await bar.getByRole('button', { name: 'Close audio player' }).click();
    await expect(bar).toHaveCount(0);
    await expect(page.locator('audio')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata)).toBeNull();
  }
);

failedSourceTest(
  'a failed source URL can be retried without changing the selected sermon',
  async ({ authenticatedMedia: { page, data: seeded } }) => {
    await page.goto('/admin/sermons');
    await playSermonFromSearch(page, seeded.title);
    const bar = page.getByRole('region', { name: 'Sermon audio player' });
    await expect(bar.getByRole('status')).toContainText('Audio could not load');
    await bar.getByRole('button', { name: 'Retry audio', exact: true }).click();
    await expect
      .poll(() => bar.locator('audio').evaluate((node: HTMLAudioElement) => node.readyState))
      .toBeGreaterThanOrEqual(3);
    await expect(bar.getByRole('status')).toHaveCount(0);
    await expect(bar.getByText(seeded.title, { exact: true })).toBeVisible();
    await bar.getByRole('button', { name: 'Close audio player' }).click();
    await expect(bar).toHaveCount(0);
  }
);
