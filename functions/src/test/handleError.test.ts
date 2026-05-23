import { AxiosError } from 'axios';
import { HttpsError } from 'firebase-functions/v2/https';
import handleError from '../handleError';
import * as emitOperationalAlertModule from '../notifications/emitOperationalAlert';
import * as sentryModule from '../sentry';

describe('handleError', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('emits a fallback operational alert when normalizing an unhandled error', () => {
    const emitSpy = jest.spyOn(emitOperationalAlertModule, 'emitOperationalAlert').mockResolvedValue(undefined);
    const sentrySpy = jest.spyOn(sentryModule, 'captureFunctionsExceptionAndFlush').mockResolvedValue(undefined);

    const error = new Error('boom');
    const normalized = handleError(error, {
      alertCode: 'TEST_UNHANDLED_RUNTIME_ERROR',
      summary: 'Test summary',
      context: { functionName: 'testHandler' },
      request: {
        auth: {
          uid: 'user-123',
          token: {
            email: 'Tester@Example.org',
            name: 'Test User',
            role: 'admin',
          },
        },
      } as never,
    });

    expect(normalized).toBeInstanceOf(HttpsError);
    expect(normalized.code).toBe('internal');
    expect(sentrySpy).toHaveBeenCalledWith(error, {
      tags: {
        normalizedErrorCode: 'internal',
      },
      extra: {
        functionName: 'testHandler',
        normalizedErrorCode: 'internal',
        triggeringUser: {
          uid: 'user-123',
          email: 'tester@example.org',
          displayName: 'Test User',
          role: 'admin',
        },
      },
    });
    expect(emitSpy).toHaveBeenCalledWith({
      alertCode: 'TEST_UNHANDLED_RUNTIME_ERROR',
      summary: 'Test summary',
      error,
      context: {
        functionName: 'testHandler',
        normalizedErrorCode: 'internal',
        triggeringUser: {
          uid: 'user-123',
          email: 'tester@example.org',
          displayName: 'Test User',
          role: 'admin',
        },
      },
    });
  });

  it('does not emit a duplicate operational alert for errors already reported', async () => {
    const emitSpy = jest.spyOn(emitOperationalAlertModule, 'emitOperationalAlert').mockResolvedValue(undefined);
    const sentrySpy = jest.spyOn(sentryModule, 'captureFunctionsExceptionAndFlush').mockResolvedValue(undefined);

    const error = new Error('already reported');
    emitOperationalAlertModule.markOperationalAlertEmitted(error);

    emitSpy.mockClear();
    const normalized = handleError(error);

    expect(normalized).toBeInstanceOf(HttpsError);
    expect(emitSpy).not.toHaveBeenCalled();
    expect(sentrySpy).not.toHaveBeenCalled();
  });

  it('maps upstream 429 responses to resource-exhausted with retry metadata', () => {
    const emitSpy = jest.spyOn(emitOperationalAlertModule, 'emitOperationalAlert').mockResolvedValue(undefined);
    const sentrySpy = jest.spyOn(sentryModule, 'captureFunctionsExceptionAndFlush').mockResolvedValue(undefined);
    const error = new AxiosError(
      'Request failed with status code 429',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        status: 429,
        statusText: 'Too Many Requests',
        headers: {
          'retry-after': '2.77',
        },
        config: { headers: {} } as never,
        data: {
          message: 'rate limited',
        },
      }
    );

    const normalized = handleError(error);

    expect(normalized).toBeInstanceOf(HttpsError);
    expect(normalized.code).toBe('resource-exhausted');
    expect(sentrySpy).toHaveBeenCalledWith(error, {
      tags: {
        normalizedErrorCode: 'resource-exhausted',
      },
      extra: {
        normalizedErrorCode: 'resource-exhausted',
      },
    });
    expect(normalized.details).toMatchObject({
      code: 'UPSTREAM_RATE_LIMITED',
      upstream_status: 429,
      retry_after_seconds: 2.77,
      retry_after_ms: 2770,
      upstream: {
        message: 'rate limited',
      },
    });
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          normalizedErrorCode: 'resource-exhausted',
        }),
      })
    );
  });

  it('maps upstream 5xx responses to unavailable with upstream metadata', () => {
    const emitSpy = jest.spyOn(emitOperationalAlertModule, 'emitOperationalAlert').mockResolvedValue(undefined);
    const sentrySpy = jest.spyOn(sentryModule, 'captureFunctionsExceptionAndFlush').mockResolvedValue(undefined);
    const error = new AxiosError(
      'Request failed with status code 502',
      'ERR_BAD_RESPONSE',
      undefined,
      undefined,
      {
        status: 502,
        statusText: 'Bad Gateway',
        headers: {
          'retry-after': '5',
        },
        config: { headers: {} } as never,
        data: {
          message: 'upstream temporarily unavailable',
        },
      }
    );

    const normalized = handleError(error);

    expect(normalized).toBeInstanceOf(HttpsError);
    expect(normalized.code).toBe('unavailable');
    expect(normalized.details).toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      upstream_status: 502,
      retry_after_seconds: 5,
      retry_after_ms: 5000,
      upstream: {
        message: 'upstream temporarily unavailable',
      },
    });
    expect(sentrySpy).toHaveBeenCalledWith(error, {
      tags: {
        normalizedErrorCode: 'unavailable',
      },
      extra: {
        normalizedErrorCode: 'unavailable',
      },
    });
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          normalizedErrorCode: 'unavailable',
        }),
      })
    );
  });

  it('can suppress reporting for caller-classified transient upstream failures', () => {
    const emitSpy = jest.spyOn(emitOperationalAlertModule, 'emitOperationalAlert').mockResolvedValue(undefined);
    const sentrySpy = jest.spyOn(sentryModule, 'captureFunctionsExceptionAndFlush').mockResolvedValue(undefined);
    const error = new AxiosError(
      'Request failed with status code 503',
      'ERR_BAD_RESPONSE',
      undefined,
      undefined,
      {
        status: 503,
        statusText: 'Service Unavailable',
        headers: {},
        config: { headers: {} } as never,
        data: {
          message: 'service unavailable',
        },
      }
    );

    const normalized = handleError(error, { suppressReporting: true });

    expect(normalized).toBeInstanceOf(HttpsError);
    expect(normalized.code).toBe('unavailable');
    expect(sentrySpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('treats Subsplash lock contention as an expected retry path', () => {
    const emitSpy = jest.spyOn(emitOperationalAlertModule, 'emitOperationalAlert').mockResolvedValue(undefined);
    const sentrySpy = jest.spyOn(sentryModule, 'captureFunctionsExceptionAndFlush').mockResolvedValue(undefined);
    const error = new HttpsError('aborted', 'Subsplash lock contention prevented this mutation.', {
      code: 'SUBSPLASH_LOCK_BUSY',
      locked_keys: ['series:series-123'],
      wait_ms: 10000,
      retry_after_ms: 1000,
    });

    const normalized = handleError(error);

    expect(normalized).toBe(error);
    expect(sentrySpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
