import { expect, test } from '@playwright/test';

function createSilentWav(durationSeconds = 0.5, sampleRate = 44100) {
  const numSamples = Math.floor(durationSeconds * sampleRate);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function loginAsDevAdmin(page: import('@playwright/test').Page) {
  await page.goto('/login?callbackurl=/');
  const devLoginButton = page.getByRole('button', { name: /Dev Login/i });
  await expect(devLoginButton).toBeVisible();
  await devLoginButton.click();
  await expect(page.getByLabel('Upload from Youtube Url toggle')).toBeVisible();
}

test.describe('Audio trimmer', () => {
  test('scrub, trim end, and reset without console errors', async ({ page }) => {
    await loginAsDevAdmin(page);

    const toggle = page.getByLabel('Upload from Youtube Url toggle');
    if (await toggle.isChecked()) {
      await toggle.click();
    }

    const dropzone = page.getByText('Drag & drop audio files here, or click to select files').locator('..');
    const fileInput = dropzone.locator('input');
    await fileInput.setInputFiles({
      name: 'sample.wav',
      mimeType: 'audio/wav',
      buffer: createSilentWav(),
    });

    const trimStartInput = page.getByRole('textbox', { name: 'Trim Start' });
    const trimEndInput = page.getByRole('textbox', { name: 'Trim End' });
    await expect(trimStartInput).toBeVisible({ timeout: 10000 });
    await expect(trimEndInput).toBeVisible({ timeout: 10000 });

    const playhead = page.getByTestId('audio-trim-playhead');
    const playheadBefore = parseFloat((await playhead.getAttribute('data-playhead-percent')) || '0');
    await page.getByTestId('audio-trim-timeline').click({ position: { x: 70, y: 10 } });
    const playheadAfter = parseFloat((await playhead.getAttribute('data-playhead-percent')) || '0');
    expect(playheadAfter).toBeGreaterThan(playheadBefore);

    await trimEndInput.click({ force: true });
    await page.keyboard.press('Control+A');
    await page.keyboard.type('0000100');

    await page.getByRole('button', { name: 'Reset to end' }).click({ force: true });
  });

  test('scrub while playing stays stable', async ({ page }) => {
    await loginAsDevAdmin(page);

    const toggle = page.getByLabel('Upload from Youtube Url toggle');
    if (await toggle.isChecked()) {
      await toggle.click();
    }

    const dropzone = page.getByText('Drag & drop audio files here, or click to select files').locator('..');
    const fileInput = dropzone.locator('input');
    await fileInput.setInputFiles({
      name: 'sample.wav',
      mimeType: 'audio/wav',
      buffer: createSilentWav(2.0),
    });

    const playButton = page.getByRole('button', { name: 'Play' });
    await playButton.click({ force: true });

    const playhead = page.getByTestId('audio-trim-playhead');
    const playheadBefore = parseFloat((await playhead.getAttribute('data-playhead-percent')) || '0');
    await page.getByTestId('audio-trim-timeline').click({ position: { x: 80, y: 10 } });
    await page.waitForTimeout(300);
    await page.getByTestId('audio-trim-timeline').click({ position: { x: 20, y: 10 } });
    const playheadAfter = parseFloat((await playhead.getAttribute('data-playhead-percent')) || '0');
    expect(playheadAfter).toBeGreaterThan(playheadBefore);
  });

  test('drag playhead while playing does not jump', async ({ page }) => {
    await loginAsDevAdmin(page);

    const toggle = page.getByLabel('Upload from Youtube Url toggle');
    if (await toggle.isChecked()) {
      await toggle.click();
    }

    const dropzone = page.getByText('Drag & drop audio files here, or click to select files').locator('..');
    const fileInput = dropzone.locator('input');
    await fileInput.setInputFiles({
      name: 'sample.wav',
      mimeType: 'audio/wav',
      buffer: createSilentWav(2.0),
    });

    const playButton = page.getByRole('button', { name: 'Play' });
    await playButton.click({ force: true });

    const timeline = page.getByTestId('audio-trim-timeline');
    const box = await timeline.boundingBox();
    if (!box) throw new Error('Missing audio timeline');
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
    await page.mouse.up();

    const playhead = page.getByTestId('audio-trim-playhead');
    const playheadAfter = parseFloat((await playhead.getAttribute('data-playhead-percent')) || '0');
    expect(playheadAfter).toBeGreaterThan(10);
  });
});
