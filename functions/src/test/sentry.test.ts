describe('functions sentry', () => {
  const originalFunctionsDsn = process.env.FUNCTIONS_SENTRY_DSN;
  const originalSentryDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.FUNCTIONS_SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    jest.dontMock('@sentry/node');
  });

  afterAll(() => {
    process.env.FUNCTIONS_SENTRY_DSN = originalFunctionsDsn;
    process.env.SENTRY_DSN = originalSentryDsn;
  });

  it('flushes handled exceptions after capture', async () => {
    const setTag = jest.fn();
    const setExtra = jest.fn();
    const captureException = jest.fn().mockReturnValue('event-123');
    const flush = jest.fn().mockResolvedValue(true);

    jest.doMock('@sentry/node', () => ({
      init: jest.fn(),
      isEnabled: jest.fn(() => true),
      withScope: (callback: (scope: { setTag: typeof setTag; setExtra: typeof setExtra }) => string | undefined) =>
        callback({
          setTag,
          setExtra,
        }),
      captureException,
      flush,
    }));

    const sentryModule = await import('../sentry');
    await sentryModule.captureFunctionsExceptionAndFlush(
      new Error('boom'),
      {
        tags: { functionName: 'addtolist' },
        extra: { listId: 'abc123' },
      },
      1500
    );

    expect(captureException).toHaveBeenCalled();
    expect(setTag).toHaveBeenCalledWith('functionName', 'addtolist');
    expect(setExtra).toHaveBeenCalledWith('listId', 'abc123');
    expect(flush).toHaveBeenCalledWith(1500);
  });
});
