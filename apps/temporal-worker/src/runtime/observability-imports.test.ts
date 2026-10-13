/** Exercise the real SDK client and shared bootstraps; only the transport is inert. */
jest.mock('@sentry/node', () => {
  const actual = jest.requireActual<typeof import('@sentry/node')>('@sentry/node');
  return {
    ...actual,
    init: jest.fn((options) =>
      actual.init({
        ...options,
        defaultIntegrations: false,
        skipOpenTelemetrySetup: true,
        transport: () => ({ send: async () => ({}), flush: async () => true }),
      })
    ),
  };
});
jest.mock('@temporalio/worker', () => ({ Runtime: { install: jest.fn() } }));

const originalEnv = { ...process.env };
beforeEach(() => {
  jest.resetModules();
  process.env.TEMPORAL_SENTRY_DSN = 'https://worker@example.com/1';
  process.env.FUNCTIONS_SENTRY_DSN = 'https://functions@example.com/2';
  process.env.SENTRY_DSN = 'https://audio@example.com/3';
  process.env.SENTRY_RELEASE = 'standalone-release';
  process.env.SENTRY_ENVIRONMENT = 'staging';
});
afterEach(async () => {
  const sentry = await import('@sentry/node');
  await sentry.close(100);
  sentry.getCurrentScope().setClient(undefined);
  process.env = { ...originalEnv };
});

test.each([true, false])(
  'worker keeps one client through genuine shared bootstraps (reporting %s)',
  async (enabled) => {
    if (!enabled) delete process.env.TEMPORAL_SENTRY_DSN;
    const sentry = await import('@sentry/node');
    const { initializeWorkerObservability } = await import('./observability');
    initializeWorkerObservability('urm-app-staging', 'worker-build', ['urm-orchestration']);
    const client = sentry.getClient();
    await import('../../../process-audio/src/instrument');
    const functions = await import('../../../../functions/src/sentry');
    functions.initFunctionsSentry();
    await functions.startFunctionsSpan({ name: 'shared-operation', op: 'test' }, async () => undefined);
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(sentry.getClient()).toBe(client);
    expect(client?.getOptions()).toMatchObject({
      enabled,
      environment: 'urm-app-staging',
      release: 'worker-build',
      initialScope: { tags: { service: 'temporal-worker', role: 'orchestration' } },
    });
    expect(sentry.getCurrentScope().getScopeData().tags.service).toBe('temporal-worker');
  }
);

test.each(['audio', 'functions'])('standalone %s still initializes its own real client', async (service) => {
  const sentry = await import('@sentry/node');
  if (service === 'audio') await import('../../../process-audio/src/instrument');
  else (await import('../../../../functions/src/sentry')).initFunctionsSentry();
  expect(sentry.init).toHaveBeenCalledTimes(1);
  expect(sentry.getClient()?.getOptions()).toMatchObject({
    enabled: true,
    environment: 'staging',
    release: 'standalone-release',
    initialScope: { tags: { service: service === 'audio' ? 'process-audio' : 'firebase-functions' } },
  });
});
