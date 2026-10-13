import type { Firestore } from 'firebase-admin/firestore';
const mockPrograms: Array<{ writes: unknown[]; finalFragment?: boolean }> = [];
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: () => ({ options: { projectId: 'project' } }) },
}));
jest.mock('../subsplashUtils', () => ({ authenticateSubsplash: jest.fn(), createAxiosConfig: jest.fn() }));
jest.mock('../temporal/publishing/durableOperationContext', () => ({
  getDurablePublishingJobId: () => 'job',
  getPublishingMutationOperation: () => 'speaker-delete',
  runDurableTransaction: async (db: { runTransaction: (run: unknown) => unknown }, run: unknown) =>
    db.runTransaction(run),
  publishingMutationRequestFingerprint: () => 'f'.repeat(64),
  prepareAcknowledgedProjectionPlan: async (_tx: unknown, plan: { writes: unknown[]; finalFragment?: boolean }) => {
    mockPrograms.push(plan);
    return { projectionDigest: 'digest', commit: () => {} };
  },
}));
import {
  prepareSpeakerDeletionMirrors,
  removeSpeakerDeletionMirrors,
  SPEAKER_DELETION_MIRROR_PLANS,
} from './speakerDeletionMirrors';

type Data = Record<string, unknown>;
function fakeFirestore(initial: Map<string, Data>) {
  const data = new Map(initial);
  const writes: string[] = [];
  const snapshot = (path: string): any => {
    const value = data.get(path);
    return {
      id: path.split('/').at(-1),
      ref: reference(path),
      exists: value !== undefined,
      data: () => value,
      get: (field: string) =>
        field
          .split('.')
          .reduce<unknown>(
            (current, key) => (current && typeof current === 'object' ? (current as Data)[key] : undefined),
            value
          ),
    };
  };
  const reference = (path: string): any => ({
    path,
    id: path.split('/').at(-1),
    collection: (name: string) => query(`${path}/${name}`),
    get: async () => snapshot(path),
  });
  const query = (path: string, limit = Infinity, cursor = ''): any => ({
    doc: (id: string) => reference(`${path}/${id}`),
    orderBy: () => query(path, limit, cursor),
    limit: (next: number) => query(path, next, cursor),
    startAfter: (doc: { ref: { path: string } }) => query(path, limit, doc.ref.path),
    get: async () => {
      const selected = [...data.keys()]
        .filter(
          (key) =>
            key > cursor &&
            (path.startsWith('@group:')
              ? key.split('/').length === 4 && key.split('/')[2] === path.slice(7)
              : key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1)
        )
        .sort()
        .slice(0, limit);
      const docs = selected.map(snapshot);
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  });
  const tx = {
    get: async (ref: { path: string }) => snapshot(ref.path),
    getAll: async (...refs: Array<{ path: string }>) => refs.map((ref) => snapshot(ref.path)),
    create: (ref: { path: string }, value: Data) => {
      if (data.has(ref.path)) throw Error('duplicate');
      data.set(ref.path, value);
      writes.push(ref.path);
    },
    set: (ref: { path: string }, value: Data) => {
      data.set(ref.path, value);
      writes.push(ref.path);
    },
    update: (ref: { path: string }, value: Data) => {
      data.set(ref.path, { ...data.get(ref.path), ...value });
      writes.push(ref.path);
    },
  };
  const db = {
    doc: reference,
    collection: query,
    collectionGroup: (group: string) => query(`@group:${group}`),
    runTransaction: async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx),
  };
  return { db: db as unknown as Firestore, data, writes };
}
function fixture(count: number) {
  const intent = {
    projectId: 'project',
    jobId: 'job',
    kind: 'speaker.mutate',
    generation: 1,
    entity: { type: 'speaker', id: 'selected' },
    payload: {
      kind: 'speaker.mutate',
      entity: { type: 'speaker', id: 'selected' },
      payload: { operation: 'delete', input: { speakerId: 'selected' } },
    },
  };
  const initial = new Map<string, Data>([
    ['durableJobIntents/job', intent],
    ['durableJobs/job', { ...intent, state: 'running' }],
    ['speakers/selected', { id: 'selected', tagId: 'tag' }],
  ]);
  for (let i = 0; i < count; i++)
    initial.set(`sermons/s${String(i).padStart(4, '0')}`, {
      id: `s${i}`,
      speakers: [
        { id: 'selected', tagId: 'tag' },
        { id: 'keep', tagId: 'keep-tag' },
      ],
      keep: 'unchanged',
    });
  initial.set('lists/list/listItems/sermon', {
    mediaItem: { speakers: [{ id: 'selected', tagId: 'tag' }], title: 'Preserve' },
    position: 4,
  });
  initial.set('series/series/seriesItems/sermon', { speakers: [{ id: 'selected', tagId: 'tag' }], position: 5 });
  return fakeFirestore(initial);
}
beforeEach(() => {
  mockPrograms.length = 0;
});
it('captures more than one scan page and streams bounded immutable fragments without canonical pruning', async () => {
  const f = fixture(230);
  const handle = await prepareSpeakerDeletionMirrors(f.db, { speakerId: 'selected', tagId: 'tag' });
  expect(
    f.writes.every(
      (path) =>
        path.startsWith(SPEAKER_DELETION_MIRROR_PLANS + '/') || path.startsWith('temporalProviderDesiredDeletionPlans/')
    )
  ).toBe(true);
  expect(f.data.get('sermons/s0000')?.speakers as unknown[]).toHaveLength(2);
  expect(
    [...f.data.keys()].filter((path) => path.startsWith(`${SPEAKER_DELETION_MIRROR_PLANS}/${handle.planId}/rows/`))
  ).toHaveLength(232);
  expect(mockPrograms.slice(0, -1).every((plan) => plan.writes.length <= 64 && plan.finalFragment === false)).toBe(
    true
  );
  expect(mockPrograms.at(-1)).toMatchObject({
    writes: [],
    verifications: [],
    finalFragment: true,
    completesActivity: false,
  });
  expect(f.data.get(`${SPEAKER_DELETION_MIRROR_PLANS}/${handle.planId}`)?.state).toBe('prepared');
});
it('refuses pruning when no original DELETE acknowledgement exists', async () => {
  const f = fixture(1);
  const handle = await prepareSpeakerDeletionMirrors(f.db, { speakerId: 'selected', tagId: 'tag' });
  await expect(removeSpeakerDeletionMirrors(f.db, handle)).rejects.toThrow('SPEAKER_DELETION_MIRROR_PROOF_INVALID');
  expect(f.data.get('sermons/s0000')?.speakers as unknown[]).toHaveLength(2);
});
