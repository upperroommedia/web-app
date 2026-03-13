import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import { DocumentData, FieldValue } from 'firebase-admin/firestore';
import { hashInviteToken } from './inviteToken';
import {
  ClaimInviteInputType,
  ClaimInviteResultData,
  InviteClaimStatus,
  InviteClaimStatusType,
  InviteDocument,
  ROLE_INVITES_COLLECTION,
  isInviteRevoked,
  normalizeInviteEmail,
  normalizeInviteRole,
} from './inviteTypes';
import handleError from '../handleError';

type ClaimInviteOutputType = { status: 'success'; data: ClaimInviteResultData } | { status: 'error'; error: string };

class InviteClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteClaimError';
  }
}

interface PendingClaimState {
  inviteId: string;
  invitedEmail: string;
  invitedRole: NonNullable<ReturnType<typeof normalizeInviteRole>>;
  isAlreadyClaimedByCurrentUser: boolean;
}

const isKnownClaimStatus = (value: unknown): value is InviteClaimStatusType =>
  value === InviteClaimStatus.PENDING ||
  value === InviteClaimStatus.ROLE_PENDING ||
  value === InviteClaimStatus.COMPLETE ||
  value === InviteClaimStatus.ROLE_FAILED;

const parseClaimableInvite = (value: DocumentData | undefined): InviteDocument => {
  if (!value || typeof value !== 'object') {
    throw new InviteClaimError('Invite not found.');
  }

  return value as InviteDocument;
};

