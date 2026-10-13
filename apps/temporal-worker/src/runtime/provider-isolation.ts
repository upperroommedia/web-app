/** Separate Firebase projects do not serialize a shared external provider account.
 * The current staging Subsplash app is production's app. Until reviewed account
 * identities or a shared authority are configured, only production may mutate. */
export function assertLiveProviderMutationProject(projectId: string): void {
  if (projectId !== 'urm-app') {
    throw Object.assign(new Error('Isolated provider accounts are required'), {
      code: 'PROVIDER_ACCOUNT_ISOLATION_REQUIRED',
    });
  }
}
/** This permits private emulator journals, never a live provider transport. */
export function isPrivateProviderMutationSimulation(): boolean {
  return (
    process.env.NODE_ENV === 'test' &&
    process.env.TEMPORAL_PROVIDER_MUTATION_SIMULATION === 'true' &&
    /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')
  );
}
