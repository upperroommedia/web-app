jest.mock('firebase-functions/v2/firestore', () => ({ onDocumentDeleted: jest.fn() }));
jest.mock('firebase-functions/v2', () => ({ logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { storage: jest.fn(), firestore: jest.fn() },
}));
jest.mock('../../firestoreDataConverter', () => ({
  firestoreAdminImagesConverter: { fromFirestore: () => ({ downloadLink: 'https://example.test/image' }) },
}));
jest.mock('@upperroom/shared/shared/firebaseProjectConfig', () => ({ getFirebaseImagesBucket: () => 'images.test' }));
jest.mock('@upperroom/shared/shared/firebaseStorageUrls', () => ({
  extractStoragePathFromDownloadUrl: () => 'image.jpg',
}));
jest.mock('../../handleError', () => ({ __esModule: true, default: (error: unknown) => error }));

import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import '../../DocumentListeners/Images/imageOnDelete';

const handler = jest.mocked(onDocumentDeleted).mock.calls[0][1] as unknown as (event: {
  params: { imageId: string };
  data: object;
}) => Promise<void>;
const event = { params: { imageId: 'image-1' }, data: {} };

describe('imageOnDelete', () => {
  const previousOwner = process.env.TASK_ORCHESTRATOR_IMAGES;
  let releaseControl: Record<string, unknown> | undefined;
  let providerUsage: Record<string, unknown> | undefined;
  beforeEach(() => {
    process.env.TASK_ORCHESTRATOR_IMAGES = 'legacy';
    releaseControl = undefined;
    providerUsage = undefined;
    jest.mocked(firebaseAdmin.firestore).mockReturnValue({
      doc: (path: string) => ({ path }),
      runTransaction: async (handler: (transaction: unknown) => Promise<void>) =>
        handler({
          get: async (reference: { path: string }) => {
            expect(['_control/temporalRelease', '_control/temporalProviderUsage']).toContain(reference.path);
            const document = reference.path === '_control/temporalRelease' ? releaseControl : providerUsage;
            return { exists: document !== undefined, data: () => document };
          },
        }),
    } as unknown as ReturnType<typeof firebaseAdmin.firestore>);
  });
  afterAll(() => {
    if (previousOwner === undefined) delete process.env.TASK_ORCHESTRATOR_IMAGES;
    else process.env.TASK_ORCHESTRATOR_IMAGES = previousOwner;
  });
  it('accepts repeat event delivery after the storage object has already been deleted', async () => {
    let exists = true;
    const remove = jest.fn(async (options?: { ignoreNotFound?: boolean }) => {
      if (!exists && !options?.ignoreNotFound) throw new Error('object not found');
      exists = false;
    });
    jest
      .mocked(firebaseAdmin.storage)
      .mockReturnValue({ bucket: () => ({ file: () => ({ delete: remove }) }) } as unknown as ReturnType<
        typeof firebaseAdmin.storage
      >);
    await handler(event);
    await expect(handler(event)).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('still propagates storage permission or availability failures', async () => {
    const failure = new Error('permission denied');
    jest.mocked(firebaseAdmin.storage).mockReturnValue({
      bucket: () => ({
        file: () => ({
          delete: async () => {
            throw failure;
          },
        }),
      }),
    } as unknown as ReturnType<typeof firebaseAdmin.storage>);
    await expect(handler(event)).rejects.toBe(failure);
  });

  it('blocks a stale legacy deployment when Temporal owns image execution', async () => {
    releaseControl = {
      schemaVersion: 1,
      revision: 1,
      admission: 'open',
      domains: { images: { owner: 'temporal', admission: 'open' } },
    };
    const remove = jest.fn(async () => undefined);
    jest
      .mocked(firebaseAdmin.storage)
      .mockReturnValue({ bucket: () => ({ file: () => ({ delete: remove }) }) } as unknown as ReturnType<
        typeof firebaseAdmin.storage
      >);
    await expect(handler(event)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('allows cleanup of an already-deleted legacy image while new admissions are paused', async () => {
    releaseControl = {
      schemaVersion: 1,
      revision: 1,
      admission: 'paused',
      domains: { images: { owner: 'legacy', admission: 'paused' } },
    };
    const remove = jest.fn(async () => undefined);
    jest
      .mocked(firebaseAdmin.storage)
      .mockReturnValue({ bucket: () => ({ file: () => ({ delete: remove }) }) } as unknown as ReturnType<
        typeof firebaseAdmin.storage
      >);
    await expect(handler(event)).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it.each(['building', 'ready'])(
    'blocks legacy cleanup while provider reference verification is %s',
    async (status) => {
      releaseControl = {
        schemaVersion: 1,
        revision: 1,
        releaseId: 'release-1',
        admission: 'paused',
        domains: { images: { owner: 'legacy', admission: 'paused' } },
      };
      providerUsage = { releaseId: 'release-1', status };
      const remove = jest.fn(async () => undefined);
      jest
        .mocked(firebaseAdmin.storage)
        .mockReturnValue({ bucket: () => ({ file: () => ({ delete: remove }) }) } as unknown as ReturnType<
          typeof firebaseAdmin.storage
        >);
      await expect(handler(event)).rejects.toMatchObject({ code: 'unavailable' });
      expect(remove).not.toHaveBeenCalled();
    }
  );
});
