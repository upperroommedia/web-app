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

  it('keeps v11 automatic sensitive data and logging disabled', async () => {
    const init = jest.fn();
    jest.doMock('@sentry/node', () => ({ init, getClient: () => undefined }));
    const sentryModule = await import('../sentry');
    sentryModule.initFunctionsSentry();
    const options = init.mock.calls[0][0];
    expect(options.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
      stackFrameVariables: false,
    });
    expect(options.includeLocalVariables).toBe(false);
    expect(options.beforeSendLog({ body: 'must not ship' })).toBeNull();
  });

  it('flushes handled exceptions after capture', async () => {
    const setTag = jest.fn();
    const setExtra = jest.fn();
    const captureException = jest.fn().mockReturnValue('event-123');
    const flush = jest.fn().mockResolvedValue(true);

    jest.doMock('@sentry/node', () => ({
      init: jest.fn(),
      getClient: () => undefined,
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
