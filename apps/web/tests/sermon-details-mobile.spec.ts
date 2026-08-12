import { expect, test } from '@playwright/test';
import { seedPlayableSermon } from './helpers/seedPlayableSermon';

async function loginAsDevAdmin(page: import('@playwright/test').Page, callbackPath: string) {
  await page.goto(`/login?callbackurl=${encodeURIComponent(callbackPath)}`);
  const devLoginButton = page.getByRole('button', { name: /Dev Login/i });
  await expect(devLoginButton).toBeVisible();
  await devLoginButton.click();
  await page.waitForURL(new RegExp(callbackPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

test.describe('Sermon details responsive header', () => {
  test.setTimeout(30_000);

  test('gives content and actions their own rows at iPhone width', async ({ page }) => {
    const seededSermon = await seedPlayableSermon();
    const detailPath = `/admin/sermons/${seededSermon.id}`;

    try {
      await page.setViewportSize({ width: 393, height: 852 });
      await loginAsDevAdmin(page, detailPath);
      await expect(page.getByRole('heading', { name: seededSermon.title })).toBeVisible();

      const header = await page.getByTestId('sermon-detail-header').boundingBox();
      const artwork = await page.getByTestId('sermon-detail-artwork').boundingBox();
      const info = await page.getByTestId('sermon-detail-info').boundingBox();
      const actions = await page.getByTestId('sermon-detail-actions').boundingBox();

      expect(header).not.toBeNull();
      expect(artwork).not.toBeNull();
      expect(info).not.toBeNull();
      expect(actions).not.toBeNull();
      expect(info!.width).toBeGreaterThan(artwork!.width * 2);
      expect(actions!.y).toBeGreaterThanOrEqual(Math.max(artwork!.y + artwork!.height, info!.y + info!.height));
      expect(Math.abs(actions!.x - header!.x)).toBeLessThan(2);
      expect(Math.abs(actions!.width - header!.width)).toBeLessThan(2);

      const editButton = await page.getByRole('button', { name: 'Edit' }).boundingBox();
      const deleteButton = await page.getByRole('button', { name: 'Delete' }).boundingBox();
      expect(editButton).not.toBeNull();
      expect(deleteButton).not.toBeNull();
      expect(Math.abs(editButton!.y - deleteButton!.y)).toBeLessThan(2);
      expect(editButton!.width).toBeGreaterThan(100);
      expect(deleteButton!.width).toBeGreaterThan(100);
    } finally {
      await seededSermon.cleanup();
    }
  });
});
