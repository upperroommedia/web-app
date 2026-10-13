import type { Firestore } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
import { createMediaAdmission } from './admission';

type RecordData = Record<string, any>;
class TransactionDatabase {
  readonly records = new Map<string, RecordData>();
  beforeFirstCommit?: () => void;
  collection(name: string): any {
    return {
      doc: (id: string) => ({
        path: `${name}/${id}`,
        id,
        collection: (child: string) => this.collection(`${name}/${id}/${child}`),
      }),
      limit: (_n: number) => ({ query: true, path: name }),
    };
  }
  async runTransaction<T>(callback: (transaction: any) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const writes: Array<() => void> = [];
      let wrote = false;
      const transaction = {
        get: async (document: { path: string }) => {
          if (wrote) throw new Error('Read after write');
          if ((document as any).query) return { docs: [], size: 0, empty: true };
          const data = this.records.get(document.path);
          return { exists: !!data, ref: document, data: () => data, get: (field: string) => data?.[field] };
        },
        create: (document: { path: string }, data: RecordData) => {
          wrote = true;
          writes.push(() => this.records.set(document.path, structuredClone(data)));
        },
        set: (document: { path: string }, data: RecordData) => {
          wrote = true;
          writes.push(() => this.records.set(document.path, structuredClone(data)));
        },
        update: (document: { path: string }, data: RecordData) => {
          wrote = true;
          writes.push(() =>
            this.records.set(document.path, { ...this.records.get(document.path), ...structuredClone(data) })
          );
        },
      };
      const result = await callback(transaction);
      if (attempt === 0 && this.beforeFirstCommit) {
        this.beforeFirstCommit();
        continue;
      }
      writes.forEach((write) => write());
      return result;
    }
    throw new Error('Transaction retry exhausted');
  }
}
function fixture() {
  const database = new TransactionDatabase();
  database.records.set('sermons/sermon', { uploaderId: 'actor' });
  database.records.set('durableUploadSessions/upload-job', {
    actorUid: 'actor',
    projectId: 'test-project',
    sermonId: 'sermon',
    state: 'awaiting_source',
  });
  database.records.set('durableJobs/upload-job', {
    requestedBy: 'actor',
    projectId: 'test-project',
    state: 'awaiting_source',
    revision: 1,
  });
  const admit = createMediaAdmission({
    firestore: database as unknown as Firestore,
    bucket: {
      name: 'test-bucket',
      file: () => ({ getMetadata: async () => [{ generation: '7', size: 100 }] }),
    } as unknown as Bucket,
    projectId: 'test-project',
    coordinatorTaskQueue: 'urm-orchestration',
    mediaTaskQueue: 'urm-media',
    assertLegacyDrained: async () => {},
    enqueueInTransaction: (transaction, input) => {
      transaction.create(database.collection('outbox').doc(input.ref.jobId) as any, input);
      transaction.create(database.collection('durableJobs').doc(input.ref.jobId) as any, {
        state: 'queued',
        projectId: input.ref.projectId,
        requestedBy: input.actorUid,
        revision: 1,
      });
    },
  });
  const args = {
    payload: { id: 'sermon', startTime: 0, duration: 30, storageFilePath: 'sermons/sermon' },
    actorUid: 'actor',
    requestId: 'source-ready',
    expectedSourceGeneration: '7',
    sourceUploadJobId: 'upload-job',
  };
  return { database, admit, args };
}

test('source confirmation and media outbox commit atomically', async () => {
  const { database, admit, args } = fixture();
  const result = await admit(args);
  expect(result.action).toBe('queued');
  expect(database.records.get('durableJobs/upload-job')?.state).toBe('succeeded');
  expect(database.records.get('durableUploadSessions/upload-job')?.mediaJobRef).toEqual(result.ref);
  expect(database.records.has(`outbox/${result.ref.jobId}`)).toBe(true);
  expect(database.records.get(`temporalMediaRequests/${result.ref.jobId}`)?.sources.storage).toEqual({
    path: 'sermons/sermon',
    generation: '7',
  });
  const repeated = await admit(args);
  expect(repeated.ref).toEqual(result.ref);
  expect(repeated.action).toBe('unchanged');
});

test('cancelled source upload cannot create media work', async () => {
  const { database, admit, args } = fixture();
  database.records.get('durableJobs/upload-job')!.state = 'cancelled';
  await expect(admit(args)).rejects.toThrow('cancelled');
  expect([...database.records.keys()].filter((key) => key.startsWith('outbox/'))).toEqual([]);
  expect(database.records.has('temporalMediaState/sermon')).toBe(false);
});

test('concurrent cancellation wins on transaction retry without publishing an outbox', async () => {
  const { database, admit, args } = fixture();
  database.beforeFirstCommit = () => {
    database.records.get('durableJobs/upload-job')!.state = 'cancelled';
  };
  await expect(admit(args)).rejects.toThrow('cancelled');
  expect(
    [...database.records.keys()].filter((key) => key.startsWith('outbox/') || key.startsWith('temporalMediaRequests/'))
  ).toEqual([]);
  expect(database.records.get('durableJobs/upload-job')!.state).toBe('cancelled');
});

test('source generation mismatch rejects before any media transaction', async () => {
  const { database, admit, args } = fixture();
  await expect(admit({ ...args, expectedSourceGeneration: '6' })).rejects.toThrow('generation changed');
  expect(database.records.has('temporalMediaState/sermon')).toBe(false);
});

test('another actor cannot confirm a reserved source upload', async () => {
  const { database, admit, args } = fixture();
  await expect(admit({ ...args, actorUid: 'other' })).rejects.toThrow('unavailable');
  expect(database.records.has('temporalMediaState/sermon')).toBe(false);
});

test('pending coalesced requests settle superseded while active work keeps ownership until cleanup', async () => {
  const { database, admit, args } = fixture();
  const initial = await admit(args);
  database.records.get('temporalMediaState/sermon')!.runningRef = initial.ref;
  const second = await admit({ ...args, sourceUploadJobId: undefined, requestId: 'edit-2' });
  expect(database.records.get(`durableJobs/${initial.ref.jobId}`)!.state).toBe('queued');
  const third = await admit({ ...args, sourceUploadJobId: undefined, requestId: 'edit-3' });
  expect(database.records.get(`durableJobs/${second.ref.jobId}`)!.state).toBe('superseded');
  expect(database.records.get('temporalMediaState/sermon')!.runningRef).toEqual(initial.ref);
  expect(database.records.get('temporalMediaState/sermon')!.ref).toEqual(third.ref);
});

test('same caller request ID cannot change media input', async () => {
  const { admit, args } = fixture();
  await admit({ ...args, sourceUploadJobId: undefined });
  await expect(
    admit({ ...args, sourceUploadJobId: undefined, payload: { ...args.payload, duration: 31 } })
  ).rejects.toThrow('different media input');
});
