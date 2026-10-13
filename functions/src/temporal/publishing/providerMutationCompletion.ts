/** Only a synchronous original response proves that a mutable provider request completed. */
export function assertSynchronousProviderMutationCompleted(response: { status?: unknown }): void {
  if (response.status !== 200 && response.status !== 204) {
    throw new Error('PROVIDER_MUTATION_COMPLETION_UNCONFIRMED');
  }
}
