import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { FieldValue } from 'firebase-admin/firestore';
import type { DocumentData } from 'firebase-admin/firestore';
import { IdempotencyRecord } from './lockTypes';

const IDEMPOTENCY_COLLECTION = 'subsplashOperationKeys';

const sanitizeFirestoreValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeFirestoreValue(item))
      .filter((item) => item !== undefined);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, nestedValue]) => [key, sanitizeFirestoreValue(nestedValue)] as const)
        .filter(([, nestedValue]) => nestedValue !== undefined)
    );
  }

  return value === undefined ? undefined : value;
};

const getIdempotencyRef = (operationKey: string): ReturnType<ReturnType<typeof firebaseAdmin.firestore>['doc']> => {
  return firebaseAdmin.firestore().collection(IDEMPOTENCY_COLLECTION).doc(operationKey);
};

const parseIdempotencyRecord = (
  operationKey: string,
  value: DocumentData | undefined
): IdempotencyRecord | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const status = value.status;
  if (status !== 'in_progress' && status !== 'completed' && status !== 'failed') {
    return null;
  }

  const safeNow = Date.now();
  return {
    operationKey,
    status,
    result: value.result,
    failure: value.failure && typeof value.failure === 'object'
      ? {
        message: typeof value.failure.message === 'string' ? value.failure.message : 'Unknown error',
        code: typeof value.failure.code === 'string' ? value.failure.code : undefined,
        stack: typeof value.failure.stack === 'string' ? value.failure.stack : undefined,
      }
      : undefined,
    startedAtMs: typeof value.startedAtMs === 'number' ? value.startedAtMs : safeNow,
    updatedAtMs: typeof value.updatedAtMs === 'number' ? value.updatedAtMs : safeNow,
    completedAtMs: typeof value.completedAtMs === 'number' ? value.completedAtMs : undefined,
    failedAtMs: typeof value.failedAtMs === 'number' ? value.failedAtMs : undefined,
  };
};

const toFailurePayload = (error: unknown): NonNullable<IdempotencyRecord['failure']> => {
  if (error instanceof Error) {
    const maybeCode = (error as Error & { code?: unknown }).code;
    return {
      message: error.message,
      ...(typeof maybeCode === 'string' ? { code: maybeCode } : {}),
      ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
    };
  }

  if (typeof error === 'string') {
    return {
      message: error,
    };
  }

  return {
    message: 'Unknown error',
  };
};

export interface ClaimOperationResult {
  status: 'claimed' | 'in_progress' | 'completed' | 'failed';
  record: IdempotencyRecord;
}

export const claimOperation = async (operationKey: string): Promise<ClaimOperationResult> => {
  const ref = getIdempotencyRef(operationKey);
  const nowMs = Date.now();
  let claimResult: ClaimOperationResult | null = null;

  await firebaseAdmin.firestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const existingRecord = parseIdempotencyRecord(operationKey, snapshot.data());

    if (!snapshot.exists || !existingRecord) {
      const claimedRecord: IdempotencyRecord = {
        operationKey,
        status: 'in_progress',
        startedAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      transaction.set(ref, claimedRecord);
      claimResult = {
        status: 'claimed',
        record: claimedRecord,
      };
      return;
    }

    if (existingRecord.status === 'completed') {
      claimResult = {
        status: 'completed',
        record: existingRecord,
      };
      return;
    }

    if (existingRecord.status === 'in_progress') {
      claimResult = {
        status: 'in_progress',
        record: existingRecord,
      };
      return;
    }

    const retryRecord: IdempotencyRecord = {
      operationKey,
      status: 'in_progress',
      startedAtMs: nowMs,
      updatedAtMs: nowMs,
    };

    transaction.set(ref, {
      status: 'in_progress',
      startedAtMs: nowMs,
      updatedAtMs: nowMs,
      result: FieldValue.delete(),
      failure: FieldValue.delete(),
      completedAtMs: FieldValue.delete(),
      failedAtMs: FieldValue.delete(),
    }, { merge: true });

    claimResult = {
      status: 'claimed',
      record: retryRecord,
    };
  });

  if (!claimResult) {
    throw new Error(`Failed to claim operation key ${operationKey}.`);
  }

  return claimResult;
};

export const completeOperation = async (
  operationKey: string,
  result: unknown
): Promise<IdempotencyRecord> => {
  const nowMs = Date.now();
  const ref = getIdempotencyRef(operationKey);
  const sanitizedResult = sanitizeFirestoreValue(result);

  await ref.set({
    operationKey,
    status: 'completed',
    ...(sanitizedResult !== undefined ? { result: sanitizedResult } : { result: FieldValue.delete() }),
    updatedAtMs: nowMs,
    completedAtMs: nowMs,
    failure: FieldValue.delete(),
    failedAtMs: FieldValue.delete(),
  }, { merge: true });

  const snapshot = await ref.get();
  const record = parseIdempotencyRecord(operationKey, snapshot.data());
  if (!record) {
    throw new Error(`Completed operation ${operationKey} could not be reloaded.`);
  }

  return record;
};

export const markOperationFailed = async (
  operationKey: string,
  error: unknown
): Promise<IdempotencyRecord> => {
  const nowMs = Date.now();
  const ref = getIdempotencyRef(operationKey);
  const failurePayload = toFailurePayload(error);

  await ref.set({
    operationKey,
    status: 'failed',
    failure: failurePayload,
    updatedAtMs: nowMs,
    failedAtMs: nowMs,
    result: FieldValue.delete(),
    completedAtMs: FieldValue.delete(),
  }, { merge: true });

  const snapshot = await ref.get();
  const record = parseIdempotencyRecord(operationKey, snapshot.data());
  if (!record) {
    throw new Error(`Failed operation ${operationKey} could not be reloaded.`);
  }

  return record;
};

export const getOperationResult = async (
  operationKey: string
): Promise<IdempotencyRecord | null> => {
  const snapshot = await getIdempotencyRef(operationKey).get();
  if (!snapshot.exists) {
    return null;
  }

  return parseIdempotencyRecord(operationKey, snapshot.data());
};
