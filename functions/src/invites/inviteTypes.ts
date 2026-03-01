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

export const ROLE_INVITES_COLLECTION = 'roleInvites';
export const INVITE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

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
