import { testCallableAuth, type AuthData } from '../helpers/callableAuth';
import axios from 'axios';
import { withIdempotency } from '../../locks/withIdempotency';
import { withSubsplashLocks } from '../../locks/withSubsplashLocks';
import handleError from '../../handleError';
import { emitOperationalAlert } from '../../notifications/emitOperationalAlert';
import uploadToSubsplash from '../../uploadToSubsplash';
import editSubsplashSermon from '../../editSubsplashSermon';
import deleteFromSubsplash from '../../deleteFromSubsplash';
import uploadToSoundCloud from '../../uploadToSoundCloud';
import editSoundCloudSermon from '../../editSoundCloudSermon';
import deleteFromSoundCloud from '../../deleteFromSoundCloud';
import addintrooutrotaskgenerator from '../../../../functions-media/src/addIntroOutroTaskGenerator';
import { HttpsError } from 'firebase-functions/v2/https';
import { SOUNDCLOUD_AUTH_RECONNECT_REQUIRED_CODE } from '@upperroom/shared/shared/soundcloudAuth';

const mockUploadTrack = jest.fn();
const mockPrepareMultipartUpload = jest.fn();
const mockRunWithSoundCloudAccessToken = jest.fn();
const mockQueueAudioRequest = jest.fn();
const mockUpdateTrack = jest.fn();
const mockDeleteTrack = jest.fn();
const mockSermonDocUpdate = jest.fn();
const mockStorageFileExists = jest.fn();
const mockStorageFileGetMetadata = jest.fn();

jest.mock('../../locks/withIdempotency', () => ({
  withIdempotency: jest.fn(async (_operationKey: string, run: () => Promise<unknown>) => run()),
}));
jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: jest.fn(async (_lockKeys: string[], run: () => Promise<unknown>) => run()),
}));
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: jest.fn().mockResolvedValue('fake-token'),
  createAxiosConfig: jest.fn((url: string, _token: string, method: string, data?: unknown) => ({
    url,
    method,
    data,
    headers: {},
  })),
}));
jest.mock('../../notifications/emitOperationalAlert', () => ({
  emitOperationalAlert: jest.fn(async () => undefined),
}));
jest.mock('../../handleError', () => ({
  __esModule: true,
  default: jest.fn((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return Object.assign(new Error(`normalized:${message}`), { code: 'internal' });
  }),
}));
jest.mock('../../soundcloudClient', () => ({
  getAuthenticatedSoundCloudAccountId: jest.fn().mockResolvedValue('soundcloud:users:123'),
  uploadTrack: (...args: unknown[]) => mockUploadTrack(...args),
  prepareMultipartUpload: (...args: unknown[]) => mockPrepareMultipartUpload(...args),
  updateTrack: (...args: unknown[]) => mockUpdateTrack(...args),
  deleteTrack: (...args: unknown[]) => mockDeleteTrack(...args),
  isSoundCloudTrackNotFoundError: () => false,
  normalizeSoundCloudApiError: (error: unknown) => {
    throw error;
  },
}));
jest.mock('../../soundcloudSecrets', () => ({
  getSoundCloudAccessToken: () => 'fake-soundcloud-token',
  refreshSoundCloudAccessToken: () => 'fake-soundcloud-token',
  runWithSoundCloudAccessToken: (operation: (token: string) => unknown) => mockRunWithSoundCloudAccessToken(operation),
  soundcloudSecretsWithRuntimeAlerts: [],
  soundcloudOAuthSecrets: [],
}));
jest.mock('../../../../functions-media/src/processAudioQueueStore', () => ({
  queueOrReplaceProcessAudioRequest: (...args: unknown[]) => mockQueueAudioRequest(...args),
}));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    app: () => jest.requireActual('firebase-admin/app').getApp(),
    storage: () => ({
      bucket: () => ({
        name: 'urm-app.appspot.com',
        file: () => ({
          exists: (...args: unknown[]) => mockStorageFileExists(...args),
          getMetadata: (...args: unknown[]) => mockStorageFileGetMetadata(...args),
          download: () => Promise.resolve([Buffer.alloc(0)]),
          delete: jest.fn(),
          setMetadata: jest.fn(),
        }),
      }),
    }),
    firestore: () => {
      const actual = jest.requireActual('firebase-admin/firestore').getFirestore();
      return {
        // Exercise real cutover leases while keeping the business projection
        // update observed by this notification contract test.
        doc: actual.doc.bind(actual),
        runTransaction: actual.runTransaction.bind(actual),
        collection: (collectionName: string) =>
          collectionName === 'sermons'
            ? {
                doc: (id: string) => ({
                  get: () => actual.collection('sermons').doc(id).get(),
                  update: (...args: unknown[]) => mockSermonDocUpdate(...args),
                }),
                withConverter: () => ({
                  doc: () => ({ update: (...args: unknown[]) => mockSermonDocUpdate(...args) }),
                }),
              }
            : actual.collection(collectionName),
      };
    },
    database: () => ({
      ref: () => ({
        set: jest.fn(),
        remove: jest.fn(),
      }),
    }),
  },
}));
jest.mock('axios');
jest.mock('firebase-functions/v2/https', () => {
  const actual = jest.requireActual('firebase-functions/v2/https');
  return {
    ...actual,
    onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: unknown) =>
      typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler
    ),
  };
});

