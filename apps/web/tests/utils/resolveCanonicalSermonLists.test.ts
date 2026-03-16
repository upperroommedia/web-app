import { createEmptySermon } from '../../types/Sermon';
import { List, ListType, OverflowBehavior } from '../../types/List';

const getDocMock = jest.fn();
const getDocsMock = jest.fn();
const collectionMock = jest.fn();
const docMock = jest.fn();
const queryMock = jest.fn();
const whereMock = jest.fn();
const limitMock = jest.fn();

jest.mock('../../firebase/firestore', () => ({
  __esModule: true,
  default: {},
  getDoc: (...args: unknown[]) => getDocMock(...args),
  getDocs: (...args: unknown[]) => getDocsMock(...args),
  collection: (...args: unknown[]) => collectionMock(...args),
  doc: (...args: unknown[]) => docMock(...args),
  query: (...args: unknown[]) => queryMock(...args),
  where: (...args: unknown[]) => whereMock(...args),
  limit: (...args: unknown[]) => limitMock(...args),
}));

const buildList = (overrides: Partial<List>): List => ({
  id: overrides.id ?? 'list-id',
  name: overrides.name ?? 'List',
  images: overrides.images ?? [],
  overflowBehavior: overrides.overflowBehavior ?? OverflowBehavior.CREATENEWLIST,
  type: overrides.type ?? ListType.TOPIC_LIST,
  createdAtMillis: overrides.createdAtMillis ?? 0,
  updatedAtMillis: overrides.updatedAtMillis ?? 0,
  ...overrides,
});

describe('resolveCanonicalSermonLists', () => {
  beforeEach(() => {
    jest.resetModules();
    getDocMock.mockReset();
    getDocsMock.mockReset();
    collectionMock.mockImplementation((...args: unknown[]) => args);
    docMock.mockImplementation((...args: unknown[]) => ({
      path: args.join('/'),
      withConverter: () => ({ path: args.join('/') }),
    }));
    queryMock.mockImplementation((...args: unknown[]) => ({
      withConverter: () => ({ args }),
    }));
    whereMock.mockImplementation((...args: unknown[]) => args);
    limitMock.mockImplementation((value: unknown) => value);
  });

  it('adds missing speaker-linked, subtitle, and topic lists', async () => {
    const { resolveCanonicalSermonLists } = await import('../../utils/resolveCanonicalSermonLists');

    const sermon = createEmptySermon('user-1');
    sermon.subtitle = 'Give Me a Word';
    sermon.topics = ['Anxiety'];
    sermon.speakers = [
      {
        id: 'speaker-1',
        name: 'Speaker',
        images: [],
        sermonCount: 0,
        listId: 'speaker-list',
      },
    ];

    const topicList = buildList({ id: 'topic-list', name: 'Anxiety', type: ListType.TOPIC_LIST });
    const subtitleList = buildList({ id: 'subtitle-list', name: 'Give Me a Word', type: ListType.CATEGORY_LIST });
    const speakerList = buildList({ id: 'speaker-list', name: 'Speaker List', type: ListType.SPEAKER_LIST });

    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => speakerList,
    });
    getDocsMock
      .mockResolvedValueOnce({
        docs: [{ data: () => subtitleList }],
      })
      .mockResolvedValueOnce({
        docs: [{ data: () => topicList }],
      });

    const result = await resolveCanonicalSermonLists(sermon, []);

    expect(result.map((list) => list.id)).toEqual(['speaker-list', 'subtitle-list', 'topic-list']);
  });
});
