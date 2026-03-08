import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import { buildInviteClaimUrl, queueInviteEmail } from './inviteEmail';
import { createInviteTokenArtifact } from './inviteToken';
import {
  INVITE_EXPIRY_MS,
  InviteClaimStatus,
  InviteDocument,
  InviteEmailStatus,
  InviteLifecycleStatus,
  ResendInviteInputType,
  ResendInviteResultData,
  ROLE_INVITES_COLLECTION,
  getInviteLifecycleStatus,
  normalizeInviteEmail,
  normalizeInviteRole,
} from './inviteTypes';

type ResendInviteOutputType = { status: 'success'; data: ResendInviteResultData } | { status: 'error'; error: string };

const isAdmin = (request: CallableRequest<unknown>): boolean =>
  request.auth?.token.role === 'admin' && typeof request.auth.uid === 'string';

export const resendInviteHandler = async (
  request: CallableRequest<ResendInviteInputType>
): Promise<ResendInviteOutputType> => {
  if (!isAdmin(request)) {
    return { status: 'error', error: 'Not Authorized' };
  }

  const inviteId = request.data?.inviteId?.trim();
  if (!inviteId) {
    return { status: 'error', error: 'Invite id is required.' };
  }

  const invitesCollection = firebaseAdmin.firestore().collection(ROLE_INVITES_COLLECTION);
  const previousInviteSnapshot = await invitesCollection.doc(inviteId).get();
  if (!previousInviteSnapshot.exists) {
    return { status: 'error', error: 'Invite not found.' };
  }

  const previousInvite = previousInviteSnapshot.data() as InviteDocument;
  if (previousInvite.claimStatus === InviteClaimStatus.COMPLETE) {
    return { status: 'error', error: 'Claimed invites cannot be resent.' };
  }
  if (getInviteLifecycleStatus(previousInvite) !== InviteLifecycleStatus.EXPIRED) {
    return { status: 'error', error: 'Only expired invites can be resent.' };
  }

  const invitedEmail = normalizeInviteEmail(previousInvite.invitedEmail ?? '');
  const invitedRole = normalizeInviteRole(previousInvite.invitedRole ?? '');
  if (!invitedEmail || !invitedRole) {
    return { status: 'error', error: 'Invite data is invalid.' };
  }

  const { rawToken, tokenHash } = createInviteTokenArtifact();
  const createdAtMs = Date.now();
  const expiresAtMs = createdAtMs + INVITE_EXPIRY_MS;
  const createdByEmail =
    typeof request.auth?.token.email === 'string' ? normalizeInviteEmail(request.auth.token.email) : null;
  const inviteUrl = buildInviteClaimUrl(rawToken);

  const newInviteRef = await invitesCollection.add({
    invitedEmail,
    invitedRole,
    tokenHash,
    claimStatus: InviteClaimStatus.PENDING,
    createdByUid: request.auth?.uid,
    createdByEmail,
    createdAtMs,
    expiresAtMs,
    resendOfInviteId: inviteId,
    email: {
      status: InviteEmailStatus.NOT_ATTEMPTED,
    },
  });

  const emailState = await queueInviteEmail({
    inviteId: newInviteRef.id,
    invitedEmail,
    invitedRole,
    inviteUrl,
    expiresAtMs,
  });

  await Promise.all([
    newInviteRef.update({
      email: emailState,
    }),
    previousInviteSnapshot.ref.update({
      resentAtMs: createdAtMs,
      resentByInviteId: newInviteRef.id,
    }),
  ]);

  return {
    status: 'success',
    data: {
      inviteId: newInviteRef.id,
      inviteUrl,
      invitedEmail,
      invitedRole,
      expiresAtMs,
      emailStatus: emailState.status,
      resentFromInviteId: inviteId,
    },
  };
};

const resendinvite = onCall(resendInviteHandler);

export default resendinvite;
