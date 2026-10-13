import type { AuthData } from '../helpers/callableAuth';
import { testCallableAuth } from '../helpers/callableAuth';
jest.mock('../../temporal/legacyAdmissionLease', () => ({
  withLegacyAdmissionLease: async (
    _db: unknown,
    _options: unknown,
    run: (lease: { markEffectsStarted: () => Promise<void> }) => Promise<unknown>
  ) => run({ markEffectsStarted: async () => undefined }),
}));
jest.mock('../../notifications/emitOperationalAlert', () => ({
  emitOperationalAlert: jest.fn(),
  hasOperationalAlertBeenEmitted: () => false,
}));
jest.mock('../../temporal/publishing/providerReceipts', () => ({
  executeProviderCreate: jest.fn(
    async (options: { prepare?: () => Promise<void>; execute: () => Promise<unknown> }) => {
      await options.prepare?.();
      return options.execute();
    }
  ),
}));
import {
  mockUploadTrack,
  mockNormalizeSoundCloudApiError,
  mockPrepareMultipartUpload,
  mockDisposePreparedUpload,
} from './mocks';
import uploadToSoundCloud, { uploadToSoundCloudDomain } from '../../uploadToSoundCloud';
import { executeProviderCreate } from '../../temporal/publishing/providerReceipts';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { UploadToSoundCloudInputType, UploadToSoundCloudReturnType } from '../../uploadToSoundCloud';

const handler = uploadToSoundCloud as unknown as (req: {
  auth?: AuthData;
  data: UploadToSoundCloudInputType;
}) => Promise<UploadToSoundCloudReturnType>;

