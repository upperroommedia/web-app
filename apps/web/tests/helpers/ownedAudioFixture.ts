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
        const mediaHeaders = { ...headers, 'accept-ranges': 'bytes', 'content-length': String(wav.length) };
        const fullResponse = () =>
          route.fulfill({
            status: 200,
            contentType: 'audio/wav',
            headers: mediaHeaders,
            body: method === 'HEAD' ? '' : wav,
          });
        // RFC 9110 §14.2: Range is defined for GET only; HEAD describes the complete representation.
        const range = route.request().headers().range;
        if (method === 'HEAD' || range === undefined) return fullResponse();
        const invalid = () =>
          route.fulfill({ status: 400, headers: { ...mediaHeaders, 'content-length': '0' }, body: '' });
        const unsatisfiable = () =>
          route.fulfill({
            status: 416,
            headers: { ...mediaHeaders, 'content-length': '0', 'content-range': `bytes */${wav.length}` },
            body: '',
          });
        const field = /^([^\s=]+)=(.*)$/.exec(range.trim());
        if (!field) return invalid();
        // Unknown units must be ignored. This single-range fixture also ignores multipart ranges
        // as permitted by §14.2, returning the full representation without inventing a slice.
        if (field[1].toLowerCase() !== 'bytes' || field[2].includes(',')) return fullResponse();
        const bounds = /^(\d*)-(\d*)$/.exec(field[2].trim());
        if (!bounds || (!bounds[1] && !bounds[2])) return invalid();
        // BigInt preserves arbitrarily large decimal positions without integer-overflow rounding.
        const length = BigInt(wav.length);
        let start: bigint;
        let end: bigint;
        if (!bounds[1]) {
          const suffix = BigInt(bounds[2]);
          if (suffix === BigInt(0)) return unsatisfiable();
          start = suffix >= length ? BigInt(0) : length - suffix;
          end = length - BigInt(1);
        } else {
          start = BigInt(bounds[1]);
          end = bounds[2] ? BigInt(bounds[2]) : length - BigInt(1);
          if (bounds[2] && end < start) return invalid();
          if (start >= length) return unsatisfiable();
          if (end >= length) end = length - BigInt(1);
        }
        const body = wav.subarray(Number(start), Number(end) + 1);
        return route.fulfill({
          status: 206,
          contentType: 'audio/wav',
          headers: {
            ...mediaHeaders,
            'content-length': String(body.length),
            'content-range': `bytes ${start}-${end}/${wav.length}`,
          },
          body,
        });
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
