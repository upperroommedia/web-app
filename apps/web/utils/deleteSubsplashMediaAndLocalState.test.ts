import { deleteSubsplashMediaAndLocalState } from './deleteSubsplashMediaAndLocalState';

const createFunctionV2Mock = jest.fn((name: string) => {
  void name;
  return undefined as unknown;
});
const deleteFromSubsplashMock = jest.fn();
const createSubsplashDeleteIntentKeyMock = jest.fn((scope: string, sermonId: string) => `${scope}:${sermonId}`);
const getDocsMock = jest.fn();
const getDocMock = jest.fn();
const updateDocMock = jest.fn();
const incrementMock = jest.fn((value: number) => ({ __increment__: value }));
const deleteFieldMock = jest.fn(() => 'DELETE_FIELD');
const collectionMock = jest.fn((firestoreArg: unknown, path: string) => {
  void firestoreArg;
  return {
    path,
    withConverter: () => ({ path, withConverter: true }),
  };
});
const docMock = jest.fn((firestoreArg: unknown, ...pathSegments: string[]) => {
  void firestoreArg;
  const path = pathSegments.join('/');
  if (pathSegments.length === 2 && pathSegments[0] === 'sermons') {
    return {
      path,
      withConverter: () => 'SERMON_DOC_REF',
    };
  }
  return { path };
});
const batchSetMock = jest.fn();
const batchCommitMock = jest.fn(() => Promise.resolve());
const writeBatchMock = jest.fn(() => ({
  set: batchSetMock,
  commit: batchCommitMock,
}));

jest.mock('./createFunction', () => ({
  createFunctionV2: (...args: Parameters<typeof createFunctionV2Mock>) => createFunctionV2Mock(...args),
}));

jest.mock('./subsplashPublishFlow', () => ({
  createSubsplashDeleteIntentKey: (...args: Parameters<typeof createSubsplashDeleteIntentKeyMock>) =>
    createSubsplashDeleteIntentKeyMock(...args),
}));

jest.mock('../firebase/firestore', () => ({
  __esModule: true,
  default: {},
  collection: (...args: Parameters<typeof collectionMock>) => collectionMock(...args),
  deleteField: (...args: Parameters<typeof deleteFieldMock>) => deleteFieldMock(...args),
  doc: (...args: Parameters<typeof docMock>) => docMock(...args),
  getDoc: (...args: Parameters<typeof getDocMock>) => getDocMock(...args),
  getDocs: (...args: Parameters<typeof getDocsMock>) => getDocsMock(...args),
  increment: (...args: Parameters<typeof incrementMock>) => incrementMock(...args),
  updateDoc: (...args: Parameters<typeof updateDocMock>) => updateDocMock(...args),
  writeBatch: (...args: Parameters<typeof writeBatchMock>) => writeBatchMock(...args),
}));

describe('deleteSubsplashMediaAndLocalState', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    createFunctionV2Mock.mockImplementation((name: string) => {
      if (name === 'deletefromsubsplash') {
        return deleteFromSubsplashMock;
      }
      throw new Error(`Unexpected callable: ${name}`);
    });
    deleteFromSubsplashMock.mockResolvedValue(undefined);
    getDocsMock.mockResolvedValue({
      docs: [
        {
          id: 'list-a',
          ref: 'SERMON_LIST_A_REF',
          data: () => ({
            uploadStatus: { status: 'UPLOADED', listItemId: 'row-a' },
          }),
        },
        {
          id: 'list-b',
          ref: 'SERMON_LIST_B_REF',
          data: () => ({
            uploadStatus: { status: 'NOT_UPLOADED' },
          }),
        },
      ],
    });
    getDocMock.mockResolvedValue({
      exists: () => true,
    });
    updateDocMock.mockResolvedValue(undefined);
  });

  it('deletes the remote media and clears local list, series, and sermon subsplash state', async () => {
    await expect(deleteSubsplashMediaAndLocalState({
      sermonId: 'sermon-1',
      subsplashId: 'subsplash-1',
      seriesId: 'series-1',
    })).resolves.toBe(true);

    expect(deleteFromSubsplashMock).toHaveBeenCalledWith({
      subsplashId: 'subsplash-1',
      operationKey: 'manage-publishing-delete:sermon-1',
    });
    expect(batchSetMock).toHaveBeenCalledWith(
      'SERMON_LIST_A_REF',
      {
        uploadStatus: { status: 'NOT_UPLOADED' },
        publishGeneration: { __increment__: 1 },
      },
      { merge: true }
    );
    expect(batchSetMock).toHaveBeenCalledWith(
      { path: 'lists/list-a/listItems/sermon-1' },
      {
        subsplashId: 'DELETE_FIELD',
        uploadStatus: { status: 'NOT_UPLOADED' },
        physicalPlacement: 'DELETE_FIELD',
      },
      { merge: true }
    );
    expect(batchSetMock).toHaveBeenCalledWith(
      { path: 'series/series-1/seriesItems/sermon-1' },
      {
        publishedToSubsplash: false,
        sermonSubsplashId: 'DELETE_FIELD',
      },
      { merge: true }
    );
    expect(updateDocMock).toHaveBeenCalledWith('SERMON_DOC_REF', {
      subsplashId: 'DELETE_FIELD',
      numberOfListsUploadedTo: 0,
      subsplashUploadGeneration: { __increment__: 1 },
      'status.subsplash': 'NOT_UPLOADED',
    });
  });

  it('skips all cleanup work when the sermon has no subsplashId', async () => {
    await expect(deleteSubsplashMediaAndLocalState({
      sermonId: 'sermon-2',
      subsplashId: '',
      seriesId: 'series-2',
    })).resolves.toBe(false);

    expect(deleteFromSubsplashMock).not.toHaveBeenCalled();
    expect(getDocsMock).not.toHaveBeenCalled();
    expect(batchSetMock).not.toHaveBeenCalled();
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('does not touch series membership when there is no published series item document', async () => {
    getDocMock.mockResolvedValue({
      exists: () => false,
    });

    await deleteSubsplashMediaAndLocalState({
      sermonId: 'sermon-3',
      subsplashId: 'subsplash-3',
      seriesId: 'series-3',
    });

    expect(batchSetMock).not.toHaveBeenCalledWith(
      { path: 'series/series-3/seriesItems/sermon-3' },
      expect.anything(),
      expect.anything()
    );
  });
});