describe('uploadToSoundCloud', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(firebaseAdmin, 'firestore').mockReturnValue({} as ReturnType<typeof firebaseAdmin.firestore>);
    mockUploadTrack.mockResolvedValue({
      trackIdentifier: 'sc-track-123',
      permalinkUrl: 'https://soundcloud.com/upper-room-media/test-sermon',
    });
    mockNormalizeSoundCloudApiError.mockImplementation((error: unknown) => {
      throw error;
    });
  });

  it('returns soundCloudTrackId when authenticated and upload succeeds', async () => {
    const result = await handler({
      auth: testCallableAuth('admin'),
      data: {
        audioStoragePath: 'intro-outro-sermons/sermon-1',
        title: 'Test Sermon',
        speakers: ['Speaker A'],
        tags: ['tag1', 'tag2'],
        description: 'A test.',
      },
    });
    expect(result).toEqual({
      soundCloudTrackId: 'sc-track-123',
      soundCloudTrackUrl: 'https://soundcloud.com/upper-room-media/test-sermon',
    });
    expect(mockUploadTrack).toHaveBeenCalledTimes(1);
    expect(mockUploadTrack).toHaveBeenCalledWith(
      'fake-soundcloud-token',
      expect.objectContaining({
        audioStoragePath: 'intro-outro-sermons/sermon-1',
        title: 'Test Sermon',
        tags: ['tag1', 'tag2'],
        description: 'A test.',
      })
    );
  });

  it('includes imageSource when provided', async () => {
    await handler({
      auth: testCallableAuth('admin'),
      data: {
        audioStoragePath: 'intro-outro-sermons/sermon-1',
        title: 'Test',
        speakers: [],
        tags: [],
        description: '',
        imageSource:
          'https://firebasestorage.googleapis.com/v0/b/urm-app-prod.firebasestorage.app/o/speaker-images%2Fsome.jpg?alt=media&token=abc',
      },
    });
    expect(mockUploadTrack).toHaveBeenCalledWith(
      'fake-soundcloud-token',
      expect.objectContaining({
        imageSource:
          'https://firebasestorage.googleapis.com/v0/b/urm-app-prod.firebasestorage.app/o/speaker-images%2Fsome.jpg?alt=media&token=abc',
      })
    );
  });

  it('throws when unauthenticated', async () => {
    await expect(
      handler({
        auth: undefined,
        data: {
          audioStoragePath: 'intro-outro-sermons/sermon-1',
          title: 'Test',
          speakers: [],
          tags: [],
          description: '',
        },
      })
    ).rejects.toMatchObject({ code: 'unauthenticated', message: expect.stringContaining('authenticated') });
    expect(mockUploadTrack).not.toHaveBeenCalled();
  });

  it('throws when role cannot publish', async () => {
    await expect(
      handler({
        auth: testCallableAuth('user'),
        data: {
          audioStoragePath: 'intro-outro-sermons/sermon-1',
          title: 'Test',
          speakers: [],
          tags: [],
          description: '',
        },
      })
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(mockUploadTrack).not.toHaveBeenCalled();
  });

  it('surfaces invalid SoundCloud credentials as failed-precondition', async () => {
    mockUploadTrack.mockRejectedValue(new Error('Request failed with status code 401'));
    mockNormalizeSoundCloudApiError.mockImplementation(() => {
      throw Object.assign(new Error('Invalid SoundCloud token'), { code: 'failed-precondition' });
    });

    await handler({
      auth: testCallableAuth('admin'),
      data: {
        audioStoragePath: 'intro-outro-sermons/sermon-1',
        title: 'Test',
        speakers: [],
        tags: [],
        description: '',
      },
    })
      .then(() => {
        throw new Error('Expected handler to reject');
      })
      .catch((error: { code?: string; message?: string }) => {
        expect(error.code).toBe('internal');
        expect(error.message).toBe('Invalid SoundCloud token');
      });
  });
  it('does not start a provider creation when safe preparation fails', async () => {
    mockPrepareMultipartUpload.mockRejectedValueOnce(new Error('Storage metadata unavailable'));
    await expect(
      uploadToSoundCloudDomain({
        operationKey: 'durable:urm-app:job1:track',
        audioStoragePath: 'audio.mp3',
        title: 'Track',
        speakers: [],
        tags: [],
        description: '',
      })
    ).rejects.toThrow('Storage metadata unavailable');
    expect(executeProviderCreate).toHaveBeenCalledWith(expect.objectContaining({ prepare: expect.any(Function) }));
    expect(mockUploadTrack).not.toHaveBeenCalled();
  });
  it('does not reopen sources when a confirmed receipt returns its cached result', async () => {
    jest.mocked(executeProviderCreate).mockResolvedValueOnce({ trackIdentifier: 'cached-track' });
    expect(
      await uploadToSoundCloudDomain({
        operationKey: 'durable:urm-app:job1:track',
        audioStoragePath: 'audio.mp3',
        title: 'Track',
        speakers: [],
        tags: [],
        description: '',
      })
    ).toEqual({ soundCloudTrackId: 'cached-track' });
    expect(mockUploadTrack).not.toHaveBeenCalled();
    expect(mockDisposePreparedUpload).not.toHaveBeenCalled();
    expect(mockPrepareMultipartUpload).not.toHaveBeenCalled();
  });
  it('disposes source streams when receipt ownership is lost after safe preparation', async () => {
    (executeProviderCreate as unknown as jest.Mock).mockImplementationOnce(
      async (options: { prepare: () => Promise<void> }) => {
        await options.prepare();
        throw new Error('Claim lost');
      }
    );
    await expect(
      uploadToSoundCloudDomain({
        operationKey: 'durable:urm-app:job1:track',
        audioStoragePath: 'audio.mp3',
        title: 'Track',
        speakers: [],
        tags: [],
        description: '',
      })
    ).rejects.toThrow('Claim lost');
    expect(mockUploadTrack).not.toHaveBeenCalled();
    expect(mockDisposePreparedUpload).toHaveBeenCalledTimes(1);
  });
});

it('binds the authenticated account prepared with the actual SoundCloud POST token', async () => {
  jest.clearAllMocks();
  mockUploadTrack.mockResolvedValue({ trackIdentifier: 'soundcloud:tracks:123' });
  (executeProviderCreate as unknown as jest.Mock).mockImplementationOnce(
    async (options: {
      prepare: () => Promise<void>;
      getProviderAccount: () => unknown;
      execute: () => Promise<unknown>;
    }) => {
      await options.prepare();
      expect(options.getProviderAccount()).toEqual({ provider: 'soundcloud', account: 'soundcloud:users:42' });
      return options.execute();
    }
  );
  await uploadToSoundCloudDomain({
    operationKey: 'durable:urm-app:job1:track',
    audioStoragePath: 'audio.mp3',
    title: 'Track',
    speakers: [],
    tags: [],
    description: '',
  });
  expect(mockUploadTrack).toHaveBeenCalledWith('fake-soundcloud-token', expect.any(Object));
});

it('blocks replacement allocation if the actual POST token belongs to a changed account',async()=>{
  jest.clearAllMocks();
  await expect(uploadToSoundCloudDomain({operationKey:'durable:urm-app:job1:replacement',audioStoragePath:'audio.mp3',title:'Track',speakers:[],tags:[],description:''},{expectedProviderAccount:'soundcloud:users:99'})).rejects.toBeDefined();
  expect(mockPrepareMultipartUpload).not.toHaveBeenCalled();
  expect(mockUploadTrack).not.toHaveBeenCalled();
});
