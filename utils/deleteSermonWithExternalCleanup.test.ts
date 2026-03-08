import { deleteSermonWithExternalCleanup } from './deleteSermonWithExternalCleanup';

const createFunctionV2Mock = jest.fn();
const deleteFromSubsplashMock = jest.fn();
const deleteFromSoundCloudMock = jest.fn();
const createOperationKeyMock = jest.fn(() => 'operation-key-123');
const deleteDocMock = jest.fn();
const withConverterMock = jest.fn(() => 'sermon-doc-ref');
const docMock = jest.fn(() => ({
  withConverter: withConverterMock,
}));

jest.mock('./createFunction', () => ({
  createFunctionV2: (...args: unknown[]) => createFunctionV2Mock(...args),
}));

jest.mock('./callableConcurrency', () => ({
  createOperationKey: (...args: unknown[]) => createOperationKeyMock(...args),
}));

jest.mock('../firebase/firestore', () => ({
  __esModule: true,
  default: {},
  deleteDoc: (...args: unknown[]) => deleteDocMock(...args),
  doc: (...args: unknown[]) => docMock(...args),
}));

describe('deleteSermonWithExternalCleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    deleteFromSubsplashMock.mockResolvedValue(undefined);
    deleteFromSoundCloudMock.mockResolvedValue(undefined);
    deleteDocMock.mockResolvedValue(undefined);

    createFunctionV2Mock.mockImplementation((name: string) => {
      if (name === 'deletefromsubsplash') {
        return deleteFromSubsplashMock;
      }
      if (name === 'deletefromsoundcloud') {
        return deleteFromSoundCloudMock;
      }
      throw new Error(`Unexpected callable: ${name}`);
    });
  });

  it('passes a generated operationKey to deletefromsubsplash cleanup callable', async () => {
    await deleteSermonWithExternalCleanup({
      sermonId: 'sermon-1',
      subsplashId: 'subsplash-1',
    });

    expect(createOperationKeyMock).toHaveBeenCalledWith('sermon-admin-delete-cleanup', 'sermon-1');
    expect(deleteFromSubsplashMock).toHaveBeenCalledWith({
      operationKey: 'operation-key-123',
      subsplashId: 'subsplash-1',
    });
    expect(deleteDocMock).toHaveBeenCalledTimes(1);
  });

  it('blocks local Firestore deletion when external cleanup fails', async () => {
    deleteFromSubsplashMock.mockRejectedValue(new Error('Subsplash delete failed'));

    await expect(
      deleteSermonWithExternalCleanup({
        sermonId: 'sermon-2',
        subsplashId: 'subsplash-2',
      })
    ).rejects.toThrow('Subsplash delete failed');

    expect(deleteDocMock).not.toHaveBeenCalled();
  });

  it('preserves lock contention metadata for caller retry handling', async () => {
    const contentionError = Object.assign(new Error('Lock busy'), {
      code: 'resource-exhausted',
      details: {
        code: 'SUBSPLASH_LOCK_BUSY',
        locked_keys: ['media-item:subsplash-3'],
        wait_ms: 12000,
        retry_after_ms: 2500,
      },
    });
    deleteFromSubsplashMock.mockRejectedValue(contentionError);

    await expect(
      deleteSermonWithExternalCleanup({
        sermonId: 'sermon-3',
        subsplashId: 'subsplash-3',
      })
    ).rejects.toMatchObject({
      code: 'resource-exhausted',
      details: {
        code: 'SUBSPLASH_LOCK_BUSY',
        locked_keys: ['media-item:subsplash-3'],
        wait_ms: 12000,
        retry_after_ms: 2500,
      },
      message: expect.stringContaining('Retry in about 3s'),
    });

    expect(deleteDocMock).not.toHaveBeenCalled();
  });
});
