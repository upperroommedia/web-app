import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  assertAdministrativeIntegrationSetupInTransaction,
  assertLegacyAdmissionInTransaction,
  assertNewLegacyContinuationInTransaction,
  assertOriginalLegacySourceBoundaryInTransaction,
  TEMPORAL_RELEASE_CONTROL_PATH,
} from './releaseControl';

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
  legacySourceSermonId?: string;
  legacySourceOwnerUid?: string;
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
  /** Only the server create trigger can continue a canonical source admitted before pause. */
  legacySourceUpload?: {
    sermonId: string;
    uploaderId: string;
    sourceStartTime: number;
    trimDurationSeconds: number;
    youtubeUrl?: string;
  };
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
  return withAdmissionLease(firestore, options, callback, async (tx) => {
    const continuation = options.continuation || Boolean(options.legacySourceUpload);
    await assertLegacyAdmissionInTransaction(tx, firestore, options.domain, { continuation });
  });
}

/** One-time administrative OAuth grants stay synchronous, fenced and drain-visible under either owner. */
export async function withAdministrativeCredentialSetupLease<T>(
  firestore: Firestore,
  options: {
    actorUid: string;
    actorRole: unknown;
    operation: 'createSoundCloudAuthSession' | 'exchangeSoundCloudAuthCode' | 'setYouTubeCookies';
    projectId: string;
  },
  callback: (lease: LegacyAdmissionLease) => Promise<T>
): Promise<T> {
  if (
    options.actorRole !== 'admin' ||
    !options.actorUid ||
    options.actorUid.startsWith('system:') ||
    !['createSoundCloudAuthSession', 'exchangeSoundCloudAuthCode', 'setYouTubeCookies'].includes(options.operation)
  )
    throw new HttpsError('permission-denied', 'Only administrators may configure this integration.');
  const domain = options.operation === 'setYouTubeCookies' ? 'media' : 'accounts';
  return withAdmissionLease(firestore, { ...options, domain }, callback, (tx) =>
    assertAdministrativeIntegrationSetupInTransaction(tx, firestore, domain)
  );
}

async function withAdmissionLease<T>(
  firestore: Firestore,
  options: LegacyAdmissionLeaseOptions,
  callback: (lease: LegacyAdmissionLease) => Promise<T>,
  assertAdmission: (tx: import('firebase-admin/firestore').Transaction) => Promise<void>
): Promise<T> {
  if (!options.actorUid || !options.projectId || !options.operation || !options.domain)
    throw new HttpsError('invalid-argument', 'Legacy admission metadata is required.');
  const leaseId = `legacy-${randomUUID()}`,
    document = firestore.collection(LEGACY_ADMISSION_LEASES_COLLECTION).doc(leaseId),
    timeout = options.diagnosticTimeoutMs ?? 60000;
  await firestore.runTransaction(async (tx) => {
    const source = options.legacySourceUpload;
    if (
      source &&
      (options.domain !== 'media' ||
        options.actorUid !== 'system:firebase-event' ||
        options.operation !== 'sermonaudiocreatetrigger' ||
        !source.sermonId ||
        source.sermonId.includes('/') ||
        !source.uploaderId ||
        !Number.isFinite(source.sourceStartTime) ||
        source.sourceStartTime < 0 ||
        !Number.isFinite(source.trimDurationSeconds) ||
        source.trimDurationSeconds <= 0)
    )
      throw new HttpsError('permission-denied', 'Only the verified initial source trigger may continue this upload.');
    await assertAdmission(tx);
    const control = await tx.get(firestore.doc(TEMPORAL_RELEASE_CONTROL_PATH));
    if (source) {
      const sermon = await tx.get(firestore.doc(`sermons/${source.sermonId}`));
      if (
        !sermon.exists ||
        sermon.get('uploaderId') !== source.uploaderId ||
        sermon.get('status.audioStatus') !== 'PENDING' ||
        sermon.get('activeDurableJobs.upload') ||
        sermon.get('activeDurableJobs.audio') ||
        sermon.get('sourceStartTime') !== source.sourceStartTime ||
        sermon.get('trimDurationSeconds') !== source.trimDurationSeconds ||
        (sermon.get('youtubeUrl')?.trim() || undefined) !== source.youtubeUrl
      )
        throw new HttpsError(
          'aborted',
          'The previously admitted source is no longer pending with this owner and selection.'
        );
      await assertOriginalLegacySourceBoundaryInTransaction(tx, firestore, sermon);
    } else if (options.continuation) {
      await assertNewLegacyContinuationInTransaction(tx, firestore);
    }

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
      ...(source ? { legacySourceSermonId: source.sermonId, legacySourceOwnerUid: source.uploaderId } : {}),
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
