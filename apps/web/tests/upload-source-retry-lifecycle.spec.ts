import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { FieldPath } from 'firebase-admin/firestore';
import type { DurableAdmissionRequest, DurableAdmissionReceipt, DurableJob } from '@upperroom/contracts/temporal';
import { getAdminDb, seedPlayableSermon } from './helpers/seedPlayableSermon';

function wav(seconds = 20) {
  const rate = 44100;
  const bytes = Math.floor(rate * seconds) * 2;
  const buffer = Buffer.alloc(bytes + 44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + bytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(bytes, 40);
  return buffer;
}

/** Local admission/projection fixtures; never start a workflow or transfer source bytes. */
test('retains a local file after cancellation and starts an explicit same-sermon attempt', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const db = getAdminDb();
  const canonical = await seedPlayableSermon();
  const suffix = randomUUID();
  const categoryName = `Retry Category ${suffix}`;
  const topicName = `Retry Topic ${suffix}`;
  const speakerName = `Retry Speaker ${suffix}`;
  const categoryRef = db.collection('lists').doc(`pw-retry-category-${suffix}`);
  const topicListRef = db.collection('lists').doc(`pw-retry-topic-list-${suffix}`);
  const topicRef = db.collection('topics').doc(`pw-retry-topic-${suffix}`);
  const speakerRef = db.collection('speakers').doc(`pw-retry-speaker-${suffix}`);
  const sourceRef = db.collection('durableJobs').doc(`pw-retry-source-${suffix}`);
  const nextRef = db.collection('durableJobs').doc(`pw-retry-next-${suffix}`);
  const now = Date.now();
  const admissions: DurableAdmissionRequest[] = [];
  const forbiddenRequests: string[] = [];
  const list = (id: string, name: string, type: string) => ({
    id,
    name,
    type,
    images: [],
    createdAtMillis: now,
    updatedAtMillis: now,
    overflowBehavior: 'ERROR',
    isRootList: true,
    count: 0,
  });
  try {
    const seed = db.batch();
    seed.set(categoryRef, list(categoryRef.id, categoryName, 'category-list'));
    seed.set(topicListRef, list(topicListRef.id, topicName, 'topic-list'));
    seed.set(topicRef, {
      id: topicRef.id,
      title: topicName,
      listId: topicListRef.id,
      images: [],
      itemsCount: 0,
      createdAtMillis: now,
      updatedAtMillis: now,
    });
    seed.set(speakerRef, { id: speakerRef.id, name: speakerName, images: [], sermonCount: 0 });
    await seed.commit();
    const topics = await db.collection('topics').where(FieldPath.documentId(), '==', topicRef.id).get();
    const categories = await db.collection('lists').where(FieldPath.documentId(), '==', categoryRef.id).get();
    const topicBundle = db.bundle(`retry-topics-${suffix}`).add('latest-topics-query', topics).build();
    const categoryBundle = db.bundle(`retry-categories-${suffix}`).add('latest-subtitles-query', categories).build();
    await page.route(/\/(?:createtopicbundle|createsubtitlebundle)(?:\?.*)?$/i, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        headers: { 'access-control-allow-origin': '*', 'x-bundle-timestamp': String(now) },
        body: route.request().url().includes('createtopicbundle') ? topicBundle : categoryBundle,
      });
    });
    await page.route(
      /(?:api\.(?:subsplash|soundcloud)\.com|\/(?:commandDurableJob|addintrooutrotaskgenerator|uploadToSubsplash|deleteFromSubsplash|uploadToSoundCloud|deleteFromSoundCloud|addToList|removeFromList|addToSeries|removeFromSeries)(?:\?.*)?$|\/v0\/b\/[^/]+\/o(?:\?.*)?$)/i,
      async (route) => {
        if (route.request().method() === 'POST' || route.request().url().includes('api.')) {
          forbiddenRequests.push(route.request().url());
          await route.abort();
        } else await route.continue();
      }
    );
    await page.route(/\/submitDurableJob(?:\?.*)?$/i, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const request = (route.request().postDataJSON() as { data: DurableAdmissionRequest }).data;
      const jwt = route
        .request()
        .headers()
        .authorization?.replace(/^Bearer\s+/i, '');
      if (!jwt) throw new Error('Local admission needs authenticated requester identity.');
      const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')) as {
        sub?: string;
        user_id?: string;
      };
      const requester = claims.sub ?? claims.user_id;
      if (!requester) throw new Error('Local token does not identify its requester.');
      expect(request.kind).toBe('upload.create');
      admissions.push(request);
      const ref = admissions.length === 1 ? sourceRef : nextRef;
      const receipt: DurableAdmissionReceipt = {
        jobId: ref.id,
        projectId: process.env.GCLOUD_PROJECT ?? 'urm-app',
        requestId: request.requestId,
        admissionState: 'accepted',
        generation: admissions.length,
        revision: 1,
      };
      const job: DurableJob = {
        schemaVersion: 1,
        ...receipt,
        kind: 'upload.create',
        entity: { type: 'sermon', id: canonical.id },
        workflowId: `wf-${ref.id}`,
        requestedBy: requester,
        state: 'cancelled',
        createdAt: now,
        updatedAt: now,
        steps: [],
        actions: [],
      };
      await ref.set(job);
      if (admissions.length === 1) {
        const metadata = request.payload.sermon as Record<string, unknown>;
        await db.collection('sermons').doc(canonical.id).update({
          title: metadata.title,
          description: metadata.description,
          subtitle: metadata.subtitle,
          uploaderId: requester,
        });
      } else {
        expect(request.payload.retryOfJobId).toBe(sourceRef.id);
        expect(request.requestId).not.toBe(admissions[0].requestId);
        expect(request.payload.source).toEqual(admissions[0].payload.source);
        expect(request.payload.trimStart).toBe(admissions[0].payload.trimStart);
        expect(request.payload.duration).toBe(admissions[0].payload.duration);
        expect(request.payload.listIds).toEqual(admissions[0].payload.listIds);
        await db
          .collection('sermons')
          .doc(canonical.id)
          .update({
            'status.audioStatus': 'PROCESSED',
            durationSeconds: 20,
            audioArtifacts: {
              jobId: nextRef.id,
              requestVersion: 'fixture-v2',
              revision: 2,
              sourcePath: `fixture/${suffix}/source`,
              sourceDurationSeconds: 20,
              processedPath: `fixture/${suffix}/processed`,
              finalPath: `fixture/${suffix}/final`,
              durationSeconds: 20,
            },
          });
        // Simulate the private, server-verified completion proof; never infer completion from cancelled status.
        receipt.clientResult = { alreadyComplete: true, sermonId: canonical.id };
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ result: receipt }),
      });
    });
    await page.goto('/login?callbackurl=/');
    await page.getByRole('button', { name: /Dev Login/i }).click();
    await expect(page.getByRole('switch', { name: 'Upload from Youtube Url', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(`Retained audio ${suffix}`);
    await page
      .getByRole('textbox', { name: 'Description', exact: true })
      .fill('Source retained through explicit retry.');
    await page.getByRole('combobox', { name: 'Subtitle', exact: true }).fill(categoryName);
    await page.getByRole('option', { name: categoryName, exact: true }).click();
    await page.getByRole('combobox', { name: 'Speaker(s)', exact: true }).fill(speakerName);
    await page.getByRole('option', { name: new RegExp(speakerName) }).click();
    await page.getByRole('combobox', { name: 'Topic', exact: true }).click();
    await page.getByRole('option', { name: topicName, exact: true }).click();
    await page.keyboard.press('Escape');
    const dropzone = page.getByText('Drag & drop audio files here, or click to select files').locator('..');
    await dropzone.locator('input').setInputFiles({ name: 'retained.wav', mimeType: 'audio/wav', buffer: wav() });
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Try upload again', exact: true })).toBeEnabled();
    expect(admissions).toHaveLength(1);
    await page.screenshot({
      path:
        testInfo.project.name === 'mobile-chrome'
          ? '/tmp/urm-temporal-upload-retry-mobile.png'
          : '/tmp/urm-temporal-upload-retry-desktop.png',
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Try upload again', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/sermons/${canonical.id}$`));
    expect(admissions).toHaveLength(2);
    expect(forbiddenRequests).toEqual([]);
  } finally {
    const cleanup = db.batch();
    [categoryRef, topicListRef, topicRef, speakerRef, sourceRef, nextRef].forEach((ref) => cleanup.delete(ref));
    await cleanup.commit();
    await canonical.cleanup();
  }
});
