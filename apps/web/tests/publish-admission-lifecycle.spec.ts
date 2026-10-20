import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { DurableAdmissionReceipt, DurableJob } from '@upperroom/contracts/temporal';
import { getAdminDb, seedPlayableSermon } from './helpers/seedPlayableSermon';

/** Local projection fixtures only. Admission is intercepted before any provider workflow starts. */
test('a completed accepted job aging out of history does not leave publishing disabled', async ({ page }) => {
  test.setTimeout(60_000);
  const sermon = await seedPlayableSermon();
  const db = getAdminDb();
  const sermonRef = db.collection('sermons').doc(sermon.id);
  const listRef = sermonRef.collection('sermonLists').doc('lifecycle-destination');
  const jobId = `pw-publish-receipt-${randomUUID()}`;
  const acceptedRef = db.collection('durableJobs').doc(jobId);
  const now = Date.now();
  const receipt: DurableAdmissionReceipt = {
    jobId,
    projectId: process.env.GCLOUD_PROJECT ?? 'urm-app',
    requestId: randomUUID(),
    admissionState: 'queued',
    revision: 1,
    generation: 1,
  };
  const accepted: DurableJob = {
    schemaVersion: 1,
    jobId,
    projectId: receipt.projectId,
    kind: 'sermon.unpublish',
    entity: { type: 'sermon', id: sermon.id, label: `Acknowledged original ${jobId}` },
    workflowId: `wf-${jobId}`,
    generation: 1,
    revision: 1,
    requestedBy: 'playwright-e2e',
    requestId: receipt.requestId,
    state: 'queued',
    createdAt: now,
    updatedAt: now,
    steps: [],
    actions: [],
  };
  const newerRefs = Array.from({ length: 26 }, (_, index) =>
    db.collection('durableJobs').doc(`${jobId}-newer-${index}`)
  );
  let admissions = 0;
  const providerRequests: string[] = [];
  try {
    await listRef.set({
      id: listRef.id,
      name: 'Lifecycle destination',
      type: 'topic-list',
      images: [],
      createdAtMillis: now,
      overflowBehavior: 'ERROR',
      uploadStatus: { status: 'UPLOADED', listItemId: 'fixture-only-remote-id' },
    });
    await page.route(
      /(?:api\.(?:subsplash|soundcloud)\.com|\/(?:uploadToSubsplash|deleteFromSubsplash|uploadToSoundCloud|deleteFromSoundCloud|addToList|removeFromList|addToSeries|removeFromSeries)(?:\?.*)?$)/i,
      async (route) => {
        providerRequests.push(route.request().url());
        await route.abort();
      }
    );
    await page.route(/\/submitDurableJob(?:\?.*)?$/i, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      admissions += 1;
      const payload = route.request().postDataJSON() as { data: { requestId: string; kind: string } };
      expect(payload.data.kind).toBe('sermon.unpublish');
      receipt.requestId = payload.data.requestId;
      accepted.requestId = payload.data.requestId;
      await acceptedRef.set(accepted);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ result: receipt }),
      });
    });
    const target = `/admin/sermons/${sermon.id}`;
    await page.goto(`/login?callbackurl=${encodeURIComponent(target)}`);
    await page.getByRole('button', { name: /Dev Login/i }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/sermons/${sermon.id}$`));
    const publish = page.getByRole('button', { name: /^Publish to /, exact: false });
    const unpublish = page.getByRole('button', { name: 'Unpublish From Everywhere', exact: true });
    const history = page.getByRole('region', { name: 'Recent activity', exact: true });
    await expect(history).toHaveCount(0);
    await page.getByRole('button', { name: 'Advanced activity', exact: true }).click();
    await expect(history).toHaveCount(1);
    await expect(unpublish).toBeEnabled();
    await unpublish.click();
    await expect(page.getByText('Request accepted.', { exact: false })).toBeVisible();
    await expect(unpublish).toBeDisabled();
    await expect(history.getByText(accepted.entity.label!, { exact: true })).toBeVisible();
    // Confirmed absence makes a new publish meaningful while retaining this panel's admission state.
    await listRef.update({ uploadStatus: { status: 'NOT_UPLOADED' } });
    await acceptedRef.update({
      state: 'succeeded',
      revision: 2,
      updatedAt: now + 1,
      finishedAt: now + 1,
      destinations: [{ destination: 'subsplash', state: 'absent' }],
    });
    await expect(publish).toBeEnabled();
    const batch = db.batch();
    newerRefs.forEach((ref, index) =>
      batch.set(ref, {
        ...accepted,
        jobId: ref.id,
        entity: { type: 'sermon', id: sermon.id, label: `Newer lifecycle task ${index}` },
        workflowId: `wf-${ref.id}`,
        requestId: ref.id,
        state: 'succeeded',
        revision: 1,
        createdAt: now + index + 10,
        updatedAt: now + index + 10,
        finishedAt: now + index + 10,
      })
    );
    await batch.commit();
    await expect(history.getByText('Newer lifecycle task 25', { exact: true })).toBeVisible();
    await expect(history.getByText(accepted.entity.label!, { exact: true })).toHaveCount(0);
    await expect(publish).toBeEnabled();
    expect(admissions).toBe(1);
    expect(providerRequests).toEqual([]);
    await expect(page).toHaveURL(new RegExp(`/admin/sermons/${sermon.id}$`));
  } finally {
    const cleanup = db.batch();
    newerRefs.forEach((ref) => cleanup.delete(ref));
    cleanup.delete(acceptedRef);
    cleanup.delete(listRef);
    await cleanup.commit();
    await sermon.cleanup();
  }
});
