import { SandboxHttpError, SandboxScriptedFault } from './types';
import { getProviderExecutionProfile } from './profile';
import { isTrustedScriptedSandboxFault } from './scriptedFailure';
import { isExpectedOperationalError } from '../expectedOperationalError';
import handleError from '../handleError';
import { captureFunctionsExceptionAndFlush } from '../sentry';
import { emitOperationalAlert } from '../notifications/emitOperationalAlert';
jest.mock('../sentry', () => ({ captureFunctionsExceptionAndFlush: jest.fn() }));
jest.mock('../notifications/emitOperationalAlert', () => ({
  emitOperationalAlert: jest.fn(),
  hasOperationalAlertBeenEmitted: () => false,
}));
jest.mock('firebase-functions/v2/https', () => ({
  HttpsError: class HttpsError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly details?: unknown
    ) {
      super(message);
    }
  },
}));
jest.mock('./profile', () => ({ getProviderExecutionProfile: jest.fn() }));
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(getProviderExecutionProfile)
    .mockReturnValue({
      schemaVersion: 1,
      mode: 'sandbox',
      projectId: 'urm-app-staging',
      profileId: 'urm-app-staging-publishing-v1',
      version: 1,
      namespace: 'urm-app-staging-publishing-v1',
    });
});
test('only actual server-scripted class plus verified staging sandbox suppresses an expected test failure', () => {
  const error = new SandboxScriptedFault(403, 'permanent-failure', 'fixture');
  expect(isTrustedScriptedSandboxFault(error)).toBe(true);
  expect(isExpectedOperationalError(error)).toBe(true);
});
test.each([
  new Error('genuine bug'),
  new SandboxHttpError(503, 'unsupported route'),
  { sandboxScriptedFault: true, scenario: 'permanent-failure', code: 'PROVIDER_SANDBOX_ERROR' },
])('ordinary failures and forged marker objects remain reportable %#', (error) => {
  expect(isTrustedScriptedSandboxFault(error)).toBe(false);
  expect(isExpectedOperationalError(error)).toBe(false);
});
test('production and missing/unverified profile cannot suppress even a constructed scripted instance', () => {
  const error = new SandboxScriptedFault(503, 'transient-failure', 'fixture');
  jest
    .mocked(getProviderExecutionProfile)
    .mockReturnValue({
      schemaVersion: 1,
      mode: 'live',
      projectId: 'urm-app',
      profileId: 'urm-app-live-v1',
      version: 1,
    });
  expect(isExpectedOperationalError(error)).toBe(false);
  jest.mocked(getProviderExecutionProfile).mockImplementation(() => {
    throw new Error('unverified');
  });
  expect(isExpectedOperationalError(error)).toBe(false);
});

test('handleError checks original trusted class before normalization and leaves genuine defects observable', () => {
  handleError(new SandboxScriptedFault(503, 'transient-failure', 'fixture'));
  expect(captureFunctionsExceptionAndFlush).not.toHaveBeenCalled();
  expect(emitOperationalAlert).not.toHaveBeenCalled();
  handleError(new Error('genuine defect'));
  expect(captureFunctionsExceptionAndFlush).toHaveBeenCalledTimes(1);
  expect(emitOperationalAlert).toHaveBeenCalledTimes(1);
});
