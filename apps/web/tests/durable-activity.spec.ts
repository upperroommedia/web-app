import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { DurableJob } from '@upperroom/contracts/temporal';
import { getAdminDb, seedPlayableSermon } from './helpers/seedPlayableSermon';

async function login(page: Page, target: string) {
  await page.goto(`/login?callbackurl=${encodeURIComponent(target)}`);
  await page.getByRole('button', { name: /Dev Login/i }).click();
  await expect(page).toHaveURL(new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
async function seedJob(sermonId: string, patch: Partial<DurableJob> = {}) {
  const db = getAdminDb();
  const jobId = `pw-job-${randomUUID()}`;
  const now = Date.now();
  const job: DurableJob = {
    schemaVersion: 1,
    jobId,
    projectId: process.env.GCLOUD_PROJECT ?? 'urm-app',
    kind: 'audio.process',
    entity: { type: 'sermon', id: sermonId },
    workflowId: `wf-${jobId}`,
    generation: 1,
    revision: 1,
    requestedBy: 'playwright-e2e',
    requestId: randomUUID(),
    state: 'running',
    createdAt: now,
    updatedAt: now,
    steps: [{ id: 'transcode', label: 'Transcoding audio', state: 'running', attempt: 1 }],
    actions: [],
    ...patch,
  };
  await db.collection('durableJobs').doc(jobId).set(job);
  return {
    job,
    ref: db.collection('durableJobs').doc(jobId),
    cleanup: () => db.collection('durableJobs').doc(jobId).delete(),
  };
}

test.describe('Durable activity survives the browser lifecycle', () => {
  test.setTimeout(45_000);
  test('keeps the same task visible after reload and another tab, then shows its confirmed outcome', async ({
    page,
    context,
  }) => {
    const sermon = await seedPlayableSermon();
    const seeded = await seedJob(sermon.id);
    try {
      const target = `/admin/activity/${seeded.job.jobId}`;
      await login(page, target);
      await expect(page.getByRole('region', { name: 'Process audio status' })).toBeVisible();
      await expect(page.getByRole('status')).toContainText('Transcoding audio');
      await page.reload();
      await expect(page.getByRole('status')).toContainText('Transcoding audio');
      const second = await context.newPage();
      await second.goto(target);
      await expect(second.getByRole('status')).toContainText('Transcoding audio');
      await seeded.ref.update({
        state: 'succeeded',
        revision: 2,
        updatedAt: Date.now(),
        finishedAt: Date.now(),
        steps: [{ id: 'transcode', label: 'Transcoding audio', state: 'succeeded', attempt: 1 }],
      });
      await expect(page.getByRole('status')).toContainText('Complete');
      await expect(second.getByRole('status')).toContainText('Complete');
      await second.close();
    } finally {
      await seeded.cleanup();
      await sermon.cleanup();
    }
  });

  test('renders responsive measured steps and cancellation separately from completion', async ({ page }) => {
    const sermon = await seedPlayableSermon();
    const seeded = await seedJob(sermon.id, {
      state: 'cancel_requested',
      steps: [
        {
          id: 'cleanup',
          label: 'Cleaning up source',
          state: 'running',
          attempt: 2,
          progress: { completed: 43, total: 100, unit: 'items' },
        },
      ],
    });
    try {
      await page.setViewportSize({ width: 393, height: 852 });
      await login(page, `/admin/activity/${seeded.job.jobId}`);
      await expect(page.getByRole('status')).toContainText('Cancellation requested');
      await expect(page.getByRole('progressbar', { name: 'Cleaning up source' })).toHaveAttribute(
        'aria-valuenow',
        '43'
      );
      await expect(page.getByText('Attempt 2')).toBeVisible();
      const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(horizontalOverflow).toBe(false);
    } finally {
      await seeded.cleanup();
      await sermon.cleanup();
    }
  });

  test('does not mark queued child audio processing complete when the source upload finished', async ({ page }) => {
    const sermon = await seedPlayableSermon();
    const child = await seedJob(sermon.id, { state: 'queued', steps: [] });
    const upload = await seedJob(sermon.id, {
      kind: 'upload.create',
      state: 'succeeded',
      result: { mediaJobId: child.job.jobId },
      steps: [],
    });
    try {
      await login(page, `/admin/activity/${upload.job.jobId}`);
      await expect(page.getByRole('region', { name: 'Upload sermon status' })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'Source received' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Process audio status' })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'Queued' })).toBeVisible();
    } finally {
      await upload.cleanup();
      await child.cleanup();
      await sermon.cleanup();
    }
  });
  test('clears approval evidence when the server replaces the repair certificate', async ({ page }) => {
    const sermon = await seedPlayableSermon();
    const attention = {
      kind: 'remote_drift' as const,
      message: 'Review confirmed repair',
      resolutionKind: 'critical_repair' as const,
      certificateId: 'a'.repeat(64),
      repairPurpose: 'repair_confirmed_changes' as const,
    };
    const seeded = await seedJob(sermon.id, { state: 'needs_attention', attention, actions: ['resolve'] });
    try {
      await login(page, `/admin/activity/${seeded.job.jobId}`);
      const submit = page.getByRole('button', { name: 'Continue reviewed tracking repair' });
      await expect(submit).toBeDisabled();
      await expect(page.getByLabel('Repair certificate', { exact: true })).toHaveAttribute('readonly', '');
      await page.getByLabel('Repair review or support ticket reference').fill('review-ticket');
      await page.getByLabel('Repair review reason').fill('Confirmed changes have been reviewed.');
      await expect(submit).toBeEnabled();
      await seeded.ref.update({
        attention: { ...attention, certificateId: 'b'.repeat(64) },
        revision: 2,
        updatedAt: Date.now(),
      });
      await expect(page.getByLabel('Repair certificate', { exact: true })).toHaveValue('b'.repeat(64));
      await expect(page.getByLabel('Repair review or support ticket reference')).toHaveValue('');
      await expect(page.getByLabel('Repair review reason')).toHaveValue('');
      await expect(submit).toBeDisabled();
    } finally {
      await seeded.cleanup();
      await sermon.cleanup();
    }
  });
  test('reviews legacy track retention only against the current fixed source certificate', async ({ page }) => {
    const sermon = await seedPlayableSermon();
    const attention = {
      kind: 'remote_drift' as const,
      message: 'Review legacy track retention',
      resolutionKind: 'critical_repair' as const,
      certificateId: 'a'.repeat(64),
      repairPurpose: 'complete_fixed_cleanup' as const,
      requiresRetentionAcknowledgement: true,
    };
    const seeded = await seedJob(sermon.id, {
      kind: 'sermon.delete',
      state: 'needs_attention',
      attention,
      actions: ['resolve'],
    });
    const commands: Array<Record<string, unknown>> = [];
    await page.route(/\/commandDurableJob(?:\?.*)?$/i, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      commands.push((route.request().postDataJSON() as { data: Record<string, unknown> }).data);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ result: { jobId: seeded.job.jobId, revision: 4, admissionState: 'accepted' } }),
      });
    });
    try {
      await login(page, `/admin/activity/${seeded.job.jobId}`);
      const submit = page.getByRole('button', { name: 'Keep track and finish saved cleanup', exact: true });
      const acknowledgement = page.getByRole('checkbox', {
        name: 'I agree to keep the original SoundCloud track; its content may remain online.',
        exact: true,
      });
      const evidence = page.getByLabel('Repair review or support ticket reference');
      const reason = page.getByLabel('Repair review reason');
      await expect(submit).toBeDisabled();
      await expect(page.getByLabel('Repair certificate', { exact: true })).toHaveAttribute('readonly', '');
      await evidence.fill('support-review');
      await reason.fill('Keep the original track; finish saved local cleanup.');
      await expect(submit).toBeDisabled();
      await acknowledgement.check();
      await expect(submit).toBeEnabled();
      await seeded.ref.update({
        generation: 2,
        revision: 2,
        attention: { ...attention, certificateId: 'b'.repeat(64) },
        updatedAt: Date.now(),
      });
      await expect(page.getByLabel('Repair certificate', { exact: true })).toHaveValue('b'.repeat(64));
      await expect(evidence).toHaveValue('');
      await expect(reason).toHaveValue('');
      await expect(acknowledgement).not.toBeChecked();
      await expect(submit).toBeDisabled();
      await evidence.fill('new-support-review');
      await reason.fill('Keep original remote content.');
      await acknowledgement.check();
      await seeded.ref.update({
        revision: 3,
        attention: { ...attention, certificateId: 'b'.repeat(64), requiresRetentionAcknowledgement: false },
        updatedAt: Date.now(),
      });
      await expect(acknowledgement).toHaveCount(0);
      await expect(evidence).toHaveValue('');
      await expect(reason).toHaveValue('');
      await seeded.ref.update({
        revision: 4,
        attention: { ...attention, certificateId: 'b'.repeat(64) },
        updatedAt: Date.now(),
      });
      await expect(acknowledgement).not.toBeChecked();
      await evidence.fill('final-support-review');
      await reason.fill('Explicitly keep the track.');
      await acknowledgement.check();
      await submit.click();
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]).toMatchObject({
        jobId: seeded.job.jobId,
        expectedRevision: 4,
        action: 'resolve',
        resolution: {
          decision: 'continue_critical_repair',
          certificateId: 'b'.repeat(64),
          evidenceReference: 'final-support-review',
          reason: 'Explicitly keep the track.',
          retentionAcknowledged: true,
        },
      });
      expect(Object.keys(commands[0].resolution as Record<string, unknown>).sort()).toEqual(
        ['certificateId', 'decision', 'evidenceReference', 'reason', 'retentionAcknowledged'].sort()
      );
    } finally {
      await seeded.cleanup();
      await sermon.cleanup();
    }
  });
  test('pages through more than 100 unresolved tasks and resets pages when filters change', async ({ page }) => {
    const db = getAdminDb();
    const prefix = `pw-pagination-${randomUUID()}`;
    const now = Date.now() + 86400000;
    const refs = Array.from({ length: 105 }, (_, index) =>
      db.collection('durableJobs').doc(`${prefix}-${String(index).padStart(3, '0')}`)
    );
    const batch = db.batch();
    refs.forEach((ref, index) =>
      batch.set(ref, {
        schemaVersion: 1,
        jobId: ref.id,
        projectId: process.env.GCLOUD_PROJECT ?? 'urm-app',
        kind: 'provider.orphan_review',
        entity: { type: 'maintenance', id: ref.id, label: `${prefix} item ${index}` },
        workflowId: `wf-${ref.id}`,
        generation: 1,
        revision: 1,
        requestedBy: 'playwright-e2e',
        requestId: ref.id,
        state: 'needs_attention',
        createdAt: now,
        updatedAt: now,
        steps: [],
        actions: [],
      })
    );
    await batch.commit();
    try {
      await login(page, '/admin/activity');
      await page.getByRole('button', { name: 'Needs attention', exact: true }).click();
      await expect(page.getByText(`${prefix} item 104`, { exact: true })).toBeVisible();
      await expect(page.getByText(/Page 1 · Showing 100 tasks/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Older tasks', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Older tasks', exact: true }).click();
      await expect(page.getByText(`${prefix} item 0`, { exact: true })).toBeVisible();
      await expect(page.getByText(`${prefix} item 104`, { exact: true })).toHaveCount(0);
      await expect(page.getByText(/Page 2 · Showing/)).toBeVisible();
      await page.getByRole('button', { name: 'Newer tasks', exact: true }).click();
      await expect(page.getByText(`${prefix} item 104`, { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Older tasks', exact: true }).click();
      await expect(page.getByText(`${prefix} item 0`, { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Active', exact: true }).click();
      await expect(page.getByText(/Page 1 · Showing 100 tasks/)).toBeVisible();
      await expect(page.getByText(`${prefix} item 104`, { exact: true })).toBeVisible();
    } finally {
      const cleanup = db.batch();
      refs.forEach((ref) => cleanup.delete(ref));
      await cleanup.commit();
    }
  });
});
