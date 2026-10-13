import { webcrypto } from 'node:crypto';
const getMetadataMock = jest.fn();
const uploadBytesMock = jest.fn();
const submitMock = jest.fn();
jest.mock('../firebase/auth', () => ({ __esModule: true, default: { currentUser: { uid: 'owner' } } }));
jest.mock('../firebase/firebase', () => ({ __esModule: true, default: { options: { projectId: 'test-project' } } }));
jest.mock('../firebase/storage', () => ({
  imageStorage: {},
  ref: (_storage: unknown, path: string) => ({ path }),
  getMetadata: (...args: unknown[]) => getMetadataMock(...args),
  uploadBytes: (...args: unknown[]) => uploadBytesMock(...args),
}));
jest.mock('./durableJobs', () => ({ submitDurableIntent: (...args: unknown[]) => submitMock(...args) }));
import { deleteDurableImage, ingestDurableImage } from './durableImages';

const store = new Map<string, string>();
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  },
});
const image = {
  blob: new Blob(['image-data'], { type: 'image/jpeg' }),
  url: 'blob:preview',
  contentType: 'image/jpeg',
  type: 'square' as const,
};

describe('durable image source transfer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    getMetadataMock.mockRejectedValue({ code: 'storage/object-not-found' });
    uploadBytesMock.mockImplementation(async (_ref, blob, metadata) => ({
      metadata: { ...metadata, size: blob.size, generation: '17' },
    }));
    submitMock.mockImplementation(async (input) => ({
      jobId: 'job',
      requestId: input.requestId,
      projectId: 'test-project',
      revision: 1,
      generation: 1,
      admissionState: 'queued',
    }));
  });
  it('uses the admission ID in immutable source path and validates the object generation', async () => {
    await ingestDurableImage(image, 'new-square.jpg');
    const intent = submitMock.mock.calls[0][0];
    expect(uploadBytesMock.mock.calls[0][0].path).toBe(`durable-image-sources/owner/${intent.requestId}/source`);
    expect(intent).toMatchObject({
      kind: 'image.ingest',
      entity: { type: 'image', id: intent.requestId },
      payload: { name: 'new-square.jpg', type: 'square', sourceGeneration: '17', contentType: 'image/jpeg' },
    });
    expect(uploadBytesMock.mock.calls[0][2].customMetadata).toMatchObject({
      ownerUID: 'owner',
      durableRequestId: intent.requestId,
    });
  });
  it('reuses the exact request and existing source after an ambiguous admission', async () => {
    submitMock.mockRejectedValueOnce(new Error('connection lost'));
    await expect(ingestDurableImage(image, 'retry-square.jpg')).rejects.toThrow('connection lost');
    const firstIntent = submitMock.mock.calls[0][0];
    const saved = (await uploadBytesMock.mock.results[0].value).metadata;
    getMetadataMock.mockResolvedValue(saved);
    await ingestDurableImage(image, 'retry-square.jpg');
    expect(submitMock.mock.calls[1][0]).toEqual(firstIntent);
    expect(uploadBytesMock).toHaveBeenCalledTimes(1);
  });
  it('does not overwrite or admit a source with mismatched ownership or fingerprint', async () => {
    getMetadataMock.mockResolvedValue({
      generation: '20',
      size: image.blob.size,
      customMetadata: { ownerUID: 'someone-else' },
    });
    await expect(ingestDurableImage(image, 'mismatch-square.jpg')).rejects.toThrow('does not match');
    expect(uploadBytesMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });
  it('does not interpret a network failure as a missing object', async () => {
    getMetadataMock.mockRejectedValue({ code: 'storage/retry-limit-exceeded' });
    await expect(ingestDurableImage(image, 'offline-square.jpg')).rejects.toEqual({
      code: 'storage/retry-limit-exceeded',
    });
    expect(uploadBytesMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });
  it('deletes by canonical identity and leaves provider resolution to the server', async () => {
    await deleteDurableImage('image-123');
    expect(submitMock).toHaveBeenCalledWith({
      kind: 'image.delete',
      entity: { type: 'image', id: 'image-123' },
      payload: {},
    });
  });
});