type RuntimeAlertTarget = {
  functionName: string;
  alertCode: string;
  requiredContextFields: string[];
};

const publishRuntimeAlertTargets: RuntimeAlertTarget[] = [
  {
    functionName: 'uploadToSubsplash',
    alertCode: 'PUBLISH_SUBSPLASH_UPLOAD_RUNTIME_FAILURE',
    requiredContextFields: ['functionName', 'operationKey', 'lockKey'],
  },
  {
    functionName: 'editSubsplashSermon',
    alertCode: 'PUBLISH_SUBSPLASH_EDIT_RUNTIME_FAILURE',
    requiredContextFields: ['functionName', 'operationKey', 'subsplashId'],
  },
  {
    functionName: 'deleteFromSubsplash',
    alertCode: 'PUBLISH_SUBSPLASH_DELETE_RUNTIME_FAILURE',
    requiredContextFields: ['functionName', 'operationKey', 'subsplashId'],
  },
  {
    functionName: 'uploadToSoundCloud',
    alertCode: 'PUBLISH_SOUNDCLOUD_UPLOAD_RUNTIME_FAILURE',
    requiredContextFields: ['functionName', 'audioStoragePath'],
  },
  {
    functionName: 'editSoundCloudSermon',
    alertCode: 'PUBLISH_SOUNDCLOUD_EDIT_RUNTIME_FAILURE',
    requiredContextFields: ['functionName', 'trackId'],
  },
  {
    functionName: 'deleteFromSoundCloud',
    alertCode: 'PUBLISH_SOUNDCLOUD_DELETE_RUNTIME_FAILURE',
    requiredContextFields: ['functionName', 'soundCloudTrackId'],
  },
];

const audioRuntimeAlertTargets: RuntimeAlertTarget[] = [
  {
    functionName: 'addintrooutrotaskgenerator',
    alertCode: 'AUDIO_TASK_GENERATOR_RUNTIME_FAILURE',
    requiredContextFields: ['functionName', 'sermonId', 'audioSourceType', 'audioSource', 'taskRoute'],
  },
];

const runtimeAlertTargets = [...publishRuntimeAlertTargets, ...audioRuntimeAlertTargets];

type CallableRequestShape<T> = {
  auth?: AuthData;
  data: T;
};

