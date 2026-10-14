jest.mock('firebase-functions/v2', () => ({ firestore: { onDocumentWritten: jest.fn() } }));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({ __esModule: true, default: { firestore: jest.fn() } }));
jest.mock('../../DocumentListeners/currentCanonicalMirrors', () => ({
  ...jest.requireActual('../../DocumentListeners/currentCanonicalMirrors'),
  reconcileCurrentCanonicalMirrors: jest.fn(),
}));
jest.mock('../../handleError', () => ({ __esModule: true, default: (error: unknown) => error }));
jest.mock('../../algoliaSecrets', () => ({ algoliaSecretsWithRuntimeAlerts: [] }));
jest.mock('../../algoliaSyncSermon', () => ({ waitForSermonToReachAlgolia: jest.fn() }));
import { Timestamp } from 'firebase-admin/firestore';
import { firestore } from 'firebase-functions/v2';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { reconcileCurrentCanonicalMirrors } from '../../DocumentListeners/currentCanonicalMirrors';
import { waitForSermonToReachAlgolia } from '../../algoliaSyncSermon';

const sourceData = {
  id: 'sermon-1',
  title: 'Current canonical title',
  images: [],
  editedAtMillis: 7,
  searchPending: true,
};
const event = (before: unknown, after: unknown) => ({
  params: { sermonId: 'sermon-1' },
  data: { before: { data: () => before }, after: { data: () => after } },
});
let runHandler: (event: unknown) => Promise<void>;
let sourceTime: Timestamp;
let currentTime: Timestamp;
let currentExists: boolean;
let pending: boolean;
let writes: object[];
let docRead: jest.Mock;
let transaction: jest.Mock;
beforeAll(() => {
  const ref = { get: (...args: unknown[]) => docRead(...args) };
  jest.mocked(firebaseAdmin.firestore).mockReturnValue({
    doc: () => ref,
    runTransaction: (...args: unknown[]) => transaction(...args),
  } as unknown as ReturnType<typeof firebaseAdmin.firestore>);
  require('../../DocumentListeners/Sermons/sermonWriteTrigger');
  runHandler = jest.mocked(firestore.onDocumentWritten).mock.calls[0][1] as unknown as typeof runHandler;
});
beforeEach(() => {
  sourceTime = new Timestamp(10, 1);
  currentTime = sourceTime;
  currentExists = true;
  pending = true;
  writes = [];
  jest.mocked(reconcileCurrentCanonicalMirrors).mockReset().mockResolvedValue();
  jest.mocked(waitForSermonToReachAlgolia).mockReset().mockResolvedValue(true);
  docRead = jest.fn(async () => ({ data: () => sourceData, updateTime: sourceTime }));
  transaction = jest.fn(async (run) =>
    run({
      get: async () => ({ exists: currentExists, updateTime: currentTime, get: () => pending }),
      update: (_ref: unknown, patch: object) => writes.push(patch),
    })
  );
});
describe('sermonWriteTrigger current-state projection and acknowledgement', () => {
  it('ignores delayed delete events completely, preserving recreated roots, descendants and Storage', async () => {
    await runHandler(event(sourceData, undefined));
    expect(reconcileCurrentCanonicalMirrors).not.toHaveBeenCalled();
    expect(docRead).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
  it('acknowledges only the canonical revision actually observed by the index poll', async () => {
    await runHandler(event(undefined, { ...sourceData, title: 'Stale event title' }));
    expect(waitForSermonToReachAlgolia).toHaveBeenCalledWith({ sermonId: 'sermon-1', editedAtMillis: 7 });
    expect(writes).toMatchObject([{ searchPending: false }]);
  });
  it('does not acknowledge a newer edit even if editedAtMillis stayed the same', async () => {
    jest.mocked(waitForSermonToReachAlgolia).mockImplementation(async () => {
      currentTime = new Timestamp(10, 2);
      return true;
    });
    await runHandler(event(undefined, sourceData));
    expect(writes).toEqual([]);
  });
  it('does not resurrect a deleted or recreated canonical sermon after the index poll', async () => {
    jest.mocked(waitForSermonToReachAlgolia).mockImplementation(async () => {
      currentExists = false;
      return true;
    });
    await runHandler(event(undefined, sourceData));
    expect(writes).toEqual([]);
    currentExists = true;
    currentTime = new Timestamp(11, 0);
    await runHandler(event(undefined, sourceData));
    expect(writes).toEqual([]);
  });
  it('preserves nested media and placement structure while propagating canonical truth', async () => {
    await runHandler(event(undefined, sourceData));
    const [, options] = jest.mocked(reconcileCurrentCanonicalMirrors).mock.calls[0];
    const patch = options.project(
      { ...sourceData, numberOfLists: 99, publishActivity: 'private' },
      { type: 'sermon', mediaItem: {}, position: 3 }
    );
    expect(patch).toEqual({
      name: sourceData.title,
      images: [],
      mediaItem: { id: 'sermon-1', title: sourceData.title, images: [], editedAtMillis: 7 },
    });
    expect(patch).not.toHaveProperty('position');
  });
  it('does not poll or acknowledge if mirror reconciliation fails', async () => {
    jest.mocked(reconcileCurrentCanonicalMirrors).mockRejectedValue(new Error('PAGE_FAILED'));
    await expect(runHandler(event(undefined, sourceData))).rejects.toThrow('PAGE_FAILED');
    expect(waitForSermonToReachAlgolia).not.toHaveBeenCalled();
  });
});
