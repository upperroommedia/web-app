import { createMediaTest, expect, test } from './helpers/mediaTest';
import type { ConsoleMessage, Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const oversizedPreviewTest = createMediaTest<string>(async (_page, usePrepared) => {
  const directory = await mkdtemp(join(tmpdir(), 'urm-preview-budget-'));
  try {
    const path = join(directory, 'long-recording.wav');
    await writeFile(path, createSilentWav(400, 44100));
    await usePrepared({ callbackPath: '/', data: path });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function collectTrimmerBrowserErrors(page: Page) {
  const messages: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') {
      messages.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    messages.push(error.message);
  });
  return messages;
}

const outageTest = createMediaTest<{ pageErrors: string[]; rejected: Set<string> }>(async (page, usePrepared) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const rejected = new Set<string>();
  const endpoints = new Set(
    ['createsubtitlebundle', 'createlatestlistbundle'].map(
      (name) => `http://127.0.0.1:5001/demo-temporal-ci/us-central1/${name}`
    )
  );
  if (process.env.URM_MEDIA_BROWSER_STATUS_FIXTURE !== 'true' || process.env.GCLOUD_PROJECT !== 'demo-temporal-ci')
    throw new Error('Catalog outage regression requires the isolated demo harness');
  await page.route(
    (url) => endpoints.has(url.href),
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      rejected.add(route.request().url());
      await route.fulfill({
        status: 503,
        headers: { 'access-control-allow-origin': 'http://127.0.0.1:3004', vary: 'Origin' },
        body: 'Deliberate catalog bundle outage',
      });
    }
  );
  await usePrepared({ callbackPath: '/', data: { pageErrors, rejected } });
});

const mobileTrimTest = createMediaTest<void>(async (page, usePrepared) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await usePrepared({ callbackPath: '/', data: undefined });
});

const blobFetchTest = createMediaTest<string[]>(async (page, usePrepared) => {
  const browserErrors = collectTrimmerBrowserErrors(page);
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (target.startsWith('blob:')) {
        return Promise.reject(new TypeError('Load failed'));
      }
      return originalFetch(input, init);
    };
  });
  await usePrepared({ callbackPath: '/', data: browserErrors });
});

const rejectedPlayTest = createMediaTest<string[]>(async (page, usePrepared) => {
  const browserErrors = collectTrimmerBrowserErrors(page);
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () =>
      Promise.reject(new DOMException('The operation is not supported.', 'NotSupportedError'));
  });
  await usePrepared({ callbackPath: '/', data: browserErrors });
});

const lifetimeTest = createMediaTest<void>(async (page, usePrepared) => {
  await page.addInitScript(() => {
    const probe = { created: [] as string[], revoked: [] as string[], previewReads: 0 };
    Object.assign(window, { __waveformLifetimeProbe: probe });
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (value) => {
      const url = create(value);
      if (value instanceof File && value.name === 'bounded-preview.wav') probe.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      probe.revoked.push(url);
      revoke(url);
    };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      if (
        message &&
        typeof message === 'object' &&
        'blob' in message &&
        message.blob instanceof Blob &&
        'duration' in message &&
        typeof message.duration === 'number'
      )
        probe.previewReads++;
      Reflect.apply(post, this, [message, options ?? {}]);
    };
  });
  await usePrepared({ callbackPath: '/', data: undefined });
});

