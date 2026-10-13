import type { LegacyAdmissionLease } from '../temporal/legacyAdmissionLease';
import { isDomainTemporalEnabled } from '../temporal/ownership';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { CallableRequest, onCall } from 'firebase-functions/v2/https';
import handleError from '../handleError';
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
  request: CallableRequest<RevokeInviteInputType>,
  lease?: LegacyAdmissionLease
): Promise<RevokeInviteOutputType> => {
  try {
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

    const transactionResult = await firebaseAdmin.firestore().runTransaction(async (transaction) => {
      const control = await import('../temporal/releaseControl');
      if (isDomainTemporalEnabled('accounts'))
        await control.assertAdmissionReleaseInTransaction(transaction, firebaseAdmin.firestore(), 'invite.create');
      else
        await control.assertLegacyAdmissionInTransaction(transaction, firebaseAdmin.firestore(), 'accounts', {
          continuation: Boolean(lease),
        });
      const freshSnapshot = await transaction.get(inviteRef);
      if (!freshSnapshot.exists) return { error: 'Invite not found.' };
      const fresh = freshSnapshot.data() as InviteDocument & {
        temporalJobId?: string;
        temporalClaimsAppliedJobId?: string;
      };
      if (fresh.claimStatus === InviteClaimStatus.COMPLETE) return { error: 'Claimed invites cannot be revoked.' };
      if (fresh.claimStatus === InviteClaimStatus.ROLE_PENDING || fresh.claimStatus === InviteClaimStatus.ROLE_FAILED) {
        if (fresh.temporalClaimsAppliedJobId)
          return { error: 'The invited role has already been applied. Change the user role instead.' };
        const job = fresh.temporalJobId
          ? await transaction.get(firebaseAdmin.firestore().collection('durableJobs').doc(fresh.temporalJobId))
          : undefined;
        if (!job || !['cancelled', 'failed', 'superseded'].includes(job.get('state')))
          return { error: 'Invite claim is in progress. Wait for it to complete before changing access.' };
      }
      if (typeof fresh.revokedAtMs === 'number') return { revokedAtMs: fresh.revokedAtMs };
      await lease?.markEffectsStarted();
      transaction.update(inviteRef, { revokedAtMs, revokedByUid: request.auth?.uid, revokedByEmail });
      return { revokedAtMs };
    });
    if ('error' in transactionResult) return { status: 'error', error: transactionResult.error! };

    return {
      status: 'success',
      data: {
        inviteId,
        revokedAtMs: transactionResult.revokedAtMs,
        lifecycleStatus: InviteLifecycleStatus.REVOKED,
      },
    };
  } catch (error) {
    handleError(error, {
      alertCode: 'REVOKE_INVITE_RUNTIME_FAILURE',
      summary: 'revokeInvite failed while revoking an invite.',
      request,
      context: { functionName: 'revokeInvite', inviteId: request.data?.inviteId ?? null },
    });
    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

export const revokeInviteSource = async (
  request: CallableRequest<RevokeInviteInputType>
): Promise<RevokeInviteOutputType> => {
  if (isDomainTemporalEnabled('accounts') || !request.auth?.uid || request.auth.token.role !== 'admin')
    return revokeInviteHandler(request);
  return (await import('../temporal/accounts/sourceAdmission')).withLegacyAccountSource(
    firebaseAdmin.firestore(),
    request.auth.uid,
    'invite.revoke',
    (lease) => revokeInviteHandler(request, lease)
  );
};
const revokeinvite = onCall(revokeInviteSource);

export default revokeinvite;
