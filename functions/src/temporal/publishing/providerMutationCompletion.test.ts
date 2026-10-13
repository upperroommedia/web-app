import { assertSynchronousProviderMutationCompleted } from './providerMutationCompletion';

describe('synchronous provider mutation completion', () => {
  it.each([200, 204])('accepts an original synchronous HTTP %s completion', (status) => {
    expect(() => assertSynchronousProviderMutationCompleted({ status })).not.toThrow();
  });
  it.each([202, 201, 307, 308, undefined])(
    'does not claim queued, redirected or unproven response %s completed',
    (status) => {
      expect(() => assertSynchronousProviderMutationCompleted({ status })).toThrow(
        'PROVIDER_MUTATION_COMPLETION_UNCONFIRMED'
      );
    }
  );
});
