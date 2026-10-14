import { FieldPath, Firestore, Transaction, Timestamp, DocumentSnapshot } from 'firebase-admin/firestore';
export interface EmailReleaseControl {
  schemaVersion: 1;
  revision: number;
  admission: 'open' | 'paused';
  domains: Record<string, { owner: 'temporal' | 'legacy'; admission: 'open' | 'paused' }>;
  releaseId: string;
  updatedAt: number;
}
const CONTROL_PATH = '_control/temporalRelease';
function controlValid(control: EmailReleaseControl | undefined): control is EmailReleaseControl {
  return (
    !!control &&
    control.schemaVersion === 1 &&
    Number.isSafeInteger(control.revision) &&
    control.revision > 0 &&
    typeof control.releaseId === 'string' &&
    !!control.releaseId &&
    ['open', 'paused'].includes(control.admission) &&
    Number.isFinite(control.updatedAt) &&
    !!control.domains?.emails &&
    ['legacy', 'temporal'].includes(control.domains.emails.owner) &&
    ['open', 'paused'].includes(control.domains.emails.admission)
  );
}
function emailTimestamp(value: unknown): { seconds: number; nanoseconds: number } {
  const v = value as { seconds: number; nanoseconds: number };
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
    throw new Error('EMAIL_LEGACY_TIMESTAMP_INVALID');
  return v;
}
function legacyEmailAuthority(snapshot: DocumentSnapshot, release: DocumentSnapshot) {
  const control = snapshot.data();
  if (!control) return undefined;
  const checkpoint = release.data();
  if (!Object.prototype.hasOwnProperty.call(control, 'legacyAdmissionCutoff')) {
    const phase = checkpoint?.phase === 'paused-for-recovery' ? checkpoint.pausedFrom : checkpoint?.phase;
    if (
      checkpoint?.mode === 'durable-upgrade' ||
      Object.prototype.hasOwnProperty.call(checkpoint ?? {}, 'legacySettlingCutoff') ||
      Object.prototype.hasOwnProperty.call(checkpoint ?? {}, 'compatibilityVerifiedAt') ||
      (phase && !['freezing-ui', 'ui-frozen'].includes(phase))
    )
      throw new Error('EMAIL_LEGACY_CUTOFF_REQUIRED');
    return undefined;
  }
  const state = checkpoint,
    cutoff = emailTimestamp(control.legacyAdmissionCutoff);
  const pinned = emailTimestamp(state?.legacySettlingCutoff),
    verified = emailTimestamp(state?.compatibilityVerifiedAt);
  const grace = state?.legacySettlingGraceSeconds;
  if (
    state?.mode !== 'initial-cutover' ||
    typeof control.releaseId !== 'string' ||
    !control.releaseId ||
    state.releaseId !== control.releaseId ||
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
    throw new Error('EMAIL_LEGACY_SETTLING_INVALID');
  const deadline = cutoff.seconds * 1000 + Math.ceil(cutoff.nanoseconds / 1e6) + grace * 1000;
  if (!Number.isSafeInteger(deadline)) throw new Error('EMAIL_LEGACY_DEADLINE_INVALID');
  return { cutoff, deadline };
}
/** Portable conformance adapter for NEW, untracked continuations. Persisted mail
 * is an existing original admission and uses the typed boundary below. */
export function assertLegacyEmailClaimWindow(snapshot: DocumentSnapshot, release: DocumentSnapshot): void {
  const authority = legacyEmailAuthority(snapshot, release);
  if (!authority) return;
  const now = emailTimestamp(snapshot.readTime);
  const serverNow = now.seconds * 1000 + Math.floor(now.nanoseconds / 1e6);
  if (!Number.isSafeInteger(serverNow)) throw new Error('EMAIL_LEGACY_DEADLINE_INVALID');
  if (serverNow >= authority.deadline) throw new Error('EMAIL_LEGACY_CLAIM_WINDOW_ENDED');
}
/** Mail is a server-only persisted admission. Its native creation boundary, not
 * trigger delivery time, permits first execution after grace. The final release
 * control transaction counts PENDING/PROCESSING mail until this claim settles. */
export async function assertNewLegacyEmailClaim(
  tx: Transaction,
  db: Firestore,
  mail: DocumentSnapshot,
  mailCollection: string
): Promise<void> {
  const [control, release] = await Promise.all([
    tx.get(db.doc(CONTROL_PATH)),
    tx.get(db.doc('_control/temporalReleaseState')),
  ]);
  if (!control.exists) return;
  const c = control.data() as EmailReleaseControl;
  if (!controlValid(c) || c.domains.emails.owner !== 'legacy') throw new Error('EMAIL_LEGACY_OWNER_RETIRED');
  const authority = legacyEmailAuthority(control, release);
  if (!authority) return;
  const path = mail.ref?.path;
  if (
    !/^[A-Za-z0-9_-]+$/.test(mailCollection) ||
    !mail.exists ||
    !path ||
    path.split('/').length !== 2 ||
    path.split('/')[0] !== mailCollection ||
    !path.split('/')[1] ||
    !['PENDING', 'RETRY'].includes(mail.get('delivery.state')) ||
    mail.get('delivery.orchestrator') === 'temporal'
  )
    throw new Error('EMAIL_ORIGINAL_ADMISSION_INVALID');
  const created = emailTimestamp(mail.createTime);
  if (
    created.seconds > authority.cutoff.seconds ||
    (created.seconds === authority.cutoff.seconds && created.nanoseconds > authority.cutoff.nanoseconds)
  )
    throw new Error('EMAIL_POST_CUTOFF_ADMISSION_REQUIRES_REVIEW');
}
export async function assertLegacyEmailRelease(tx: Transaction, db: Firestore): Promise<void> {
  const snapshot = await tx.get(db.doc(CONTROL_PATH));
  if (!snapshot.exists) return; // compatibility before the first controlled release
  const control = snapshot.data() as EmailReleaseControl;
  if (!controlValid(control) || control.domains.emails.owner !== 'legacy')
    throw new Error('EMAIL_LEGACY_OWNER_RETIRED');
  // These mail records were already admitted by privileged server producers.
}
export async function assertTemporalEmailRelease(
  tx: Transaction,
  db: Firestore,
  projectId: string,
  parentRef?: unknown,
  releaseImport?: { revision: number; releaseId: string }
): Promise<void> {
  const snapshot = await tx.get(db.doc(CONTROL_PATH));
  const control = snapshot.data() as EmailReleaseControl | undefined;
  if (!controlValid(control)) throw new Error('EMAIL_RELEASE_CONTROL_REQUIRED');
  if (releaseImport) {
    if (
      control.revision !== releaseImport.revision ||
      control.releaseId !== releaseImport.releaseId ||
      control.admission !== 'paused' ||
      control.domains.emails.admission !== 'paused'
    )
      throw new Error('EMAIL_RELEASE_IMPORT_STALE');
    return;
  }
  if (control.domains.emails.owner !== 'temporal') throw new Error('EMAIL_TEMPORAL_OWNER_INACTIVE');
  if (control.admission === 'open' && control.domains.emails.admission === 'open') return;
  const ref = parentRef as { jobId?: unknown; projectId?: unknown };
  if (!ref || ref.projectId !== projectId || typeof ref.jobId !== 'string' || !ref.jobId || ref.jobId.includes('/'))
    throw new Error('EMAIL_RELEASE_ADMISSION_PAUSED');
  const [intent, job] = await Promise.all([
    tx.get(db.collection('durableJobIntents').doc(ref.jobId)),
    tx.get(db.collection('durableJobs').doc(ref.jobId)),
  ]);
  if (
    !intent.exists ||
    !job.exists ||
    intent.get('projectId') !== projectId ||
    job.get('projectId') !== projectId ||
    intent.get('jobId') !== ref.jobId ||
    job.get('jobId') !== ref.jobId ||
    intent.get('kind') !== job.get('kind') ||
    intent.get('actorUid') !== job.get('requestedBy')
  )
    throw new Error('EMAIL_PARENT_INTENT_INVALID');
}
/** An expired/failed SMTP attempt can have been accepted without an acknowledgement.
 * Legacy ERROR has no trustworthy pre-submit marker, even when attempts is zero:
 * that counter was incremented only in the lost terminal write. */
export function legacySmtpOutcomeUncertain(delivery: Record<string, any> | undefined): boolean {
  if (delivery?.orchestrator === 'temporal') return false;
  const submission = delivery?.smtpSubmissionState;
  if (submission === 'started' || submission === 'unknown') return true;
  if (submission !== undefined && !['not_submitted', 'accepted'].includes(submission)) return true;
  return delivery?.state === 'ERROR' && submission === undefined;
}
export interface LegacyEmailDrainCounts {
  smtpUncertain: number;
  pendingFresh: number;
  retryWithPriorAttempts: number;
  processingActive: number;
  processingLeaseExpired: number;
  terminalSuccess: number;
  terminalError: number;
  temporalOwned: number;
  invalid: number;
  total: number;
}
export function countLegacyEmailDelivery(
  counts: LegacyEmailDrainCounts,
  delivery: Record<string, any> | undefined,
  now: number
): void {
  counts.total += 1;
  if (delivery?.orchestrator === 'temporal') {
    counts.temporalOwned += 1;
    return;
  }
  if (legacySmtpOutcomeUncertain(delivery)) {
    counts.smtpUncertain += 1;
    return;
  }
  const state = delivery?.state;
  if (!state || state === 'PENDING' || state === 'RETRY') {
    if ((delivery?.attempts || 0) > 0) counts.retryWithPriorAttempts += 1;
    else counts.pendingFresh += 1;
  } else if (state === 'PROCESSING') {
    if (delivery.leaseExpireTime?.toMillis?.() > now) counts.processingActive += 1;
    else counts.processingLeaseExpired += 1; // expiry is never proof of no SMTP acceptance
  } else if (state === 'SUCCESS') counts.terminalSuccess += 1;
  else if (state === 'ERROR') counts.terminalError += 1;
  else counts.invalid += 1;
}
/** Metadata-only stable read snapshot, anchored to the paused release before/after.
 * Existing child producers must also be drained in the cross-domain release audit. */
export async function scanLegacyEmailDrain(
  db: Firestore,
  input: { mailCollection: string; expectedControlRevision: number; releaseId: string }
): Promise<{
  schemaVersion: 1;
  controlRevision: number;
  releaseId: string;
  counts: LegacyEmailDrainCounts;
  drained: boolean;
}> {
  const readControl = async () => {
    const control = (await db.doc(CONTROL_PATH).get()).data() as EmailReleaseControl | undefined;
    if (
      !controlValid(control) ||
      control.revision !== input.expectedControlRevision ||
      control.releaseId !== input.releaseId ||
      control.admission !== 'paused' ||
      control.domains.emails.admission !== 'paused'
    )
      throw new Error('EMAIL_DRAIN_AUDIT_CONTROL_STALE');
    return control;
  };
  await readControl();
  const counts: LegacyEmailDrainCounts = {
    smtpUncertain: 0,
    pendingFresh: 0,
    retryWithPriorAttempts: 0,
    processingActive: 0,
    processingLeaseExpired: 0,
    terminalSuccess: 0,
    terminalError: 0,
    temporalOwned: 0,
    invalid: 0,
    total: 0,
  };
  const now = Date.now();
  await db.runTransaction(
    async (tx) => {
      let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
      for (;;) {
        let page = db
          .collection(input.mailCollection)
          .orderBy(FieldPath.documentId())
          .select(
            'delivery.state',
            'delivery.leaseExpireTime',
            'delivery.attempts',
            'delivery.orchestrator',
            'delivery.smtpSubmissionState'
          )
          .limit(250);
        if (cursor) page = page.startAfter(cursor);
        const snapshot = await tx.get(page);
        for (const doc of snapshot.docs) countLegacyEmailDelivery(counts, doc.get('delivery'), now);
        if (snapshot.docs.length < 250) break;
        cursor = snapshot.docs[snapshot.docs.length - 1];
      }
    },
    { readOnly: true }
  );
  await readControl();
  const drained =
    counts.smtpUncertain +
      counts.pendingFresh +
      counts.retryWithPriorAttempts +
      counts.processingActive +
      counts.processingLeaseExpired +
      counts.invalid ===
    0;
  return {
    schemaVersion: 1,
    controlRevision: input.expectedControlRevision,
    releaseId: input.releaseId,
    counts,
    drained,
  };
}
