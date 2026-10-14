import { logWaveformPreviewFailure, safePlayMediaElement } from '../../components/trimmer/trimmerMedia';

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
});
