import { OverflowBehavior } from '@upperroom/shared/types/List';
import editSubsplashList from '../../editSubsplashList';
import { clearFirestore, createListDocument, getListBySubsplashId } from '../addToList/firestoreHelpers';

const mockLists = new Map<string, { id: string; title: string; subtitle?: string; images?: Array<{ id: string; type: string }> }>();
const mockImages = new Map<string, { id: string; type: string; title?: string }>();

jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: jest.fn().mockResolvedValue('fake-token'),
  createAxiosConfig: jest.fn((url: string, token: string, method: string, data?: unknown) => ({
    url,
    token,
    method,
    data,
    headers: {},
  })),
}));

jest.mock('axios', () => {
  return jest.fn((config: { method: string; url: string; data?: unknown }) => {
    const method = config.method.toUpperCase();
    const listMatch = config.url.match(/builder\/v1\/lists\/([a-zA-Z0-9-]+)$/);
    const imageMatch = config.url.match(/files\/v1\/images\/([a-zA-Z0-9-]+)$/);

    if (method === 'GET' && imageMatch) {
      const image = mockImages.get(imageMatch[1]);
      if (!image) {
        return Promise.reject({ response: { status: 404, data: { error: 'Image not found' } } });
      }
      return Promise.resolve({ data: image });
    }

    if (method === 'GET' && config.url.startsWith('https://example.com/')) {
      return Promise.resolve({
        data: Buffer.from('fake-image'),
        headers: { 'content-type': 'image/jpeg' },
      });
    }

    if (method === 'POST' && config.url.endsWith('/files/v1/images')) {
      const payload = config.data as { type: string; title?: string };
      const id = `repaired-${mockImages.size + 1}`;
      const image = { id, type: payload.type, title: payload.title };
      mockImages.set(id, image);
      return Promise.resolve({
        data: {
          id,
          type: payload.type,
          _links: { presigned_upload_url: { href: `https://upload.test/${id}` } },
        },
      });
    }

    if (method === 'PUT' && config.url.startsWith('https://upload.test/')) {
      return Promise.resolve({ data: null, status: 200 });
    }

    if (method === 'PATCH' && listMatch) {
      const listId = listMatch[1];
      const payload =
        typeof config.data === 'string'
          ? (JSON.parse(config.data) as { title?: string; subtitle?: string; _embedded?: { images?: Array<{ id: string; type: string }> } })
          : ((config.data ?? {}) as { title?: string; subtitle?: string; _embedded?: { images?: Array<{ id: string; type: string }> } });

      const existingList = mockLists.get(listId) ?? { id: listId, title: listId };
      const updatedList = {
        ...existingList,
        ...(payload.title ? { title: payload.title } : {}),
        ...(payload.subtitle ? { subtitle: payload.subtitle } : {}),
        ...(payload._embedded?.images ? { images: payload._embedded.images } : {}),
      };
      mockLists.set(listId, updatedList);
      return Promise.resolve({ data: updatedList });
    }

    return Promise.reject(new Error(`Unhandled axios request: ${method} ${config.url}`));
  });
});

jest.mock('../../locks/withIdempotency', () => ({
  withIdempotency: jest.fn(async (_operationKey: string, run: () => Promise<unknown>) => run()),
}));

jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: jest.fn(async (_lockKeys: string[], run: () => Promise<unknown>) => run()),
}));

jest.mock('firebase-functions/v2/https', () => {
  const actual = jest.requireActual('firebase-functions/v2/https');
  return {
    ...actual,
    onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: unknown) =>
      (typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler)
    ),
  };
});

type EditHandler = (request: {
  auth?: { token?: { role?: string } };
  data: {
    listId: string;
    title?: string;
    subtitle?: string;
    images?: unknown[];
    operationKey?: string;
  };
}) => Promise<unknown>;

const editHandler = editSubsplashList as unknown as EditHandler;

