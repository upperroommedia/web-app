import { ROLES } from '../../../context/types';
import { FunctionOutputType } from '../../../types/Function';
import { UserRoleType } from '../../../types/User';

export const ROLE_REQUEST_EMAIL_ENQUEUE_FAILED = 'ROLE_REQUEST_EMAIL_ENQUEUE_FAILED' as const;
export const ROLE_REQUESTS_COLLECTION = 'roleRequests' as const;
export const ROLE_REQUEST_STATUS_PENDING = 'pending' as const;

export const ROLE_REQUEST_NOTIFICATION_STATUSES = [
  'not_attempted',
  'queued',
  'queue_failed',
  'skipped_existing',
] as const;

export type RoleRequestNotificationStatus = (typeof ROLE_REQUEST_NOTIFICATION_STATUSES)[number];
export type RequestableRoleType = Exclude<UserRoleType, 'admin'>;

const REQUESTABLE_ROLE_VALUES = ROLES.filter((role): role is RequestableRoleType => role !== 'admin');
const REQUESTABLE_ROLE_SET = new Set<string>(REQUESTABLE_ROLE_VALUES);

const MAX_ROLE_REQUEST_REASON_LENGTH = 1_000;

export interface CreateRoleRequestInputType {
  requestedRole: string;
  reason: string;
}

export interface RoleRequestNotificationState {
  status: RoleRequestNotificationStatus;
  attemptedAtMs?: number;
  queueMailId?: string;
  queueErrorMessage?: string;
  warningCode?: string;
}

export interface PersistedRoleRequestDocument {
  requesterUid: string;
  requesterEmail: string;
  requesterDisplayName?: string;
  requestedRole: RequestableRoleType;
  reason: string;
  status: typeof ROLE_REQUEST_STATUS_PENDING;
  createdAtMs: number;
  updatedAtMs: number;
  adminUrl: string;
  notification: RoleRequestNotificationState;
}

export interface CreateRoleRequestSuccessData {
  roleRequestId: string;
  requestStatus: 'created' | 'existing';
  notification: RoleRequestNotificationState;
  warning?: {
    code: typeof ROLE_REQUEST_EMAIL_ENQUEUE_FAILED;
    message: string;
  };
}

export type CreateRoleRequestOutputType = FunctionOutputType<CreateRoleRequestSuccessData>;

export const isRequestableRole = (value: string): value is RequestableRoleType => REQUESTABLE_ROLE_SET.has(value);

export const sanitizeRoleRequestReason = (reason: string): string => reason.replace(/\s+/g, ' ').trim();

export const buildRoleRequestAdminUrl = (adminBaseUrl: string): string => {
  const trimmedBaseUrl = adminBaseUrl.replace(/\/+$/, '');
  return `${trimmedBaseUrl}/admin/users`;
};

export type CreateRoleRequestValidationResult =
  | {
      ok: true;
      value: {
        requestedRole: RequestableRoleType;
        reason: string;
      };
    }
  | {
      ok: false;
      error: string;
    };

export const validateCreateRoleRequestInput = (
  input: Partial<CreateRoleRequestInputType> | undefined
): CreateRoleRequestValidationResult => {
  const requestedRole = input?.requestedRole?.trim();
  if (!requestedRole || !isRequestableRole(requestedRole)) {
    return {
      ok: false,
      error: `Invalid requestedRole. Supported values: ${REQUESTABLE_ROLE_VALUES.join(', ')}`,
    };
  }

  const reason = sanitizeRoleRequestReason(input?.reason ?? '');
  if (!reason) {
    return { ok: false, error: 'Reason is required.' };
  }
  if (reason.length > MAX_ROLE_REQUEST_REASON_LENGTH) {
    return {
      ok: false,
      error: `Reason must be ${MAX_ROLE_REQUEST_REASON_LENGTH} characters or fewer.`,
    };
  }

  return {
    ok: true,
    value: {
      requestedRole,
      reason,
    },
  };
};
