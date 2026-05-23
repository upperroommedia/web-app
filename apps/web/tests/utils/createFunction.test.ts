export {};

const httpsCallableMock = jest.fn();
const httpsCallableFromURLMock = jest.fn();
const captureExceptionMock = jest.fn();
const startSpanMock = jest.fn(async (_options: unknown, callback: () => Promise<unknown>) => callback());

jest.mock('../../firebase/functions', () => ({
  __esModule: true,
  default: { app: 'functions-instance' },
  httpsCallable: (...args: unknown[]) => httpsCallableMock(...args),
  httpsCallableFromURL: (...args: unknown[]) => httpsCallableFromURLMock(...args),
}));

jest.mock('@sentry/nextjs', () => ({
  __esModule: true,
  startSpan: (options: unknown, callback: () => Promise<unknown>) => startSpanMock(options, callback),
  withScope: (callback: (scope: {
    setTag: (key: string, value: string) => void;
    setLevel: (level: string) => void;
  }) => void) =>
    callback({
      setTag: jest.fn(),
      setLevel: jest.fn(),
    }),
  captureException: (error: unknown) => captureExceptionMock(error),
}));

describe('createFunction helpers', () => {
  beforeEach(() => {
    jest.resetModules();
    httpsCallableMock.mockReset();
    httpsCallableFromURLMock.mockReset();
    captureExceptionMock.mockReset();
    startSpanMock.mockClear();
  });

  it('uses Firebase callable discovery for v2 functions and merges metadata into object payloads', async () => {
    const callable = jest.fn().mockResolvedValue({ data: { ok: true } });
    httpsCallableMock.mockReturnValue(callable);

    const { createFunctionV2 } = await import('../../utils/createFunction');
    const invoke = createFunctionV2<{ id: string; operationKey?: string }, { ok: boolean }>('setyoutubecookies');

    await expect(
      invoke(
        { id: 'cookie-upload' },
        {
          metadata: {
            operationKey: 'youtube-cookie-upload',
          },
        }
      )
    ).resolves.toEqual({ ok: true });

    expect(httpsCallableMock).toHaveBeenCalledWith({ app: 'functions-instance' }, 'setyoutubecookies');
    expect(httpsCallableFromURLMock).not.toHaveBeenCalled();
    expect(callable).toHaveBeenCalledWith({
      id: 'cookie-upload',
      operationKey: 'youtube-cookie-upload',
    });
  });

  it('leaves primitive payloads unchanged when metadata is provided', async () => {
    const callable = jest.fn().mockResolvedValue({ data: 'ok' });
    httpsCallableMock.mockReturnValue(callable);

    const { createFunctionV2 } = await import('../../utils/createFunction');
    const invoke = createFunctionV2<string, string>('getyoutubecookiestatus');

    await expect(
      invoke('noop', {
        metadata: {
          operationKey: 'ignored',
        },
      })
    ).resolves.toBe('ok');

    expect(callable).toHaveBeenCalledWith('noop');
  });

  it('captures callable failures in Sentry and rethrows them', async () => {
    const error = Object.assign(new Error('call failed'), { code: 'functions/internal' });
    const callable = jest.fn().mockRejectedValue(error);
    httpsCallableMock.mockReturnValue(callable);

    const { createFunctionV2 } = await import('../../utils/createFunction');
    const invoke = createFunctionV2<{ id: string }, { ok: boolean }>('uploadtosoundcloud');

    await expect(invoke({ id: 'sermon-123' })).rejects.toBe(error);

    expect(startSpanMock).toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledWith(error);
  });

  it('does not capture expected bulkaddtoseries membership conflicts', async () => {
    const error = Object.assign(
      new Error('Published membership changed in Subsplash. Refresh the series and retry with a fresh snapshot hash.'),
      { code: 'functions/failed-precondition' }
    );
    const callable = jest.fn().mockRejectedValue(error);
    httpsCallableMock.mockReturnValue(callable);

    const { createFunctionV2 } = await import('../../utils/createFunction');
    const invoke = createFunctionV2<{ id: string }, { ok: boolean }>('bulkaddtoseries');

    await expect(invoke({ id: 'sermon-123' })).rejects.toBe(error);

    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('does not capture expected Subsplash lock contention callable errors', async () => {
    const error = Object.assign(new Error('Subsplash lock contention prevented this mutation.'), {
      code: 'functions/aborted',
      details: {
        code: 'SUBSPLASH_LOCK_BUSY',
        locked_keys: ['series:series-123'],
        wait_ms: 10000,
        retry_after_ms: 1000,
      },
    });
    const callable = jest.fn().mockRejectedValue(error);
    httpsCallableMock.mockReturnValue(callable);

    const { createFunctionV2 } = await import('../../utils/createFunction');
    const invoke = createFunctionV2<{ id: string }, { ok: boolean }>('reorderseriesitems');

    await expect(invoke({ id: 'series-123' })).rejects.toBe(error);

    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('does not capture optional getusersbyids display lookup timeouts', async () => {
    const error = Object.assign(new Error('deadline exceeded'), {
      code: 'functions/deadline-exceeded',
    });
    const callable = jest.fn().mockRejectedValue(error);
    httpsCallableMock.mockReturnValue(callable);

    const { createFunctionV2 } = await import('../../utils/createFunction');
    const invoke = createFunctionV2<{ uids: string[] }, { users: unknown[] }>('getusersbyids');

    await expect(invoke({ uids: ['user-123'] })).rejects.toBe(error);

    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('does not capture generate secured key unauthenticated session errors', async () => {
    const error = Object.assign(new Error('unauthenticated'), {
      code: 'functions/unauthenticated',
    });
    const callable = jest.fn().mockRejectedValue(error);
    httpsCallableMock.mockReturnValue(callable);

    const { createFunction } = await import('../../utils/createFunction');
    const invoke = createFunction<{ userId: string }, string>('generatesecuredapikey');

    await expect(invoke({ userId: 'user-123' })).rejects.toBe(error);

    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('does not capture transient upstream publish callable failures', async () => {
    const error = Object.assign(new Error('upstream unavailable'), {
      code: 'functions/unavailable',
    });
    const callable = jest.fn().mockRejectedValue(error);
    httpsCallableMock.mockReturnValue(callable);

    const { createFunctionV2 } = await import('../../utils/createFunction');
    const invoke = createFunctionV2<{ audioStoragePath: string }, { soundCloudTrackId: string }>('uploadtosoundcloud');

    await expect(invoke({ audioStoragePath: 'audio/sermon.mp3' })).rejects.toBe(error);

    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
