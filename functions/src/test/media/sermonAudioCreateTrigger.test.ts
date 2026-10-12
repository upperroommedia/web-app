import type { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import { computeProcessAudioRequestVersion } from '@upperroom/contracts/processAudioQueue';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { Sermon, sermonStatusType, uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { queueOrReplaceProcessAudioRequest } from '../../../../functions-media/src/processAudioQueueStore';
import { enqueueInitialSermonAudio } from '../../../../functions-media/src/sermonAudioCreateTrigger';

const buildSermon = (overrides: Partial<Sermon> = {}): Sermon => ({
  id: 'sermon-123',
  title: 'Synthetic sermon',
  description: '',
  speakers: [],
  subtitle: 'Sunday Homilies',
  dateMillis: 1,
  sourceStartTime: 12,
  trimDurationSeconds: 900,
  durationSeconds: 0,
  topics: [],
  status: {
    audioStatus: sermonStatusType.PENDING,
    soundCloud: uploadStatus.NOT_UPLOADED,
    subsplash: uploadStatus.NOT_UPLOADED,
  },
  images: [],
  createdAtMillis: 1,
  editedAtMillis: 1,
  youtubeUrl: 'https://www.youtube.com/watch?v=synthetic',
  ...overrides,
});

describe('sermonAudioCreateTrigger', () => {
  afterEach(async () => {
    await Promise.all([
      firebaseAdmin.database().ref('processAudioRequests/sermon-123').remove(),
      firebaseAdmin.database().ref('processAudioQueueClaims/sermon-123').remove(),
    ]);
  });

  it('enqueues a newly created pending YouTube sermon without a follow-up browser request', async () => {
    const enqueued: AddIntroOutroInputType[] = [];
    const existingFiles = new Set(['intros/Sunday Homilies_intro.mp3', 'outros/default_outro.mp3']);

    const result = await enqueueInitialSermonAudio('sermon-123', buildSermon(), {
      fileExists: async (path) => existingFiles.has(path),
      getDownloadUrl: async (path) => `https://storage.example.test/${encodeURIComponent(path)}`,
      enqueue: async (payload) => {
        enqueued.push(payload);
        return { action: 'queued' };
      },
    });

    expect(result).toEqual({ action: 'enqueued', queueAction: 'queued' });
    expect(enqueued).toEqual([
      {
        id: 'sermon-123',
        youtubeUrl: 'https://www.youtube.com/watch?v=synthetic',
        startTime: 12,
        duration: 900,
        deleteOriginal: true,
        introUrl: 'https://storage.example.test/intros%2FSunday%20Homilies_intro.mp3',
        outroUrl: 'https://storage.example.test/outros%2Fdefault_outro.mp3',
      },
    ]);
  });

  it('does not enqueue imported or already processed sermons', async () => {
    const enqueue = jest.fn();

    await expect(
      enqueueInitialSermonAudio(
        'sermon-123',
        buildSermon({
          status: {
            audioStatus: sermonStatusType.PROCESSED,
            soundCloud: uploadStatus.NOT_UPLOADED,
            subsplash: uploadStatus.NOT_UPLOADED,
          },
        }),
        {
          fileExists: jest.fn(),
          getDownloadUrl: jest.fn(),
          enqueue,
        }
      )
    ).resolves.toEqual({ action: 'skipped', reason: 'not_pending' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('retries through the Firestore event when an uploaded storage source is not available yet', async () => {
    const enqueue = jest.fn();

    await expect(
      enqueueInitialSermonAudio('sermon-123', buildSermon({ youtubeUrl: undefined }), {
        fileExists: async (path) => path === 'outros/default_outro.mp3' || path === 'intros/default_intro.mp3',
        getDownloadUrl: async (path) => `https://storage.example.test/${encodeURIComponent(path)}`,
        enqueue,
      })
    ).rejects.toThrow('Initial sermon audio source is not available');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('coalesces the create trigger when the browser already queued the same request', async () => {
    const payload: AddIntroOutroInputType = {
      id: 'sermon-123',
      youtubeUrl: 'https://www.youtube.com/watch?v=synthetic',
      startTime: 12,
      duration: 900,
      deleteOriginal: true,
      introUrl: 'https://storage.example.test/intro.mp3',
      outroUrl: 'https://storage.example.test/outro.mp3',
    };
    const requestVersion = computeProcessAudioRequestVersion(payload);
    const requestRef = firebaseAdmin.database().ref('processAudioRequests/sermon-123');
    await requestRef.set({
      sermonId: 'sermon-123',
      sourceType: 'youtube',
      currentPayload: payload,
      currentRequestVersion: requestVersion,
      queuedTaskId: 'existing-task',
      queuedAt: '2026-10-06T00:00:00.000Z',
      updatedAt: '2026-10-06T00:00:00.000Z',
    });

    await expect(
      queueOrReplaceProcessAudioRequest({
        database: firebaseAdmin.database(),
        payload,
        targetUri: 'https://processor.example.test/task',
        ownerId: 'sermon-create:event-123',
        onlyIfMissing: true,
      })
    ).resolves.toEqual({
      action: 'unchanged',
      requestVersion,
      sourceType: 'youtube',
    });

    expect((await requestRef.child('queuedTaskId').get()).val()).toBe('existing-task');
  });
});
