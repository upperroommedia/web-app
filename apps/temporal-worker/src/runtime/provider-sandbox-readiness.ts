import type { Firestore } from 'firebase-admin/firestore';
import type { DurableJobKind } from '@upperroom/contracts/temporal';
import { isSandboxProviderIntent } from '../../../../functions/src/providerSandbox/admission';
import {
  getProviderExecutionProfile,
  assertSandboxCatalogReady,
  sandboxProfileDocumentPath,
  assertSandboxIntentProfile,
  assertMatchingSandboxProfile,
} from '../../../../functions/src/providerSandbox/profile';

export interface ProviderSandboxReadiness {
  mode: 'sandbox';
  profileId: string;
  ready: true;
}
const providerRoles = new Set(['urm-orchestration', 'urm-controls', 'urm-images']);
const activeStates = [
  'awaiting_source',
  'queued',
  'running',
  'retrying',
  'waiting_for_auth',
  'cancel_requested',
  'reconciling',
  'needs_attention',
];
/** Startup verifies the private marker and bounded real job provenance. Health probes
 * serve this cached result; every activity rechecks its current intent before effects. */
export async function verifyProviderSandboxReadiness(
  db: Firestore,
  projectId: string,
  queues: readonly string[],
  validateActiveJobs = false
): Promise<ProviderSandboxReadiness | undefined> {
  if (!queues.some((queue) => providerRoles.has(queue))) return undefined;
  const profile = getProviderExecutionProfile(projectId);
  if (profile.mode === 'live') return undefined;
  await db.runTransaction(
    async (tx) => {
      const marker = await tx.get(db.doc(sandboxProfileDocumentPath(profile)));
      assertSandboxCatalogReady(profile, marker.data());
      if (!validateActiveJobs) return;
      const active = await tx.get(db.collection('durableJobs').where('state', 'in', activeStates).limit(1001));
      if (active.size > 1000) throw new Error('PROVIDER_SANDBOX_PREFLIGHT_JOB_BOUND');
      for (const row of active.docs) {
        const job = row.data();
        if (!isSandboxProviderIntent(job.kind as DurableJobKind, { action: 'speaker-accept' })) continue;
        const intent = (await tx.get(db.collection('durableJobIntents').doc(row.id))).data();
        if (
          !intent ||
          intent.jobId !== row.id ||
          job.jobId !== row.id ||
          intent.projectId !== profile.projectId ||
          job.projectId !== profile.projectId ||
          intent.generation !== job.generation ||
          intent.kind !== job.kind
        )
          throw new Error('PROVIDER_SANDBOX_PREFLIGHT_INTENT_MISMATCH');
        if (!isSandboxProviderIntent(intent.kind as DurableJobKind, intent.payload)) continue;
        const pinned = assertSandboxIntentProfile(profile, intent);
        assertMatchingSandboxProfile(profile, job.providerExecution);
        if (pinned.scenario !== job.providerExecution.scenario)
          throw new Error('PROVIDER_SANDBOX_PREFLIGHT_SCENARIO_MISMATCH');
      }
    },
    { readOnly: true }
  );
  return { mode: 'sandbox', profileId: profile.profileId, ready: true };
}