export const claimInviteHandler = async (
  request: CallableRequest<ClaimInviteInputType>
): Promise<ClaimInviteOutputType> => {
  const claimantUid = request.auth?.uid;
  if (!claimantUid) {
    return { status: 'error', error: 'Unauthorized.' };
  }

  const claimantEmailRaw = request.auth?.token.email;
  if (typeof claimantEmailRaw !== 'string' || claimantEmailRaw.trim().length === 0) {
    return { status: 'error', error: 'Authenticated user is missing an email claim.' };
  }
  const claimantEmail = normalizeInviteEmail(claimantEmailRaw);

  const token = request.data?.token?.trim();
  if (!token) {
    return { status: 'error', error: 'Invite token is required.' };
  }

  const tokenHash = hashInviteToken(token);
  const firestore = firebaseAdmin.firestore();
  const auth = firebaseAdmin.auth();

  let pendingClaim: PendingClaimState;

  try {
    pendingClaim = await firestore.runTransaction(async (transaction) => {
      const inviteQuery = firestore.collection(ROLE_INVITES_COLLECTION).where('tokenHash', '==', tokenHash).limit(1);
      const inviteSnapshot = await transaction.get(inviteQuery);

      if (inviteSnapshot.empty) {
        throw new InviteClaimError('Invite not found.');
      }

      const inviteDoc = inviteSnapshot.docs[0];
      const invite = parseClaimableInvite(inviteDoc.data());
      const nowMs = Date.now();

      const invitedEmail = normalizeInviteEmail(invite.invitedEmail ?? '');
      if (invitedEmail !== claimantEmail) {
        throw new InviteClaimError(
          `Invite email does not match authenticated user. This invite is for ${invitedEmail}. Please sign in with that email.`
        );
      }

      if (isInviteRevoked(invite)) {
        throw new InviteClaimError('Invite has been revoked.');
      }

      if (typeof invite.expiresAtMs !== 'number' || invite.expiresAtMs <= nowMs) {
        throw new InviteClaimError('Invite has expired.');
      }

      const invitedRole = normalizeInviteRole(invite.invitedRole ?? '');
      if (!invitedRole) {
        throw new InviteClaimError('Invite role is invalid.');
      }

      if (!isKnownClaimStatus(invite.claimStatus)) {
        throw new InviteClaimError('Invite status is invalid.');
      }

      if (invite.claimStatus === InviteClaimStatus.COMPLETE) {
        const claimedByUid = typeof invite.claimedByUid === 'string' ? invite.claimedByUid : null;
        const claimedByEmail = typeof invite.claimedByEmail === 'string' ? normalizeInviteEmail(invite.claimedByEmail) : null;
        const isClaimedByCurrentUser =
          claimedByEmail === claimantEmail ||
          (claimedByEmail === null && claimedByUid === claimantUid);

        if (!isClaimedByCurrentUser) {
          throw new InviteClaimError('Invite has already been claimed by a different account.');
        }

        return {
          inviteId: inviteDoc.id,
          invitedEmail,
          invitedRole,
          isAlreadyClaimedByCurrentUser: true,
        };
      }

      if (invite.claimStatus === InviteClaimStatus.ROLE_PENDING || invite.claimStatus === InviteClaimStatus.ROLE_FAILED) {
        const claimedByUid = typeof invite.claimedByUid === 'string' ? invite.claimedByUid : null;
        const claimedByEmail = typeof invite.claimedByEmail === 'string' ? normalizeInviteEmail(invite.claimedByEmail) : null;

        if (claimedByUid !== claimantUid || claimedByEmail !== claimantEmail) {
          throw new InviteClaimError('Invite has already been claimed.');
        }
      }

      if (invite.claimStatus === InviteClaimStatus.PENDING) {
        transaction.update(inviteDoc.ref, {
          claimStatus: InviteClaimStatus.ROLE_PENDING,
          claimedByUid: claimantUid,
          claimedByEmail: claimantEmail,
          claimedAtMs: nowMs,
          roleFailureAtMs: FieldValue.delete(),
          roleFailureMessage: FieldValue.delete(),
        });
      }

      if (invite.claimStatus === InviteClaimStatus.ROLE_FAILED) {
        transaction.update(inviteDoc.ref, {
          claimStatus: InviteClaimStatus.ROLE_PENDING,
          roleFailureAtMs: FieldValue.delete(),
          roleFailureMessage: FieldValue.delete(),
        });
      }

      return {
        inviteId: inviteDoc.id,
        invitedEmail,
        invitedRole,
        isAlreadyClaimedByCurrentUser: false,
      };
    });
  } catch (error) {
    if (error instanceof InviteClaimError) {
      logger.warn('invite claim validation failed', {
        claimantUid,
        claimantEmail,
        reason: error.message,
      });
      return { status: 'error', error: error.message };
    }

    logger.error('invite claim validation failed unexpectedly', {
      claimantUid,
      claimantEmail,
      error: error instanceof Error ? error.message : String(error),
    });
    handleError(error, {
      alertCode: 'CLAIM_INVITE_VALIDATION_RUNTIME_FAILURE',
      summary: 'claimInvite failed while validating an invite claim.',
      context: { functionName: 'claimInvite', claimantUid },
    });
    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Failed to validate invite.',
    };
  }

  const inviteRef = firestore.collection(ROLE_INVITES_COLLECTION).doc(pendingClaim.inviteId);

  if (pendingClaim.isAlreadyClaimedByCurrentUser) {
    return {
      status: 'success',
      data: {
        inviteId: pendingClaim.inviteId,
        invitedEmail: pendingClaim.invitedEmail,
        invitedRole: pendingClaim.invitedRole,
        effectiveRole: pendingClaim.invitedRole,
        claimStatus: InviteClaimStatus.COMPLETE,
      },
    };
  }

  try {
    const user = await auth.getUser(claimantUid);
    const effectiveRole = pendingClaim.invitedRole;
    const mergedClaims = {
      ...(user.customClaims ?? {}),
      role: effectiveRole,
    };

    await auth.setCustomUserClaims(claimantUid, mergedClaims);
    await auth.revokeRefreshTokens(claimantUid);

    await inviteRef.update({
      claimStatus: InviteClaimStatus.COMPLETE,
      roleAssignedAtMs: Date.now(),
      roleFailureAtMs: FieldValue.delete(),
      roleFailureMessage: FieldValue.delete(),
    });

    return {
      status: 'success',
      data: {
        inviteId: pendingClaim.inviteId,
        invitedEmail: pendingClaim.invitedEmail,
        invitedRole: pendingClaim.invitedRole,
        effectiveRole,
        claimStatus: InviteClaimStatus.COMPLETE,
      },
    };
  } catch (error) {
    const roleFailureMessage = error instanceof Error ? error.message : String(error);
    logger.error('invite claim role assignment failed', {
      claimantUid,
      claimantEmail,
      inviteId: pendingClaim.inviteId,
      roleFailureMessage,
    });
    handleError(error, {
      alertCode: 'CLAIM_INVITE_ROLE_ASSIGNMENT_RUNTIME_FAILURE',
      summary: 'claimInvite failed while assigning the invited role.',
      context: { functionName: 'claimInvite', claimantUid, inviteId: pendingClaim.inviteId },
    });

    await inviteRef.update({
      claimStatus: InviteClaimStatus.ROLE_FAILED,
      roleFailureAtMs: Date.now(),
      roleFailureMessage,
    });

    return {
      status: 'error',
      error: `Role assignment failed: ${roleFailureMessage}`,
    };
  }
};

const claimInvite = onCall(claimInviteHandler);

export default claimInvite;
