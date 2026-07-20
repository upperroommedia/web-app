import { AxiosError } from 'axios';
import { normalizeSoundCloudApiError } from '../../soundcloudClient';

describe('soundcloudClient error normalization', () => {
  it('normalizes SoundCloud upload validation failures without leaking upstream response data', () => {
    const error = new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 400,
      statusText: 'Bad Request',
      headers: {},
      config: { headers: {} } as never,
      data: {
        errors: [
          {
            field: 'asset_data',
            message: 'synthetic upstream validation detail',
          },
        ],
      },
    });

    try {
      normalizeSoundCloudApiError(error);
      throw new Error('Expected normalizeSoundCloudApiError to throw');
    } catch (normalizedError) {
      const httpsError = normalizedError as { code?: string; message?: string; details?: unknown };
      expect(httpsError.code).toBe('invalid-argument');
      expect(httpsError.message).toContain('SoundCloud rejected the track upload');
      expect(httpsError.details).toEqual({
        code: 'SOUNDCLOUD_UPLOAD_REJECTED',
        upstream_status: 400,
      });
    }
  });
});
