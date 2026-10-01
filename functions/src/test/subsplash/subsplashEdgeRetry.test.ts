import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import '../../subsplashUtils';

const blockedResponse = (config: InternalAxiosRequestConfig): AxiosResponse => ({
  status: 403,
  statusText: 'Forbidden',
  headers: {},
  config,
  data: '<html><title>403 Forbidden</title></html>',
});

describe('Subsplash API edge retry', () => {
  it('replays a blocked API request at most three times', async () => {
    const adapter = jest.fn(async (config: InternalAxiosRequestConfig) => {
      throw new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', config, undefined, blockedResponse(config));
    });

    await expect(axios({
      method: 'get',
      url: 'https://core.subsplash.com/media/v1/media-items/test-item',
      adapter,
    })).rejects.toMatchObject({ code: 'unavailable' });

    expect(adapter).toHaveBeenCalledTimes(4);
  });

  it('does not retry a JSON permission error', async () => {
    const adapter = jest.fn(async (config: InternalAxiosRequestConfig) => {
      throw new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', config, undefined, {
        ...blockedResponse(config),
        data: { error: 'forbidden' },
      });
    });

    await expect(axios({
      method: 'get',
      url: 'https://core.subsplash.com/media/v1/media-items/test-item',
      adapter,
    })).rejects.toMatchObject({ response: { status: 403 } });

    expect(adapter).toHaveBeenCalledTimes(1);
  });
});
