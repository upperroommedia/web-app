import { createEmptySermon } from '../../types/Sermon';
import { List, ListType, OverflowBehavior } from '../../types/List';
import { sermonStatusType, uploadStatus } from '../../types/SermonTypes';

const updateDocMock = jest.fn();
const getDocMock = jest.fn();
const getDocsMock = jest.fn();
const writeBatchDeleteMock = jest.fn();
const writeBatchSetMock = jest.fn();
const writeBatchUpdateMock = jest.fn();
const writeBatchCommitMock = jest.fn();
const writeBatchMock = jest.fn();
const docMock = jest.fn();
const collectionGroupMock = jest.fn();
const collectionMock = jest.fn();
const queryMock = jest.fn();
const whereMock = jest.fn();
const orderByMock = jest.fn();
const limitMock = jest.fn();
const createFunctionV2Mock = jest.fn();
const runTransactionMock = jest.fn();
const transactionGetMock = jest.fn();
const getDownloadURLMock = jest.fn();
const refMock = jest.fn();
const compactSeriesItemPositionsMock = jest.fn();

jest.mock('../../firebase/firestore', () => ({
  __esModule: true,
  default: {},
  Timestamp: {
    fromMillis: (millis: number) => ({ toMillis: () => millis }),
  },
  deleteField: jest.fn(() => 'DELETE_FIELD'),
  increment: jest.fn((value: number) => `increment:${value}`),
  limit: (...args: unknown[]) => limitMock(...args),
  orderBy: (...args: unknown[]) => orderByMock(...args),
  updateDoc: (...args: unknown[]) => updateDocMock(...args),
  getDoc: (...args: unknown[]) => getDocMock(...args),
  getDocs: (...args: unknown[]) => getDocsMock(...args),
  writeBatch: (...args: unknown[]) => writeBatchMock(...args),
  doc: (...args: string[]) => docMock(...args),
  collectionGroup: (...args: unknown[]) => collectionGroupMock(...args),
  collection: (...args: unknown[]) => collectionMock(...args),
  query: (...args: unknown[]) => queryMock(...args),
  where: (...args: unknown[]) => whereMock(...args),
  runTransaction: (...args: unknown[]) => runTransactionMock(...args),
}));

jest.mock('../../utils/createFunction', () => ({
  __esModule: true,
  createFunctionV2: (...args: unknown[]) => createFunctionV2Mock(...args),
}));

jest.mock('../../utils/compactSeriesItemPositions', () => ({
  compactSeriesItemPositions: (...args: unknown[]) => compactSeriesItemPositionsMock(...args),
}));

jest.mock('../../firebase/storage', () => ({
  __esModule: true,
  getStorage: jest.fn(() => ({})),
  getDownloadURL: (...args: unknown[]) => getDownloadURLMock(...args),
  ref: (...args: unknown[]) => refMock(...args),
}));

jest.mock('../../firebase/firebase', () => ({
  __esModule: true,
  default: {},
  isDevelopment: false,
}));

jest.mock('../../utils/callableConcurrency', () => ({
  __esModule: true,
  createOperationKey: jest.fn(() => 'operation-key'),
  createPublishedMembershipHash: jest.fn(() => 'membership-hash'),
  createRetryIntentKey: jest.fn((scope: string, id: string, suffix: string) => `${scope}:${id}:${suffix}`),
  parseLockBusyDetails: jest.fn(() => null),
}));

const buildList = (overrides: Partial<List>): List =>
  ({
    id: overrides.id ?? 'list-id',
    name: overrides.name ?? 'List',
    images: overrides.images ?? [],
    overflowBehavior: overrides.overflowBehavior ?? OverflowBehavior.CREATENEWLIST,
    type: overrides.type ?? ListType.TOPIC_LIST,
    createdAtMillis: overrides.createdAtMillis ?? 0,
    updatedAtMillis: overrides.updatedAtMillis ?? 0,
    ...overrides,
  }) as List;

const buildListDoc = (list: Partial<List> & { id: string }) => ({
  id: list.id,
  data: () => list,
  ref: {
    path: `sermons/sermon-1/sermonLists/${list.id}`,
    parent: {
      parent: {
        id: 'sermon-1',
      },
    },
  },
});

const buildListItemDoc = (listId: string) => ({
  ref: {
    parent: {
      parent: {
        id: listId,
      },
    },
  },
});

