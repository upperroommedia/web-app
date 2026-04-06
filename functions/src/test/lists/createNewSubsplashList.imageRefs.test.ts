import axios from 'axios';
import { createNewSubsplashList } from '../../createNewSubsplashList';

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
      mockImages.set(id, { id, type: payload.type, title: payload.title });
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

    if (method === 'POST' && config.url.endsWith('/builder/v1/lists')) {
      const payload = config.data as { _embedded?: { images?: Array<{ id: string; type: string }> } };
      return Promise.resolve({
        data: {
          id: 'new-list-1',
          _embedded: payload._embedded,
        },
      });
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

describe('createNewSubsplashList image refs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockImages.clear();
  });

  it('repairs mismatched remote image ids before creating a list', async () => {
    mockImages.set('square-remote', { id: 'square-remote', type: 'square', title: 'Square' });
    mockImages.set('wide-remote', { id: 'wide-remote', type: 'square', title: 'Wrong Wide' });

    const result = await createNewSubsplashList({
      title: 'Test List',
      images: [
        { id: 'local-square', subsplashId: 'square-remote', type: 'square', downloadLink: 'https://example.com/square.jpg', name: 'Square' } as never,
        { id: 'local-wide', subsplashId: 'wide-remote', type: 'wide', downloadLink: 'https://example.com/wide.jpg', name: 'Wide' } as never,
      ],
      operationKey: 'create-list-images-1',
    });

    expect(result.listId).toBe('new-list-1');
    const mockAxios = axios as jest.MockedFunction<typeof axios>;
    const createListCall = mockAxios.mock.calls.find(
      ([config]) => (config as { url?: string }).url === 'https://core.subsplash.com/builder/v1/lists'
    );
    expect(createListCall).toBeDefined();
    const createListRequest = createListCall?.[0] as unknown as {
      data: { _embedded?: { images?: Array<{ id: string; type: string }> } };
    };
    expect(createListRequest.data._embedded?.images).toEqual([
      { id: 'square-remote', type: 'square' },
      { id: 'repaired-3', type: 'wide' },
    ]);
  });
});
