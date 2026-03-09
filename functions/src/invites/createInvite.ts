import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import { buildInviteClaimUrl, queueInviteEmail } from './inviteEmail';
import { createInviteTokenArtifact } from './inviteToken';
import {
  CreateInviteInputType,
  CreateInviteResultData,
  INVITE_EXPIRY_MS,
  InviteClaimStatus,
  InviteEmailStatus,
  ROLE_INVITES_COLLECTION,
  isValidInviteEmail,
  normalizeInviteEmail,
  normalizeInviteRole,
} from './inviteTypes';

type CreateInviteOutputType = { status: 'success'; data: CreateInviteResultData } | { status: 'error'; error: string };

export const createInviteHandler = async (
  request: CallableRequest<CreateInviteInputType>
): Promise<CreateInviteOutputType> => {
  if (request.auth?.token.role !== 'admin' || !request.auth.uid) {
    return { status: 'error', error: 'Not Authorized' };
  }

  const normalizedEmail = normalizeInviteEmail(request.data?.email ?? '');
  if (!isValidInviteEmail(normalizedEmail)) {
    return { status: 'error', error: 'Invalid invite email.' };
  }

  const normalizedRole = normalizeInviteRole(request.data?.role ?? '');
  if (!normalizedRole) {
    return { status: 'error', error: 'Invalid invite role.' };
  }

  const { rawToken, tokenHash } = createInviteTokenArtifact();
  const createdAtMs = Date.now();
  const expiresAtMs = createdAtMs + INVITE_EXPIRY_MS;
  const createdByEmail =
    typeof request.auth.token.email === 'string' && request.auth.token.email.trim().length > 0
      ? normalizeInviteEmail(request.auth.token.email)
      : null;
  const inviteUrl = buildInviteClaimUrl(rawToken);

  const inviteRef = await firebaseAdmin.firestore().collection(ROLE_INVITES_COLLECTION).add({
    invitedEmail: normalizedEmail,
    invitedRole: normalizedRole,
    tokenHash,
    claimStatus: InviteClaimStatus.PENDING,
    createdByUid: request.auth.uid,
    createdByEmail,
    createdAtMs,
    expiresAtMs,
    email: {
      status: InviteEmailStatus.NOT_ATTEMPTED,
    },
  });

  const emailState = await queueInviteEmail({
    inviteId: inviteRef.id,
    invitedEmail: normalizedEmail,
    invitedRole: normalizedRole,
    inviteUrl,
    expiresAtMs,
  });

  await inviteRef.update({
    email: emailState,
  });

  return {
    status: 'success',
    data: {
      inviteId: inviteRef.id,
      inviteUrl,
      invitedEmail: normalizedEmail,
      invitedRole: normalizedRole,
      expiresAtMs,
      emailStatus: emailState.status,
    },
  };
};

const createInvite = onCall(createInviteHandler);

export default createInvite;
