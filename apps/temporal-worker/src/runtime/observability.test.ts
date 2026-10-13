import * as Sentry from '@sentry/node';
import { initializeWorkerObservability } from './observability';
jest.mock('@sentry/node', () => ({ init: jest.fn() }));
jest.mock('@temporalio/worker', () => ({ Runtime: { install: jest.fn() } }));
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