test.describe('Audio trimmer', () => {
  outageTest(
    'catalog bundle outage falls back to Firestore without blocking local audio controls',
    async ({
      authenticatedMedia: {
        page,
        data: { pageErrors, rejected },
      },
    }) => {
      await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeEnabled();
      expect(rejected.size).toBe(2);
      const dropzone = page.getByText('Drag & drop audio files here, or click to select files').locator('..');
      await dropzone
        .locator('input')
        .setInputFiles({ name: 'outage-draft.wav', mimeType: 'audio/wav', buffer: createSilentWav(10) });
      const play = page.getByRole('button', { name: 'Play', exact: true });
      await expect(play).toBeEnabled();
      await play.click();
      const pause = page.getByRole('button', { name: 'Pause', exact: true });
      await expect(pause).toBeVisible();
      await pause.click();
      const start = page.getByRole('textbox', { name: 'Trim Start' });
      await start.click();
      await start.press('ControlOrMeta+A');
      await start.pressSequentially('0000010');
      await start.blur();
      await expect(start).toHaveValue('00:00:01.0');
      expect(pageErrors).toEqual([]);
    }
  );

  test('scrub, trim end, and reset without console errors', async ({ authenticatedMedia: { page } }) => {
    const toggle = page.getByRole('switch', { name: 'Upload from Youtube Url' });
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
    await expect(trimStartInput).toBeEnabled();
    await expect(trimEndInput).toBeEnabled();

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

  test('scrub while playing stays stable', async ({ authenticatedMedia: { page } }) => {
    const toggle = page.getByRole('switch', { name: 'Upload from Youtube Url' });
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
    await expect(playButton).toBeEnabled();
    await playButton.click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

    const playhead = page.getByTestId('audio-trim-playhead');
    const playheadBefore = parseFloat((await playhead.getAttribute('data-playhead-percent')) || '0');
    await page.getByTestId('audio-trim-timeline').click({ position: { x: 80, y: 10 } });
    await page.waitForTimeout(300);
    await page.getByTestId('audio-trim-timeline').click({ position: { x: 20, y: 10 } });
    const playheadAfter = parseFloat((await playhead.getAttribute('data-playhead-percent')) || '0');
    expect(playheadAfter).toBeGreaterThan(playheadBefore);
  });

  test('drag playhead while playing does not jump', async ({ authenticatedMedia: { page } }) => {
    const toggle = page.getByRole('switch', { name: 'Upload from Youtube Url' });
    if (await toggle.isChecked()) {
      await toggle.click();
    }

    const dropzone = page.getByText('Drag & drop audio files here, or click to select files').locator('..');
    const fileInput = dropzone.locator('input');
    await fileInput.setInputFiles({
      name: 'sample.wav',
      mimeType: 'audio/wav',
      buffer: createSilentWav(10.0),
    });

    const playButton = page.getByRole('button', { name: 'Play' });
    await expect(playButton).toBeEnabled();
    await playButton.click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

    const timeline = page.getByTestId('audio-trim-timeline');
    await timeline.scrollIntoViewIfNeeded();
    const box = await timeline.boundingBox();
    if (!box) throw new Error('Missing audio timeline');
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    const playhead = page.getByTestId('audio-trim-playhead');
    const playheadAfter = parseFloat((await playhead.getAttribute('data-playhead-percent')) || '0');
    expect(playheadAfter).toBeGreaterThan(10);
    expect(playheadAfter).toBeGreaterThan(60);
    expect(playheadAfter).toBeLessThan(90);
  });

  mobileTrimTest(
    'trim Start/End inputs visible and actionable on mobile viewport',
    async ({ authenticatedMedia: { page } }) => {
      const toggle = page.getByRole('switch', { name: 'Upload from Youtube Url' });
      if (await toggle.isChecked()) {
        await toggle.click();
      }

      const dropzone = page.getByText('Drag & drop audio files here, or click to select files').locator('..');
      const fileInput = dropzone.locator('input');
      await fileInput.setInputFiles({
        name: 'sample.wav',
        mimeType: 'audio/wav',
        buffer: createSilentWav(20),
      });

      const trimStartInput = page.getByRole('textbox', { name: 'Trim Start' });
      const trimEndInput = page.getByRole('textbox', { name: 'Trim End' });
      await expect(trimStartInput).toBeVisible({ timeout: 10000 });
      await expect(trimEndInput).toBeVisible({ timeout: 10000 });
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
      await expect(trimEndInput).toHaveValue('00:00:20.0');
      await expect(trimStartInput).toBeEnabled();

      const viewportSize = page.viewportSize();
      const startBox = await trimStartInput.boundingBox();
      const endBox = await trimEndInput.boundingBox();
      if (viewportSize && startBox) {
        expect(startBox.x).toBeGreaterThanOrEqual(0);
        expect(startBox.x + startBox.width).toBeLessThanOrEqual(viewportSize.width);
      }
      if (viewportSize && endBox) {
        expect(endBox.x).toBeGreaterThanOrEqual(0);
        expect(endBox.x + endBox.width).toBeLessThanOrEqual(viewportSize.width);
      }

      await trimStartInput.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.type('0000100');
      await expect(trimStartInput).toHaveValue('00:00:10.0');
      await trimEndInput.click();
      await expect(trimStartInput).toHaveValue('00:00:10.0');

      await trimStartInput.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.type('0000250');
      await expect(trimStartInput).toHaveAttribute('aria-invalid', 'true');
      await trimEndInput.click();
      await expect(trimStartInput).toHaveValue('00:00:19.9');
      await expect(trimStartInput).toHaveAttribute('aria-invalid', 'false');
    }
  );

  blobFetchTest(
    'local upload waveform uses file data when object URL fetch fails',
    async ({ authenticatedMedia: { page, data: browserErrors } }) => {
      const toggle = page.getByRole('switch', { name: 'Upload from Youtube Url' });
      if (await toggle.isChecked()) {
        await toggle.click();
      }

      const dropzone = page.getByText('Drag & drop audio files here, or click to select files').locator('..');
      await dropzone.locator('input').setInputFiles({
        name: 'sample.wav',
        mimeType: 'audio/wav',
        buffer: createSilentWav(),
      });

      await expect(page.getByRole('textbox', { name: 'Trim Start' })).toBeVisible({ timeout: 10000 });
      await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled({ timeout: 10000 });
      expect(browserErrors).toEqual([]);
    }
  );

  rejectedPlayTest(
    'rejected media play promise does not surface as a browser error',
    async ({ authenticatedMedia: { page, data: browserErrors } }) => {
      const toggle = page.getByRole('switch', { name: 'Upload from Youtube Url' });
      if (await toggle.isChecked()) {
        await toggle.click();
      }

      const dropzone = page.getByText('Drag & drop audio files here, or click to select files').locator('..');
      await dropzone.locator('input').setInputFiles({
        name: 'sample.wav',
        mimeType: 'audio/wav',
        buffer: createSilentWav(),
      });

      const playButton = page.getByRole('button', { name: 'Play' });
      await expect(playButton).toBeEnabled({ timeout: 10000 });
      await playButton.click({ force: true });
      await expect(playButton).toBeEnabled();
      expect(browserErrors).toEqual([]);
    }
  );
});

test.describe('Bounded optional waveform lifetime', () => {
  lifetimeTest(
    'reuses local PCM peaks across viewport changes and releases its preview on SPA navigation',
    async ({ authenticatedMedia: { page } }) => {
      const dropzone = page.getByText('Drag & drop audio files here, or click to select files').locator('..');
      await dropzone
        .locator('input')
        .setInputFiles({ name: 'bounded-preview.wav', mimeType: 'audio/wav', buffer: createSilentWav(1) });
      await expect(page.getByTestId('audio-trim-timeline').locator('canvas')).toBeVisible();
      const snapshot = () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __waveformLifetimeProbe: { created: string[]; revoked: string[]; previewReads: number };
              }
            ).__waveformLifetimeProbe
        );
      const before = await snapshot();
      for (const width of [420, 800, 500, 1000, 360]) await page.setViewportSize({ width, height: 800 });
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
      expect((await snapshot()).previewReads).toBe(before.previewReads);
      page.on('dialog', (dialog) => dialog.accept());
      await page.evaluate(() => {
        Object.assign(window, { __mediaSpaNavigation: 'waveform-lifetime' });
      });
      const activityLink = page.getByRole('link', { name: 'Activity', exact: true });
      if (!(await activityLink.isVisible()))
        await page.getByRole('button', { name: 'open drawer', exact: true }).click();
      await expect(activityLink).toHaveCount(1);
      await expect(activityLink).toBeVisible();
      await activityLink.click();
      await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => (window as unknown as { __mediaSpaNavigation?: string }).__mediaSpaNavigation)
      ).toBe('waveform-lifetime');
      await expect
        .poll(async () => {
          const current = await snapshot();
          return current.created.length > 0 && current.created.every((url) => current.revoked.includes(url));
        })
        .toBe(true);
    }
  );

  oversizedPreviewTest(
    'keeps playback and trim controls available when optional preview exceeds its budget',
    async ({ authenticatedMedia: { page, data: recordingPath } }) => {
      const dropzone = page.getByText('Drag & drop audio files here, or click to select files').locator('..');
      // Input stays valid/playable PCM, but exceeds the preview's 32 MiB input budget.
      // Use the real file path so transferring a 35 MB inline protocol payload does
      // not consume the functional playback/trim assertion budget.
      await dropzone.locator('input').setInputFiles(recordingPath);
      await expect(page.getByRole('img', { name: /Waveform preview unavailable/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
      const start = page.getByRole('textbox', { name: 'Trim Start' });
      await expect(start).toBeEnabled();
      await start.click();
      await start.press('ControlOrMeta+A');
      await start.pressSequentially('0000010');
      await start.blur();
      await expect(start).toHaveValue('00:00:01.0');
    }
  );
});