describe('editSubsplashList overflow naming', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockLists.clear();
    mockImages.clear();
    await clearFirestore();
  });

  it('keeps every overflow page on the canonical root-based continuation title', async () => {
    const rootFirestoreId = 'edit-root-doc';
    const rootSubsplashId = 'edit-root-subsplash';
    const overflow1SubsplashId = 'edit-overflow-1-subsplash';
    const overflow2SubsplashId = 'edit-overflow-2-subsplash';

    mockLists.set(rootSubsplashId, {
      id: rootSubsplashId,
      title: 'Original Root List',
    });
    mockLists.set(overflow1SubsplashId, {
      id: overflow1SubsplashId,
      title: 'More Original Root List sermons',
      subtitle: 'Page 1',
    });
    mockLists.set(overflow2SubsplashId, {
      id: overflow2SubsplashId,
      title: 'More More Original Root List sermons',
      subtitle: 'Page 2',
    });

    await createListDocument({
      id: rootFirestoreId,
      subsplashId: rootSubsplashId,
      title: 'Original Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 4,
      logicalCount: 9,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 0,
      moreSermonsRef: overflow1SubsplashId,
    });
    await createListDocument({
      id: 'edit-overflow-doc-1',
      subsplashId: overflow1SubsplashId,
      title: 'More Original Root List sermons',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 4,
      isMoreSermonsList: true,
      isRootList: false,
      rootListId: rootFirestoreId,
      overflowDepth: 1,
      moreSermonsRef: overflow2SubsplashId,
    });
    await createListDocument({
      id: 'edit-overflow-doc-2',
      subsplashId: overflow2SubsplashId,
      title: 'More More Original Root List sermons',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 1,
      isMoreSermonsList: true,
      isRootList: false,
      rootListId: rootFirestoreId,
      overflowDepth: 2,
    });

    await editHandler({
      auth: { token: { role: 'admin' } },
      data: {
        listId: rootSubsplashId,
        title: 'Fresh Root Name',
        operationKey: 'edit-overflow-name-1',
      },
    });

    expect(mockLists.get(rootSubsplashId)?.title).toBe('Fresh Root Name');
    expect(mockLists.get(overflow1SubsplashId)).toMatchObject({
      title: 'More Fresh Root Name sermons',
      subtitle: 'Page 1',
    });
    expect(mockLists.get(overflow2SubsplashId)).toMatchObject({
      title: 'More Fresh Root Name sermons',
      subtitle: 'Page 2',
    });

    expect((await getListBySubsplashId(rootSubsplashId))!.data()).toMatchObject({
      name: 'Fresh Root Name',
    });
    expect((await getListBySubsplashId(overflow1SubsplashId))!.data()).toMatchObject({
      name: 'More Fresh Root Name sermons',
      isRootList: false,
      isMoreSermonsList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 1,
    });
    expect((await getListBySubsplashId(overflow2SubsplashId))!.data()).toMatchObject({
      name: 'More Fresh Root Name sermons',
      isRootList: false,
      isMoreSermonsList: true,
      rootListId: rootFirestoreId,
      overflowDepth: 2,
    });
  });

  it('repairs mismatched remote image ids before patching list artwork', async () => {
    mockLists.set('list-1', {
      id: 'list-1',
      title: 'List 1',
    });
    mockImages.set('square-remote', { id: 'square-remote', type: 'square', title: 'Square' });
    mockImages.set('wide-remote', { id: 'wide-remote', type: 'square', title: 'Wrong Wide' });

    await editHandler({
      auth: { token: { role: 'admin' } },
      data: {
        listId: 'list-1',
        images: [
          { id: 'local-square', subsplashId: 'square-remote', type: 'square', downloadLink: 'https://example.com/square.jpg', name: 'Square' },
          { id: 'local-wide', subsplashId: 'wide-remote', type: 'wide', downloadLink: 'https://example.com/wide.jpg', name: 'Wide' },
        ],
        operationKey: 'edit-list-images-1',
      },
    });

    expect(mockLists.get('list-1')?.images).toEqual([
      { id: 'square-remote', type: 'square' },
      { id: 'repaired-3', type: 'wide' },
    ]);
  });
});
