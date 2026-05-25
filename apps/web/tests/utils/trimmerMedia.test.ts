import {
  logWaveformPreviewFailure,
  readWaveformAudioData,
  safePlayMediaElement,
} from '../../components/trimmer/trimmerMedia';

describe('trimmer media helpers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('captures rejected media play promises', async () => {
    const error = new Error('play rejected');
    const onFailure = jest.fn();
    const media = {
      play: jest.fn(() => Promise.reject(error)),
    };

    safePlayMediaElement(media, onFailure);
    await Promise.resolve();

    expect(media.play).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(error);
  });

  it('captures synchronous media play errors', () => {
    const error = new Error('play threw');
    const onFailure = jest.fn();
    const media = {
      play: jest.fn(() => {
        throw error;
      }),
    };

    safePlayMediaElement(media, onFailure);

    expect(media.play).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(error);
  });

  it('does not write waveform preview failures to console.error in production', () => {
    jest.replaceProperty(process.env, 'NODE_ENV', 'production');
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    logWaveformPreviewFailure(new Error('waveform unavailable'));

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('logs waveform preview failures as warnings outside production', () => {
    jest.replaceProperty(process.env, 'NODE_ENV', 'test');
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    logWaveformPreviewFailure(new Error('waveform unavailable'));

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
  });

  it('reads local waveform audio data from the original blob instead of fetching its object URL', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const blob = new Blob(['audio bytes'], { type: 'audio/wav' });

    const buffer = await readWaveformAudioData({
      url: 'blob:https://uploader.example.test/local-audio',
      blob,
    });

    expect(new TextDecoder().decode(buffer)).toBe('audio bytes');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches remote waveform audio data when no local blob is provided', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('remote audio').buffer,
    } as Response);

    const buffer = await readWaveformAudioData({
      url: 'https://media.example.test/audio.mp3',
    });

    expect(new TextDecoder().decode(buffer)).toBe('remote audio');
    expect(fetchSpy).toHaveBeenCalledWith('https://media.example.test/audio.mp3', { signal: undefined });
  });
});