const uploadToSubsplashHandler = uploadToSubsplash as unknown as (
  request: CallableRequestShape<Record<string, unknown>>
) => Promise<unknown>;
const editSubsplashSermonHandler = editSubsplashSermon as unknown as (
  request: CallableRequestShape<Record<string, unknown>>
) => Promise<unknown>;
const deleteFromSubsplashHandler = deleteFromSubsplash as unknown as (
  request: CallableRequestShape<Record<string, unknown>>
) => Promise<unknown>;
const uploadToSoundCloudHandler = uploadToSoundCloud as unknown as (
  request: CallableRequestShape<Record<string, unknown>>
) => Promise<unknown>;
const editSoundCloudSermonHandler = editSoundCloudSermon as unknown as (
  request: CallableRequestShape<Record<string, unknown>>
) => Promise<unknown>;
const deleteFromSoundCloudHandler = deleteFromSoundCloud as unknown as (
  request: CallableRequestShape<Record<string, unknown>>
) => Promise<unknown>;
const addIntroOutroTaskGeneratorHandler = addintrooutrotaskgenerator as unknown as (
  request: CallableRequestShape<Record<string, unknown>>
) => Promise<unknown>;

const mockAxios = axios as jest.MockedFunction<typeof axios>;
const mockWithIdempotency = withIdempotency as jest.MockedFunction<typeof withIdempotency>;
const mockWithSubsplashLocks = withSubsplashLocks as jest.MockedFunction<typeof withSubsplashLocks>;
const mockEmitOperationalAlert = emitOperationalAlert as jest.MockedFunction<typeof emitOperationalAlert>;
const mockHandleError = handleError as jest.MockedFunction<typeof handleError>;

const adminAuth = testCallableAuth('admin');

const buildUploadToSubsplashPayload = () => ({
  operationKey: 'upload-op-1',
  lockKey: 'sermon-123',
  title: 'Sermon',
  subtitle: 'Episode',
  speakers: [],
  autoPublish: false,
  audioTitle: 'Audio',
  audioUrl: 'https://example.com/audio.mp3',
  topics: [],
  description: 'desc',
  images: [],
  date: new Date(),
});

const buildAddIntroOutroPayload = () => ({
  id: 'sermon-audio-123',
  startTime: 0,
  duration: 180,
  storageFilePath: 'sermons/sermon-audio-123',
  introUrl: 'https://example.com/intro.mp3',
  outroUrl: 'https://example.com/outro.mp3',
});

