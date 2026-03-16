import { createEmptySermon } from '../../types/Sermon';
import { List, ListType, OverflowBehavior } from '../../types/List';

const updateDocMock = jest.fn();
const getDocsMock = jest.fn();
const writeBatchDeleteMock = jest.fn();
const writeBatchSetMock = jest.fn();
const writeBatchCommitMock = jest.fn();
const writeBatchMock = jest.fn();
const docMock = jest.fn();
const collectionGroupMock = jest.fn();
const queryMock = jest.fn();
const whereMock = jest.fn();
const createFunctionV2Mock = jest.fn();
const resolveCanonicalSermonListsMock = jest.fn();
const runTransactionMock = jest.fn();

jest.mock('../../firebase/firestore', () => ({
  __esModule: true,
  default: {},
  Timestamp: {
    fromMillis: (millis: number) => ({ toMillis: () => millis }),
  },
  deleteField: jest.fn(() => Symbol('deleteField')),
  increment: jest.fn(),
  limit: jest.fn(),
  orderBy: jest.fn(),
  updateDoc: (...args: unknown[]) => updateDocMock(...args),
  getDocs: (...args: unknown[]) => getDocsMock(...args),
  writeBatch: (...args: unknown[]) => writeBatchMock(...args),
  doc: (...args: unknown[]) => docMock(...args),
  collectionGroup: (...args: unknown[]) => collectionGroupMock(...args),
  query: (...args: unknown[]) => queryMock(...args),
  where: (...args: unknown[]) => whereMock(...args),
  collection: jest.fn(),
  runTransaction: (...args: unknown[]) => runTransactionMock(...args),
}));

jest.mock('../../utils/createFunction', () => ({
  __esModule: true,
  createFunctionV2: (...args: unknown[]) => createFunctionV2Mock(...args),
}));

jest.mock('../../utils/resolveCanonicalSermonLists', () => ({
  __esModule: true,
  resolveCanonicalSermonLists: (...args: unknown[]) => resolveCanonicalSermonListsMock(...args),
}));

jest.mock('../../utils/callableConcurrency', () => ({
  __esModule: true,
  createOperationKey: jest.fn(() => 'operation-key'),
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

describe('editSermon list membership persistence', () => {
  beforeEach(() => {
    jest.resetModules();
    updateDocMock.mockReset().mockResolvedValue(undefined);
    getDocsMock.mockReset();
    writeBatchDeleteMock.mockReset();
    writeBatchSetMock.mockReset();
    writeBatchCommitMock.mockReset().mockResolvedValue(undefined);
    writeBatchMock.mockReset().mockReturnValue({
      delete: writeBatchDeleteMock,
      set: writeBatchSetMock,
      commit: writeBatchCommitMock,
    });
    docMock.mockReset().mockImplementation((...segments: string[]) => ({
      path: segments.join('/'),
      id: segments[segments.length - 1],
      withConverter() {
        return this;
      },
    }));
    collectionGroupMock.mockReset().mockImplementation((...args: unknown[]) => args);
    queryMock.mockReset().mockImplementation((...args: unknown[]) => ({
      args,
      withConverter() {
        return this;
      },
    }));
    whereMock.mockReset().mockImplementation((...args: unknown[]) => args);
    createFunctionV2Mock.mockReset();
    resolveCanonicalSermonListsMock.mockReset();
    runTransactionMock.mockReset().mockResolvedValue(undefined);
    global.alert = jest.fn();
  });

  it('does not delete an existing derived list membership when canonical membership still contains it', async () => {
    const editSermon = (await import('../../pages/api/editSermon')).default;

    const sermon = createEmptySermon('user-1');
    sermon.id = 'sermon-1';
    sermon.subtitle = 'I’m New';
    sermon.speakers = [
      {
        id: 'speaker-1',
        name: 'Speaker',
        images: [],
        sermonCount: 0,
        listId: 'speaker-list',
      },
    ];

    const speakerList = buildList({
      id: 'speaker-list',
      name: 'TEST [TO DELETE]',
      type: ListType.SPEAKER_LIST,
    });

    resolveCanonicalSermonListsMock.mockResolvedValue([speakerList]);
    getDocsMock.mockResolvedValue({
      docs: [
        {
          ref: {
            parent: {
              parent: {
                id: 'speaker-list',
              },
            },
          },
        },
      ],
    });

    await editSermon(sermon, []);

    expect(resolveCanonicalSermonListsMock).toHaveBeenCalledWith(sermon, []);
    expect(writeBatchDeleteMock).not.toHaveBeenCalled();
    expect(writeBatchSetMock).not.toHaveBeenCalled();
    expect(writeBatchCommitMock).toHaveBeenCalled();
  });

  it('does not auto-delete stale firebase list memberships when canonical membership excludes them', async () => {
    const editSermon = (await import('../../pages/api/editSermon')).default;

    const sermon = createEmptySermon('user-1');
    sermon.id = 'sermon-2';
    sermon.subtitle = 'I’m New';

    const topicList = buildList({
      id: 'topic-list',
      name: 'Anger',
      type: ListType.TOPIC_LIST,
    });

    resolveCanonicalSermonListsMock.mockResolvedValue([topicList]);
    getDocsMock.mockResolvedValue({
      docs: [
        {
          ref: {
            parent: {
              parent: {
                id: 'speaker-list',
              },
            },
          },
        },
      ],
    });

    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await editSermon(sermon, [topicList]);

    expect(writeBatchDeleteMock).not.toHaveBeenCalled();
    expect(writeBatchSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lists/topic-list/listItems/sermon-2' }),
      sermon
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'editSermon.autoDeletePrevented',
      expect.objectContaining({
        sermonId: 'sermon-2',
        staleListIds: ['speaker-list'],
        canonicalListIds: ['topic-list'],
      })
    );

    consoleWarnSpy.mockRestore();
  });
});
