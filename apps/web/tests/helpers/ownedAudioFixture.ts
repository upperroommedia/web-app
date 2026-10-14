import type { Page } from '@playwright/test';

// Per-sermon media only: exact loopback Storage origin, bucket and object path.
export async function routePlayableAudio(page: Page, sermonId: string, failFirstMetadata = false) {
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
  const project = process.env.GCLOUD_PROJECT ?? 'urm-app';
  const port = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_PORT ?? '9199';
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) throw new Error('Invalid local media Storage port');
  const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? `${project}.appspot.com`;
  const expectedPath = `/v0/b/${bucket}/o/intro-outro-sermons/${sermonId}`;
  await page.route(
    (url) =>
      (url.origin === `http://127.0.0.1:${port}` || url.origin === `http://localhost:${port}`) &&
      decodeURIComponent(url.pathname) === expectedPath,
    async (route) => {
      const method = route.request().method();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        await route.abort('blockedbyclient');
        throw new Error('Owned media fixture rejects non-read methods');
      }
      const url = new URL(route.request().url());
      const headers = {
        'access-control-allow-origin': route.request().headers().origin || '*',
        'access-control-allow-credentials': 'true',
        'access-control-allow-headers': route.request().headers()['access-control-request-headers'] || '*',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (url.searchParams.get('alt') === 'media') {
        return route.fulfill({ status: 200, contentType: 'audio/wav', headers, body: method === 'HEAD' ? '' : wav });
      }
      if (method === 'HEAD') return route.fulfill({ status: 200, contentType: 'application/json', headers, body: '' });
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
    }
  );
}
