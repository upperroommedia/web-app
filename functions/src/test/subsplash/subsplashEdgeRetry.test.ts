import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import '../../subsplashUtils';
import { getProviderRelayUrl } from '../../providerRelay';

const blockedResponse = (config: InternalAxiosRequestConfig): AxiosResponse => ({
  status: 403,
  statusText: 'Forbidden',
  headers: {},
  config,
  data: '<html><title>403 Forbidden</title></html>',
});

describe('Subsplash API edge retry', () => {
  it('maps only approved provider hosts to the relay', () => {
    expect(getProviderRelayUrl(
      'https://secure.soundcloud.com/oauth/token',
      'https://yt-worker.upperroommedia.org'
    )).toBe('https://yt-worker.upperroommedia.org/internal/provider-relay/soundcloud-token');
    expect(getProviderRelayUrl(
      'https://core.subsplash.com/media/v1/media-items?include=images',
      'https://yt-worker.upperroommedia.org'
    )).toBe('https://yt-worker.upperroommedia.org/internal/provider-relay/subsplash/media/v1/media-items?include=images');
    expect(getProviderRelayUrl(
      'https://core.subsplash.com.evil.example/media/v1/media-items',
      'https://yt-worker.upperroommedia.org'
    )).toBeNull();
    expect(getProviderRelayUrl(
      'https://api.soundcloud.com/tracks',
      'https://yt-worker.upperroommedia.org'
    )).toBe('https://yt-worker.upperroommedia.org/internal/provider-relay/soundcloud/tracks');
    expect(getProviderRelayUrl(
      'https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A42',
      'https://yt-worker.upperroommedia.org'
    )).toBe('https://yt-worker.upperroommedia.org/internal/provider-relay/soundcloud/tracks/soundcloud%3Atracks%3A42');
    expect(getProviderRelayUrl(
      'https://api.soundcloud.com/users',
      'https://yt-worker.upperroommedia.org'
    )).toBeNull();
  });

  it('retries a provider block through the configured relay', async () => {
    const priorProject = process.env.GCLOUD_PROJECT;
    const priorToken = process.env.PROVIDER_EGRESS_RELAY_TOKEN;
    process.env.GCLOUD_PROJECT = 'urm-app';
    process.env.PROVIDER_EGRESS_RELAY_TOKEN = 'test-relay-token';
    try {
      const adapter = jest.fn(async (config: InternalAxiosRequestConfig) => {
        if (adapter.mock.calls.length === 1) {
          throw new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', config, undefined, blockedResponse(config));
        }
        return { status: 200, statusText: 'OK', headers: {}, config, data: { id: 'item-1' } };
      });

      await expect(axios({
        method: 'get',
        url: 'https://core.subsplash.com/media/v1/media-items/item-1',
        adapter,
      })).resolves.toMatchObject({ data: { id: 'item-1' } });

      expect(adapter).toHaveBeenCalledTimes(2);
      expect(adapter.mock.calls[0][0].url).toBe('https://yt-worker.upperroommedia.org/internal/provider-relay/subsplash/media/v1/media-items/item-1');
      expect(adapter.mock.calls[1][0].url).toBe(adapter.mock.calls[0][0].url);
      expect(adapter.mock.calls[0][0].headers.get('x-provider-relay-token')).toBe('test-relay-token');
    } finally {
      if (priorProject === undefined) delete process.env.GCLOUD_PROJECT;
      else process.env.GCLOUD_PROJECT = priorProject;
      if (priorToken === undefined) delete process.env.PROVIDER_EGRESS_RELAY_TOKEN;
      else process.env.PROVIDER_EGRESS_RELAY_TOKEN = priorToken;
    }
  });

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
