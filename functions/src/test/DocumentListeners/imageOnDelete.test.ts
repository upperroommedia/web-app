jest.mock('firebase-functions/v2/firestore', () => ({ onDocumentDeleted: jest.fn() }));
jest.mock('firebase-functions/v2', () => ({ logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({ __esModule: true, default: { storage: jest.fn() } }));
jest.mock('../../firestoreDataConverter', () => ({ firestoreAdminImagesConverter: { fromFirestore: () => ({ downloadLink: 'https://example.test/image' }) } }));
jest.mock('@upperroom/shared/shared/firebaseProjectConfig', () => ({ getFirebaseImagesBucket: () => 'images.test' }));
jest.mock('@upperroom/shared/shared/firebaseStorageUrls', () => ({ extractStoragePathFromDownloadUrl: () => 'image.jpg' }));
jest.mock('../../handleError', () => ({ __esModule: true, default: (error: unknown) => error }));

import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import '../../DocumentListeners/Images/imageOnDelete';

const handler = jest.mocked(onDocumentDeleted).mock.calls[0][1] as unknown as (event: { params: { imageId: string }; data: object }) => Promise<void>;
const event = { params: { imageId: 'image-1' }, data: {} };

describe('imageOnDelete', () => {
  it('accepts repeat event delivery after the storage object has already been deleted', async () => {
    let exists = true;
    const remove = jest.fn(async (options?: { ignoreNotFound?: boolean }) => {
      if (!exists && !options?.ignoreNotFound) throw new Error('object not found');
      exists = false;
    });
    jest.mocked(firebaseAdmin.storage).mockReturnValue({ bucket: () => ({ file: () => ({ delete: remove }) }) } as unknown as ReturnType<typeof firebaseAdmin.storage>);
    await handler(event);
    await expect(handler(event)).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('still propagates storage permission or availability failures', async () => {
    const failure = new Error('permission denied');
    jest.mocked(firebaseAdmin.storage).mockReturnValue({ bucket: () => ({ file: () => ({ delete: async () => { throw failure; } }) }) } as unknown as ReturnType<typeof firebaseAdmin.storage>);
    await expect(handler(event)).rejects.toBe(failure);
  });
});
