jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: () => ({ options: { projectId: 'urm-app' } }) },
}));
jest.mock('axios', () => ({ __esModule: true, default: Object.assign(jest.fn(), { get: jest.fn() }) }));
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: async () => 'test-token',
  createAxiosConfig: (url: string, _token: string, method: string) => ({ url, method }),
}));
jest.mock('../../soundcloudSecrets', () => ({
  runWithSoundCloudAccessToken: (run: (token: string) => Promise<unknown>) => run('test-token'),
}));
jest.mock('../../temporal/publishing/providerReceipts', () => ({
  ...jest.requireActual('../../temporal/publishing/providerReceipts'),
  readProviderReceipt: jest.fn(),
}));
import axios from 'axios';
import {
  ProviderReceipt,
  providerPayloadFingerprint,
  readProviderReceipt,
} from '../../temporal/publishing/providerReceipts';
import {
  verifyPublishingRemoteResource,
  verifyAcknowledgedResourceAbsent,
} from '../../temporal/publishing/receiptResolution';
const mockRequest = axios as unknown as jest.Mock;
const mockGet = axios.get as jest.Mock;
const receipt = (step: string, payload: Record<string, unknown>): ProviderReceipt => ({
  step,
  operationKey: 'publish:generation1',
  intentPayload: payload,
  fingerprint: providerPayloadFingerprint(payload),
  state: 'needs_review',
  updatedAtMillis: 0,
});
describe('provider-specific adoption verification', () => {
  beforeEach(() => jest.resetAllMocks());
  it('adopts a known audio ID only from the expected application and intent', async () => {
    mockRequest.mockResolvedValue({ data: { id: 'audio-id', app_key: '9XTSHD', title: 'Recording' } });
    expect(
      await verifyPublishingRemoteResource(receipt('subsplash-audio', { audioTitle: 'Recording' }), 'audio-id')
    ).toBe('audio-id');
    expect(mockRequest.mock.calls[0][0].url).toBe('https://core.subsplash.com/files/v1/audios/audio-id');
  });
  it('rejects a valid ID belonging to another Subsplash application', async () => {
    mockRequest.mockResolvedValue({ data: { id: 'audio-id', app_key: 'OTHER', title: 'Recording' } });
    await expect(
      verifyPublishingRemoteResource(receipt('subsplash-audio', { audioTitle: 'Recording' }), 'audio-id')
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
  it('rejects a media item with the right title but unrelated audio', async () => {
    jest
      .mocked(readProviderReceipt)
      .mockResolvedValue({ ...receipt('subsplash-audio', {}), state: 'confirmed', result: 'expected-audio' });
    mockRequest.mockResolvedValue({
      data: { id: 'media-id', app_key: '9XTSHD', title: 'Sermon', _embedded: { audio: { id: 'other-audio' } } },
    });
    await expect(
      verifyPublishingRemoteResource(receipt('subsplash-media-item', { title: 'Sermon' }), 'media-id')
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
  it('adopts SoundCloud into the exact upload result shape after checking the connected account', async () => {
    mockGet.mockResolvedValueOnce({ data: { id: 42 } }).mockResolvedValueOnce({
      data: {
        id: 123,
        urn: 'soundcloud:tracks:123',
        title: 'Sermon',
        description: 'Description',
        user: { id: 42 },
        permalink_url: 'https://soundcloud.com/urm/sermon',
      },
    });
    expect(
      await verifyPublishingRemoteResource(
        receipt('soundcloud-track', { title: 'Sermon', description: 'Description' }),
        '123'
      )
    ).toEqual({ trackIdentifier: 'soundcloud:tracks:123', permalinkUrl: 'https://soundcloud.com/urm/sermon' });
  });
  it('rejects a public SoundCloud track from a different account despite matching title', async () => {
    mockGet
      .mockResolvedValueOnce({ data: { id: 42 } })
      .mockResolvedValueOnce({ data: { id: 123, title: 'Sermon', description: '', user: { id: 99 } } });
    await expect(
      verifyPublishingRemoteResource(receipt('soundcloud-track', { title: 'Sermon', description: '' }), '123')
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
  it('rejects missing immutable payload before making network requests', async () => {
    const missing = receipt('subsplash-audio', { audioTitle: 'Recording' });
    delete missing.intentPayload;
    await expect(verifyPublishingRemoteResource(missing, 'audio-id')).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });
  it('adopts an image allocation with a verified fresh upload slot', async () => {
    const image = { id: 'old-image', type: 'wide', name: 'Wide image', downloadLink: 'https://storage.example/source' };
    const href = `https://bucket.s3.amazonaws.com/image?Expires=${Math.floor(Date.now() / 1000) + 3600}`;
    mockRequest.mockResolvedValue({
      data: {
        id: 'new-image',
        app_key: '9XTSHD',
        type: 'wide',
        title: 'Wide image',
        content_type: 'image/jpeg',
        _links: { presigned_upload_url: { href } },
      },
    });
    expect(
      await verifyPublishingRemoteResource(receipt('image-create', { image, contentType: 'image/jpeg' }), 'new-image')
    ).toEqual({ id: 'new-image', type: 'wide', _links: { presigned_upload_url: { href } } });
  });
  it('rejects image adoption when the provider upload slot expired', async () => {
    const image = { id: 'old-image', type: 'wide', name: 'Wide image' };
    mockRequest.mockResolvedValue({
      data: {
        id: 'new-image',
        app_key: '9XTSHD',
        type: 'wide',
        title: 'Wide image',
        content_type: 'image/jpeg',
        _links: { presigned_upload_url: { href: 'https://bucket.s3.amazonaws.com/image?Expires=1' } },
      },
    });
    await expect(
      verifyPublishingRemoteResource(receipt('image-create', { image, contentType: 'image/jpeg' }), 'new-image')
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
  it('adopts a list into the minimal list-create result after verifying image associations', async () => {
    const images = [{ id: 'image', type: 'square' }];
    mockRequest.mockResolvedValue({
      data: { id: 'list', app_key: '9XTSHD', title: 'List', type: 'standard', _embedded: { images } },
    });
    expect(
      await verifyPublishingRemoteResource(
        receipt('list-create', { title: 'List', type: 'standard', _embedded: { images } }),
        'list'
      )
    ).toEqual({ listId: 'list' });
  });
  it('preserves the full overflow-list result needed by list mutations', async () => {
    const remote = {
      id: 'overflow',
      app_key: '9XTSHD',
      title: 'Overflow',
      type: 'standard',
      status: 'published',
      list_rows_count: 0,
      max_item_count: 200,
      _links: { 'list-rows': { href: 'https://core.subsplash.com/builder/v1/lists/overflow/list-rows' } },
    };
    mockRequest.mockResolvedValue({ data: remote });
    expect(
      await verifyPublishingRemoteResource(
        receipt('overflow-list-create', { title: 'Overflow', type: 'standard', status: 'published' }),
        'overflow'
      )
    ).toEqual(remote);
  });
  it('adopts a speaker tag after verifying its descriptions and image association', async () => {
    const squareImage = { id: 'local-image', subsplashId: 'remote-image', type: 'square' };
    mockRequest.mockResolvedValue({
      data: {
        id: 'tag',
        app_key: '9XTSHD',
        type: 'speaker',
        title: 'Speaker',
        short_description: 'Bio',
        description: 'Description',
        _embedded: { 'square-image': { id: 'remote-image', type: 'square' } },
      },
    });
    expect(
      await verifyPublishingRemoteResource(
        receipt('speaker-tag-create', {
          title: 'Speaker',
          squareImage,
          shortDescription: 'Bio',
          description: 'Description',
        }),
        'tag'
      )
    ).toEqual({ tagId: 'tag' });
  });
  it('rejects a speaker tag with an unrelated image despite matching title', async () => {
    mockRequest.mockResolvedValue({
      data: {
        id: 'tag',
        app_key: '9XTSHD',
        type: 'speaker',
        title: 'Speaker',
        _embedded: { 'square-image': { id: 'wrong-image', type: 'square' } },
      },
    });
    await expect(
      verifyPublishingRemoteResource(
        receipt('speaker-tag-create', { title: 'Speaker', squareImage: { id: 'expected-image', type: 'square' } }),
        'tag'
      )
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('known acknowledgement fixed-resource absence verification', () => {
  beforeEach(() => jest.resetAllMocks());
  it('accepts only a known authenticated Subsplash resource 404/410 and never deletes', async () => {
    mockRequest.mockResolvedValueOnce({ status: 404, data: { errors: [{ code: 'resource_not_found' }] } });
    expect(
      await verifyAcknowledgedResourceAbsent(receipt('speaker-tag-create', { title: 'Speaker' }), 'original-tag')
    ).toBe(true);
    expect(mockRequest.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      url: 'https://core.subsplash.com/tags/v1/tags/original-tag',
    });
    expect(mockRequest.mock.calls[0][0].validateStatus(401)).toBe(false);
    mockRequest.mockResolvedValueOnce({ status: 200, data: { id: 'original-tag' } });
    expect(
      await verifyAcknowledgedResourceAbsent(receipt('speaker-tag-create', { title: 'Speaker' }), 'original-tag')
    ).toBe(false);
  });
  it('rejects a proxy HTML missing-resource response', async () => {
    mockRequest.mockResolvedValueOnce({ status: 404, data: '<!doctype html><html>edge failure</html>' });
    await expect(
      verifyAcknowledgedResourceAbsent(receipt('subsplash-audio', { audioTitle: 'Recording' }), 'original-audio')
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
  it('requires the original SoundCloud owner before accepting known-track absence', async () => {
    const saved = {
      ...receipt('soundcloud-track', { title: 'Track' }),
      providerAccount: { provider: 'soundcloud' as const, account: 'soundcloud:users:42' },
    };
    mockGet.mockResolvedValueOnce({ data: { id: 42 } }).mockResolvedValueOnce({ status: 410, data: {} });
    expect(await verifyAcknowledgedResourceAbsent(saved, 'soundcloud:tracks:123')).toBe(true);
    expect(mockGet.mock.calls[0][1].headers.Authorization).toBe(mockGet.mock.calls[1][1].headers.Authorization);
  });
  it('fails closed for legacy SoundCloud bindings and changed connected accounts', async () => {
    await expect(
      verifyAcknowledgedResourceAbsent(receipt('soundcloud-track', { title: 'Track' }), 'soundcloud:tracks:123')
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(mockGet).not.toHaveBeenCalled();
    mockGet.mockResolvedValueOnce({ data: { id: 99 } });
    await expect(
      verifyAcknowledgedResourceAbsent(
        {
          ...receipt('soundcloud-track', { title: 'Track' }),
          providerAccount: { provider: 'soundcloud', account: 'soundcloud:users:42' },
        },
        'soundcloud:tracks:123'
      )
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