const getListItemWrite = (listId: string) =>
  writeBatchSetMock.mock.calls.find(
    ([ref]) => (ref as { path?: string }).path === `lists/${listId}/listItems/sermon-1`
  );

const createFunctionMap = () => {
  const map: Record<string, jest.Mock> = {
    editSoundCloudSermon: jest.fn().mockResolvedValue({ soundCloudTrackUrl: 'https://soundcloud.test/updated' }),
    editSubsplashSermon: jest.fn().mockResolvedValue(undefined),
    addtolist: jest.fn().mockResolvedValue([]),
    removefromlist: jest.fn().mockResolvedValue([]),
    addtoseries: jest.fn().mockResolvedValue({ status: 'success' }),
    removefromseries: jest.fn().mockResolvedValue({ status: 'success', message: 'ok', mediaItemId: 'subsplash-1' }),
    reorderseriesitems: jest.fn().mockResolvedValue({ status: 'success' }),
    createseries: jest.fn().mockResolvedValue({ status: 'success', subsplashId: 'series-subsplash-2' }),
    createnewsubsplashlist: jest.fn().mockResolvedValue({ listId: 'subsplash-list-new' }),
    uploadToSubsplash: jest.fn().mockResolvedValue({ id: 'subsplash-created' }),
    deletefromsubsplash: jest.fn().mockResolvedValue(undefined),
  };

  createFunctionV2Mock.mockImplementation((name: string) => {
    const fn = map[name];
    if (!fn) {
      throw new Error(`Unexpected callable requested in test: ${name}`);
    }
    return fn;
  });

  return map;
};

