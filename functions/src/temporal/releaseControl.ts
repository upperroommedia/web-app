import { Timestamp, type DocumentSnapshot, type Firestore, type Transaction } from 'firebase-admin/firestore';
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
type NativeLegacyTimestamp = { seconds: number; nanoseconds: number };
function legacyTimestamp(value: unknown): NativeLegacyTimestamp {
  const v = value as NativeLegacyTimestamp;
  const plain =
    value &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 2 &&
    Object.prototype.hasOwnProperty.call(value, 'seconds') &&
    Object.prototype.hasOwnProperty.call(value, 'nanoseconds');
  const native =
    !plain &&
    value instanceof Timestamp &&
    Object.keys(value).length === 2 &&
    Object.prototype.hasOwnProperty.call(value, '_seconds') &&
    Object.prototype.hasOwnProperty.call(value, '_nanoseconds');
  if (
    (!plain && !native) ||
    !Number.isSafeInteger(v.seconds) ||
    v.seconds < -62135596800 ||
    v.seconds > 253402300799 ||
    !Number.isSafeInteger(v.nanoseconds) ||
    v.nanoseconds < 0 ||
    v.nanoseconds >= 1e9
  )
    throw new HttpsError('failed-precondition', 'Legacy continuation timestamp authority is invalid.');
  return v;
}
function legacyContinuationAuthority(control: DocumentSnapshot, release: DocumentSnapshot) {
  const c = control.data();
  if (!c) return undefined;
  const checkpoint = release.data();
  if (!Object.prototype.hasOwnProperty.call(c, 'legacyAdmissionCutoff')) {
    const phase = checkpoint?.phase === 'paused-for-recovery' ? checkpoint.pausedFrom : checkpoint?.phase;
    if (
      checkpoint?.mode === 'durable-upgrade' ||
      Object.prototype.hasOwnProperty.call(checkpoint ?? {}, 'legacySettlingCutoff') ||
      Object.prototype.hasOwnProperty.call(checkpoint ?? {}, 'compatibilityVerifiedAt') ||
      (phase && !['freezing-ui', 'ui-frozen'].includes(phase))
    )
      throw new HttpsError('failed-precondition', 'Legacy continuation cutoff authority is missing.');
    return undefined;
  }
  const state = checkpoint,
    cutoff = legacyTimestamp(c.legacyAdmissionCutoff);
  const pinned = legacyTimestamp(state?.legacySettlingCutoff),
    verified = legacyTimestamp(state?.compatibilityVerifiedAt);
  const grace = state?.legacySettlingGraceSeconds;
  if (
    state?.mode !== 'initial-cutover' ||
    typeof c.releaseId !== 'string' ||
    !c.releaseId ||
    state.releaseId !== c.releaseId ||
    cutoff.seconds !== pinned.seconds ||
    cutoff.nanoseconds !== pinned.nanoseconds ||
    cutoff.seconds !== verified.seconds ||
    cutoff.nanoseconds !== verified.nanoseconds ||
    !Number.isSafeInteger(grace) ||
    grace < 3600 ||
    grace > 86400 ||
    !Number.isSafeInteger(grace * 1000) ||
    !Number.isSafeInteger(state.maximumLegacyExecutionSeconds) ||
    state.maximumLegacyExecutionSeconds < 540 ||
    grace < state.maximumLegacyExecutionSeconds
  )
    throw new HttpsError('failed-precondition', 'Legacy continuation settling authority is incomplete.');
  const deadline = cutoff.seconds * 1000 + Math.ceil(cutoff.nanoseconds / 1e6) + grace * 1000;
  if (!Number.isSafeInteger(deadline))
    throw new HttpsError('failed-precondition', 'Legacy continuation deadline is invalid.');
  return { cutoff, deadline };
}
/** Only a fresh server snapshot can authorize a NEW legacy continuation claim.
 * Completion/heartbeat of a known lease does not call this admission fence. */
export function assertLegacyContinuationWindow(control: DocumentSnapshot, release: DocumentSnapshot): void {
  const authority = legacyContinuationAuthority(control, release);
  if (!authority) return;
  const now = legacyTimestamp(control.readTime);
  const serverNow = now.seconds * 1000 + Math.floor(now.nanoseconds / 1e6);
  if (!Number.isSafeInteger(serverNow))
    throw new HttpsError('failed-precondition', 'Legacy continuation server time is invalid.');
  if (serverNow >= authority.deadline)
    throw new HttpsError('unavailable', 'The legacy continuation settling window has ended.');
}
/** Acquisition-only seam. Revalidation of a known accepted lease must not call it. */
export async function assertNewLegacyContinuationInTransaction(
  transaction: Transaction,
  firestore: Firestore
): Promise<void> {
  const [control, release] = await Promise.all([
    transaction.get(firestore.doc(TEMPORAL_RELEASE_CONTROL_PATH)),
    transaction.get(firestore.doc('_control/temporalReleaseState')),
  ]);
  if (!control.exists) return;
  assertLegacyContinuationWindow(control, release);
}
/** A canonical source created before cutoff is the original admission, not a new
 * listener task. The caller must first verify its PENDING owner/selection in this
 * same claim transaction; the permanent pending-source drain protects its handoff. */
export async function assertOriginalLegacySourceBoundaryInTransaction(
  transaction: Transaction,
  firestore: Firestore,
  source: DocumentSnapshot
): Promise<void> {
  const [control, release] = await Promise.all([
    transaction.get(firestore.doc(TEMPORAL_RELEASE_CONTROL_PATH)),
    transaction.get(firestore.doc('_control/temporalReleaseState')),
  ]);
  if (!source.exists || !source.createTime)
    throw new HttpsError('aborted', 'The original canonical source admission is unavailable.');
  const created = legacyTimestamp(source.createTime);
  const authority = legacyContinuationAuthority(control, release);
  if (
    authority &&
    (created.seconds > authority.cutoff.seconds ||
      (created.seconds === authority.cutoff.seconds && created.nanoseconds > authority.cutoff.nanoseconds))
  )
    throw new HttpsError('aborted', 'This source was not admitted before the verified compatibility pause boundary.');
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

/** Administrative connection setup is not replayable work; its lease still participates in release drain. */
export async function assertAdministrativeIntegrationSetupInTransaction(
  transaction: Transaction,
  firestore: Firestore,
  domain: 'accounts' | 'media'
): Promise<void> {
  const snapshot = await transaction.get(firestore.doc(TEMPORAL_RELEASE_CONTROL_PATH));
  const barrier = await transaction.get(firestore.doc('_control/temporalProviderUsage'));
  if (!snapshot.exists) return;
  const control = snapshot.data() as TemporalReleaseControl;
  const accounts = control.domains?.[domain];
  if (
    control.schemaVersion !== 1 ||
    !Number.isSafeInteger(control.revision) ||
    control.revision < 1 ||
    !Number.isFinite(control.updatedAt) ||
    control.updatedAt < 0 ||
    typeof control.releaseId !== 'string' ||
    !control.releaseId ||
    !['open', 'paused'].includes(control.admission) ||
    !accounts ||
    !['legacy', 'temporal'].includes(accounts.owner) ||
    !['open', 'paused'].includes(accounts.admission)
  )
    throw new HttpsError('failed-precondition', 'Integration setup release control is invalid.');
  if (
    control.admission !== 'open' ||
    accounts.admission !== 'open' ||
    (barrier.get('releaseId') === control.releaseId && barrier.get('status') === 'building')
  )
    throw new HttpsError(
      'unavailable',
      'Integration setup is paused while the service is changing. Try again after the release is ready.'
    );
}
