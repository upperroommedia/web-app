export {};

const initMock = jest.fn();
const replayIntegrationMock = jest.fn((_options: unknown) => ({ name: 'replay' }));
const captureRouterTransitionStartMock = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  __esModule: true,
  init: (options: unknown) => initMock(options),
  replayIntegration: (options: unknown) => replayIntegrationMock(options),
  captureRouterTransitionStart: captureRouterTransitionStartMock,
}));

describe('client Sentry instrumentation', () => {
  beforeEach(() => {
    jest.resetModules();
    initMock.mockReset();
    replayIntegrationMock.mockClear();
  });

  it('installs the client noise filter on the active Next.js entrypoint', async () => {
    await import('../../instrumentation-client');

    expect(initMock).toHaveBeenCalledTimes(1);
    const options = initMock.mock.calls[0][0] as {
      beforeSend: (event: { exception?: { values?: Array<{ type?: string; value?: string }> } }) => unknown;
    };
    const intentionalRouteAbort = {
      exception: {
        values: [{ type: 'Error', value: 'routeChange aborted.' }],
      },
    };
    const unexpectedError = {
      exception: {
        values: [{ type: 'TypeError', value: 'Unexpected application failure' }],
      },
    };

    expect(options.beforeSend(intentionalRouteAbort)).toBeNull();
    expect(options.beforeSend(unexpectedError)).toBe(unexpectedError);
  });
});
