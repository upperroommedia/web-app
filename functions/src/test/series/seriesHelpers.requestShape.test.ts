import axios from 'axios';
import { patchMediaItemSeries } from '../../helpers/seriesHelpers';
import { createAxiosConfig } from '../../subsplashUtils';

jest.mock('../../subsplashUtils', () => ({
  createAxiosConfig: jest.fn((url: string, token: string, method: string, data?: unknown) => ({
    url,
    token,
    method,
    data,
    headers: {},
  })),
}));

jest.mock('axios');

const mockAxios = axios as jest.MockedFunction<typeof axios>;
const mockCreateAxiosConfig = createAxiosConfig as jest.MockedFunction<typeof createAxiosConfig>;

describe('seriesHelpers patchMediaItemSeries request shape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAxios.mockResolvedValue({ data: { id: 'media-item-1' } } as never);
  });

  it('includes app_key when assigning a media item to a series', async () => {
    await patchMediaItemSeries('media-item-1', 'series-1', 'fake-token');

    expect(mockCreateAxiosConfig).toHaveBeenCalledWith(
      'https://core.subsplash.com/media/v1/media-items/media-item-1',
      'fake-token',
      'PATCH',
      expect.objectContaining({
        app_key: '9XTSHD',
        id: 'media-item-1',
        _embedded: {
          'media-series': { id: 'series-1' },
        },
      })
    );
  });

  it('includes app_key when unassigning a media item from a series', async () => {
    await patchMediaItemSeries('media-item-1', null, 'fake-token');

    expect(mockCreateAxiosConfig).toHaveBeenCalledWith(
      'https://core.subsplash.com/media/v1/media-items/media-item-1',
      'fake-token',
      'PATCH',
      expect.objectContaining({
        app_key: '9XTSHD',
        id: 'media-item-1',
        _embedded: {
          'media-series': null,
        },
      })
    );
  });

  it('treats a bad PATCH response as success when the remote item is already assigned to the target series', async () => {
    mockAxios
      .mockRejectedValueOnce({
        response: {
          data: {
            errors: [{ code: 'bad_request', detail: 'the request is invalid or malformed' }],
          },
        },
      } as never)
      .mockResolvedValueOnce({
        data: {
          id: 'media-item-1',
          position: 3,
          _embedded: {
            'media-series': { id: 'series-1' },
          },
        },
      } as never)
      .mockResolvedValueOnce({
        data: {
          id: 'series-1',
          title: 'Series 1',
          status: 'published',
          media_items_count: 1,
          published_media_items_count: 1,
        },
      } as never);

    const result = await patchMediaItemSeries('media-item-1', 'series-1', 'fake-token');

    expect(result).toEqual(
      expect.objectContaining({
        id: 'media-item-1',
        position: 3,
        _embedded: {
          'media-series': { id: 'series-1' },
        },
      })
    );
    expect(mockAxios).toHaveBeenCalledTimes(3);
  });
});
