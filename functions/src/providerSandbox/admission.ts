import type { DurableJobKind, ProviderExecution, ProviderSimulationScenario } from '@upperroom/contracts/temporal';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  assertSandboxCatalogReady,
  getProviderExecutionProfile,
  PROVIDER_SIMULATION_SCENARIOS,
  sandboxProfileDocumentPath,
  type SandboxProviderProfile,
} from './profile';
export function isSandboxProviderIntent(kind: DurableJobKind, payload: Record<string, unknown>): boolean {
  return (
    kind.startsWith('sermon.') ||
    kind.startsWith('list.') ||
    kind.startsWith('series.') ||
    kind.startsWith('image.') ||
    kind === 'speaker.mutate' ||
    kind === 'provider.orphan_review' ||
    (kind === 'speaker.resolve' && payload.action === 'speaker-accept') ||
    (kind === 'maintenance.run' && payload.operation !== 'media_artifacts_cleanup')
  );
}
export function prepareProviderAdmission(
  projectId: string,
  kind: DurableJobKind,
  payload: Record<string, unknown>,
  role: string,
  requestedScenario: unknown
): { profile: SandboxProviderProfile; execution: ProviderExecution } | undefined {
  const affected = isSandboxProviderIntent(kind, payload);
  if (requestedScenario !== undefined && (!affected || projectId !== 'urm-app-staging' || role !== 'admin'))
    throw new HttpsError(
      'permission-denied',
      'Only a staging administrator can choose a provider simulation scenario.'
    );
  if (!affected || projectId !== 'urm-app-staging') return undefined;
  const profile = getProviderExecutionProfile(projectId);
  if (profile.mode !== 'sandbox')
    throw new HttpsError('failed-precondition', 'The staging provider profile is unavailable.');
  const scenario = requestedScenario ?? 'success';
  if (!PROVIDER_SIMULATION_SCENARIOS.includes(scenario as ProviderSimulationScenario))
    throw new HttpsError('invalid-argument', 'Unknown provider simulation scenario.');
  return {
    profile,
    execution: {
      mode: 'sandbox',
      profileId: profile.profileId,
      version: profile.version,
      scenario: scenario as ProviderSimulationScenario,
    },
  };
}
export async function assertProviderAdmissionCatalog(
  tx: Transaction,
  db: Firestore,
  binding: { profile: SandboxProviderProfile } | undefined
): Promise<void> {
  if (binding)
    assertSandboxCatalogReady(
      binding.profile,
      (await tx.get(db.doc(sandboxProfileDocumentPath(binding.profile)))).data()
    );
}
