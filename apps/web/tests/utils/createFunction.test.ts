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
});
