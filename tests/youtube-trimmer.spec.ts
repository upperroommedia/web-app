import { expect, test } from '@playwright/test';

async function loginAsDevAdmin(page: import('@playwright/test').Page) {
  await page.goto('/login?callbackurl=/');
  const devLoginButton = page.getByRole('button', { name: /Dev Login/i });
  await expect(devLoginButton).toBeVisible();
  await devLoginButton.click();
  await expect(page.getByLabel('Upload from Youtube Url toggle')).toBeVisible();
}

async function openYouTubeTrimmer(page: import('@playwright/test').Page, url: string) {
  await loginAsDevAdmin(page);

  const toggle = page.getByLabel('Upload from Youtube Url toggle');
  await toggle.click();

  const urlInput = page.getByLabel('Youtube Link');
  await urlInput.fill(url);

  await expect(page.getByTestId('trim-slider')).toBeVisible({ timeout: 30000 });
}

async function dragHandle(page: import('@playwright/test').Page, selector: string, deltaX: number) {
  const handle = page.locator(selector);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`Missing handle: ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + deltaX, box.y + box.height / 2);
  await page.mouse.up();
}

async function playViaGesture(page: import('@playwright/test').Page) {
  const player = page.locator('.media-player');
  await player.click({ position: { x: 20, y: 20 } });
}

async function clickSliderAtPercent(page: import('@playwright/test').Page, percent: number) {
  const slider = page.getByTestId('trim-slider');
  await slider.click({ position: { x: percent, y: 5 } });
}

test.describe('YouTube trimmer', () => {
  test('shows player shell and controls for valid URL', async ({ page }) => {
    await openYouTubeTrimmer(page, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await expect(page.getByTitle('Skip to trim start')).toBeVisible();
    await expect(page.getByTitle('Skip to trim end')).toBeVisible();

    const startInput = page.getByLabel('Start');
    const endInput = page.getByLabel('End');
    if ((await startInput.count()) > 0) {
      await expect(startInput).toBeVisible();
      await expect(endInput).toBeVisible();
    }
  });

  test('shows validation error for invalid URL', async ({ page }) => {
    await loginAsDevAdmin(page);

    const toggle = page.getByLabel('Upload from Youtube Url toggle');
    await toggle.click();

    const urlInput = page.getByLabel('Youtube Link');
    await urlInput.fill('https://example.com');

    const helperText = page.locator('#youtube-url-input-helper-text');
    await expect(helperText).toContainText('Could not find YouTube video', { timeout: 15000 });
  });

  test('buffers, scrubs, and trims a long video', async ({ page }) => {
    await openYouTubeTrimmer(page, 'https://www.youtube.com/watch?v=qnmolZF_a0w');

    await expect(page.getByLabel('Start')).toBeVisible({ timeout: 30000 });

    const buffered = page.getByTestId('trim-buffered');
    await playViaGesture(page);
    await expect
      .poll(async () => parseFloat((await buffered.getAttribute('data-buffered-percent')) || '0'))
      .toBeGreaterThan(0);

    const playhead = page.getByTestId('trim-playhead');
    const startHandle = page.getByTestId('trim-handle-start');
    const endHandle = page.getByTestId('trim-handle-end');

    const playheadBefore = parseFloat((await playhead.getAttribute('data-playhead-percent')) || '0');
    await clickSliderAtPercent(page, 70);
    const playheadAfter = parseFloat((await playhead.getAttribute('data-playhead-percent')) || '0');
    expect(playheadAfter).toBeGreaterThan(playheadBefore + 1);

    const startBefore = parseFloat((await startHandle.getAttribute('data-trim-start-percent')) || '0');
    const endBefore = parseFloat((await endHandle.getAttribute('data-trim-end-percent')) || '0');

    const startInput = page.getByRole('textbox', { name: 'Start' });
    await startInput.click({ force: true });
    await page.keyboard.press('Control+A');
    await page.keyboard.type('0000100');

    const endInput = page.getByRole('textbox', { name: 'End' });
    await endInput.click({ force: true });
    await page.keyboard.press('Control+A');
    await page.keyboard.type('0000300');

    const startAfter = parseFloat((await startHandle.getAttribute('data-trim-start-percent')) || '0');
    const endAfter = parseFloat((await endHandle.getAttribute('data-trim-end-percent')) || '0');
    expect(startAfter).toBeGreaterThan(startBefore);
    expect(endAfter).toBeLessThan(endBefore);
  });

  test('reset end clears loading after drag', async ({ page }) => {
    await openYouTubeTrimmer(page, 'https://www.youtube.com/watch?v=qnmolZF_a0w');

    const endInput = page.getByRole('textbox', { name: 'End' });
    await endInput.click({ force: true });
    await page.keyboard.press('Control+A');
    await page.keyboard.type('0000300');

    await page.getByRole('button', { name: 'Reset to end' }).click({ force: true });

    const loadingOverlay = page.getByTestId('player-loading-overlay');
    await expect(loadingOverlay).toHaveCount(0);
  });

  test('plays and edits time inputs', async ({ page }) => {
    await openYouTubeTrimmer(page, 'https://www.youtube.com/watch?v=qnmolZF_a0w');

    await playViaGesture(page);

    const startInput = page.getByRole('textbox', { name: 'Start' });
    await startInput.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('0000100');
    await expect(startInput).toHaveValue(/00:00:10/);

    const endInput = page.getByRole('textbox', { name: 'End' });
    await endInput.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('0000300');
    await expect(endInput).toHaveValue(/00:00:30/);
  });
});
