import type { GetYouTubeCookieStatusOutputType } from '@upperroom/contracts/getYouTubeCookieStatus';
import type { SetYouTubeCookiesInput, SetYouTubeCookiesOutputType } from '@upperroom/contracts/setYouTubeCookies';
import { encodeTextToBase64, readYouTubeCookieFileAsBase64, uploadYouTubeCookiesFromFile } from './youtubeCookies';

const SAMPLE_COOKIE_TEXT = [
  '# Netscape HTTP Cookie File',
  '.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\tcookie-value',
].join('\n');

describe('youtubeCookies utils', () => {
  it('encodes cookie text to base64', () => {
    expect(encodeTextToBase64(SAMPLE_COOKIE_TEXT)).toBe(Buffer.from(SAMPLE_COOKIE_TEXT, 'utf8').toString('base64'));
  });

  it('reads a .txt cookie file and converts it to base64 immediately', async () => {
    const file = {
      name: 'cookies.txt',
      text: jest.fn().mockResolvedValue(SAMPLE_COOKIE_TEXT),
    };

    await expect(readYouTubeCookieFileAsBase64(file)).resolves.toBe(
      Buffer.from(SAMPLE_COOKIE_TEXT, 'utf8').toString('base64')
    );
    expect(file.text).toHaveBeenCalledTimes(1);
  });

  it('rejects non-text cookie uploads', async () => {
    await expect(
      readYouTubeCookieFileAsBase64({
        name: 'cookies.json',
        text: jest.fn().mockResolvedValue(SAMPLE_COOKIE_TEXT),
      })
    ).rejects.toThrow('YouTube cookies must be uploaded as a .txt file.');
  });

  it('uploads cookies through the callable and refreshes the returned status', async () => {
    const setYouTubeCookies = jest.fn<Promise<SetYouTubeCookiesOutputType>, [SetYouTubeCookiesInput]>().mockResolvedValue(
      {
        hasCookies: true,
        cookieBreakerOpen: false,
        disabledUntil: null,
        youtubeQueueBlocked: false,
        probeStatus: 'idle',
        deferredYouTubeTaskCount: 0,
        blockerReason: null,
        blockerEpisodeId: null,
        blockerUpdatedAt: null,
        metadata: null,
      }
    );
    const refreshedStatus: GetYouTubeCookieStatusOutputType = {
      hasCookies: true,
      cookieBreakerOpen: false,
      disabledUntil: null,
      youtubeQueueBlocked: true,
      probeStatus: 'probing',
      deferredYouTubeTaskCount: 2,
      blockerReason: null,
      blockerEpisodeId: 'episode-1',
      blockerUpdatedAt: '2026-03-26T18:09:43.380Z',
      metadata: {
        sourceFileName: 'cookies.txt',
        uploadedAt: '2026-03-24T18:09:43.380Z',
        uploadedByEmail: 'admin@example.com',
        lastHealthStatus: 'uploaded_unverified',
      },
    };
    const getYouTubeCookieStatus = jest
      .fn<Promise<GetYouTubeCookieStatusOutputType>, [Record<string, never>]>()
      .mockResolvedValue(refreshedStatus);

    const result = await uploadYouTubeCookiesFromFile({
      file: {
        name: 'cookies.txt',
        text: jest.fn().mockResolvedValue(SAMPLE_COOKIE_TEXT),
      },
      setYouTubeCookies,
      getYouTubeCookieStatus,
    });

    expect(setYouTubeCookies).toHaveBeenCalledWith({
      cookiesBase64: Buffer.from(SAMPLE_COOKIE_TEXT, 'utf8').toString('base64'),
      fileName: 'cookies.txt',
    });
    expect(getYouTubeCookieStatus).toHaveBeenCalledWith({});
    expect(setYouTubeCookies.mock.invocationCallOrder[0]).toBeLessThan(getYouTubeCookieStatus.mock.invocationCallOrder[0]);
    expect(result).toEqual(refreshedStatus);
  });
});
