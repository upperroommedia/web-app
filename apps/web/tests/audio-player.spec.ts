import { expect, test } from '@playwright/test';
import { seedPlayableSermon } from './helpers/seedPlayableSermon';

async function loginAsDevAdmin(page: import('@playwright/test').Page) {
  await page.goto('/login?callbackurl=/');
  const devLoginButton = page.getByRole('button', { name: /Dev Login/i });
  await expect(devLoginButton).toBeVisible();
  await devLoginButton.click();
  await expect(page.getByRole('switch', { name: 'Upload from Youtube Url', exact: true })).toBeVisible();
}

async function playSermonFromSearch(page: import('@playwright/test').Page, sermonTitle: string) {
  const searchBox = page.getByRole('searchbox').first();
  await expect(searchBox).toBeVisible();
  // Wait for the authenticated initial query before exercising a refinement.
  // The seeded newest sermon must be visible; a stalled or denied query still fails here.
  await expect(page.getByText(sermonTitle)).toBeVisible({ timeout: 15_000 });
  await searchBox.fill(sermonTitle);
  await expect(page.getByText(sermonTitle)).toBeVisible({ timeout: 10_000 });

  const playButton = page.locator('button:has([data-testid="PlayArrowIcon"])').first();
  await expect(playButton).toBeVisible();
  await playButton.click();
}

test.describe('Audio player (floating bar)', () => {
  test.setTimeout(30_000);

  test('player visible and main content has bottom padding when playing on admin sermons', async ({ page }) => {
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

  test('player visible and bottom spacing on mobile viewport', async ({ page }) => {
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

// Local deterministic media: browser exercises real Video.js/native audio without
// contacting a media provider or requiring a pre-existing Storage object.
async function routePlayableAudio(page: import('@playwright/test').Page, sermonId: string, failFirstMetadata = false) {
  let metadataRequests = 0;
  const samples = 8_000 * 60;
  const wav = Buffer.alloc(44 + samples, 128);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8_000, 24);
  wav.writeUInt32LE(8_000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples, 40);
  await page.route('**/o/**', async (route) => {
    const url = new URL(route.request().url());
    if (!decodeURIComponent(url.pathname).includes(`intro-outro-sermons/${sermonId}`)) return route.continue();
    const headers = {
      'access-control-allow-origin': route.request().headers().origin || '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': route.request().headers()['access-control-request-headers'] || '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.searchParams.get('alt') === 'media') {
      return route.fulfill({ status: 200, contentType: 'audio/wav', headers, body: wav });
    }
    if (failFirstMetadata && metadataRequests++ === 0) {
      return route.fulfill({
        status: 404,
        headers,
        json: { error: { code: 404, message: 'Fixture temporarily unavailable' } },
      });
    }
    const bucket = decodeURIComponent(url.pathname.split('/b/')[1].split('/o/')[0]);
    return route.fulfill({
      headers,
      json: {
        name: `intro-outro-sermons/${sermonId}`,
        bucket,
        contentType: 'audio/wav',
        size: String(wav.length),
        generation: '1',
        metageneration: '1',
        downloadTokens: 'local-browser-fixture',
      },
    });
  });
}

test('real audio controls support pause, keyboard seek/volume, mute and close with local media', async ({ page }) => {
  const seeded = await seedPlayableSermon();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await routePlayableAudio(page, seeded.id);
    await loginAsDevAdmin(page);
    await page.goto('/admin/sermons');
    await playSermonFromSearch(page, seeded.title);
    const bar = page.getByRole('region', { name: 'Sermon audio player' });
    const audio = bar.locator('audio');
    await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.readyState)).toBeGreaterThanOrEqual(3);
    await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe(seeded.title);
    await expect(bar.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
    await bar.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.paused)).toBe(true);
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
  } finally {
    await seeded.cleanup();
  }
});

test('a failed source URL can be retried without changing the selected sermon', async ({ page }) => {
  const seeded = await seedPlayableSermon();
  try {
    await routePlayableAudio(page, seeded.id, true);
    await loginAsDevAdmin(page);
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
  } finally {
    await seeded.cleanup();
  }
});
