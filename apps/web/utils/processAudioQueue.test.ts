import {
  computeProcessAudioRequestVersion,
  computeProcessAudioTaskId,
  normalizeProcessAudioRequest,
  sanitizeProcessAudioPayload,
} from '@upperroom/contracts/processAudioQueue';

describe('processAudioQueue contract helpers', () => {
  it('normalizes identical retry requests deterministically', () => {
    const payload = {
      id: 'sermon-123',
      youtubeUrl: 'https://www.youtube.com/watch?v=abc123',
      startTime: 12,
      duration: 345,
      deleteOriginal: true,
      introUrl: 'gs://intro.mp3',
      outroUrl: 'gs://outro.mp3',
    } as const;

    expect(normalizeProcessAudioRequest(payload)).toEqual({
      sermonId: 'sermon-123',
      sourceType: 'youtube',
      sourceValue: 'https://www.youtube.com/watch?v=abc123',
      startTime: 12,
      duration: 345,
      deleteOriginal: true,
      skipTranscode: false,
      introUrl: 'gs://intro.mp3',
      outroUrl: 'gs://outro.mp3',
    });
  });

  it('returns the same request version for the same effective payload', () => {
    const first = computeProcessAudioRequestVersion({
      id: 'sermon-123',
      storageFilePath: 'sermons/sermon-123',
      startTime: 0,
      duration: 120,
      deleteOriginal: true,
    });
    const second = computeProcessAudioRequestVersion({
      id: 'sermon-123',
      storageFilePath: 'sermons/sermon-123',
      startTime: 0,
      duration: 120,
      deleteOriginal: true,
      skipTranscode: false,
      introUrl: undefined,
      outroUrl: undefined,
    });

    expect(first).toBe(second);
  });

  it('sanitizes optional payload fields before queue state persistence', () => {
    expect(
      sanitizeProcessAudioPayload({
        id: 'sermon-123',
        youtubeUrl: 'https://www.youtube.com/watch?v=abc123',
        startTime: 0,
        duration: 120,
        deleteOriginal: undefined,
        skipTranscode: undefined,
        introUrl: undefined,
        outroUrl: undefined,
      })
    ).toEqual({
      id: 'sermon-123',
      youtubeUrl: 'https://www.youtube.com/watch?v=abc123',
      startTime: 0,
      duration: 120,
      deleteOriginal: false,
      skipTranscode: false,
    });
  });

  it('changes the request version when the trim window changes', () => {
    const initial = computeProcessAudioRequestVersion({
      id: 'sermon-123',
      youtubeUrl: 'https://www.youtube.com/watch?v=abc123',
      startTime: 0,
      duration: 120,
    });
    const changed = computeProcessAudioRequestVersion({
      id: 'sermon-123',
      youtubeUrl: 'https://www.youtube.com/watch?v=abc123',
      startTime: 15,
      duration: 120,
    });

    expect(initial).not.toBe(changed);
  });

  it('creates hashed task ids that vary with the newest request version', () => {
    const sermonId = 'sermon-123';
    const firstId = computeProcessAudioTaskId(sermonId, 'abcdef1234567890');
    const secondId = computeProcessAudioTaskId(sermonId, 'fedcba0987654321');

    expect(firstId).toMatch(/^pa-[a-f0-9]{8}-[a-f0-9]{16}$/);
    expect(secondId).toMatch(/^pa-[a-f0-9]{8}-[a-f0-9]{16}$/);
    expect(firstId).not.toBe(secondId);
  });
});
