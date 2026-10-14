import { createHash } from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  withLegacyAdmissionLease,
  LEGACY_ADMISSION_LEASES_COLLECTION,
  type LegacyAdmissionLease,
} from '../temporal/legacyAdmissionLease';
import { assertLegacyAdmissionInTransaction, TEMPORAL_RELEASE_CONTROL_PATH } from '../temporal/releaseControl';

export interface NativeEventTimestamp {
  seconds: number;
  nanoseconds: number;
}
export interface ProviderListenerEvent {
  id: string;
  time: string;
  sourceCreatedAt: NativeEventTimestamp;
}
export const LEGACY_PROVIDER_LISTENER_RECEIPTS = 'legacyProviderListenerReceipts';

export function validNativeTimestamp(value: unknown): value is NativeEventTimestamp {
  const t = value as NativeEventTimestamp | undefined;
  return Boolean(
    t &&
      Number.isSafeInteger(t.seconds) &&
      Number.isSafeInteger(t.nanoseconds) &&
      t.nanoseconds >= 0 &&
      t.nanoseconds < 1_000_000_000
  );
}
export function timestampAtOrBefore(a: NativeEventTimestamp, b: NativeEventTimestamp): boolean {
  return (
    validNativeTimestamp(a) &&
    validNativeTimestamp(b) &&
    (a.seconds < b.seconds || (a.seconds === b.seconds && a.nanoseconds <= b.nanoseconds))
  );
}
export function sameNativeTimestamp(a: NativeEventTimestamp, b: NativeEventTimestamp): boolean {
  return (
    validNativeTimestamp(a) && validNativeTimestamp(b) && a.seconds === b.seconds && a.nanoseconds === b.nanoseconds
  );
}
/** CloudEvent time is RFC3339. Preserve submillisecond precision instead of rounding through Date. */
export function parseProviderEventTime(value: string): NativeEventTimestamp {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  const milliseconds = match ? Date.parse(`${match[1]}Z`) : NaN;
  if (!match || !Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== match[1])
    throw new HttpsError('failed-precondition', 'The original provider event timestamp is invalid.');
  return { seconds: milliseconds / 1000, nanoseconds: Number((match[2] ?? '').padEnd(9, '0')) };
}

export interface ProviderListenerLeaseContext {
  lease: LegacyAdmissionLease;
  projectId: string;
  operation: 'sermonListOnDelete' | 'seriesItemOnWrite';
}
/** Reuse only the actual active server lease, never an id or callback that escaped its lifetime. */
export async function assertActiveProviderListenerLease(
  tx: Transaction,
  firestore: Firestore,
  context: ProviderListenerLeaseContext
): Promise<void> {
  if (!context.lease.leaseId || context.lease.leaseId.includes('/'))
    throw new HttpsError('failed-precondition', 'The active provider listener lease is required.');
  const snapshot = await tx.get(firestore.collection(LEGACY_ADMISSION_LEASES_COLLECTION).doc(context.lease.leaseId));
  const record = snapshot.data();
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.leaseId !== context.lease.leaseId ||
    record.projectId !== context.projectId ||
    record.domain !== 'publishing' ||
    record.actorUid !== 'system:firebase-event' ||
    record.operation !== context.operation ||
    record.state !== 'active' ||
    typeof record.effectsStarted !== 'boolean' ||
    !Number.isSafeInteger(record.releaseRevision) ||
    record.releaseRevision < 0 ||
    !Number.isFinite(record.acquiredAt) ||
    !Number.isFinite(record.heartbeatAt) ||
    !Number.isFinite(record.diagnosticExpiresAt)
  )
    throw new HttpsError('failed-precondition', 'The provider listener lease is no longer active with this owner.');
}
export async function assertProviderListenerEventInTransaction(
  tx: Transaction,
  firestore: Firestore,
  event: ProviderListenerEvent,
  context: ProviderListenerLeaseContext
): Promise<void> {
  await assertActiveProviderListenerLease(tx, firestore, context);
  await assertLegacyAdmissionInTransaction(tx, firestore, 'publishing', { continuation: true });
  const control = await tx.get(firestore.doc(TEMPORAL_RELEASE_CONTROL_PATH));
  if (!control.exists) return;
  if (!Number.isSafeInteger(control.get('revision')) || control.get('revision') < 1)
    throw new HttpsError('failed-precondition', 'Provider event release control is invalid.');
  const cutoff = control.get('legacyAdmissionCutoff'),
    eventTime = parseProviderEventTime(event.time);
  if (cutoff !== undefined && (!validNativeTimestamp(cutoff) || !timestampAtOrBefore(eventTime, cutoff)))
    throw new HttpsError('unavailable', 'This provider event was not admitted before the compatibility cutoff.');
}

/**
 * One provider attempt per immutable platform event. A crash/unknown response cannot safely
 * be retried: its receipt and admission lease remain available for explicit reconciliation.
 * The lifetime lease covers the non-atomic gap between Firestore and provider transport.
 */
