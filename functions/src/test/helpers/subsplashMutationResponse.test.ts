import { assertSynchronousProviderMutationCompleted } from '../../temporal/publishing/providerMutationCompletion';

it.each([200, 204])('accepts completed original HTTP %i', (status) => {
  const data = { id: 'verified' };
  expect(() => assertSynchronousProviderMutationCompleted({ status, ...{ data } })).not.toThrow();
});
it.each([undefined, 202, 201, 206, 302])(
  'rejects unverified or asynchronous HTTP %p even with a plausible body',
  (status) => {
    expect(() => assertSynchronousProviderMutationCompleted({ status, ...{ data: { id: 'plausible' } } })).toThrow(
      'PROVIDER_MUTATION_COMPLETION_UNCONFIRMED'
    );
  }
);
