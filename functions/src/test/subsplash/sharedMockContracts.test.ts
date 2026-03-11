describe('shared firebase-function mock contracts', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('series mocks support both onCall signatures and HttpsError details', async () => {
    let singleArgCallable: unknown;
    let optionsCallable: unknown;
    let seriesError: { details?: unknown } | undefined;

    await jest.isolateModulesAsync(async () => {
      await import('../series/mocks');
      const { onCall, HttpsError } = await import('firebase-functions/v2/https');

      singleArgCallable = onCall(async () => 'single-signature');
      optionsCallable = onCall({ enforceAppCheck: false }, async () => 'options-signature');
      seriesError = new HttpsError('aborted', 'busy', { code: 'SUBSPLASH_LOCK_BUSY' });
    });

    expect(singleArgCallable).toBeDefined();
    expect(optionsCallable).toBeDefined();
    expect(seriesError).toBeDefined();
    const callSingle = singleArgCallable as (...args: unknown[]) => Promise<unknown>;
    const callOptions = optionsCallable as (...args: unknown[]) => Promise<unknown>;
    await expect(callSingle({}, {})).resolves.toBe('single-signature');
    await expect(callOptions({}, {})).resolves.toBe('options-signature');
    expect(seriesError).toHaveProperty('details');
    expect(seriesError?.details).toEqual({ code: 'SUBSPLASH_LOCK_BUSY' });
  });

  it('soundcloud mocks support both onCall signatures and HttpsError details', async () => {
    let singleArgCallable: unknown;
    let optionsCallable: unknown;
    let soundcloudError: { details?: unknown } | undefined;

    await jest.isolateModulesAsync(async () => {
      await import('../soundcloud/mocks');
      const { onCall, HttpsError } = await import('firebase-functions/v2/https');

      singleArgCallable = onCall(async () => 'single-signature');
      optionsCallable = onCall({ enforceAppCheck: false }, async () => 'options-signature');
      soundcloudError = new HttpsError('aborted', 'busy', { code: 'SUBSPLASH_LOCK_BUSY' });
    });

    expect(singleArgCallable).toBeDefined();
    expect(optionsCallable).toBeDefined();
    expect(soundcloudError).toBeDefined();
    const callSingle = singleArgCallable as (...args: unknown[]) => Promise<unknown>;
    const callOptions = optionsCallable as (...args: unknown[]) => Promise<unknown>;
    await expect(callSingle({}, {})).resolves.toBe('single-signature');
    await expect(callOptions({}, {})).resolves.toBe('options-signature');
    expect(soundcloudError).toHaveProperty('details');
    expect(soundcloudError?.details).toEqual({ code: 'SUBSPLASH_LOCK_BUSY' });
  });
});
