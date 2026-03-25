const httpsCallableMock = jest.fn();
const httpsCallableFromURLMock = jest.fn();

jest.mock('../../firebase/functions', () => ({
  __esModule: true,
  default: { app: 'functions-instance' },
  httpsCallable: (...args: unknown[]) => httpsCallableMock(...args),
  httpsCallableFromURL: (...args: unknown[]) => httpsCallableFromURLMock(...args),
}));

describe('createFunction helpers', () => {
  beforeEach(() => {
    jest.resetModules();
    httpsCallableMock.mockReset();
    httpsCallableFromURLMock.mockReset();
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
});
