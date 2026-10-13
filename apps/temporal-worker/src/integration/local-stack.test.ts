import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { extractProviderResources, PROVIDER_USAGE_CONTROL } from '@upperroom/orchestration/provider-usage';
import {
  submitServerDurableJob,
  confirmUploadSource,
  getServerDurableJobReceipt,
} from '../../../../functions/src/temporal/bridge';
import { createRuntimeActivities } from '../runtime/activities';
import { OutboxDispatcher } from '../runtime/dispatcher';
import { runMediaCommand } from '../../../process-audio/src/temporal/native';
import { getFFmpegPath, getFFprobePath } from '../../../process-audio/src/utils';

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('real admission, immutable upload, dispatcher and Temporal workers publish measured audio once', async () => {
  const db = firebaseAdmin.firestore(),
    bucket = firebaseAdmin.storage().bucket();
  const projectId = firebaseAdmin.app().options.projectId!;
  const fixture = `stack-${randomUUID()}`,
    actorUid = fixture,
    requestId = `${fixture}-upload`;
  const directory = await mkdtemp(join(tmpdir(), 'temporal-local-stack-'));
  const control = db.doc('_control/temporalRelease'),
    previousControl = await control.get();
  const usageControl = db.doc(PROVIDER_USAGE_CONTROL),
    previousUsageControl = await usageControl.get();
  const existingDocs = new Set<string>();
  for (const collection of await db.listCollections()) {
    for (const doc of (await collection.get()).docs) existingDocs.add(doc.ref.path);
  }
  const objects: string[] = [];
  let environment: TestWorkflowEnvironment | undefined, dispatcher: OutboxDispatcher | undefined;
  const workers: Worker[] = [],
    runs: Promise<void>[] = [];
  let sermonId: string | undefined;
  try {
    await firebaseAdmin.auth().createUser({ uid: actorUid });
    await firebaseAdmin.auth().setCustomUserClaims(actorUid, { role: 'admin' });
    await control.set({
      schemaVersion: 1,
      revision: 1,
      admission: 'open',
      domains: { media: { owner: 'temporal', admission: 'open' } },
      updatedAt: Date.now(),
      releaseId: fixture,
    });
    // A fresh local stack has no provider bindings. Prove that condition before
    // installing the same readiness barrier required by the production cutover.
    for (const group of [
      'sermons',
      'lists',
      'series',
      'speakers',
      'images',
      'listItems',
      'sermonLists',
      'seriesItems',
      'durableJobIntents',
    ]) {
      for (const doc of (await db.collectionGroup(group).get()).docs) {
        expect(extractProviderResources(projectId, doc.ref.path, doc.data())).toEqual([]);
      }
    }
    await usageControl.set({
      schemaVersion: 1,
      projectId,
      epoch: fixture,
      status: 'ready',
      releaseId: fixture,
      controlRevision: 1,
    });
    const source = join(directory, 'source.wav'),
      bumper = join(directory, 'bumper.mp3');
    await runMediaCommand(
      getFFmpegPath(),
      ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', source],
      new AbortController().signal
    );
    await runMediaCommand(
      getFFmpegPath(),
      ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=0.7', bumper],
      new AbortController().signal
    );
    for (const kind of ['intro', 'outro']) {
      const path = `${kind}s/${fixture}_${kind}.mp3`;
      objects.push(path);
      await bucket.file(path).save(await readFile(bumper), { resumable: false });
    }
    const bytes = await readFile(source);
    const fingerprint = {
      algorithm: 'sha256-chunks-v1',
      chunkBytes: 4194304,
      value: createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest('hex'),
    };
    const request = {
      actorUid,
      requestId,
      kind: 'upload.create' as const,
      entity: { type: 'sermon' as const, id: 'client-placeholder' },
      payload: {
        sermon: { title: 'Full local stack integration', subtitle: fixture },
        source: { type: 'file', name: 'source.wav', size: bytes.length, lastModified: 1000, fingerprint },
        trimStart: 0.5,
        duration: 1,
      },
    };
    const [receipt, duplicate] = await Promise.all([submitServerDurableJob(request), submitServerDurableJob(request)]);
    expect(duplicate.jobId).toBe(receipt.jobId);
    expect(await getServerDurableJobReceipt(actorUid, requestId)).toEqual(receipt);
    expect((await db.doc(`durableJobs/${receipt.jobId}`).get()).get('state')).toBe('awaiting_source');
    const reservation = receipt.sourceUpload!;
    objects.push(reservation.storagePath);
    await bucket.file(reservation.storagePath).save(bytes, {
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: {
        contentType: 'audio/wav',
        metadata: { durableJobId: receipt.jobId, fingerprint: JSON.stringify(fingerprint) },
      },
    });
    const [metadata] = await bucket.file(reservation.storagePath).getMetadata();
    const resolution = { storagePath: reservation.storagePath, generation: String(metadata.generation) };
    const child = await confirmUploadSource(actorUid, receipt.jobId, resolution);
    expect(await confirmUploadSource(actorUid, receipt.jobId, resolution)).toEqual(child);
    expect((await db.doc(`durableJobs/${receipt.jobId}`).get()).data()).toMatchObject({
      state: 'succeeded',
      result: { mediaJobId: child.jobId, mediaJobRef: { projectId, jobId: child.jobId } },
    });
    const childDoc = db.doc(`durableJobs/${child.jobId}`);
    expect((await childDoc.get()).get('state')).toBe('queued');
    sermonId = (await childDoc.get()).get('entity.id');
    environment = await TestWorkflowEnvironment.createLocal();
    const activities = createRuntimeActivities(
      projectId,
      ['urm-orchestration', 'urm-media', 'urm-controls'],
      environment.client
    );
    for (const queue of ['urm-orchestration', 'urm-media', 'urm-controls'] as const) {
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        taskQueue: queue,
        ...(queue === 'urm-orchestration' ? { workflowsPath: require.resolve('../workflows/media') } : {}),
        activities: activities.queues[queue],
        shutdownGraceTime: '5 seconds',
        shutdownForceTime: '20 seconds',
      });
      workers.push(worker);
    }
    dispatcher = new OutboxDispatcher({ db, projectId, client: environment.client });
    await dispatcher.tick();
    expect(dispatcher.healthy).toBe(true);
    // Simulate the dispatcher crashing after Temporal accepted the start but before
    // its Firestore acknowledgement persisted. Recovery must reuse the same workflow.
    const dispatched = await db.collection('durableJobOutbox').where('dispatch.ref.jobId', '==', child.jobId).get();
    expect(dispatched.size).toBe(1);
    await dispatched.docs[0].ref.update({ state: 'dispatching', leaseExpiresAt: 0 });
    const restartedDispatcher = new OutboxDispatcher({ db, projectId, client: environment.client });
    await restartedDispatcher.tick();
    expect(restartedDispatcher.healthy).toBe(true);
    await restartedDispatcher.stop();
    expect((await dispatched.docs[0].ref.get()).get('state')).toBe('dispatched');
    for (const worker of workers) runs.push(worker.run());
    dispatcher.start();
    const observed = new Set<string>();
    const unsubscribe = childDoc.onSnapshot((snapshot) => observed.add(snapshot.get('state')));
    try {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const job = (await childDoc.get()).data()!;
        if (job.state === 'succeeded') break;
        if (['failed', 'needs_attention', 'cancelled', 'superseded'].includes(job.state))
          throw new Error(`Audio integration did not succeed: ${JSON.stringify(job)}`);
        await sleep(100);
      }
      expect((await childDoc.get()).get('state')).toBe('succeeded');
      expect(observed.has('running')).toBe(true);
    } finally {
      unsubscribe();
    }
    const sermon = (await db.doc(`sermons/${sermonId}`).get()).data()!;
    expect(sermon.status.audioStatus).toBe('PROCESSED');
    expect(sermon.audioArtifacts.jobId).toBe(child.jobId);
    expect(sermon.audioArtifacts.sourceDurationSeconds).toBeCloseTo(3, 1);
    expect(sermon.audioArtifacts.durationSeconds).toBeGreaterThan(2.3);
    expect(sermon.audioArtifacts.durationSeconds).toBeLessThan(3);
    const final = join(directory, 'final.mp3');
    await bucket.file(sermon.audioArtifacts.finalPath).download({ destination: final });
    const measured = await runMediaCommand(
      getFFprobePath(),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', final],
      new AbortController().signal
    );
    expect(Number(measured.trim())).toBeCloseTo(sermon.audioArtifacts.durationSeconds, 1);
    expect(await getServerDurableJobReceipt(actorUid, requestId)).toEqual(receipt);
    await dispatcher.tick();
    expect((await db.doc(`temporalMediaState/${sermonId}`).get()).get('ref.jobId')).toBe(child.jobId);
  } finally {
    await dispatcher?.stop();
    for (const worker of workers) if (worker.getState() === 'RUNNING') worker.shutdown();
    await Promise.allSettled(runs);
    await environment?.teardown();
    // This suite is serialized by the dedicated emulator harness; preserve all preexisting fixtures.
    for (const collection of await db.listCollections())
      for (const doc of (await collection.get()).docs) {
        if (doc.ref.path !== control.path && doc.ref.path !== usageControl.path && !existingDocs.has(doc.ref.path))
          await db.recursiveDelete(doc.ref);
      }
    if (previousControl.exists) await control.set(previousControl.data()!);
    else await control.delete();
    if (previousUsageControl.exists) await usageControl.set(previousUsageControl.data()!);
    else await usageControl.delete();
    if (sermonId) {
      await firebaseAdmin.database().ref(`processAudioRequests/${sermonId}`).remove();
      const [files] = await bucket.getFiles({ prefix: 'workflow-audio/' });
      for (const file of files) if (file.name.includes(sermonId)) await file.delete();
    }
    await Promise.all(objects.map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
    await firebaseAdmin.auth().deleteUser(actorUid);
    await rm(directory, { recursive: true, force: true });
  }
}, 240000);
