import { createHash } from 'node:crypto';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { SearchProviderError } from './provider-session';

export interface SearchTaskReceipt {
  schemaVersion: 1;
  targetDigest: string;
  action: 'addObject' | 'deleteObject';
  objectId: string;
  taskID: number;
  sourceVersion: string;
  recordDigest?: string;
  requestedByJobId: string;
}
export interface ConfirmedSearchSave {
  schemaVersion: 1;
  confirmedForJobId: string;
  targetDigest: string;
  objectId: string;
  sourceVersion: string;
  recordDigest: string;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    );
  return value;
}
// Firestore maps need not preserve insertion order; task CAS compares semantic JSON values.
export const searchDigest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export function sourceVersion(snapshot: DocumentSnapshot): string {
  if (!snapshot.exists) return 'absent';
  const time = snapshot.updateTime;
  if (
    !time ||
    !Number.isSafeInteger(time.seconds) ||
    !Number.isInteger(time.nanoseconds) ||
    time.nanoseconds < 0 ||
    time.nanoseconds >= 1_000_000_000
  )
    throw new SearchProviderError('SearchSourceVersionInvalid', true);
  return `${time.seconds}:${time.nanoseconds}`;
}
function invalid(): never {
  throw new SearchProviderError('SearchTaskReceiptInvalid', true);
}
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const version = (value: unknown): value is string =>
  typeof value === 'string' && (value === 'absent' || /^-?\d+:\d{1,9}$/.test(value));
export function readSearchTask(value: unknown, targetDigest: string): SearchTaskReceipt | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const v = value as SearchTaskReceipt;
  if (
    v.schemaVersion !== 1 ||
    v.targetDigest !== targetDigest ||
    !digest(v.targetDigest) ||
    !['addObject', 'deleteObject'].includes(v.action) ||
    typeof v.objectId !== 'string' ||
    !v.objectId ||
    !Number.isSafeInteger(v.taskID) ||
    v.taskID < 0 ||
    !version(v.sourceVersion) ||
    typeof v.requestedByJobId !== 'string' ||
    !v.requestedByJobId ||
    (v.action === 'addObject'
      ? !digest(v.recordDigest) || v.sourceVersion === 'absent'
      : v.recordDigest !== undefined) ||
    Object.keys(v).some(
      (key) =>
        ![
          'schemaVersion',
          'targetDigest',
          'action',
          'objectId',
          'taskID',
          'sourceVersion',
          'recordDigest',
          'requestedByJobId',
        ].includes(key)
    )
  )
    return invalid();
  return v;
}
export function readConfirmedSearchSave(value: unknown, targetDigest: string): ConfirmedSearchSave | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const v = value as ConfirmedSearchSave;
  if (
    v.schemaVersion !== 1 ||
    typeof v.confirmedForJobId !== 'string' ||
    !v.confirmedForJobId ||
    !digest(v.targetDigest) ||
    typeof v.objectId !== 'string' ||
    !v.objectId ||
    !version(v.sourceVersion) ||
    v.sourceVersion === 'absent' ||
    !digest(v.recordDigest) ||
    Object.keys(v).some(
      (key) =>
        !['schemaVersion', 'confirmedForJobId', 'targetDigest', 'objectId', 'sourceVersion', 'recordDigest'].includes(
          key
        )
    )
  )
    return invalid();
  // Confirmed cache is only an optimization; a reviewed target/schema change requires a fresh write.
  return v.targetDigest === targetDigest ? v : undefined;
}
export function singleSearchTaskId(responses: Array<{ taskID: number }>): number {
  if (
    !Array.isArray(responses) ||
    responses.length !== 1 ||
    !Number.isSafeInteger(responses[0]?.taskID) ||
    responses[0].taskID < 0
  )
    return invalid();
  return responses[0].taskID;
}
