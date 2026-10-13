import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { DurableJobKind } from '@upperroom/contracts/temporal';
import { domainForKind } from './ownership';
export const TEMPORAL_RELEASE_CONTROL_PATH = '_control/temporalRelease';
export interface TemporalReleaseControl {
  schemaVersion: 1;
  revision: number;
  admission: 'open' | 'paused';
  domains: Record<string, { owner: 'temporal' | 'legacy'; admission: 'open' | 'paused' }>;
  updatedAt: number;
  releaseId: string;
  legacyAdmissionCutoff?: { seconds: number; nanoseconds: number };
}
/** Read before any writes so an operator pause conflicts with in-flight admissions. */
export async function assertAdmissionReleaseInTransaction(
  transaction: Transaction,
  firestore: Firestore,
  kind: DurableJobKind,
  options: { continuation?: boolean; domain?: string } = {}
): Promise<void> {
  const snapshot = await transaction.get(firestore.doc(TEMPORAL_RELEASE_CONTROL_PATH));
  const control = snapshot.data() as TemporalReleaseControl | undefined;
  const domain = options.domain ?? domainForKind(kind),
    state = control?.domains?.[domain];
  if (
    !control ||
    control.schemaVersion !== 1 ||
    !Number.isSafeInteger(control.revision) ||
    control.revision < 1 ||
    state?.owner !== 'temporal'
  )
    throw new HttpsError(
      'failed-precondition',
      'This operation is not owned by the active Temporal release. Refresh before starting new work.'
    );
  if (!options.continuation && (control.admission !== 'open' || state.admission !== 'open'))
    throw new HttpsError(
      'unavailable',
      'New tasks are paused for a release change. Your existing tasks remain available; try again after the release is ready.'
    );
}

/** Compatibility backend fence: missing control preserves the pre-migration legacy owner. */
export async function assertLegacyAdmissionInTransaction(
  transaction: Transaction,
  firestore: Firestore,
  domain: string,
  options: { continuation?: boolean } = {}
): Promise<void> {
  const snapshot = await transaction.get(firestore.doc(TEMPORAL_RELEASE_CONTROL_PATH));
  const usageBarrier = await transaction.get(firestore.doc('_control/temporalProviderUsage'));
  if (!snapshot.exists) return;
  const control = snapshot.data() as TemporalReleaseControl;
  const state = control.domains?.[domain];
  if (
    ['media', 'publishing', 'images', 'accounts'].includes(domain) &&
    control.admission === 'paused' &&
    usageBarrier.data()?.releaseId === control.releaseId &&
    ['building', 'ready'].includes(usageBarrier.data()?.status)
  )
    throw new HttpsError(
      'unavailable',
      'Legacy writes are frozen while provider references are verified for this release.'
    );
  if (control.schemaVersion !== 1 || state?.owner !== 'legacy')
    throw new HttpsError(
      'failed-precondition',
      'This operation moved to the durable task service. Refresh the application before starting new work.'
    );
  if (!options.continuation && (control.admission !== 'open' || state.admission !== 'open'))
    throw new HttpsError(
      'unavailable',
      'New tasks are paused while the service is changing. Existing work will finish; try again when the release is ready.'
    );
}
export async function assertLegacyAdmissionAllowed(
  firestore: Firestore,
  domain: string,
  options: { continuation?: boolean } = {}
): Promise<void> {
  await firestore.runTransaction((tx) => assertLegacyAdmissionInTransaction(tx, firestore, domain, options));
}
