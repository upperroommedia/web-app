import type { DurableActivityExecution } from '@upperroom/orchestration/job-store';
import type { Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { CreateSpeakerCallableInputType } from '../../speakers/createSpeakerTypes';

/** Private admission payload. Never return these fields to a Workflow. */
export type AccountIntent =
  | { action: 'role-assign'; assignmentId: string; targetUid: string; role: string }
  | { action: 'role-accept' | 'role-deny'; requestId: string; message?: string }
  | {
      action: 'speaker-accept' | 'speaker-deny';
      requestId: string;
      speaker?: CreateSpeakerCallableInputType['speaker'];
      createSpeakerList?: boolean;
      message?: string;
    }
  | { action: 'invite-claim'; inviteId: string; claimantUid: string }
  | { action: 'invite-email'; inviteId: string; inviteUrl: string };
export interface PrivateAccountIntent {
  payload: AccountIntent;
  actorUid: string;
  createdAt: number;
}
export interface AccountStepResult {
  state: 'completed' | 'blocked' | 'needs_review';
  code?: string;
  receiptId?: string;
}
export interface AccountStore {
  loadIntent<T>(ref: DurableJobRef): Promise<{ payload: T; actorUid: string; createdAt: number }>;
  assertCurrent(ref: DurableJobRef): Promise<void>;
  getExecutionIdentity?(): DurableActivityExecution | undefined;
  assertCurrentInTransaction(tx: Transaction, ref: DurableJobRef): Promise<unknown>;
  getSourceStepIds?(): string[];
  markCritical?(ref: DurableJobRef, reasonCode: string): Promise<void>;
  recordStep(ref: DurableJobRef, step: string, state: AccountStepResult): Promise<void>;
}
export class AccountDomainError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
export function validateAccountIntent(input: unknown): AccountIntent {
  if (!input || typeof input !== 'object') throw new AccountDomainError('INVALID_ACCOUNT_INTENT');
  const value = input as Record<string, unknown>;
  const validId = (id: unknown): id is string =>
    typeof id === 'string' && id.length > 0 && id.length <= 512 && !id.includes('/');
  if (
    value.action === 'role-assign' &&
    validId(value.assignmentId) &&
    validId(value.targetUid) &&
    ['user', 'uploader', 'publisher', 'admin'].includes(String(value.role))
  )
    return value as unknown as AccountIntent;
  if (value.action === 'invite-claim' && validId(value.inviteId) && validId(value.claimantUid))
    return value as unknown as AccountIntent;
  if (value.action === 'invite-email' && validId(value.inviteId) && typeof value.inviteUrl === 'string')
    return value as unknown as AccountIntent;
  if (
    ['role-accept', 'role-deny', 'speaker-accept', 'speaker-deny'].includes(String(value.action)) &&
    validId(value.requestId)
  )
    return value as unknown as AccountIntent;
  throw new AccountDomainError('INVALID_ACCOUNT_INTENT');
}
