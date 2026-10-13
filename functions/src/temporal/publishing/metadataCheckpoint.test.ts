jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    firestore: () => {
      throw new Error('Live SDK forbidden in metadata checkpoint unit tests');
    },
  },
}));
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { preparePublishingMetadataCheckpoint, assertPublishingMetadataCheckpoint } from './metadataCheckpoint';
import {
  claimPublishingAllocation,
  preparePublishingAllocationCommit,
  assertPublishingContentUpdateAllocationsSettled,
  capturePublishingAllocationSource,
} from './allocationBarrier';
import type { PrivatePublishingIntent } from './types';
const ref = { projectId: 'project', jobId: 'edit-job' };
const intent: PrivatePublishingIntent = {
  sermonId: 'sermon',
  actorUid: 'actor',
  generation: 1,
  action: 'update',
  payload: { patch: { title: 'New title' } },
  destinations: { listIds: [], soundcloud: false },
};
function fixture() {
  const data = new Map<string, Record<string, unknown>>([
    ['sermons/sermon', { title: 'Old title', editedAtMillis: 0 }],
  ]);
  const doc = (path: string) => ({ path }),
    snapshot = (path: string) => ({
      exists: data.has(path),
      data: () => data.get(path),
      get: (key: string) => key.split('.').reduce((value: any, field) => value?.[field], data.get(path)),
    });
  const db = {
    doc,
    collection: (name: string) => ({ doc: (id: string) => doc(`${name}/${id}`) }),
  } as unknown as Firestore;
  const tx = {
    get: async (target: { path: string }) => snapshot(target.path),
    create: (target: { path: string }, value: Record<string, unknown>) => data.set(target.path, value),
    set: (target: { path: string }, value: Record<string, unknown>) => data.set(target.path, value),
    update: (target: { path: string }, value: Record<string, unknown>) => Object.assign(data.get(target.path)!, value),
  } as unknown as Transaction;
  const store = { commitCurrent: async (_ref: unknown, mutate: (tx: Transaction) => Promise<void>) => mutate(tx) };
  return { data, db, tx, store };
}
it('rejects a provider that appeared after a pre-admitted zero-provider metadata stage', async () => {
  const f = fixture(),
    initial = f.data.get('sermons/sermon')!;
  const complete = await preparePublishingMetadataCheckpoint(f.tx, f.db, ref, intent, initial, 'completed');
  complete();
  const creation = {
    ref: { projectId: 'project', jobId: 'list-job' },
    sermonId: 'sermon',
    provider: 'subsplash' as const,
    operationKey: 'durable:project:list-job:create',
    source: capturePublishingAllocationSource(initial),
  };
  await claimPublishingAllocation(f.db, f.store, creation);
  const bind = await preparePublishingAllocationCommit(f.tx, f.db, creation, 'media');
  f.data.set('sermons/sermon', { ...initial, subsplashId: 'media' });
  bind();
  await expect(
    assertPublishingContentUpdateAllocationsSettled(f.tx, f.db, { ref, sermonId: 'sermon' })
  ).resolves.toBeUndefined();
  await expect(
    assertPublishingMetadataCheckpoint(f.tx, f.db, ref, intent, f.data.get('sermons/sermon')!)
  ).rejects.toMatchObject({ code: 'PUBLISHING_METADATA_DESTINATIONS_CHANGED' });
  expect(f.data.get('sermons/sermon')?.title).toBe('Old title');
});
it('accepts only the exact provider set and canonical content synchronized by metadata completion', async () => {
  const f = fixture(),
    original = { title: 'Old title', editedAtMillis: 0, subsplashId: 'media' };
  f.data.set('sermons/sermon', original);
  const start = await preparePublishingMetadataCheckpoint(f.tx, f.db, ref, intent, original, 'prepared');
  start();
  const synchronized = { ...original, title: 'New title', editedAtMillis: 1 };
  const done = await preparePublishingMetadataCheckpoint(f.tx, f.db, ref, intent, synchronized, 'completed');
  f.data.set('sermons/sermon', synchronized);
  done();
  await expect(assertPublishingMetadataCheckpoint(f.tx, f.db, ref, intent, synchronized)).resolves.toBeUndefined();
  await expect(
    assertPublishingMetadataCheckpoint(f.tx, f.db, ref, intent, {
      ...synchronized,
      title: 'Another edit',
      editedAtMillis: 2,
    })
  ).rejects.toMatchObject({ code: 'PUBLISHING_METADATA_DESTINATIONS_CHANGED' });
});
