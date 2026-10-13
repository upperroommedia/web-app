import './resource-test-environment.cjs';
import { MockActivityEnvironment } from '@temporalio/testing';
import { createMediaActivities } from '../../../../process-audio/src/temporal/activities';
import { runMediaCommand } from '../../../../process-audio/src/temporal/native';
import { getFFmpegPath } from '../../../../process-audio/src/utils';
import { computeProcessAudioRequestVersion } from '@upperroom/contracts/processAudioQueue';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import type { MediaJobRef } from '../../../../process-audio/src/temporal/types';

const read = (value: any, field: string) => field.split('.').reduce((data, key) => data?.[key], value);
const update = (value: any, fields: Record<string, unknown>) => {
  for (const [field, next] of Object.entries(fields)) {
    const keys = field.split('.');
    let target = value;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys[keys.length - 1]] = next;
  }
};
class Store {
  records = new Map<string, any>();
  collection(name: string): any {
    return {
      limit: (_n: number) => ({
        get: async () => {
          const docs = [...this.records.keys()]
            .filter((p) => p.startsWith(name + '/') && p.slice(name.length + 1).split('/').length === 1)
            .map((p) => this.snapshot(p));
          return { docs, size: docs.length, empty: !docs.length };
        },
      }),
      doc: (id: string) => this.document(`${name}/${id}`),
    };
  }
  document(path: string): any {
    return {
      path,
      get: async () => this.snapshot(path),
      collection: (child: string) => this.collection(`${path}/${child}`),
    };
  }
  snapshot(path: string): any {
    return {
      exists: this.records.has(path),
      ref: this.document(path),
      data: () => this.records.get(path),
      get: (field: string) => read(this.records.get(path), field),
    };
  }
  async runTransaction(callback: (transaction: any) => Promise<any>) {
    const writes: Array<() => void> = [];
    const result = await callback({
      get: async (document: any) => this.snapshot(document.path),
      create: (document: any, value: any) => writes.push(() => this.records.set(document.path, value)),
      set: (document: any, value: any) => writes.push(() => this.records.set(document.path, value)),
      update: (document: any, patch: any) => writes.push(() => update(this.records.get(document.path), patch)),
    });
    writes.forEach((write) => write());
    return result;
  }
}
class Objects {
  name = 'test-bucket';
  objects = new Map<string, { bytes: Buffer; generation: string; metadata?: any }>();
  nextGeneration = 20;
  file(path: string, options?: { generation?: string }): any {
    const object = () => {
      const value = this.objects.get(path);
      if (!value || (options?.generation && value.generation !== options.generation))
        throw new Error('Storage generation mismatch');
      return value;
    };
    return {
      name: path,
      getMetadata: async () => [
        { generation: object().generation, size: object().bytes.length, metadata: object().metadata },
      ],
      createReadStream: () => Readable.from(object().bytes),
      createWriteStream: (configuration: any) => {
        const chunks: Buffer[] = [];
        return new Writable({
          write: (chunk, _encoding, done) => {
            chunks.push(Buffer.from(chunk));
            done();
          },
          final: (done) => {
            this.objects.set(path, {
              bytes: Buffer.concat(chunks),
              generation: String(this.nextGeneration++),
              metadata: configuration.metadata.metadata,
            });
            done();
          },
        });
      },
      delete: async () => {
        this.objects.delete(path);
      },
    };
  }
}

test('real staged audio retains original coordinates, publishes measured final media and preserves provider state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'media-pipeline-test-'));
  try {
    const raw = join(directory, 'source.wav');
    const bumper = join(directory, 'bumper.mp3');
    await runMediaCommand(
      getFFmpegPath(),
      ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', raw],
      new AbortController().signal
    );
    await runMediaCommand(
      getFFmpegPath(),
      ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=0.7', bumper],
      new AbortController().signal
    );
    const objects = new Objects();
    objects.objects.set('sermons/sermon', { bytes: await readFile(raw), generation: '7' });
    objects.objects.set('intros/default_intro.mp3', { bytes: await readFile(bumper), generation: '8' });
    objects.objects.set('outros/default_outro.mp3', { bytes: await readFile(bumper), generation: '9' });
    const store = new Store();
    const payload = {
      id: 'sermon',
      storageFilePath: 'sermons/sermon',
      startTime: 0.5,
      duration: 1,
      introUrl: 'intros/default_intro.mp3',
      outroUrl: 'outros/default_outro.mp3',
    };
    const reference: MediaJobRef = {
      jobId: 'audio-test',
      projectId: 'test-project',
      sermonId: 'sermon',
      revision: 1,
      requestVersion: computeProcessAudioRequestVersion(payload),
    };
    store.records.set('temporalMediaRequests/audio-test', {
      ref: reference,
      payload,
      sources: {
        storage: { path: 'sermons/sermon', generation: '7' },
        intro: { path: payload.introUrl, generation: '8' },
        outro: { path: payload.outroUrl, generation: '9' },
      },
    });
    store.records.set('temporalMediaState/sermon', { owner: 'temporal', ref: reference });
    store.records.set('durableJobs/audio-test', { state: 'queued' });
    store.records.set('sermons/sermon', {
      status: { audioStatus: 'PENDING', subsplash: 'UPLOADED', soundCloud: 'UPLOADED' },
    });
    const progress = new Map<string, any>();
    const activity = createMediaActivities({
      projectId: 'test-project',
      firestore: store as any,
      bucket: objects as any,
      database: {
        ref: (path: string) => ({
          transaction: async (change: (current: any) => any) => {
            const next = change(progress.get(path));
            if (next !== undefined) progress.set(path, next);
          },
        }),
      } as any,
      ytdlpPath: 'unused',
      assertAuthorized: async () => {},
      projectJob: async (ref, projection) => {
        store.records.get(`durableJobs/${ref.jobId}`).state = projection.state;
      },
    });
    const environment = new MockActivityEnvironment();
    expect(await environment.run(activity.prepareMedia, reference)).toEqual({ kind: 'ready' });
    expect(await environment.run(activity.acquireMedia, reference)).toEqual({ kind: 'ready' });
    expect(await environment.run(activity.mergeMedia, reference)).toEqual({ kind: 'ready' });
    const beforeRetry = objects.objects.size;
    await environment.run(activity.acquireMedia, reference);
    await environment.run(activity.mergeMedia, reference);
    expect(objects.objects.size).toBe(beforeRetry);
    expect(await environment.run(activity.publishMedia, reference)).toEqual({ kind: 'ready' });
    const sermon = store.records.get('sermons/sermon');
    expect(sermon.status).toEqual({
      audioStatus: 'PROCESSED',
      message: 'Completed',
      subsplash: 'UPLOADED',
      soundCloud: 'UPLOADED',
    });
    expect(sermon.audioArtifacts.sourceDurationSeconds).toBeCloseTo(3, 1);
    expect(sermon.audioArtifacts.durationSeconds).toBeGreaterThan(2.3);
    expect(sermon.audioArtifacts.durationSeconds).toBeLessThan(3);
    expect(sermon.audioArtifacts.sourcePath).not.toBe(sermon.audioArtifacts.processedPath);
    expect(objects.objects.get(sermon.audioArtifacts.finalPath)!.metadata.firebaseStorageDownloadTokens).toBeTruthy();
    store.records.get('temporalMediaState/sermon').ref = { ...reference, jobId: 'newer-job', revision: 2 };
    expect(await environment.run(activity.publishMedia, reference)).toEqual({ kind: 'superseded' });
    expect(sermon.audioArtifacts.jobId).toBe(reference.jobId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
