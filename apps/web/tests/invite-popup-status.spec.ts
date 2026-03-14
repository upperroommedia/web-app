import { expect, Page, test } from '@playwright/test';

async function loginAsDevAdmin(page: Page) {
  await page.goto('/login?callbackurl=/admin/users');
  const devLoginButton = page.getByRole('button', { name: /Dev Login/i });
  await expect(devLoginButton).toBeVisible({ timeout: 15_000 });
  await devLoginButton.click();
}

async function mockCreateInvite(
  page: Page,
  data: {
    inviteId: string;
    inviteUrl: string;
    invitedEmail: string;
    invitedRole: 'user' | 'uploader' | 'publisher' | 'admin';
    expiresAtMs: number;
    emailStatus: 'QUEUED' | 'QUEUE_FAILED';
  }
) {
  await page.route('**/createinvite**', async (route) => {
    if (route.request().method().toUpperCase() === 'OPTIONS') {
      await route.fulfill({ status: 204 });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        result: {
          status: 'success',
          data,
        },
      }),
    });
  });
}

test.describe('Invite popup delivery state', () => {
  test.setTimeout(45_000);

  test('clears stale result and shows inline validation for invalid email', async ({ page }) => {
    await loginAsDevAdmin(page);
    await expect(page.getByRole('button', { name: 'Issue Invite' })).toBeVisible({ timeout: 15_000 });

    const inviteUrl = 'http://localhost:3000/invite/claim?token=test-token-queued';
    await mockCreateInvite(page, {
      inviteId: 'invite-queued',
      inviteUrl,
      invitedEmail: 'valid@example.org',
      invitedRole: 'uploader',
      expiresAtMs: Date.now() + 60_000,
      emailStatus: 'QUEUED',
    });

    await page.getByRole('button', { name: 'Issue Invite' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Invite' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Invitee Email').fill('valid@example.org');
    await dialog.getByRole('button', { name: 'Generate Invite' }).click();

    await expect(dialog.getByText('Invite created and email queued for valid@example.org.')).toBeVisible();
    await expect(dialog.getByText('Email queued for delivery.')).toBeVisible();
    await expect(dialog.locator(`input[value="${inviteUrl}"]`)).toHaveCount(1);

    await dialog.getByLabel('Invitee Email').fill('invalid-email');
    await dialog.getByRole('button', { name: 'Generate Invite' }).click();

    await expect(dialog.getByText('Invite not sent. Please fix the email and try again.')).toBeVisible();
    await expect(dialog.getByText('Enter a valid email address.')).toBeVisible();
    await expect(dialog.locator(`input[value="${inviteUrl}"]`)).toHaveCount(0);
  });

  test('shows explicit warning when email queueing fails', async ({ page }) => {
    await loginAsDevAdmin(page);
    await expect(page.getByRole('button', { name: 'Issue Invite' })).toBeVisible({ timeout: 15_000 });

    const failedInviteUrl = 'http://localhost:3000/invite/claim?token=test-token-failed';
    await mockCreateInvite(page, {
      inviteId: 'invite-failed',
      inviteUrl: failedInviteUrl,
      invitedEmail: 'failed@example.org',
      invitedRole: 'publisher',
      expiresAtMs: Date.now() + 60_000,
      emailStatus: 'QUEUE_FAILED',
    });

    await page.getByRole('button', { name: 'Issue Invite' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Invite' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Invitee Email').fill('failed@example.org');
    await dialog.getByRole('button', { name: 'Generate Invite' }).click();

    await expect(
      dialog.getByText('Invite created for failed@example.org, but email delivery was not queued.')
    ).toBeVisible();
    await expect(dialog.getByText('Email was not queued. Share this link manually.')).toBeVisible();
    await expect(dialog.locator(`input[value="${failedInviteUrl}"]`)).toHaveCount(1);
  });
});
