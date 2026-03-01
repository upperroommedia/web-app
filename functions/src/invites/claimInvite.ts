import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import { hashInviteToken } from './inviteToken';
import {
  ClaimInviteInputType,
  ClaimInviteResultData,
  InviteClaimStatus,
  InviteClaimStatusType,
  InviteDocument,
  ROLE_INVITES_COLLECTION,
  extractRoleClaim,
  normalizeInviteEmail,
  normalizeInviteRole,
  resolveHighestRole,
} from './inviteTypes';

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
}

const isKnownClaimStatus = (value: unknown): value is InviteClaimStatusType =>
  value === InviteClaimStatus.PENDING ||
  value === InviteClaimStatus.ROLE_PENDING ||
  value === InviteClaimStatus.COMPLETE ||
  value === InviteClaimStatus.ROLE_FAILED;

const parseClaimableInvite = (value: FirebaseFirestore.DocumentData | undefined): InviteDocument => {
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
        throw new InviteClaimError('Invite email does not match authenticated user.');
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
        throw new InviteClaimError('Invite has already been claimed.');
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
          roleFailureAtMs: firebaseAdmin.firestore.FieldValue.delete(),
          roleFailureMessage: firebaseAdmin.firestore.FieldValue.delete(),
        });
      }

      if (invite.claimStatus === InviteClaimStatus.ROLE_FAILED) {
        transaction.update(inviteDoc.ref, {
          claimStatus: InviteClaimStatus.ROLE_PENDING,
          roleFailureAtMs: firebaseAdmin.firestore.FieldValue.delete(),
          roleFailureMessage: firebaseAdmin.firestore.FieldValue.delete(),
        });
      }

      return {
        inviteId: inviteDoc.id,
        invitedEmail,
        invitedRole,
      };
    });
  } catch (error) {
    if (error instanceof InviteClaimError) {
      return { status: 'error', error: error.message };
    }

    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Failed to validate invite.',
    };
  }

  const inviteRef = firestore.collection(ROLE_INVITES_COLLECTION).doc(pendingClaim.inviteId);

  try {
    const user = await auth.getUser(claimantUid);
    const currentRole = extractRoleClaim(user.customClaims?.role);
    const effectiveRole = resolveHighestRole(currentRole, pendingClaim.invitedRole);
    const mergedClaims = {
      ...(user.customClaims ?? {}),
      role: effectiveRole,
    };

    await auth.setCustomUserClaims(claimantUid, mergedClaims);
    await auth.revokeRefreshTokens(claimantUid);

    await inviteRef.update({
      claimStatus: InviteClaimStatus.COMPLETE,
      roleAssignedAtMs: Date.now(),
      roleFailureAtMs: firebaseAdmin.firestore.FieldValue.delete(),
      roleFailureMessage: firebaseAdmin.firestore.FieldValue.delete(),
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
