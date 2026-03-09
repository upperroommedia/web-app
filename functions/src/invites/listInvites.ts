import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import {
  InviteClaimStatus,
  InviteDocument,
  InviteLifecycleStatus,
  ListInvitesInputType,
  ListInvitesResultData,
  ROLE_INVITES_COLLECTION,
  getInviteEmailStatus,
  getInviteLifecycleStatus,
  normalizeInviteRole,
} from './inviteTypes';

type ListInvitesOutputType = { status: 'success'; data: ListInvitesResultData } | { status: 'error'; error: string };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const resolveLimit = (rawLimit: unknown): number => {
  if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit)) {
    return DEFAULT_LIMIT;
  }
  const normalized = Math.floor(rawLimit);
  if (normalized < 1) {
    return 1;
  }
  if (normalized > MAX_LIMIT) {
    return MAX_LIMIT;
  }
  return normalized;
};

const isAdmin = (request: CallableRequest<unknown>): boolean =>
  request.auth?.token.role === 'admin' && typeof request.auth.uid === 'string';

export const listInvitesHandler = async (
  request: CallableRequest<ListInvitesInputType>
): Promise<ListInvitesOutputType> => {
  if (!isAdmin(request)) {
    return { status: 'error', error: 'Not Authorized' };
  }

  const limit = resolveLimit(request.data?.limit);
  const nowMs = Date.now();
  const snapshot = await firebaseAdmin
    .firestore()
    .collection(ROLE_INVITES_COLLECTION)
    .orderBy('createdAtMs', 'desc')
    .limit(limit)
    .get();

  const invites = snapshot.docs.flatMap((doc) => {
    const invite = doc.data() as InviteDocument;
    const invitedRole = normalizeInviteRole(invite.invitedRole ?? '');
    if (!invitedRole || typeof invite.invitedEmail !== 'string') {
      return [];
    }

    const lifecycleStatus = getInviteLifecycleStatus(invite, nowMs);

    return [
      {
        inviteId: doc.id,
        invitedEmail: invite.invitedEmail,
        invitedRole,
        createdAtMs: invite.createdAtMs ?? 0,
        createdByEmail: invite.createdByEmail,
        expiresAtMs: invite.expiresAtMs ?? 0,
        claimStatus: invite.claimStatus ?? InviteClaimStatus.PENDING,
        lifecycleStatus,
        emailStatus: getInviteEmailStatus(invite),
        claimedByEmail: invite.claimedByEmail,
        claimedAtMs: invite.claimedAtMs,
        revokedAtMs: invite.revokedAtMs,
        canRevoke:
          lifecycleStatus === InviteLifecycleStatus.OPEN ||
          lifecycleStatus === InviteLifecycleStatus.SENT ||
          lifecycleStatus === InviteLifecycleStatus.SEND_FAILED ||
          lifecycleStatus === InviteLifecycleStatus.CLAIMING ||
          lifecycleStatus === InviteLifecycleStatus.CLAIM_FAILED,
        canResend:
          lifecycleStatus === InviteLifecycleStatus.EXPIRED,
      },
    ];
  });

  return {
    status: 'success',
    data: {
      invites,
    },
  };
};

const listinvites = onCall(listInvitesHandler);

export default listinvites;
