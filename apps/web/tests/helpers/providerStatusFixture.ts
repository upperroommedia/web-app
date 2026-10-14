import type { Page } from '@playwright/test';

/** Media-only CI fixture. Publishing-status authority is tested separately with the real handler. */
export async function installMediaProviderStatusFixture(page: Page): Promise<void> {
  if (process.env.URM_MEDIA_BROWSER_STATUS_FIXTURE === undefined) return;
  if (
    process.env.URM_MEDIA_BROWSER_STATUS_FIXTURE !== 'true' ||
    process.env.GCLOUD_PROJECT !== 'demo-temporal-ci' ||
    process.env.PLAYWRIGHT_BASE_URL !== 'http://127.0.0.1:3004'
  )
    throw new Error('Media status fixture requires the isolated demo browser harness');
  const port = process.env.NEXT_PUBLIC_FIREBASE_FUNCTIONS_EMULATOR_PORT;
  if (!port || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) throw new Error('Invalid fixture Functions port');
  const endpoint = `http://127.0.0.1:${port}/demo-temporal-ci/us-central1/getProviderSandboxStatus`;
  await page.route(
    (url) => url.href === endpoint,
    async (route) => {
      const request = route.request();
      if (request.headers().origin !== 'http://127.0.0.1:3004') throw new Error('Unexpected media fixture origin');
      const headers = {
        'access-control-allow-origin': 'http://127.0.0.1:3004',
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'authorization, content-type, x-firebase-appcheck, firebase-instance-id-token',
        vary: 'Origin',
      };
      if (request.method() === 'OPTIONS') {
        if (request.headers()['access-control-request-method'] !== 'POST')
          throw new Error('Unexpected fixture preflight');
        await route.fulfill({ status: 204, headers });
        return;
      }
      if (request.method() !== 'POST' || !/^Bearer .+/.test(request.headers().authorization ?? ''))
        throw new Error('Media status fixture expects an authenticated callable POST');
      const body: unknown = request.postDataJSON();
      if (!body || typeof body !== 'object' || JSON.stringify(body) !== '{"data":{}}')
        throw new Error('Unexpected media status callable payload');
      await route.fulfill({
        status: 200,
        headers,
        json: {
          result: {
            mode: 'blocked',
            ready: false,
            catalogReady: false,
            scenarioSelectionAllowed: false,
            reason: 'configuration-unavailable',
          },
        },
      });
    }
  );
}
