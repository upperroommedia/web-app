import * as Sentry from '@sentry/node';
import { Runtime } from '@temporalio/worker';
import { initializeWorkerObservability } from './observability';
jest.mock('@sentry/node', () => ({ init: jest.fn() }));
jest.mock('@temporalio/worker', () => ({
  DefaultLogger: jest.requireActual('@temporalio/worker').DefaultLogger,
  Runtime: { install: jest.fn() },
}));
test('shared Sentry project receives only static worker service and known role tags while privacy stays restricted', () => {
  const previous = process.env.TEMPORAL_SENTRY_DSN;
  process.env.TEMPORAL_SENTRY_DSN = 'https://test.invalid';
  try {
    initializeWorkerObservability('test', 'build', ['urm-orchestration', 'untrusted-provider-url', 'urm-controls']);
    const config = (Sentry.init as jest.Mock).mock.calls[0][0];
    expect(config.initialScope.tags).toEqual({ service: 'temporal-worker', role: 'controls,orchestration' });
    expect(config.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      queues: false,
    });
    expect(config.beforeSendLog()).toBeNull();
    const event = {
      tags: config.initialScope.tags,
      request: { authorization: 'secret' },
      breadcrumbs: ['private'],
      extra: { payload: 'private' },
    };
    expect(config.beforeSend(event)).toEqual({ tags: { service: 'temporal-worker', role: 'controls,orchestration' } });
  } finally {
    if (previous === undefined) delete process.env.TEMPORAL_SENTRY_DSN;
    else process.env.TEMPORAL_SENTRY_DSN = previous;
  }
});

test('the finite worker logger suppresses task credentials while preserving failure diagnostics', () => {
  const log = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    initializeWorkerObservability('urm-app-staging', 'build', ['urm-media-kernel-recovery']);
    const settings = (Runtime.install as jest.Mock).mock.lastCall?.[0];
    settings.logger.warn('Activity failed', {
      taskToken: 'synthetic-test-token',
      activityId: 'media-recovery-acquire',
    });
    const output = log.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(output).toContain('media-recovery-acquire');
    expect(output).not.toContain('taskToken');
    expect(output).not.toContain('synthetic-test-token');
  } finally {
    log.mockRestore();
  }
});
