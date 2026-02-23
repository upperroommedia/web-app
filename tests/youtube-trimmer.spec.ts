import { expect, test } from '@playwright/test';

/**
 * YouTube trimmer E2E tests. Run with PLAYWRIGHT_BASE_URL=http://localhost:3004 when using
 * next dev -p 3004. Tap-to-load on iOS is not exercised here (tests run in Chrome); manual
 * verification on iOS Simulator or device is required for that flow.
 */

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

async function dragSliderFromPercentToPercent(
  page: import('@playwright/test').Page,
  fromPercent: number,
  toPercent: number
) {
  await page.evaluate(
    async ({ start, end }) => {
      const slider = document.querySelector('[data-testid=\"trim-slider\"]');
      if (!slider) throw new Error('Missing trim slider');

      const rect = slider.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      const fromX = rect.left + (rect.width * start) / 100;
      const toX = rect.left + (rect.width * end) / 100;

      slider.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          clientX: fromX,
          clientY: y,
          button: 0,
          buttons: 1,
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 40));

      window.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          cancelable: true,
          clientX: toX,
          clientY: y,
          button: 0,
          buttons: 1,
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 20));

      window.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          clientX: toX,
          clientY: y,
          button: 0,
          buttons: 0,
        })
      );
    },
    { start: fromPercent, end: toPercent }
  );
}

async function setTimeInputDigits(
  page: import('@playwright/test').Page,
  label: 'Start' | 'End',
  digits: string
) {
  const input = page.getByRole('textbox', { name: label });
  await input.click({ force: true });
  await page.keyboard.press('Control+A');
  await page.keyboard.type(digits);
}

async function waitForTrimmerInitialized(page: import('@playwright/test').Page) {
  const endInput = page.getByRole('textbox', { name: 'End' });
  await expect(endInput).not.toHaveValue('00:00:00.0', { timeout: 30000 });
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
    await waitForTrimmerInitialized(page);

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
    await waitForTrimmerInitialized(page);

    await playViaGesture(page);

    await setTimeInputDigits(page, 'Start', '0000100');
    const startInput = page.getByRole('textbox', { name: 'Start' });
    await expect(startInput).toHaveValue(/00:00:10/);

    await setTimeInputDigits(page, 'End', '0000300');
    const endInput = page.getByRole('textbox', { name: 'End' });
    await expect(endInput).toHaveValue(/00:00:30/);
  });

  test('background click-drag continuously moves playhead', async ({ page }) => {
    await openYouTubeTrimmer(page, 'https://www.youtube.com/watch?v=qnmolZF_a0w');
    await waitForTrimmerInitialized(page);

    const buffered = page.getByTestId('trim-buffered');
    await playViaGesture(page);
    await expect
      .poll(async () => parseFloat((await buffered.getAttribute('data-buffered-percent')) || '0'))
      .toBeGreaterThan(0);

    const playhead = page.getByTestId('trim-playhead');
    const before = parseFloat((await playhead.getAttribute('data-playhead-percent')) || '0');
    await dragSliderFromPercentToPercent(page, 30, 75);

    await expect
      .poll(async () => parseFloat((await playhead.getAttribute('data-playhead-percent')) || '0'))
      .toBeGreaterThan(before + 10);
  });

  test('reset start then scrub does not stick in loading state', async ({ page }) => {
    await openYouTubeTrimmer(page, 'https://www.youtube.com/watch?v=qnmolZF_a0w');
    await waitForTrimmerInitialized(page);
    await playViaGesture(page);

    await setTimeInputDigits(page, 'Start', '0246425'); // 02:46:42.5
    await page.getByRole('button', { name: 'Reset to start' }).click({ force: true });
    await clickSliderAtPercent(page, 50);

    await expect
      .poll(
        async () => {
          const overlay = page.getByTestId('player-loading-overlay');
          return overlay.count();
        },
        { timeout: 12000 }
      )
      .toBe(0);
  });
});

test.describe('YouTube trimmer mobile viewport', () => {
  test('shows player and controls on mobile', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chrome', 'Runs only on mobile-chrome project');
    await openYouTubeTrimmer(page, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await expect(page.getByTestId('trim-slider')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTitle('Skip to trim start')).toBeVisible();
    await expect(page.getByTitle('Skip to trim end')).toBeVisible();
  });
});
