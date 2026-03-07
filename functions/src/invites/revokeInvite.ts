import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import {
  InviteClaimStatus,
  InviteDocument,
  InviteLifecycleStatus,
  RevokeInviteInputType,
  RevokeInviteResultData,
  ROLE_INVITES_COLLECTION,
  getInviteLifecycleStatus,
  normalizeInviteEmail,
} from './inviteTypes';

type RevokeInviteOutputType = { status: 'success'; data: RevokeInviteResultData } | { status: 'error'; error: string };

const isAdmin = (request: CallableRequest<unknown>): boolean =>
  request.auth?.token.role === 'admin' && typeof request.auth.uid === 'string';

export const revokeInviteHandler = async (
  request: CallableRequest<RevokeInviteInputType>
): Promise<RevokeInviteOutputType> => {
  if (!isAdmin(request)) {
    return { status: 'error', error: 'Not Authorized' };
  }

  const inviteId = request.data?.inviteId?.trim();
  if (!inviteId) {
    return { status: 'error', error: 'Invite id is required.' };
  }

  const inviteRef = firebaseAdmin.firestore().collection(ROLE_INVITES_COLLECTION).doc(inviteId);
  const inviteSnapshot = await inviteRef.get();
  if (!inviteSnapshot.exists) {
    return { status: 'error', error: 'Invite not found.' };
  }

  const invite = inviteSnapshot.data() as InviteDocument;
  if (invite.claimStatus === InviteClaimStatus.COMPLETE) {
    return { status: 'error', error: 'Claimed invites cannot be revoked.' };
  }

  const lifecycleStatus = getInviteLifecycleStatus(invite);
  if (lifecycleStatus === InviteLifecycleStatus.EXPIRED) {
    return { status: 'error', error: 'Invite is already expired. Use resend.' };
  }
  if (lifecycleStatus === InviteLifecycleStatus.REVOKED) {
    return {
      status: 'success',
      data: {
        inviteId,
        revokedAtMs: invite.revokedAtMs ?? Date.now(),
        lifecycleStatus: InviteLifecycleStatus.REVOKED,
      },
    };
  }

  const revokedAtMs = Date.now();
  const revokedByEmail =
    typeof request.auth?.token.email === 'string' ? normalizeInviteEmail(request.auth.token.email) : null;

  await inviteRef.update({
    revokedAtMs,
    revokedByUid: request.auth?.uid,
    revokedByEmail,
  });

  return {
    status: 'success',
    data: {
      inviteId,
      revokedAtMs,
      lifecycleStatus: InviteLifecycleStatus.REVOKED,
    },
  };
};

const revokeinvite = onCall(revokeInviteHandler);

export default revokeinvite;
