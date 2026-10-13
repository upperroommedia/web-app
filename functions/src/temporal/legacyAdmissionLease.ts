import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertLegacyAdmissionInTransaction, TEMPORAL_RELEASE_CONTROL_PATH } from './releaseControl';

export const LEGACY_ADMISSION_LEASES_COLLECTION = 'legacyAdmissionLeases';
export interface LegacyAdmissionLeaseRecord {
  schemaVersion: 1;
  leaseId: string;
  projectId: string;
  domain: string;
  actorUid: string;
  operation: string;
  state: 'active' | 'completed' | 'needs_attention';
  acquiredAt: number;
  heartbeatAt: number;
  diagnosticExpiresAt: number;
  releaseRevision: number;
  effectsStarted: boolean;
  completedAt?: number;
  outcome?: 'succeeded' | 'rejected_no_effect' | 'unknown';
  errorCode?: string;
}
export interface LegacyAdmissionLease {
  leaseId: string;
  /** Await immediately before the first mutation; never dispatch an effect before this acknowledgement. */
  markEffectsStarted(): Promise<void>;
  heartbeat(): Promise<void>;
}
export interface LegacyAdmissionLeaseOptions {
  domain: string;
  actorUid: string;
  operation: string;
  /** Only server continuations of already-admitted work may use this option. */
  continuation?: boolean;
  projectId: string;
  heartbeatIntervalMs?: number;
  diagnosticTimeoutMs?: number;
}
const safeCode = (error: unknown): string => {
  const code = error && typeof error === 'object' ? ('code' in error ? String(error.code) : 'UNKNOWN') : 'UNKNOWN';
  return /^[A-Za-z0-9_.:/-]{1,128}$/.test(code) ? code : 'UNKNOWN';
};
/**
 * Auth and input validation belong before this helper. Every accepted legacy invocation is
 * registered in the same control transaction, so it cannot become invisible during a pause.
 * An expired/crashed active lease is never treated as drained.
 */
export async function withLegacyAdmissionLease<T>(
  firestore: Firestore,
  options: LegacyAdmissionLeaseOptions,
  callback: (lease: LegacyAdmissionLease) => Promise<T>
): Promise<T> {
  if (!options.actorUid || !options.projectId || !options.operation || !options.domain)
    throw new HttpsError('invalid-argument', 'Legacy admission metadata is required.');
  const leaseId = `legacy-${randomUUID()}`,
    document = firestore.collection(LEGACY_ADMISSION_LEASES_COLLECTION).doc(leaseId),
    timeout = options.diagnosticTimeoutMs ?? 60000;
  await firestore.runTransaction(async (tx) => {
    await assertLegacyAdmissionInTransaction(tx, firestore, options.domain, { continuation: options.continuation });
    const control = await tx.get(firestore.doc(TEMPORAL_RELEASE_CONTROL_PATH));
    const now = Date.now();
    const record: LegacyAdmissionLeaseRecord = {
      schemaVersion: 1,
      leaseId,
      projectId: options.projectId,
      domain: options.domain,
      actorUid: options.actorUid,
      operation: options.operation,
      state: 'active',
      acquiredAt: now,
      heartbeatAt: now,
      diagnosticExpiresAt: now + timeout,
      releaseRevision: Number(control.get('revision') ?? 0),
      effectsStarted: false,
    };
    tx.create(document, record);
  });
  let finished = false;
  let effectsStarted = false;
  const heartbeat = async () => {
    if (finished) return;
    await firestore.runTransaction(async (tx) => {
      const current = await tx.get(document);
      if (!current.exists || current.get('state') !== 'active')
        throw new HttpsError('aborted', 'Legacy admission ownership changed.');
      tx.update(document, { heartbeatAt: Date.now(), diagnosticExpiresAt: Date.now() + timeout });
    });
  };
  const lease: LegacyAdmissionLease = {
    leaseId,
    heartbeat,
    async markEffectsStarted() {
      await firestore.runTransaction(async (tx) => {
        const current = await tx.get(document);
        if (!current.exists || current.get('state') !== 'active')
          throw new HttpsError('aborted', 'Legacy admission ownership changed.');
        tx.update(document, {
          effectsStarted: true,
          heartbeatAt: Date.now(),
          diagnosticExpiresAt: Date.now() + timeout,
        });
      });
      effectsStarted = true;
    },
  };
  const timer = setInterval(() => {
    void heartbeat().catch(() => {
      /* Retained active lease fails closed; no expiry-based recovery. */
    });
  }, options.heartbeatIntervalMs ?? 15000);
  timer.unref();
  let result: T | undefined,
    reportedFailure = false,
    failed = false,
    error: unknown;
  try {
    result = await callback(lease);
    const outcomes = Array.isArray(result) ? result : [result];
    reportedFailure = outcomes.some(
      (value) =>
        value &&
        typeof value === 'object' &&
        (['error', 'failed', 'failure', 'partial', 'partial_success'].includes(
          String(
            (value as Record<string, unknown>).status ?? (value as Record<string, unknown>).type ?? ''
          ).toLowerCase()
        ) ||
          (value as Record<string, unknown>).success === false ||
          (value as Record<string, unknown>).ok === false ||
          (value as Record<string, unknown>).error === true)
    );
  } catch (caught) {
    failed = true;
    error = caught;
  } finally {
    finished = true;
    clearInterval(timer);
    await firestore.runTransaction(async (tx) => {
      const current = await tx.get(document);
      if (!current.exists || current.get('state') !== 'active')
        throw new HttpsError('aborted', 'Legacy admission ownership changed before completion.');
      const uncertain = (failed || reportedFailure) && (effectsStarted || current.get('effectsStarted') === true);
      tx.update(document, {
        state: uncertain ? 'needs_attention' : 'completed',
        outcome: failed || reportedFailure ? (uncertain ? 'unknown' : 'rejected_no_effect') : 'succeeded',
        completedAt: Date.now(),
        heartbeatAt: Date.now(),
        ...(failed || reportedFailure ? { errorCode: failed ? safeCode(error) : 'LEGACY_ERROR_RESULT' } : {}),
      });
    });
  }
  if (failed) throw error;
  return result as T;
}
