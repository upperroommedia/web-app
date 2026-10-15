import { expect, type Page, type Route } from '@playwright/test';
import { MEDIA_FIXTURE_ADMIN } from './mediaFixtureIdentity';

const APP_ORIGIN = 'http://127.0.0.1:3004';
const AUTH_ORIGIN = 'http://127.0.0.1:9100';
type MediaCallback = '/' | '/admin/sermons';

export function assertMediaBrowserLoginEnvironment(
  env: NodeJS.ProcessEnv,
  callbackPath: string
): asserts callbackPath is MediaCallback {
  if (
    env.URM_MEDIA_BROWSER_STATUS_FIXTURE !== 'true' ||
    env.GCLOUD_PROJECT !== 'demo-temporal-ci' ||
    env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== 'demo-temporal-ci' ||
    env.NEXT_PUBLIC_FIREBASE_DEMO_EMULATORS !== 'true' ||
    env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT !== '9100' ||
    !['/', '/admin/sermons'].includes(callbackPath)
  )
    throw new Error('Media browser login requires the isolated production demo harness');
  let base: URL;
  try {
    base = new URL(env.PLAYWRIGHT_BASE_URL ?? '');
  } catch {
    throw new Error('Media browser login requires the exact loopback application');
  }
  if (base.href !== `${APP_ORIGIN}/`) throw new Error('Media browser login requires the exact loopback application');
}

export function assertMediaAuthPopupUrl(url: URL): void {
  if (
    url.origin !== AUTH_ORIGIN ||
    url.pathname !== '/emulator/auth/handler' ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.getAll('providerId').length !== 1 ||
    url.searchParams.get('providerId') !== MEDIA_FIXTURE_ADMIN.providerId ||
    url.searchParams.getAll('authType').length !== 1 ||
    url.searchParams.get('authType') !== 'signInViaPopup' ||
    url.searchParams.has('tid') ||
    url.searchParams.has('tenantId')
  )
    throw new Error('Media browser login rejected an unexpected authentication popup');
}

export function isUnexpectedMediaLoginDocument(url: URL, navigation: boolean, resourceType: string): boolean {
  return (
    navigation &&
    resourceType === 'document' &&
    url.href !== 'about:blank' &&
    url.origin !== APP_ORIGIN &&
    url.origin !== AUTH_ORIGIN
  );
}

/** Use the shipped Google button and the official emulator's existing-account UI. */
export async function loginAsMediaBrowserAdmin(page: Page, callbackPath: MediaCallback = '/'): Promise<void> {
  assertMediaBrowserLoginEnvironment(process.env, callbackPath);
  const context = page.context();
  const outsideHarness = (url: URL) => url.origin !== APP_ORIGIN && url.origin !== AUTH_ORIGIN;
  let blockedNavigation = false;
  const guard = async (route: Route) => {
    const request = route.request();
    if (isUnexpectedMediaLoginDocument(new URL(request.url()), request.isNavigationRequest(), request.resourceType())) {
      blockedNavigation = true;
      await route.abort('blockedbyclient');
      return;
    }
    await route.fallback();
  };
  // Context interception covers the popup's FIRST request, before its Page event exists.
  await context.route(outsideHarness, guard);
  try {
    await page.goto(`/login?callbackurl=${encodeURIComponent(callbackPath)}`);
    const loginUrl = new URL(page.url());
    if (loginUrl.origin !== APP_ORIGIN || loginUrl.pathname !== '/login')
      throw new Error('Media browser login rejected an unexpected application page');
    await expect(page.getByRole('button', { name: /Dev Login/i })).toHaveCount(0);
    const google = page.getByRole('button', { name: 'Log in with Google', exact: true });
    await expect(google).toBeVisible();
    const [popup] = await Promise.all([page.waitForEvent('popup'), google.click()]);
    await popup.waitForURL((url) => {
      if (url.href === 'about:blank') return false;
      assertMediaAuthPopupUrl(url);
      return true;
    });
    assertMediaAuthPopupUrl(new URL(popup.url()));
    // firebase-tools renders linked provider accounts as these list items, not buttons.
    // Match visible identity only; never read its synthetic token attribute or create an account.
    const account = popup.locator('li.js-reuse-account').filter({
      has: popup.getByText(MEDIA_FIXTURE_ADMIN.email, { exact: true }),
    });
    await expect(account).toHaveCount(1);
    await expect(account.locator('.mdc-list-item__primary-text')).toHaveText(MEDIA_FIXTURE_ADMIN.displayName);
    await expect(account.locator('.mdc-list-item__secondary-text')).toHaveText(MEDIA_FIXTURE_ADMIN.email);
    assertMediaAuthPopupUrl(new URL(popup.url()));
    await account.click();
    await page.waitForURL((url) => url.origin === APP_ORIGIN && url.pathname === callbackPath);
    if (blockedNavigation) throw new Error('Media browser login blocked an external authentication navigation');
  } catch (error) {
    if (blockedNavigation) throw new Error('Media browser login blocked an external authentication navigation');
    throw error;
  } finally {
    await context.unroute(outsideHarness, guard);
  }
}
