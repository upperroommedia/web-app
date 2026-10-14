import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { ProviderExecution, ProviderSimulationScenario } from '@upperroom/contracts/temporal';

export interface SandboxProviderProfile {
  schemaVersion: 1;
  projectId: 'urm-app-staging';
  mode: 'sandbox';
  profileId: 'urm-app-staging-publishing-v1';
  version: 1;
  namespace: 'urm-app-staging-publishing-v1';
}
export interface LiveProviderProfile {
  schemaVersion: 1;
  projectId: 'urm-app';
  mode: 'live';
  profileId: 'urm-app-live-v1';
  version: 1;
}
export const STAGING_SANDBOX_PROFILE: Readonly<SandboxProviderProfile> = Object.freeze({
  schemaVersion: 1,
  projectId: 'urm-app-staging',
  mode: 'sandbox',
  profileId: 'urm-app-staging-publishing-v1',
  version: 1,
  namespace: 'urm-app-staging-publishing-v1',
});
export const PROVIDER_SIMULATION_SCENARIOS: readonly ProviderSimulationScenario[] = [
  'success',
  'delayed-processing',
  'transient-failure',
  'permanent-failure',
  'commit-then-lost-response',
];
const reject = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};
/** The caller supplies the actual initialized Admin application's project, never callable input. */
export function resolveProviderExecutionProfile(
  actualProjectId: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): SandboxProviderProfile | LiveProviderProfile {
  if (actualProjectId === 'urm-app') {
    if (env.STAGING_PROVIDER_MODE !== undefined) reject('PROVIDER_SANDBOX_FORBIDDEN_IN_PRODUCTION');
    return { schemaVersion: 1, projectId: 'urm-app', mode: 'live', profileId: 'urm-app-live-v1', version: 1 };
  }
  if (actualProjectId !== 'urm-app-staging' || env.STAGING_PROVIDER_MODE !== 'sandbox')
    reject('PROVIDER_PROFILE_NOT_CONFIGURED');
  return { ...STAGING_SANDBOX_PROFILE };
}
export function getProviderExecutionProfile(claimedProjectId?: string): SandboxProviderProfile | LiveProviderProfile {
  const actual = firebaseAdmin.app().options.projectId;
  if (claimedProjectId && claimedProjectId !== actual) reject('PROVIDER_PROFILE_PROJECT_MISMATCH');
  return resolveProviderExecutionProfile(actual);
}
export function assertMatchingSandboxProfile(
  profile: SandboxProviderProfile,
  pinned: unknown
): asserts pinned is ProviderExecution {
  const value = pinned as Partial<ProviderExecution> | undefined;
  if (
    profile.schemaVersion !== 1 ||
    profile.mode !== 'sandbox' ||
    profile.projectId !== STAGING_SANDBOX_PROFILE.projectId ||
    profile.profileId !== STAGING_SANDBOX_PROFILE.profileId ||
    profile.version !== 1 ||
    profile.mode !== 'sandbox' ||
    profile.namespace !== STAGING_SANDBOX_PROFILE.namespace ||
    value?.mode !== 'sandbox' ||
    value.profileId !== profile.profileId ||
    value.version !== profile.version ||
    !PROVIDER_SIMULATION_SCENARIOS.includes(value.scenario as ProviderSimulationScenario)
  )
    reject('PROVIDER_INTENT_PROFILE_MISMATCH');
}
export function assertSandboxIntentProfile(
  profile: SandboxProviderProfile,
  intent: { projectId?: string; payload?: unknown; providerExecution?: unknown }
): ProviderExecution {
  if (intent.projectId && intent.projectId !== profile.projectId) reject('PROVIDER_INTENT_PROFILE_MISMATCH');
  const payload = intent.payload as { providerExecution?: unknown } | undefined;
  const pinned = payload?.providerExecution ?? intent.providerExecution;
  assertMatchingSandboxProfile(profile, pinned);
  return pinned;
}
export const sandboxProfileDocumentPath = (profile: SandboxProviderProfile): string => {
  if (
    profile.schemaVersion !== 1 ||
    profile.mode !== 'sandbox' ||
    profile.projectId !== STAGING_SANDBOX_PROFILE.projectId ||
    profile.profileId !== STAGING_SANDBOX_PROFILE.profileId ||
    profile.version !== 1 ||
    profile.namespace !== STAGING_SANDBOX_PROFILE.namespace
  )
    reject('PROVIDER_PROFILE_PROJECT_MISMATCH');
  return `_providerSandbox/${profile.profileId}`;
};
export const sandboxResourceCollectionPath = (profile: SandboxProviderProfile): string =>
  `${sandboxProfileDocumentPath(profile)}/resources`;
export function assertSandboxCatalogReady(profile: SandboxProviderProfile, marker: unknown): void {
  const value = marker as
    | { state?: unknown; profile?: unknown; catalogImportId?: unknown; sourceDigest?: unknown; resourceCount?: unknown }
    | undefined;
  if (
    !value?.profile ||
    typeof value.profile !== 'object' ||
    Object.keys(value.profile).length !== Object.keys(STAGING_SANDBOX_PROFILE).length ||
    Object.entries(STAGING_SANDBOX_PROFILE).some(
      ([key, item]) => (value.profile as unknown as Record<string, unknown>)[key] !== item
    )
  )
    reject('PROVIDER_SANDBOX_CATALOG_NOT_READY');
  assertMatchingSandboxProfile(profile, { ...(value?.profile as object), scenario: 'success' });
  if (
    value?.state !== 'ready' ||
    typeof value.catalogImportId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value.catalogImportId) ||
    !/^[a-f0-9]{64}$/.test(String(value.sourceDigest)) ||
    !Number.isSafeInteger(value.resourceCount) ||
    Number(value.resourceCount) < 0
  )
    reject('PROVIDER_SANDBOX_CATALOG_NOT_READY');
}
