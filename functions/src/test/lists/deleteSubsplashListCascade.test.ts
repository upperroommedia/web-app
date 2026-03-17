import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import axios from 'axios';
import deleteSubsplashList from '../../deleteSubsplashList';
import { authenticateSubsplash } from '../../subsplashUtils';
import type {
  DeleteSubsplashListInputType,
  DeleteSubsplashListOutputType,
} from '../../../../packages/contracts/deleteSubsplashList';
import { ListType, OverflowBehavior } from '@upperroom/shared/types/List';

jest.mock('firebase-functions/v2/https', () => {
  const actual = jest.requireActual('firebase-functions/v2/https');
  return {
    ...actual,
    onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: unknown) =>
      (typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler)
    ),
  };
});

jest.mock('axios');
jest.mock('../../subsplashUtils', () => {
  const actual = jest.requireActual('../../subsplashUtils');
  return {
    ...actual,
    authenticateSubsplash: jest.fn(async () => 'subsplash-token'),
  };
});

jest.mock('../../locks/withIdempotency', () => ({
  withIdempotency: jest.fn(async (_operationKey: string, run: () => Promise<unknown>) => run()),
}));

jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: jest.fn(async (_lockKeys: string[], run: () => Promise<unknown>) => run()),
}));

jest.setTimeout(45_000);

type CallableAuthType = {
  uid?: string;
  token?: {
    role?: string;
  };
};

type TestRequestType<T> = {
  auth?: CallableAuthType;
  data: T;
};

const firestore = firebaseAdmin.firestore();
const mockAxios = axios as jest.MockedFunction<typeof axios>;
const mockAuthenticateSubsplash = authenticateSubsplash as jest.MockedFunction<typeof authenticateSubsplash>;
const deleteSubsplashListHandler = deleteSubsplashList as unknown as (
  request: TestRequestType<DeleteSubsplashListInputType>
) => Promise<DeleteSubsplashListOutputType>;

const defaultAuth: CallableAuthType = {
  uid: 'admin-1',
  token: {
    role: 'admin',
  },
};

const clearCollection = async (collectionName: string): Promise<void> => {
  const snapshot = await firestore.collection(collectionName).get();
  if (snapshot.empty) {
    return;
  }

  const batch = firestore.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
};

describe('deleteSubsplashList cascade deletion', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.SUBSPLASH_EMAIL = 'test@example.com';
    process.env.SUBSPLASH_PASSWORD = 'test-password';
    mockAxios.mockResolvedValue({ status: 204, data: null } as never);
    mockAuthenticateSubsplash.mockResolvedValue('subsplash-token');
    await clearCollection('lists');
  });

  it('deletes the full overflow chain remotely and locally when deleting the root list', async () => {
    const now = Date.now();
    await firestore.collection('lists').doc('root-list').set({
      id: 'root-list',
      name: 'Root List',
      type: ListType.SPEAKER_LIST,
      images: [],
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      createdAtMillis: now,
      updatedAtMillis: now,
      count: 2,
      logicalCount: 4,
      hasOverflowPages: true,
      subsplashId: 'subsplash-root',
      moreSermonsRef: 'subsplash-overflow-1',
      isRootList: true,
      isMoreSermonsList: false,
      rootListId: 'root-list',
      overflowDepth: 0,
    });
    await firestore.collection('lists').doc('root-list').collection('listItems').doc('sermon-1').set({
      id: 'sermon-1',
      position: 1,
    });
    await firestore.collection('lists').doc('overflow-list-1').set({
      id: 'overflow-list-1',
      name: 'More Root List sermons',
      type: ListType.SPEAKER_LIST,
      images: [],
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      createdAtMillis: now,
      updatedAtMillis: now,
      count: 2,
      subsplashId: 'subsplash-overflow-1',
      moreSermonsRef: 'subsplash-overflow-2',
      isRootList: false,
      isMoreSermonsList: true,
      rootListId: 'root-list',
      overflowDepth: 1,
    });
    await firestore.collection('lists').doc('overflow-list-2').set({
      id: 'overflow-list-2',
      name: 'More Root List sermons',
      type: ListType.SPEAKER_LIST,
      images: [],
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      createdAtMillis: now,
      updatedAtMillis: now,
      count: 0,
      subsplashId: 'subsplash-overflow-2',
      isRootList: false,
      isMoreSermonsList: true,
      rootListId: 'root-list',
      overflowDepth: 2,
    });

    await expect(
      deleteSubsplashListHandler({
        auth: defaultAuth,
        data: { listId: 'root-list', operationKey: 'delete-root-chain-1' },
      })
    ).resolves.toMatchObject({
      status: 'deleted',
      deletedFirestoreListIds: ['overflow-list-2', 'overflow-list-1', 'root-list'],
      deletedSubsplashListIds: ['subsplash-overflow-2', 'subsplash-overflow-1', 'subsplash-root'],
    });

    expect((await firestore.collection('lists').doc('root-list').get()).exists).toBe(false);
    expect((await firestore.collection('lists').doc('overflow-list-1').get()).exists).toBe(false);
    expect((await firestore.collection('lists').doc('overflow-list-2').get()).exists).toBe(false);
    expect(mockAxios).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'DELETE',
        url: 'https://core.subsplash.com/builder/v1/lists/subsplash-overflow-2',
      })
    );
    expect(mockAxios).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'DELETE',
        url: 'https://core.subsplash.com/builder/v1/lists/subsplash-overflow-1',
      })
    );
    expect(mockAxios).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: 'DELETE',
        url: 'https://core.subsplash.com/builder/v1/lists/subsplash-root',
      })
    );
  });

  it('deletes the full logical chain even when the requested list id is an overflow page', async () => {
    const now = Date.now();
    await firestore.collection('lists').doc('root-list').set({
      id: 'root-list',
      name: 'Root List',
      type: ListType.SPEAKER_LIST,
      images: [],
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      createdAtMillis: now,
      updatedAtMillis: now,
      count: 2,
      logicalCount: 4,
      hasOverflowPages: true,
      subsplashId: 'subsplash-root',
      moreSermonsRef: 'subsplash-overflow-1',
      isRootList: true,
      isMoreSermonsList: false,
      rootListId: 'root-list',
      overflowDepth: 0,
    });
    await firestore.collection('lists').doc('overflow-list-1').set({
      id: 'overflow-list-1',
      name: 'More Root List sermons',
      type: ListType.SPEAKER_LIST,
      images: [],
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      createdAtMillis: now,
      updatedAtMillis: now,
      count: 2,
      subsplashId: 'subsplash-overflow-1',
      isRootList: false,
      isMoreSermonsList: true,
      rootListId: 'root-list',
      overflowDepth: 1,
    });

    await expect(
      deleteSubsplashListHandler({
        auth: defaultAuth,
        data: { listId: 'overflow-list-1', operationKey: 'delete-overflow-chain-1' },
      })
    ).resolves.toMatchObject({
      status: 'deleted',
      requestedListId: 'overflow-list-1',
      rootListId: 'root-list',
      deletedFirestoreListIds: ['overflow-list-1', 'root-list'],
      deletedSubsplashListIds: ['subsplash-overflow-1', 'subsplash-root'],
    });

    expect((await firestore.collection('lists').doc('root-list').get()).exists).toBe(false);
    expect((await firestore.collection('lists').doc('overflow-list-1').get()).exists).toBe(false);
  });
});
