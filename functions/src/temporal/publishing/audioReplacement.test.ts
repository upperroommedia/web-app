jest.mock('../../soundcloudClient', () => ({
  normalizeSoundCloudAccountId: (value: { urn?: string } | undefined) => value?.urn,
}));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    app: () => ({ options: { projectId: 'urm-app' } }),
    firestore: jest.fn(),
    auth: jest.fn(),
    storage: jest.fn(),
  },
}));
jest.mock('../../storageDownloadUrl', () => ({
  readFirebaseDownloadUrl: jest.fn().mockResolvedValue('https://trusted.invalid/audio'),
}));
jest.mock('axios', () => ({ __esModule: true, default: Object.assign(jest.fn(), { get: jest.fn() }) }));
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: jest.fn().mockResolvedValue('private-token'),
  createAxiosConfig: (url: string, _token: string, method: string, data: unknown) => ({ url, method, data }),
}));
jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: (_keys: string[], run: () => Promise<unknown>) => run(),
}));
jest.mock('../../soundcloudSecrets', () => ({
  runWithSoundCloudAccessToken: (run: (token: string) => Promise<unknown>) => run('private-token'),
}));
jest.mock('../../uploadToSoundCloud', () => ({
  uploadToSoundCloudDomain: jest
    .fn()
    .mockResolvedValue({ soundCloudTrackId: 'new-track', soundCloudTrackUrl: 'https://soundcloud.invalid/new' }),
}));
jest.mock('./providerDeletion', () => ({
  deletePublishingSoundCloudTrack: jest.fn().mockResolvedValue({ absenceConfirmed: true }),
}));
jest.mock('./providerReceipts', () => ({
  ...jest.requireActual('./providerReceipts'),
  executeProviderCreate: jest.fn((options: { execute: () => Promise<unknown> }) => options.execute()),
}));
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import axios from 'axios';
import { uploadToSoundCloudDomain } from '../../uploadToSoundCloud';
import { deletePublishingSoundCloudTrack } from './providerDeletion';
import {
  replacePublishedSoundCloudAudio,
  replacePublishedSubsplashAudio,
  type AudioReplacementStore,
} from './audioReplacement';
import type { PrivatePublishingIntent } from './types';
const ref = { jobId: 'parent', projectId: 'urm-app' };
const intent: PrivatePublishingIntent = {
  sermonId: 'sermon',
  generation: 1,
  action: 'update',
  actorUid: 'admin',
  destinations: { listIds: [], soundcloud: true },
  payload: {
    sermon: { title: 'Desired', description: 'Description', subtitle: 'Talk', topics: [], speakers: [], images: [] },
    processAudio: { soundcloudPolicy: 'recreate_track' },
  },
};
function fixture() {
  const rows: Record<string, Record<string, unknown>> = {
    'durableJobs/parent': { destinations: [] },
    'sermons/sermon': {
      soundCloudTrackId: 'old-track',
      audioArtifacts: { jobId: 'audio-job', requestVersion: 'version', finalPath: 'immutable/final.mp3' },
    },
    'temporalPublishingAudioDependencies/parent': { mediaRef: { jobId: 'audio-job', requestVersion: 'version' } },
  };
  const document = (path: string) => ({
    path,
    get: async () => ({ exists: Boolean(rows[path]), data: () => rows[path], get: (key: string) => rows[path]?.[key] }),
  });
  const db = { collection: (collection: string) => ({ doc: (id: string) => document(`${collection}/${id}`) }) };
  (firebaseAdmin.firestore as unknown as jest.Mock).mockReturnValue(db);
  (firebaseAdmin.auth as jest.Mock).mockReturnValue({
    getUser: async () => ({ uid: 'admin', disabled: false, customClaims: { role: 'admin' } }),
  });
  (firebaseAdmin.storage as jest.Mock).mockReturnValue({ bucket: () => ({ file: () => ({}) }) });
  const store: AudioReplacementStore = {
    leaseAudio: jest.fn().mockResolvedValue(undefined),
    assertCurrent: jest.fn().mockResolvedValue(undefined),
    commitCurrent: jest.fn(async (_ref, mutate) => {
      await mutate({
        get: async (doc: { path: string }) => ({
          exists: !!rows[doc.path],
          get: (key: string) => rows[doc.path]?.[key],
        }),
        set: (doc: { path: string }, data: Record<string, unknown>) => {
          rows[doc.path] = { ...rows[doc.path], ...data };
        },
        update: (doc: { path: string }, data: Record<string, unknown>) => {
          rows[doc.path] = { ...rows[doc.path], ...data };
        },
      } as unknown as Parameters<Parameters<AudioReplacementStore['commitCurrent']>[1]>[0]);
    }),
  };
  (axios.get as jest.Mock).mockImplementation(async (url: string) => ({
    data: url.endsWith('/me')
      ? { urn: 'soundcloud:users:42' }
      : url.endsWith('/streams')
      ? { hls_mp3_128_url: 'https://stream.invalid/ready' }
      : url.includes('old-track')
      ? {
          user: { urn: 'soundcloud:users:42' },
          sharing: 'private',
          license: 'all-rights-reserved',
          commentable: false,
          artwork_url: 'https://trusted.invalid/artwork',
        }
      : { streamable: true },
  }));
  return { rows, store };
}
describe('published audio replacement', () => {
  beforeEach(() => jest.clearAllMocks());
  it('preserves privacy/rights, confirms stream readiness, atomically switches then removes old track', async () => {
    const { rows, store } = fixture();
    (deletePublishingSoundCloudTrack as jest.Mock).mockImplementation(async (_ref, _intent, _store, id) => {
      expect(rows['sermons/sermon'].soundCloudTrackId).toBe('new-track');
      expect(id).toBe('old-track');
    });
    await replacePublishedSoundCloudAudio(ref, intent, store);
    expect(uploadToSoundCloudDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        audioStoragePath: 'immutable/final.mp3',
        providerMetadata: { sharing: 'private', license: 'all-rights-reserved', commentable: false },
      }),
      { expectedProviderAccount: 'soundcloud:users:42' }
    );
    expect(rows['sermons/sermon'].soundCloudTrackId).toBe('new-track');
    expect(rows['temporalPublishingAudioReplacements/parent-sermon'].soundcloudCleanupComplete).toBe(true);
  });
  it('preserves an intentional unstreamable setting while still requiring encoded output', async () => {
    const { rows, store } = fixture();
    (axios.get as jest.Mock).mockImplementation(async (url) => ({
      data: url.endsWith('/me')
        ? { urn: 'soundcloud:users:42' }
        : url.endsWith('/streams')
        ? { hls_mp3_128_url: 'https://stream.invalid/encoded' }
        : url.includes('old-track')
        ? { user: { urn: 'soundcloud:users:42' }, streamable: false, sharing: 'private' }
        : { streamable: false },
    }));
    await replacePublishedSoundCloudAudio(ref, intent, store);
    expect(uploadToSoundCloudDomain).toHaveBeenCalledWith(
      expect.objectContaining({ providerMetadata: { streamable: false, sharing: 'private' } }),
      { expectedProviderAccount: 'soundcloud:users:42' }
    );
    expect(rows['sermons/sermon'].soundCloudTrackId).toBe('new-track');
    expect(rows['sermons/sermon'].soundCloudPublication).toEqual({ streamable: false, sharing: 'private' });
    expect(rows['durableJobs/parent'].destinations).toEqual([
      {
        destination: 'soundcloud',
        state: 'confirmed',
        message: 'Encoded replacement ready. Existing private, non-streaming settings were preserved.',
      },
    ]);
  });
  it('retains the old reference while replacement encoding is incomplete', async () => {
    const { rows, store } = fixture();
    (axios.get as jest.Mock).mockImplementation(async (url) => ({
      data: url.endsWith('/me')
        ? { urn: 'soundcloud:users:42' }
        : url.includes('old-track')
        ? { user: { urn: 'soundcloud:users:42' }, sharing: 'public' }
        : { streamable: false },
    }));
    await expect(replacePublishedSoundCloudAudio(ref, intent, store)).rejects.toMatchObject({
      code: 'PUBLISHING_AUDIO_PROCESSING',
    });
    expect(rows['sermons/sermon'].soundCloudTrackId).toBe('old-track');
    expect(deletePublishingSoundCloudTrack).not.toHaveBeenCalled();
  });
  it('does not allocate a replacement when the authenticated account does not own the old track', async () => {
    const { rows, store } = fixture();
    (axios.get as jest.Mock).mockImplementation(async (url) => ({
      data: url.endsWith('/me')
        ? { urn: 'soundcloud:users:other' }
        : { user: { urn: 'soundcloud:users:42' }, sharing: 'public' },
    }));
    await expect(replacePublishedSoundCloudAudio(ref, intent, store)).rejects.toMatchObject({
      code: 'PUBLISHING_PROVIDER_REPAIR_REQUIRED',
    });
    expect(uploadToSoundCloudDomain).not.toHaveBeenCalled();
    expect(deletePublishingSoundCloudTrack).not.toHaveBeenCalled();
    expect(rows['sermons/sermon'].soundCloudTrackId).toBe('old-track');
  });
  it('keeps existing SoundCloud audio only under an explicit policy', async () => {
    const { rows, store } = fixture();
    await replacePublishedSoundCloudAudio(
      ref,
      { ...intent, payload: { ...intent.payload, processAudio: { soundcloudPolicy: 'keep_existing_audio' } } },
      store
    );
    expect(rows['sermons/sermon'].soundCloudTrackId).toBe('old-track');
    expect(uploadToSoundCloudDomain).not.toHaveBeenCalled();
    expect(deletePublishingSoundCloudTrack).not.toHaveBeenCalled();
    expect(rows['temporalPublishingAudioReplacements/parent-sermon'].soundcloudPolicy).toBe('keep_existing_audio');
  });
  it('stops if another audio generation superseded the awaited dependency', async () => {
    const { rows, store } = fixture();
    rows['sermons/sermon'].audioArtifacts = { jobId: 'newer-audio', requestVersion: 'newer', finalPath: 'newer.mp3' };
    await expect(replacePublishedSoundCloudAudio(ref, intent, store)).rejects.toMatchObject({
      code: 'PUBLISHING_AUDIO_SUPERSEDED',
    });
    expect(uploadToSoundCloudDomain).not.toHaveBeenCalled();
  });
  it('keeps the old Subsplash binding while transcoding is incomplete', async () => {
    const { rows, store } = fixture();
    rows['sermons/sermon'].subsplashId = 'media';
    (axios as unknown as jest.Mock).mockImplementation(async (config) => ({
      data: config.url.endsWith('/media-items/media')
        ? { _embedded: { audio: { id: 'old-audio' } } }
        : config.url.endsWith('/audios')
        ? { id: 'new-audio' }
        : { id: 'transcode', status: 'processing' },
    }));
    await expect(replacePublishedSubsplashAudio(ref, intent, store)).rejects.toMatchObject({
      code: 'PUBLISHING_AUDIO_PROCESSING',
    });
    expect((axios as unknown as jest.Mock).mock.calls.some(([config]) => config.method === 'PATCH')).toBe(false);
    expect(rows['temporalPublishingAudioReplacements/parent-sermon'].oldSubsplashAudioId).toBe('old-audio');
  });
});
