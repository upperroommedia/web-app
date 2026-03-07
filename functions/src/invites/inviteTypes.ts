export const ROLE_PRECEDENCE = {
  user: 0,
  uploader: 1,
  publisher: 2,
  admin: 3,
} as const;

export type InviteRoleType = keyof typeof ROLE_PRECEDENCE;

export const INVITE_ROLES = ['user', 'uploader', 'publisher', 'admin'] as const;

export const InviteClaimStatus = {
  PENDING: 'PENDING',
  ROLE_PENDING: 'ROLE_PENDING',
  COMPLETE: 'COMPLETE',
  ROLE_FAILED: 'ROLE_FAILED',
} as const;

export type InviteClaimStatusType = (typeof InviteClaimStatus)[keyof typeof InviteClaimStatus];

export const InviteEmailStatus = {
  NOT_ATTEMPTED: 'NOT_ATTEMPTED',
  QUEUED: 'QUEUED',
  QUEUE_FAILED: 'QUEUE_FAILED',
} as const;

export type InviteEmailStatusType = (typeof InviteEmailStatus)[keyof typeof InviteEmailStatus];

export const InviteLifecycleStatus = {
  SENT: 'SENT',
  SEND_FAILED: 'SEND_FAILED',
  OPEN: 'OPEN',
  CLAIMING: 'CLAIMING',
  CLAIM_FAILED: 'CLAIM_FAILED',
  CLAIMED: 'CLAIMED',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
} as const;

export type InviteLifecycleStatusType = (typeof InviteLifecycleStatus)[keyof typeof InviteLifecycleStatus];

export const ROLE_INVITES_COLLECTION = 'roleInvites';
export const INVITE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const INVITE_EMAIL_ENQUEUE_FAILED = 'INVITE_EMAIL_ENQUEUE_FAILED' as const;

export interface InviteEmailState {
  status: InviteEmailStatusType;
  attemptedAtMs?: number;
  queueMailId?: string;
  queueErrorMessage?: string;
  warningCode?: typeof INVITE_EMAIL_ENQUEUE_FAILED;
}

export interface InviteDocument {
  invitedEmail: string;
  invitedRole: InviteRoleType;
  tokenHash: string;
  claimStatus: InviteClaimStatusType;
  createdByUid: string;
  createdByEmail?: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  claimedByUid?: string;
  claimedByEmail?: string;
  claimedAtMs?: number;
  roleAssignedAtMs?: number;
  roleFailureAtMs?: number;
  roleFailureMessage?: string;
  revokedAtMs?: number;
  revokedByUid?: string;
  revokedByEmail?: string | null;
  resentAtMs?: number;
  resentByInviteId?: string;
  resendOfInviteId?: string;
  email?: InviteEmailState;
}

export interface CreateInviteInputType {
  email: string;
  role: InviteRoleType;
}

export interface CreateInviteResultData {
  inviteId: string;
  inviteUrl: string;
  invitedEmail: string;
  invitedRole: InviteRoleType;
  expiresAtMs: number;
  emailStatus: InviteEmailStatusType;
}

export interface ClaimInviteInputType {
  token: string;
}

export interface ClaimInviteResultData {
  inviteId: string;
  invitedEmail: string;
  invitedRole: InviteRoleType;
  effectiveRole: InviteRoleType;
  claimStatus: typeof InviteClaimStatus.COMPLETE;
}

export interface ListInvitesInputType {
  limit?: number;
}

export interface InviteSummary {
  inviteId: string;
  invitedEmail: string;
  invitedRole: InviteRoleType;
  createdAtMs: number;
  createdByEmail?: string | null;
  expiresAtMs: number;
  claimStatus: InviteClaimStatusType;
  lifecycleStatus: InviteLifecycleStatusType;
  emailStatus: InviteEmailStatusType;
  inviteUrl?: string;
  claimedByEmail?: string;
  claimedAtMs?: number;
  revokedAtMs?: number;
  canRevoke: boolean;
  canResend: boolean;
}

export interface ListInvitesResultData {
  invites: InviteSummary[];
}

export interface RevokeInviteInputType {
  inviteId: string;
}

export interface RevokeInviteResultData {
  inviteId: string;
  revokedAtMs: number;
  lifecycleStatus: typeof InviteLifecycleStatus.REVOKED;
}

export interface ResendInviteInputType {
  inviteId: string;
}

export interface ResendInviteResultData extends CreateInviteResultData {
  resentFromInviteId: string;
}

export const normalizeInviteEmail = (email: string): string => email.trim().toLowerCase();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isValidInviteEmail = (email: string): boolean => EMAIL_REGEX.test(normalizeInviteEmail(email));

export const isSupportedInviteRole = (value: string): value is InviteRoleType =>
  (INVITE_ROLES as readonly string[]).includes(value);

export const normalizeInviteRole = (role: string): InviteRoleType | null => {
  const normalized = role.trim().toLowerCase();
  if (!isSupportedInviteRole(normalized)) {
    return null;
  }
  return normalized;
};

export const extractRoleClaim = (role: unknown): InviteRoleType | null => {
  if (typeof role !== 'string') {
    return null;
  }
  return normalizeInviteRole(role);
};

export const resolveHighestRole = (currentRole: InviteRoleType | null, invitedRole: InviteRoleType): InviteRoleType => {
  if (!currentRole) {
    return invitedRole;
  }
  return ROLE_PRECEDENCE[currentRole] >= ROLE_PRECEDENCE[invitedRole] ? currentRole : invitedRole;
};

export const isInviteRevoked = (invite: InviteDocument): boolean => typeof invite.revokedAtMs === 'number';

export const isInviteExpired = (invite: InviteDocument, nowMs = Date.now()): boolean =>
  typeof invite.expiresAtMs === 'number' && invite.expiresAtMs <= nowMs;

export const getInviteEmailStatus = (invite: InviteDocument): InviteEmailStatusType =>
  invite.email?.status ?? InviteEmailStatus.NOT_ATTEMPTED;

export const getInviteLifecycleStatus = (invite: InviteDocument, nowMs = Date.now()): InviteLifecycleStatusType => {
  if (isInviteRevoked(invite)) {
    return InviteLifecycleStatus.REVOKED;
  }
  if (invite.claimStatus === InviteClaimStatus.COMPLETE) {
    return InviteLifecycleStatus.CLAIMED;
  }
  if (isInviteExpired(invite, nowMs)) {
    return InviteLifecycleStatus.EXPIRED;
  }
  if (invite.claimStatus === InviteClaimStatus.ROLE_PENDING) {
    return InviteLifecycleStatus.CLAIMING;
  }
  if (invite.claimStatus === InviteClaimStatus.ROLE_FAILED) {
    return InviteLifecycleStatus.CLAIM_FAILED;
  }
  const emailStatus = getInviteEmailStatus(invite);
  if (emailStatus === InviteEmailStatus.QUEUED) {
    return InviteLifecycleStatus.SENT;
  }
  if (emailStatus === InviteEmailStatus.QUEUE_FAILED) {
    return InviteLifecycleStatus.SEND_FAILED;
  }
  return InviteLifecycleStatus.OPEN;
};
