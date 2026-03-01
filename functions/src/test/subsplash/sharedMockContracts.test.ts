describe('shared firebase-function mock contracts', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('series mocks support both onCall signatures and HttpsError details', async () => {
    let singleArgCallable: (request: unknown) => Promise<unknown>;
    let optionsCallable: (request: unknown) => Promise<unknown>;
    let seriesError: { details?: unknown };

    jest.isolateModules(() => {
      require('../series/mocks');
      const { onCall, HttpsError } = require('firebase-functions/v2/https');

      singleArgCallable = onCall(async () => 'single-signature');
      optionsCallable = onCall({ enforceAppCheck: false }, async () => 'options-signature');
      seriesError = new HttpsError('aborted', 'busy', { code: 'SUBSPLASH_LOCK_BUSY' });
    });

    await expect(singleArgCallable!({})).resolves.toBe('single-signature');
    await expect(optionsCallable!({})).resolves.toBe('options-signature');
    expect(seriesError).toHaveProperty('details');
    expect(seriesError.details).toEqual({ code: 'SUBSPLASH_LOCK_BUSY' });
  });

  it('soundcloud mocks support both onCall signatures and HttpsError details', async () => {
    let singleArgCallable: (request: unknown) => Promise<unknown>;
    let optionsCallable: (request: unknown) => Promise<unknown>;
    let soundcloudError: { details?: unknown };

    jest.isolateModules(() => {
      require('../soundcloud/mocks');
      const { onCall, HttpsError } = require('firebase-functions/v2/https');

      singleArgCallable = onCall(async () => 'single-signature');
      optionsCallable = onCall({ enforceAppCheck: false }, async () => 'options-signature');
      soundcloudError = new HttpsError('aborted', 'busy', { code: 'SUBSPLASH_LOCK_BUSY' });
    });

    await expect(singleArgCallable!({})).resolves.toBe('single-signature');
    await expect(optionsCallable!({})).resolves.toBe('options-signature');
    expect(soundcloudError).toHaveProperty('details');
    expect(soundcloudError.details).toEqual({ code: 'SUBSPLASH_LOCK_BUSY' });
  });
});
