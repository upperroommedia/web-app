export {};

const captureExceptionMock = jest.fn();
const withScopeMock = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  __esModule: true,
  withScope: (callback: (scope: {
    setLevel: (level: string) => void;
    setTag: (key: string, value: string) => void;
    setExtra: (key: string, value: unknown) => void;
  }) => void) =>
    withScopeMock(callback),
  captureException: (error: unknown) => captureExceptionMock(error),
}));

describe('reportHandledError helpers', () => {
  const originalConsoleError = console.error;

  beforeEach(() => {
    jest.resetModules();
    captureExceptionMock.mockReset();
    withScopeMock.mockImplementation((callback) =>
      callback({
        setLevel: jest.fn(),
        setTag: jest.fn(),
        setExtra: jest.fn(),
      })
    );
    console.error = jest.fn();
    (globalThis as { window?: unknown }).window = {} as Window;
  });

  afterEach(() => {
    console.error = originalConsoleError;
    delete (globalThis as { window?: unknown }).window;
  });

  it('captures handled exceptions with normalized context', async () => {
    const { reportHandledError } = await import('../../utils/reportHandledError');
    const error = new Error('load failed');

    reportHandledError(error, {
      area: 'admin-list-details',
      action: 'load-list-details',
      extras: { listId: 'list-123' },
    });

    expect(withScopeMock).toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledWith(error);
  });

  it('captures handled messages as synthetic errors', async () => {
    const { reportHandledMessage } = await import('../../utils/reportHandledError');

    reportHandledMessage('Series no longer exists.', {
      area: 'admin-series-details',
      action: 'missing-series',
      level: 'warning',
    });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((captureExceptionMock.mock.calls[0][0] as Error).message).toBe('Series no longer exists.');
  });

  it('bridges console.error into Sentry once', async () => {
    const { installConsoleErrorCapture } = await import('../../utils/reportHandledError');

    installConsoleErrorCapture();
    installConsoleErrorCapture();

    const error = new Error('console path');
    console.error('Failed to save order', error);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(error);
  });
});
