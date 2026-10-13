jest.mock('axios', () => {
  const fn = jest.fn();
  Object.assign(fn, {
    isAxiosError: (error: unknown) => Boolean(error && typeof error === 'object' && 'isAxiosError' in error),
  });
  return { __esModule: true, default: fn };
});
jest.mock('../../subsplashUtils', () => ({
  createAxiosConfig: (url: string, _token: string, method: string, data?: unknown) => ({ url, method, data }),
}));
jest.mock('./providerReceipts', () => ({ executeProviderCreate: (...args: unknown[]) => mockReceipt(...args) }));
import axios from 'axios';
import { repairMismatchedSubsplashImageRefs } from '../../helpers/subsplashImageRefs';
const mockReceipt = jest.fn();
const request = axios as unknown as jest.Mock;
const image = {
  id: 'original',
  type: 'square',
  name: 'Image',
  downloadLink: 'https://storage.googleapis.com/canonical',
};
const configure = (fresh: boolean) => {
  mockReceipt.mockResolvedValue({
    id: 'allocated',
    _links: { presigned_upload_url: { href: 'https://uploads.invalid/expired' } },
  });
  request.mockImplementation(async ({ url }: { url: string }) => {
    if (url.endsWith('/images/original')) return { data: { id: 'original', type: 'banner' } };
    if (url === image.downloadLink) return { data: new Uint8Array([1, 2]), headers: { 'content-type': 'image/jpeg' } };
    if (url === 'https://uploads.invalid/expired')
      throw Object.assign(new Error('Expired capability'), { isAxiosError: true, response: { status: 403 } });
    if (url.endsWith('/images/allocated'))
      return {
        data: {
          id: 'allocated',
          app_key: '9XTSHD',
          type: 'square',
          content_type: 'image/jpeg',
          ...(fresh ? { _links: { presigned_upload_url: { href: 'https://uploads.invalid/renewed' } } } : {}),
        },
      };
    if (url === 'https://uploads.invalid/renewed') return { data: {} };
    throw new Error(`Unexpected provider request ${url}`);
  });
};
beforeEach(() => jest.clearAllMocks());
it('renews only the known image upload capability after an expired receipt slot', async () => {
  configure(true);
  await expect(repairMismatchedSubsplashImageRefs([image], 'token', 'durable:key')).resolves.toEqual([
    { ...image, subsplashId: 'allocated' },
  ]);
  expect(request.mock.calls.filter(([config]) => config.method === 'POST')).toHaveLength(0);
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({ url: 'https://core.subsplash.com/files/v1/images/allocated', method: 'GET' })
  );
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({ url: 'https://uploads.invalid/renewed', method: 'PUT' })
  );
});
it('requests operator attention when the existing allocation cannot expose a fresh upload slot', async () => {
  configure(false);
  await expect(repairMismatchedSubsplashImageRefs([image], 'token', 'durable:key')).rejects.toMatchObject({
    code: 'failed-precondition',
    details: { reason: 'PROVIDER_UPLOAD_SLOT_UNAVAILABLE', remoteId: 'allocated' },
  });
  expect(request.mock.calls.filter(([config]) => config.method === 'POST')).toHaveLength(0);
  expect(request.mock.calls.filter(([config]) => config.method === 'PUT')).toHaveLength(1);
});
