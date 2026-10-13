const mockReserve = jest.fn();
jest.mock('./durableOperationContext', () => ({
  reserveDurableProviderBindings: (...args: unknown[]) => mockReserve(...args),
}));
jest.mock('./providerReceipts', () => ({ providerPayloadFingerprint: () => 'body-proof' }));
import { reserveSubsplashAssociation } from './providerAssociations';
beforeEach(() => jest.clearAllMocks());
it('reserves exact provider payload identities once with a stable body identity', async () => {
  await reserveSubsplashAssociation(
    'listrows:list',
    ['media', 'media', 'image', undefined],
    {},
    { target: { provider: 'subsplash', kind: 'list', remoteId: 'list' } }
  );
  expect(mockReserve).toHaveBeenCalledWith(
    [
      { provider: 'subsplash', account: 'app:9XTSHD', remoteId: 'media' },
      { provider: 'subsplash', account: 'app:9XTSHD', remoteId: 'image' },
    ],
    'listrows:list:body-proof',
    { target: { provider: 'subsplash', kind: 'list', remoteId: 'list' } }
  );
});
it('does not dispatch a provider association when its retirement reservation is rejected', async () => {
  mockReserve.mockRejectedValue(new Error('PROVIDER_RESOURCE_CLEANUP_RESERVED'));
  await expect(reserveSubsplashAssociation('listimage:list', ['image'], {})).rejects.toThrow(
    'PROVIDER_RESOURCE_CLEANUP_RESERVED'
  );
});