describe('runtime alert taxonomy contract', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockWithIdempotency.mockReset();
    mockWithSubsplashLocks.mockReset();
    mockPrepareMultipartUpload.mockReset();
    mockRunWithSoundCloudAccessToken.mockReset();
    mockQueueAudioRequest.mockReset();
    mockHandleError.mockReset();
    mockHandleError.mockImplementation((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return new HttpsError('internal', `normalized:${message}`);
    });
    mockWithSubsplashLocks.mockImplementation(async (_keys, run) => run());
    mockPrepareMultipartUpload.mockResolvedValue({
      post: (token: string) => mockUploadTrack(token),
      dispose: jest.fn(),
    });
    mockRunWithSoundCloudAccessToken.mockImplementation(async (operation: (token: string) => unknown) =>
      operation('fake-soundcloud-token')
    );
    mockQueueAudioRequest.mockResolvedValue({ state: 'queued', sourceType: 'storage', requestVersion: 'test-request' });
    await jest
      .requireActual('firebase-admin/firestore')
      .getFirestore()
      .collection('sermons')
      .doc('sermon-audio-123')
      .set({ uploaderId: adminAuth.uid });
    process.env.SUBSPLASH_EMAIL = 'test@example.com';
    process.env.SUBSPLASH_PASSWORD = 'test-password';

    mockAxios.mockResolvedValue({ status: 200, data: { id: 'media-item-1' } } as never);
    mockWithIdempotency.mockImplementation(async (_operationKey, run) => run());
    mockUploadTrack.mockResolvedValue({
      trackIdentifier: 'sc-track-1',
      permalinkUrl: 'https://soundcloud.com/upper-room-media/sermon-1',
    });
    mockUpdateTrack.mockResolvedValue({
      trackIdentifier: 'sc-track-1',
      permalinkUrl: 'https://soundcloud.com/upper-room-media/sermon-1',
    });
    mockDeleteTrack.mockResolvedValue(undefined);
    mockSermonDocUpdate.mockResolvedValue(undefined);
    mockStorageFileExists.mockResolvedValue([true]);
    mockStorageFileGetMetadata.mockResolvedValue([
      {
        bucket: 'urm-app.appspot.com',
        name: 'sermons/sermon-audio-123',
        generation: '1',
        timeCreated: '2020-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('declares deterministic alert codes and context requirements for each targeted catch path', () => {
    expect(runtimeAlertTargets).toHaveLength(7);

    for (const target of runtimeAlertTargets) {
      expect(target.alertCode).toMatch(/^[A-Z0-9_]+$/);
      expect(target.requiredContextFields).toEqual(expect.arrayContaining(['functionName']));
    }
  });

  it('uses unique alert codes across all targeted catch paths', () => {
    const codes = runtimeAlertTargets.map((target) => target.alertCode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('emits publish alert for uploadToSubsplash catch path with operation context', async () => {
    mockWithSubsplashLocks.mockRejectedValueOnce(new Error('subsplash upload failed'));

    await expect(
      uploadToSubsplashHandler({
        auth: adminAuth,
        data: buildUploadToSubsplashPayload(),
      })
    ).rejects.toMatchObject({ code: 'internal', message: 'normalized:subsplash upload failed' });
    expect(mockWithSubsplashLocks).toHaveBeenCalledTimes(1);
    expect(mockAxios).not.toHaveBeenCalled();

    expect(mockEmitOperationalAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertCode: 'PUBLISH_SUBSPLASH_UPLOAD_RUNTIME_FAILURE',
        context: expect.objectContaining({
          functionName: 'uploadToSubsplash',
          operationKey: 'upload-op-1',
          lockKey: 'sermon-123',
        }),
      })
    );
  });

  it('emits publish alert for editSubsplashSermon catch path with entity context', async () => {
    mockWithIdempotency.mockRejectedValueOnce(new Error('subsplash edit failed'));

    await expect(
      editSubsplashSermonHandler({
        auth: adminAuth,
        data: {
          operationKey: 'edit-op-1',
          subsplashId: 'media-item-123',
          title: 'Updated',
        },
      })
    ).rejects.toMatchObject({ code: 'internal', message: 'normalized:subsplash edit failed' });

    expect(mockEmitOperationalAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertCode: 'PUBLISH_SUBSPLASH_EDIT_RUNTIME_FAILURE',
        context: expect.objectContaining({
          functionName: 'editSubsplashSermon',
          operationKey: 'edit-op-1',
          subsplashId: 'media-item-123',
        }),
      })
    );
  });

  it('emits publish alert for deleteFromSubsplash catch path with entity context', async () => {
    mockWithIdempotency.mockRejectedValueOnce(new Error('subsplash delete failed'));

    await expect(
      deleteFromSubsplashHandler({
        auth: adminAuth,
        data: {
          operationKey: 'delete-op-1',
          subsplashId: 'media-item-456',
        },
      })
    ).rejects.toMatchObject({ code: 'internal', message: 'normalized:subsplash delete failed' });

    expect(mockEmitOperationalAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertCode: 'PUBLISH_SUBSPLASH_DELETE_RUNTIME_FAILURE',
        context: expect.objectContaining({
          functionName: 'deleteFromSubsplash',
          operationKey: 'delete-op-1',
          subsplashId: 'media-item-456',
        }),
      })
    );
  });

  it('emits publish alert for uploadToSoundCloud catch path with request context', async () => {
    mockPrepareMultipartUpload.mockRejectedValueOnce(new Error('soundcloud upload failed'));

    await expect(
      uploadToSoundCloudHandler({
        auth: adminAuth,
        data: {
          audioStoragePath: 'intro-outro-sermons/sermon-11',
          title: 'Sermon',
          speakers: [],
          tags: ['tag-a'],
          description: 'desc',
        },
      })
    ).rejects.toMatchObject({ code: 'internal', message: 'normalized:soundcloud upload failed' });
    expect(mockPrepareMultipartUpload).toHaveBeenCalledTimes(1);
    expect(mockUploadTrack).not.toHaveBeenCalled();

    expect(mockEmitOperationalAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertCode: 'PUBLISH_SOUNDCLOUD_UPLOAD_RUNTIME_FAILURE',
        context: expect.objectContaining({
          functionName: 'uploadToSoundCloud',
          audioStoragePath: 'intro-outro-sermons/sermon-11',
        }),
      })
    );
  });

  it('emits publish alert for editSoundCloudSermon catch path with request context', async () => {
    mockUpdateTrack.mockRejectedValueOnce(new Error('soundcloud edit failed'));

    await expect(
      editSoundCloudSermonHandler({
        auth: adminAuth,
        data: {
          trackId: 'sc-track-22',
          title: 'Edited',
        },
      })
    ).rejects.toMatchObject({ code: 'internal', message: 'normalized:soundcloud edit failed' });

    expect(mockEmitOperationalAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertCode: 'PUBLISH_SOUNDCLOUD_EDIT_RUNTIME_FAILURE',
        context: expect.objectContaining({
          functionName: 'editSoundCloudSermon',
          trackId: 'sc-track-22',
        }),
      })
    );
  });

  it('emits publish alert for deleteFromSoundCloud catch path with request context', async () => {
    mockDeleteTrack.mockRejectedValueOnce(new Error('soundcloud delete failed'));

    await expect(
      deleteFromSoundCloudHandler({
        auth: adminAuth,
        data: {
          soundCloudTrackId: 'sc-track-99',
        },
      })
    ).rejects.toMatchObject({ code: 'internal', message: 'normalized:soundcloud delete failed' });

    expect(mockEmitOperationalAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertCode: 'PUBLISH_SOUNDCLOUD_DELETE_RUNTIME_FAILURE',
        context: expect.objectContaining({
          functionName: 'deleteFromSoundCloud',
          soundCloudTrackId: 'sc-track-99',
        }),
      })
    );
  });

  it('emits reconnect alert when SoundCloud upload requires re-authorization', async () => {
    mockRunWithSoundCloudAccessToken.mockRejectedValueOnce(
      new HttpsError('failed-precondition', 'SoundCloud authorization is missing or expired.', {
        code: SOUNDCLOUD_AUTH_RECONNECT_REQUIRED_CODE,
      })
    );

    await expect(
      uploadToSoundCloudHandler({
        auth: adminAuth,
        data: {
          audioStoragePath: 'intro-outro-sermons/sermon-reauth',
          title: 'Reconnect',
          speakers: [],
          tags: [],
          description: '',
        },
      })
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'SoundCloud authorization is missing or expired.',
    });
    expect(mockRunWithSoundCloudAccessToken).toHaveBeenCalledTimes(1);
    expect(mockPrepareMultipartUpload).not.toHaveBeenCalled();
    expect(mockUploadTrack).not.toHaveBeenCalled();

    expect(mockEmitOperationalAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertCode: 'PUBLISH_SOUNDCLOUD_UPLOAD_RUNTIME_FAILURE',
        context: expect.objectContaining({
          functionName: 'uploadToSoundCloud',
          audioStoragePath: 'intro-outro-sermons/sermon-reauth',
          soundCloudRecoveryCode: SOUNDCLOUD_AUTH_RECONNECT_REQUIRED_CODE,
        }),
      })
    );
  });

  it('does not dedupe repeated publish catch-path failures', async () => {
    mockPrepareMultipartUpload.mockRejectedValue(new Error('soundcloud upload repeated failure'));

    const failingRequest = {
      auth: adminAuth,
      data: {
        audioStoragePath: 'intro-outro-sermons/sermon-repeat',
        title: 'Repeat',
        speakers: [],
        tags: [],
        description: '',
      },
    };

    await expect(uploadToSoundCloudHandler(failingRequest)).rejects.toMatchObject({
      code: 'internal',
      message: 'normalized:soundcloud upload repeated failure',
    });
    await expect(uploadToSoundCloudHandler(failingRequest)).rejects.toMatchObject({
      code: 'internal',
      message: 'normalized:soundcloud upload repeated failure',
    });

    expect(mockEmitOperationalAlert).toHaveBeenCalledTimes(2);
    expect(mockPrepareMultipartUpload).toHaveBeenCalledTimes(2);
    expect(mockUploadTrack).not.toHaveBeenCalled();
  });

  it('emits audio alert for addintrooutrotaskgenerator catch path with task input context', async () => {
    mockQueueAudioRequest.mockRejectedValueOnce(new Error('task enqueue failed'));

    await expect(
      addIntroOutroTaskGeneratorHandler({
        auth: adminAuth,
        data: buildAddIntroOutroPayload(),
      })
    ).rejects.toMatchObject({ code: 'internal', message: 'normalized:task enqueue failed' });
    expect(mockStorageFileGetMetadata).toHaveBeenCalledTimes(1);
    expect(mockQueueAudioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyConfiguredSourceBucket: 'urm-app.appspot.com',
        legacyOriginalStorageSource: {
          kind: 'storage',
          bucket: 'urm-app.appspot.com',
          path: 'sermons/sermon-audio-123',
          generation: '1',
          timeCreated: '2020-01-01T00:00:00.000Z',
        },
      })
    );
    expect(mockQueueAudioRequest).toHaveBeenCalledTimes(1);

    expect(mockEmitOperationalAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertCode: 'AUDIO_TASK_GENERATOR_RUNTIME_FAILURE',
        context: expect.objectContaining({
          functionName: 'addintrooutrotaskgenerator',
          sermonId: 'sermon-audio-123',
          audioSourceType: 'StorageFilePath',
          audioSource: 'sermons/sermon-audio-123',
          taskRoute: 'processaudiofiletask',
        }),
      })
    );
  });

  it('does not emit a runtime alert or enqueue audio for an expected admission pause', async () => {
    const db = jest.requireActual('firebase-admin/firestore').getFirestore();
    const controlRef = db.doc('_control/temporalRelease');
    const previous = await controlRef.get();
    try {
      await controlRef.set({
        schemaVersion: 1,
        revision: 1,
        releaseId: 'runtime-alert-paused',
        admission: 'paused',
        domains: { media: { owner: 'legacy', admission: 'paused' } },
        updatedAt: Date.now(),
      });
      await expect(
        addIntroOutroTaskGeneratorHandler({ auth: adminAuth, data: buildAddIntroOutroPayload() })
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(mockStorageFileGetMetadata).not.toHaveBeenCalled();
      expect(mockSermonDocUpdate).not.toHaveBeenCalled();
      expect(mockQueueAudioRequest).not.toHaveBeenCalled();
      expect(mockEmitOperationalAlert).not.toHaveBeenCalled();
      expect(mockHandleError).not.toHaveBeenCalled();
    } finally {
      if (previous.exists) await controlRef.set(previous.data());
      else await controlRef.delete();
    }
  });

  it('preserves normalized error behavior via handleError in publish catch paths', async () => {
    mockDeleteTrack.mockRejectedValueOnce(new Error('unchanged error path'));

    await expect(
      deleteFromSoundCloudHandler({
        auth: adminAuth,
        data: {
          soundCloudTrackId: 'sc-track-unchanged',
        },
      })
    ).rejects.toMatchObject({ code: 'internal', message: 'normalized:unchanged error path' });

    expect(mockHandleError).toHaveBeenCalledTimes(1);
  });
});
