/** Provider activities require the authoritative production or isolated staging
 * profile. This never permits a staging request to use live vendor transport. */
import { getProviderExecutionProfile } from '../../../../functions/src/providerSandbox/profile';
export function assertLiveProviderMutationProject(projectId: string): void {
  getProviderExecutionProfile(projectId);
}
/** This permits private emulator journals, never a live provider transport. */
export function isPrivateProviderMutationSimulation(): boolean {
  return (
    process.env.NODE_ENV === 'test' &&
    process.env.TEMPORAL_PROVIDER_MUTATION_SIMULATION === 'true' &&
    /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')
  );
}
