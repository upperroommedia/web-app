jest.mock('firebase-functions/v2/firestore', () => ({ onDocumentUpdated: jest.fn() }));
jest.mock('firebase-functions/v2', () => ({ logger: { log: jest.fn(), debug: jest.fn(), error: jest.fn() } }));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({ __esModule: true, default: { firestore: jest.fn() } }));
jest.mock('../../DocumentListeners/currentCanonicalMirrors', () => ({
  ...jest.requireActual('../../DocumentListeners/currentCanonicalMirrors'),
  reconcileCurrentCanonicalMirrors: jest.fn(),
}));
jest.mock('../../handleError', () => ({ __esModule: true, default: (error: unknown) => error }));
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { reconcileCurrentCanonicalMirrors } from '../../DocumentListeners/currentCanonicalMirrors';
import '../../DocumentListeners/Lists/listOnUpdate';
const handler = jest.mocked(onDocumentUpdated).mock.calls[0][1] as unknown as (event: unknown) => Promise<void>;
const event = (before: object, after: object) => ({
  params: { listId: 'list-1' },
  data: { before: { data: () => before }, after: { data: () => after } },
});
describe('listOnUpdate', () => {
  beforeEach(() => {
    jest.mocked(reconcileCurrentCanonicalMirrors).mockReset();
  });
  it('uses only canonical identity to reconcile and does not pass stale event fields to the writer', async () => {
    await handler(event({ id: 'list-1', name: 'Old' }, { id: 'list-1', name: 'Stale event name' }));
    const [, options] = jest.mocked(reconcileCurrentCanonicalMirrors).mock.calls[0];
    expect(options).toMatchObject({
      sourcePath: 'lists/list-1',
      collectionGroup: 'sermonLists',
      parentCollection: 'sermons',
      id: 'list-1',
    });
    expect(options.project({ id: 'list-1', name: 'Newest' }, {})).toEqual({ id: 'list-1', name: 'Newest' });
  });
  it('avoids fanout for count and timestamp-only changes', async () => {
    await handler(
      event({ name: 'Same', count: 1, updatedAtMillis: 1 }, { name: 'Same', count: 2, updatedAtMillis: 2 })
    );
    expect(reconcileCurrentCanonicalMirrors).not.toHaveBeenCalled();
  });
  it('propagates a failed reconciliation so the event can retry', async () => {
    jest.mocked(reconcileCurrentCanonicalMirrors).mockRejectedValue(new Error('PAGE_FAILED'));
    await expect(handler(event({ name: 'Old' }, { name: 'New' }))).rejects.toThrow('PAGE_FAILED');
  });
});
