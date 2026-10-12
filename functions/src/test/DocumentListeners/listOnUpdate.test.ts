jest.mock('firebase-functions/v2/firestore', () => ({ onDocumentUpdated: jest.fn() }));
jest.mock('firebase-functions/v2', () => ({ logger: { log: jest.fn(), debug: jest.fn(), error: jest.fn() } }));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({ __esModule: true, default: { firestore: jest.fn() } }));
jest.mock('../../firestoreDataConverter', () => ({ firestoreAdminSermonListConverter: {} }));
jest.mock('../../handleError', () => ({ __esModule: true, default: (error: unknown) => error }));

import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import '../../DocumentListeners/Lists/listOnUpdate';

type TestEvent = { params: { listId: string }; data: { before: { data: () => object }; after: { data: () => object } } };
const handler = jest.mocked(onDocumentUpdated).mock.calls[0][1] as unknown as (event: TestEvent) => Promise<void>;
const event: TestEvent = {
  params: { listId: 'list-1' },
  data: {
    before: { data: () => ({ id: 'list-1', name: 'Old name' }) },
    after: { data: () => ({ id: 'list-1', name: 'New name' }) },
  },
};

function configureFirestore(docCount: number, failCommit?: number) {
  const docs = Array.from({ length: docCount }, (_, index) => ({ ref: { id: `sermon-${index}` } }));
  const committed: Array<Array<{ id: string }>> = [];
  const failure = new Error('commit failed');
  const query = { withConverter: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ docs, size: docs.length }) };
  const batch = jest.fn(() => {
    const refs: Array<{ id: string }> = [];
    return {
      update: (ref: { id: string }) => { refs.push(ref); },
      commit: async () => {
        if (refs.length > 500) throw new Error('batch write limit exceeded');
        committed.push(refs);
        if (committed.length === failCommit) throw failure;
      },
    };
  });
  jest.mocked(firebaseAdmin.firestore).mockReturnValue({ collectionGroup: () => query, batch } as unknown as ReturnType<typeof firebaseAdmin.firestore>);
  return { docs, committed, batch, failure };
}

describe('listOnUpdate', () => {
  it('updates every sermon mirror for a list linked to more than 500 sermons', async () => {
    const { docs, committed } = configureFirestore(1001);
    await handler(event);
    expect(committed.map((refs) => refs.length)).toEqual([450, 450, 101]);
    expect(committed.flat()).toEqual(docs.map((doc) => doc.ref));
  });

  it('propagates a failed commit without starting later batches', async () => {
    const { failure, batch } = configureFirestore(1001, 2);
    await expect(handler(event)).rejects.toBe(failure);
    expect(batch).toHaveBeenCalledTimes(2);
  });
});