export async function runLegacyProviderListener(input: {
  firestore: Firestore;
  projectId: string;
  operation: 'sermonListOnDelete' | 'seriesItemOnWrite';
  entityPath: string;
  event: ProviderListenerEvent;
  /** Only the already admitted outer series listener may reuse its actual lifetime lease. */
  existingLease?: LegacyAdmissionLease;
  validateCurrent(transaction: Transaction): Promise<boolean>;
  effect(operationKey: string, verifyCurrent: () => Promise<boolean>): Promise<void | 'stale'>;
}): Promise<'completed' | 'duplicate' | 'stale'> {
  const { firestore, event } = input;
  if (!event.id || !validNativeTimestamp(event.sourceCreatedAt))
    throw new HttpsError('failed-precondition', 'The original provider event generation is required.');
  const eventTime = parseProviderEventTime(event.time);
  const identity = JSON.stringify([
    input.projectId,
    input.operation,
    input.entityPath,
    event.id,
    event.time,
    event.sourceCreatedAt.seconds,
    event.sourceCreatedAt.nanoseconds,
  ]);
  // Event id determines the document; the full immutable identity must agree on every retry.
  const receiptId = createHash('sha256')
    .update(JSON.stringify([input.projectId, input.operation, input.entityPath, event.id]))
    .digest('hex');
  const receipt = firestore.collection(LEGACY_PROVIDER_LISTENER_RECEIPTS).doc(receiptId);
  const headId = createHash('sha256')
    .update(JSON.stringify([input.projectId, input.operation, input.entityPath]))
    .digest('hex');
  const head = firestore.collection('legacyProviderListenerHeads').doc(headId);
  const run = async (lease: LegacyAdmissionLease): Promise<'completed' | 'duplicate' | 'stale'> => {
    const context = { lease, projectId: input.projectId, operation: input.operation };
    const assertCurrentAdmission = (tx: Transaction) =>
      assertProviderListenerEventInTransaction(tx, firestore, event, context);
    const claim = await firestore.runTransaction(async (tx) => {
      await assertActiveProviderListenerLease(tx, firestore, context);
      const [previous, activeHead] = await Promise.all([tx.get(receipt), tx.get(head)]);
      if (previous.exists) {
        if (previous.get('identity') !== identity)
          throw new HttpsError('failed-precondition', 'Provider event identity changed.');
        if (previous.get('state') === 'completed') return 'duplicate' as const;
        throw new HttpsError(
          'failed-precondition',
          'The original provider attempt needs reconciliation before retrying.'
        );
      }
      if (activeHead.exists && activeHead.get('state') !== 'completed')
        throw new HttpsError(
          'failed-precondition',
          'An earlier provider event for this resource needs reconciliation.'
        );
      await assertCurrentAdmission(tx);
      const current = await input.validateCurrent(tx);
      const previousTime = activeHead.get('eventTime');
      const obsolete =
        input.operation === 'sermonListOnDelete' &&
        validNativeTimestamp(previousTime) &&
        timestampAtOrBefore(eventTime, previousTime) &&
        (eventTime.seconds !== previousTime.seconds || eventTime.nanoseconds !== previousTime.nanoseconds);
      const record = {
        schemaVersion: 1,
        identity,
        projectId: input.projectId,
        operation: input.operation,
        entityPath: input.entityPath,
        eventId: event.id,
        leaseId: lease.leaseId,
      };
      // A stale event is acknowledged permanently, so it cannot revive after a recreated row
      // is subsequently deleted. A completed newer event also fences delayed older events.
      if (!current || obsolete) {
        tx.create(receipt, { ...record, state: 'completed', outcome: 'stale', completedAt: Date.now() });
        return 'stale' as const;
      }
      tx.set(head, { receiptId, state: 'started', leaseId: lease.leaseId, eventTime });
      tx.create(receipt, { ...record, state: 'started', startedAt: Date.now() });
      return 'claimed' as const;
    });
    if (claim !== 'claimed') return claim;
    try {
      // Await both the drain-visible marker and a fresh owner/barrier/canonical check.
      await lease.markEffectsStarted();
      const verifyCurrent = () =>
        firestore.runTransaction(async (tx) => {
          await assertCurrentAdmission(tx);
          return input.validateCurrent(tx);
        });
      const current = await verifyCurrent();
      const effectOutcome = current ? await input.effect(`provider-listener:${receiptId}`, verifyCurrent) : 'stale';
      const stale = !current || effectOutcome === 'stale';
      const completion = firestore.batch();
      completion.update(receipt, {
        state: 'completed',
        outcome: stale ? 'stale' : 'succeeded',
        completedAt: Date.now(),
      });
      completion.update(head, { state: 'completed' });
      await completion.commit();
      return stale ? 'stale' : 'completed';
    } catch (error) {
      const failure = firestore.batch();
      failure.update(receipt, { state: 'needs_attention', outcome: 'unknown', completedAt: Date.now() });
      failure.update(head, { state: 'needs_attention' });
      await failure.commit();
      throw error;
    }
  };
  if (input.existingLease) return run(input.existingLease);
  return withLegacyAdmissionLease(
    firestore,
    {
      projectId: input.projectId,
      domain: 'publishing',
      actorUid: 'system:firebase-event',
      operation: input.operation,
      continuation: true,
    },
    run
  );
}