describe('editSermon remote edit reconciliation', () => {
  beforeEach(() => {
    jest.resetModules();
    updateDocMock.mockReset().mockResolvedValue(undefined);
    getDocMock.mockReset().mockResolvedValue({ exists: () => false });
    getDocsMock.mockReset();
    writeBatchDeleteMock.mockReset();
    writeBatchSetMock.mockReset();
    writeBatchUpdateMock.mockReset();
    writeBatchCommitMock.mockReset().mockResolvedValue(undefined);
    writeBatchMock.mockReset().mockReturnValue({
      delete: writeBatchDeleteMock,
      set: writeBatchSetMock,
      update: writeBatchUpdateMock,
      commit: writeBatchCommitMock,
    });
    docMock.mockReset().mockImplementation((...segments: string[]) => ({
      path: segments.filter((segment) => typeof segment === 'string').join('/'),
      id: segments[segments.length - 1],
      withConverter() {
        return this;
      },
    }));
    collectionGroupMock.mockReset().mockImplementation((...args: unknown[]) => ({ kind: 'collectionGroup', args }));
    collectionMock.mockReset().mockImplementation((...args: unknown[]) => ({
      kind: 'collection',
      args,
      withConverter() {
        return this;
      },
    }));
    queryMock.mockReset().mockImplementation((...args: unknown[]) => ({
      args,
      withConverter() {
        return this;
      },
    }));
    whereMock.mockReset().mockImplementation((...args: unknown[]) => args);
    orderByMock.mockReset().mockImplementation((...args: unknown[]) => args);
    limitMock.mockReset().mockImplementation((...args: unknown[]) => args);
    createFunctionV2Mock.mockReset();
    compactSeriesItemPositionsMock.mockReset().mockResolvedValue(undefined);
    transactionGetMock.mockReset().mockImplementation(async (ref: { path?: string }) => ({
      exists: () => true,
      data: () => {
        if (!ref.path?.startsWith('sermons/')) {
          return {};
        }
        const editableSermon = createEmptySermon('user-1');
        editableSermon.status.audioStatus = sermonStatusType.ERROR;
        return editableSermon;
      },
    }));
    runTransactionMock.mockReset().mockImplementation(async (_firestore, callback) => callback({
      delete: writeBatchDeleteMock,
      get: transactionGetMock,
      set: writeBatchSetMock,
      update: writeBatchUpdateMock,
    }));
    getDownloadURLMock.mockReset().mockResolvedValue('https://storage.test/audio.mp3');
    refMock.mockReset().mockReturnValue('storage-ref');
    global.alert = jest.fn();
  });

  it('updates published metadata without churning list or series memberships', async () => {
    const functions = createFunctionMap();
    const editSermon = (await import('../../pages/api/editSermon')).default;

    const originalSermon = createEmptySermon('user-1');
    originalSermon.id = 'sermon-1';
    originalSermon.title = 'Original Title';
    originalSermon.description = 'Original Description';
    originalSermon.subsplashId = 'subsplash-1';
    originalSermon.soundCloudTrackId = 'soundcloud-1';
    originalSermon.seriesId = 'series-a';
    originalSermon.subtitle = 'Legacy Category Subtitle';
    originalSermon.status.subsplash = uploadStatus.UPLOADED;
    originalSermon.status.soundCloud = uploadStatus.UPLOADED;
    originalSermon.status.audioStatus = sermonStatusType.ERROR;

    const updatedSermon = {
      ...originalSermon,
      title: 'Updated Title',
      description: 'Updated Description',
    };

    getDocMock
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => originalSermon,
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ publishedToSubsplash: true, sermonSubsplashId: 'subsplash-1' }),
      });
    getDocsMock
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [] });

    await editSermon(updatedSermon, [], { originalSermon });

    expect(functions.editSoundCloudSermon).toHaveBeenCalledTimes(1);
    expect(functions.editSubsplashSermon).toHaveBeenCalledTimes(1);
    expect(functions.editSubsplashSermon).toHaveBeenCalledWith(
      expect.not.objectContaining({ subtitle: expect.anything() })
    );
    expect(functions.addtolist).not.toHaveBeenCalled();
    expect(functions.removefromlist).not.toHaveBeenCalled();
    expect(functions.addtoseries).not.toHaveBeenCalled();
    expect(functions.removefromseries).not.toHaveBeenCalled();
    expect(runTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('clears a stale SoundCloud reference and completes the local edit when the remote track is missing', async () => {
    const functions = createFunctionMap();
    functions.editSoundCloudSermon.mockResolvedValue({ soundCloudTrackMissing: true });
    const editSermon = (await import('../../pages/api/editSermon')).default;

    const originalSermon = createEmptySermon('user-1');
    originalSermon.id = 'sermon-1';
    originalSermon.title = 'Original Title';
    originalSermon.soundCloudTrackId = 'soundcloud:tracks:deleted';
    originalSermon.soundCloudTrackUrl = 'https://soundcloud.test/deleted';
    originalSermon.status.soundCloud = uploadStatus.UPLOADED;

    const updatedSermon = {
      ...originalSermon,
      title: 'Updated Title',
    };
    const selectedList = buildList({ id: 'list-a', name: 'List A' });

    getDocsMock
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [buildListItemDoc('list-a')] });

    await editSermon(updatedSermon, [selectedList], { originalSermon });

    expect(functions.editSoundCloudSermon).toHaveBeenCalledWith(expect.objectContaining({
      trackId: 'soundcloud:tracks:deleted',
      title: 'Updated Title',
    }));
    const sermonPatch = writeBatchUpdateMock.mock.calls[0]?.[1];
    expect(sermonPatch).toEqual(expect.objectContaining({
      soundCloudTrackId: 'DELETE_FIELD',
      soundCloudTrackUrl: 'DELETE_FIELD',
      status: expect.objectContaining({
        soundCloud: uploadStatus.NOT_UPLOADED,
      }),
    }));

    const mirroredListItemWrite = getListItemWrite('list-a')?.[1];
    expect(mirroredListItemWrite).toEqual(expect.objectContaining({
      soundCloudTrackId: 'DELETE_FIELD',
      soundCloudTrackUrl: 'DELETE_FIELD',
      status: expect.objectContaining({
        soundCloud: uploadStatus.NOT_UPLOADED,
      }),
    }));
    expect(global.alert).not.toHaveBeenCalled();
  });

  it('keeps edits local when the sermon is not published anywhere', async () => {
    const functions = createFunctionMap();
    const editSermon = (await import('../../pages/api/editSermon')).default;

    const originalSermon = createEmptySermon('user-1');
    originalSermon.id = 'sermon-1';
    originalSermon.title = 'Original Title';

    const updatedSermon = {
      ...originalSermon,
      title: 'Updated Title',
      description: 'Updated Description',
    };

    getDocsMock
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [] });

    await editSermon(updatedSermon, [], { originalSermon });

    expect(functions.uploadToSubsplash).not.toHaveBeenCalled();
    expect(functions.editSubsplashSermon).not.toHaveBeenCalled();
    expect(functions.editSoundCloudSermon).not.toHaveBeenCalled();
    expect(functions.addtolist).not.toHaveBeenCalled();
    expect(functions.addtoseries).not.toHaveBeenCalled();
    expect(runTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('deletes the remote media item instead of issuing list-row removals when the last published membership is removed', async () => {
    const functions = createFunctionMap();
    const editSermon = (await import('../../pages/api/editSermon')).default;

    const sermon = createEmptySermon('user-1');
    sermon.id = 'sermon-1';
    sermon.subsplashId = 'subsplash-1';
    sermon.status.subsplash = uploadStatus.UPLOADED;

    const publishedList = {
      ...buildList({ id: 'list-a', name: 'List A', subsplashId: 'subsplash-list-a' }),
      uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-a' },
      publishGeneration: 0,
    };

    getDocsMock
      .mockResolvedValueOnce({ docs: [buildListDoc(publishedList)] })
      .mockResolvedValueOnce({ docs: [buildListItemDoc('list-a')] });

    await editSermon(sermon, [], { originalSermon: sermon });

    expect(functions.deletefromsubsplash).toHaveBeenCalledTimes(1);
    expect(functions.removefromlist).not.toHaveBeenCalled();
    expect(functions.addtolist).not.toHaveBeenCalled();
    expect(writeBatchDeleteMock).toHaveBeenCalledWith(expect.objectContaining({ path: 'sermons/sermon-1/sermonLists/list-a' }));
    expect(writeBatchDeleteMock).toHaveBeenCalledWith(expect.objectContaining({ path: 'lists/list-a/listItems/sermon-1' }));
  });

  it('keeps newly selected lists local on edit and does not auto-publish them to Subsplash', async () => {
    const functions = createFunctionMap();
    const editSermon = (await import('../../pages/api/editSermon')).default;

    const originalSermon = createEmptySermon('user-1');
    originalSermon.id = 'sermon-1';
    originalSermon.subsplashId = 'subsplash-1';
    originalSermon.status.subsplash = uploadStatus.UPLOADED;
    originalSermon.topics = ['Old Topic'];

    const sermon = {
      ...originalSermon,
      topics: ['New Topic'],
    };

    const newList = buildList({ id: 'list-b', name: 'List B', subsplashId: 'subsplash-list-b' });

    getDocsMock
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [] });

    await editSermon(sermon, [newList], { originalSermon });

    expect(functions.addtolist).not.toHaveBeenCalled();
    expect(functions.editSubsplashSermon).toHaveBeenCalledTimes(1);
    expect(functions.removefromlist).not.toHaveBeenCalled();
    expect(writeBatchSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'sermons/sermon-1/sermonLists/list-b' }),
      expect.objectContaining({
        id: 'list-b',
        uploadStatus: { status: uploadStatus.NOT_UPLOADED },
      })
    );
    const listItemWrite = getListItemWrite('list-b');
    expect(listItemWrite).toBeDefined();
    const listItemData = listItemWrite?.[1] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(listItemData, 'youtubeUrl')).toBe(false);
  });

  it('refreshes existing mirrored list items on repeated speaker and topic edits', async () => {
    const functions = createFunctionMap();
    const editSermon = (await import('../../pages/api/editSermon')).default;

    const originalSermon = createEmptySermon('user-1');
    originalSermon.id = 'sermon-1';
    originalSermon.subsplashId = 'subsplash-1';
    originalSermon.status.subsplash = uploadStatus.UPLOADED;
    originalSermon.speakers = [{ id: 'speaker-1', name: 'Speaker One', images: [], listId: 'speaker-list-1', sermonCount: 1 }];
    originalSermon.topics = ['Old Topic'];

    const updatedSermon = {
      ...originalSermon,
      speakers: [{ id: 'speaker-2', name: 'Speaker Two', images: [], listId: 'speaker-list-2', sermonCount: 1 }],
      topics: ['New Topic'],
      youtubeUrl: undefined,
    };

    const existingList = {
      ...buildList({ id: 'list-a', name: 'List A', subsplashId: 'subsplash-list-a' }),
      uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-a' },
      publishGeneration: 0,
    };

    getDocsMock
      .mockResolvedValueOnce({ docs: [buildListDoc(existingList)] })
      .mockResolvedValueOnce({ docs: [buildListItemDoc('list-a')] });

    await editSermon(updatedSermon, [existingList], { originalSermon });

    expect(functions.editSubsplashSermon).toHaveBeenCalledTimes(1);
    const listItemWrite = getListItemWrite('list-a');
    expect(listItemWrite).toBeDefined();
    expect(listItemWrite?.[2]).toEqual({ merge: true });
    expect(listItemWrite?.[1]).toEqual(
      expect.objectContaining({
        speakers: updatedSermon.speakers,
        topics: ['New Topic'],
        uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-a' },
        youtubeUrl: 'DELETE_FIELD',
      })
    );
  });

  it('backfills a missing mirrored list item without writing an undefined youtubeUrl payload', async () => {
    const functions = createFunctionMap();
    const editSermon = (await import('../../pages/api/editSermon')).default;

    const originalSermon = createEmptySermon('user-1');
    originalSermon.id = 'sermon-1';
    originalSermon.subsplashId = 'subsplash-1';
    originalSermon.status.subsplash = uploadStatus.UPLOADED;
    originalSermon.speakers = [{ id: 'speaker-1', name: 'Speaker One', images: [], listId: 'speaker-list-1', sermonCount: 1 }];
    originalSermon.topics = ['Old Topic'];

    const updatedSermon = {
      ...originalSermon,
      speakers: [{ id: 'speaker-2', name: 'Speaker Two', images: [], listId: 'speaker-list-2', sermonCount: 1 }],
      topics: ['New Topic'],
      youtubeUrl: undefined,
    };

    const existingList = {
      ...buildList({ id: 'list-a', name: 'List A', subsplashId: 'subsplash-list-a' }),
      uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-a' },
      publishGeneration: 0,
    };

    getDocsMock
      .mockResolvedValueOnce({ docs: [buildListDoc(existingList)] })
      .mockResolvedValueOnce({ docs: [] });

    await editSermon(updatedSermon, [existingList], { originalSermon });

    expect(functions.editSubsplashSermon).toHaveBeenCalledTimes(1);
    const listItemWrite = getListItemWrite('list-a');
    expect(listItemWrite).toBeDefined();
    expect(listItemWrite?.[2]).toEqual({ merge: true });
    const listItemData = listItemWrite?.[1] as Record<string, unknown>;
    expect(listItemData).toEqual(
      expect.objectContaining({
        speakers: updatedSermon.speakers,
        topics: ['New Topic'],
        uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-a' },
      })
    );
    expect(Object.prototype.hasOwnProperty.call(listItemData, 'youtubeUrl')).toBe(false);
  });

  it('keeps added lists local when editing an unpublished sermon', async () => {
    const functions = createFunctionMap();
    const editSermon = (await import('../../pages/api/editSermon')).default;

    const sermon = createEmptySermon('user-1');
    sermon.id = 'sermon-1';

    const newList = buildList({ id: 'list-new', name: 'List New' });

    getDocsMock
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [] });

    await editSermon(sermon, [newList], { originalSermon: sermon });

    expect(functions.uploadToSubsplash).not.toHaveBeenCalled();
    expect(functions.createnewsubsplashlist).not.toHaveBeenCalled();
    expect(functions.addtolist).not.toHaveBeenCalled();
    expect(writeBatchSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'sermons/sermon-1/sermonLists/list-new' }),
      expect.objectContaining({
        id: 'list-new',
        uploadStatus: { status: uploadStatus.NOT_UPLOADED },
      })
    );
  });

  it('syncs series reassignment by removing the old membership, adding the new one, and reordering', async () => {
    const functions = createFunctionMap();
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const editSermon = (await import('../../pages/api/editSermon')).default;

    const originalSermon = createEmptySermon('user-1');
    originalSermon.id = 'sermon-1';
    originalSermon.subsplashId = 'subsplash-1';
    originalSermon.seriesId = 'series-a';
    originalSermon.status.audioStatus = sermonStatusType.ERROR;
    originalSermon.status.subsplash = uploadStatus.UPLOADED;

    const updatedSermon = {
      ...originalSermon,
      seriesId: 'series-b',
    };

    getDocMock
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => originalSermon,
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ publishedToSubsplash: true, sermonSubsplashId: 'subsplash-1' }),
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          id: 'series-b',
          name: 'Series B',
          ownerId: 'user-1',
          summary: '',
          images: [],
          subsplashId: 'series-subsplash-b',
        }),
      });
    getDocsMock
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({
        docs: [
          {
            data: () => ({ position: 7 }),
          },
        ],
      })
      .mockResolvedValueOnce({
        docs: [
          {
            id: 'sermon-2',
            data: () => ({
              position: 7,
              publishedToSubsplash: true,
              sermonSubsplashId: 'subsplash-2',
            }),
          },
        ],
      })
      .mockResolvedValueOnce({
        docs: [],
      })
      .mockResolvedValueOnce({
        docs: [
          {
            data: () => ({ position: 7 }),
          },
        ],
      });

    await editSermon(updatedSermon, [], { originalSermon });

    expect(functions.removefromseries).toHaveBeenCalledTimes(1);
    expect(functions.removefromseries).toHaveBeenCalledWith(
      expect.objectContaining({
        firestoreSeriesId: 'series-a',
      })
    );
    expect(compactSeriesItemPositionsMock).toHaveBeenCalledWith('series-a');
    expect(functions.addtoseries).toHaveBeenCalledTimes(1);
    expect(functions.reorderseriesitems).toHaveBeenCalledTimes(1);
    expect(runTransactionMock).toHaveBeenCalledTimes(2);
    consoleWarnSpy.mockRestore();
  });

  it('keeps a newly assigned series local when the sermon was not previously published to a series', async () => {
    const functions = createFunctionMap();
    const editSermon = (await import('../../pages/api/editSermon')).default;

    const originalSermon = createEmptySermon('user-1');
    originalSermon.id = 'sermon-1';
    originalSermon.title = 'Original Title';

    const updatedSermon = {
      ...originalSermon,
      seriesId: 'series-b',
    };

    getDocMock.mockResolvedValue({
      exists: () => false,
    });
    getDocsMock
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [] });

    await editSermon(updatedSermon, [], { originalSermon });

    expect(functions.uploadToSubsplash).not.toHaveBeenCalled();
    expect(functions.addtoseries).not.toHaveBeenCalled();
    expect(functions.reorderseriesitems).not.toHaveBeenCalled();
    expect(runTransactionMock).toHaveBeenCalledTimes(2);
    expect(runTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function)
    );
    expect(writeBatchCommitMock).not.toHaveBeenCalled();
  });

  it('aborts the local save when removing a published list fails remotely', async () => {
    const functions = createFunctionMap();
    functions.removefromlist.mockRejectedValue(new Error('removefromlist failed'));

    const editSermon = (await import('../../pages/api/editSermon')).default;

    const sermon = createEmptySermon('user-1');
    sermon.id = 'sermon-1';
    sermon.subsplashId = 'subsplash-1';
    sermon.status.subsplash = uploadStatus.UPLOADED;

    const existingList = {
      ...buildList({ id: 'list-a', name: 'List A', subsplashId: 'subsplash-list-a' }),
      uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-a' },
      publishGeneration: 0,
    };
    const retainedList = {
      ...buildList({ id: 'list-b', name: 'List B', subsplashId: 'subsplash-list-b' }),
      uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-b' },
      publishGeneration: 0,
    };

    getDocsMock
      .mockResolvedValueOnce({ docs: [buildListDoc(existingList), buildListDoc(retainedList)] })
      .mockResolvedValueOnce({ docs: [buildListItemDoc('list-a'), buildListItemDoc('list-b')] });

    await expect(editSermon(sermon, [retainedList], { originalSermon: sermon })).rejects.toThrow('removefromlist failed');

    expect(runTransactionMock).not.toHaveBeenCalled();
    expect(global.alert).toHaveBeenCalledWith('removefromlist failed');
  });

  it('reports a processing conflict without attempting the local write when processing starts after preflight', async () => {
    createFunctionMap();
    const editSermon = (await import('../../pages/api/editSermon')).default;

    const sermon = createEmptySermon('user-1');
    sermon.id = 'sermon-1';
    sermon.status.audioStatus = sermonStatusType.ERROR;

    getDocMock.mockResolvedValueOnce({
      exists: () => true,
      data: () => sermon,
    });
    getDocsMock
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [] });

    const processingSermon = createEmptySermon('user-1');
    processingSermon.id = sermon.id;
    processingSermon.status.audioStatus = sermonStatusType.PROCESSING;
    transactionGetMock.mockResolvedValueOnce({
      exists: () => true,
      data: () => processingSermon,
    });

    await expect(editSermon(sermon, [], { originalSermon: sermon })).rejects.toThrow(
      'Audio processing started while this sermon was being edited'
    );

    expect(runTransactionMock).toHaveBeenCalledTimes(1);
    expect(writeBatchUpdateMock).not.toHaveBeenCalled();
    expect(writeBatchSetMock).not.toHaveBeenCalled();
    expect(writeBatchDeleteMock).not.toHaveBeenCalled();
    expect(global.alert).toHaveBeenCalledWith(
      'Audio processing started while this sermon was being edited. Wait for processing to finish, then try again.'
    );
  });
});
