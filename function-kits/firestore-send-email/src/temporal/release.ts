import { FieldPath, Firestore, Transaction } from 'firebase-admin/firestore';
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
export interface LegacyEmailDrainCounts {
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
          .select('delivery.state', 'delivery.leaseExpireTime', 'delivery.attempts', 'delivery.orchestrator')
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
