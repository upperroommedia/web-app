import { createHash } from 'node:crypto';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type {
  DurableAdmissionRequest,
  DurableEntityRef,
  DurableJobKind,
  DurableJobRef,
} from '@upperroom/contracts/temporal';
import { createInviteTokenArtifact, hashInviteToken } from '../../invites/inviteToken';
import { buildInviteClaimUrl } from '../../invites/inviteEmail';
import {
  normalizeInviteEmail,
  normalizeInviteRole,
  isValidInviteEmail,
  ROLE_INVITES_COLLECTION,
  INVITE_EXPIRY_MS,
  InviteClaimStatus,
  InviteEmailStatus,
} from '../../invites/inviteTypes';
import { requireSquareImage, requireTrimmedSpeakerName } from '../../speakers/speakerMutations';
import { validateDenySpeakerRequestInput } from '../../speakerRequests/speakerRequestTypes';
import { assertAccountClaimsResourceAvailable } from './claimsResource';
import type { AccountIntent } from './types';

export interface AccountAdmissionPlan {
  kind: DurableJobKind;
  entity: DurableEntityRef;
  payload: AccountIntent;
  /** Private response to submitting client, never public job projection/history. */
  clientResult?: Record<string, unknown>;
  /** Invoke before createInTransaction: all reservation reads precede writes. */
  reserve(transaction: Transaction, ref: DurableJobRef): Promise<void>;
}
const bad = (message: string): never => {
  throw new HttpsError('invalid-argument', message);
};
const id = (value: unknown): string =>
  typeof value === 'string' && /^[^/]{1,512}$/.test(value.trim())
    ? value.trim()
    : bad('A valid request ID is required.');
const db = () => firebaseAdmin.firestore();

async function assertReservationAvailable(tx: Transaction, previousJobId: unknown, ref: DurableJobRef): Promise<void> {
  if (!previousJobId || previousJobId === ref.jobId) return;
  if (typeof previousJobId !== 'string') throw new HttpsError('aborted', 'Request reservation is invalid.');
  const previous = await tx.get(db().collection('durableJobs').doc(previousJobId));
  if (!previous.exists || !['cancelled', 'failed', 'superseded'].includes(previous.get('state')))
    throw new HttpsError('aborted', 'Request resolution already in progress.');
}

/** Only server-authenticated source records determine account targets and roles. */
export async function normalizeAccountAdmission(
  request: DurableAdmissionRequest,
  actorUid: string
): Promise<AccountAdmissionPlan> {
  const actor = await firebaseAdmin.auth().getUser(actorUid);
  if (actor.disabled) throw new HttpsError('permission-denied', 'Account is disabled.');
  const input = request.payload;
  if (request.kind === 'invite.claim') {
    if (typeof input.token !== 'string' || !input.token.trim() || input.token.length > 4096)
      bad('Invite token is required.');
    const tokenHash = hashInviteToken((input.token as string).trim());
    const query = db().collection(ROLE_INVITES_COLLECTION).where('tokenHash', '==', tokenHash).limit(1);
    const matches = await query.get();
    if (matches.empty) throw new HttpsError('not-found', 'Invite not found.');
    const target = matches.docs[0].ref;
    const expectedEmail = normalizeInviteEmail(actor.email ?? '');
    return {
      kind: request.kind,
      entity: { type: 'user', id: actor.uid },
      payload: { action: 'invite-claim', inviteId: target.id, claimantUid: actor.uid },
      async reserve(tx, ref) {
        const invite = (await tx.get(target)).data();
        if (
          !invite ||
          invite.tokenHash !== tokenHash ||
          normalizeInviteEmail(invite.invitedEmail ?? '') !== expectedEmail
        )
          throw new HttpsError('permission-denied', 'Invite does not belong to this account.');
        if (
          typeof invite.revokedAtMs === 'number' ||
          (invite.claimStatus !== InviteClaimStatus.COMPLETE &&
            (!Number.isFinite(invite.expiresAtMs) || invite.expiresAtMs <= Date.now()))
        )
          throw new HttpsError('failed-precondition', 'Invite is expired or revoked.');
        if (!normalizeInviteRole(invite.invitedRole)) bad('Invite role is invalid.');
        if (invite.claimedByUid && invite.claimedByUid !== actor.uid)
          throw new HttpsError('failed-precondition', 'Invite already claimed.');
        if (invite.claimStatus === InviteClaimStatus.COMPLETE) return;
        if (
          ![InviteClaimStatus.PENDING, InviteClaimStatus.ROLE_PENDING, InviteClaimStatus.ROLE_FAILED].includes(
            invite.claimStatus
          )
        )
          throw new HttpsError('failed-precondition', 'Invite already completed.');
        await assertReservationAvailable(tx, invite.temporalJobId, ref);
        await assertAccountClaimsResourceAvailable(tx, ref.projectId, actor.uid, ref.jobId);
        tx.update(target, {
          claimStatus: InviteClaimStatus.ROLE_PENDING,
          claimedByUid: actor.uid,
          claimedByEmail: expectedEmail,
          claimedAtMs: Date.now(),
          temporalJobId: ref.jobId,
        });
      },
    };
  }
  if (actor.customClaims?.role !== 'admin') throw new HttpsError('permission-denied', 'Admin authorization required.');
  if (request.kind === 'role.assign') {
    const targetUid = id(input.uid);
    const role = normalizeInviteRole(typeof input.role === 'string' ? input.role : '');
    if (!role) bad('A valid role is required.');
    await firebaseAdmin.auth().getUser(targetUid);
    const assignmentId = createHash('sha256').update(`${actor.uid}:${request.requestId}`).digest('hex');
    return {
      kind: request.kind,
      entity: { type: 'user', id: targetUid },
      payload: { action: 'role-assign', assignmentId, targetUid, role: role! },
      async reserve(tx, ref) {
        await assertAccountClaimsResourceAvailable(tx, ref.projectId, targetUid, ref.jobId);
        tx.create(db().collection('_durableAccountAssignments').doc(assignmentId), {
          targetUid,
          role,
          temporalJobId: ref.jobId,
        });
      },
    };
  }
  if (request.kind === 'role.resolve' || request.kind === 'speaker.resolve') {
    const isRole = request.kind === 'role.resolve';
    const requestId = id(input.requestId ?? (isRole ? input.roleRequestId : input.speakerRequestId));
    const decision = input.decision ?? input.action;
    if (decision !== 'accept' && decision !== 'deny') bad('Decision must be accept or deny.');
    const target = db()
      .collection(isRole ? 'roleRequests' : 'speakerRequests')
      .doc(requestId);
    const snapshot = await target.get();
    if (!snapshot.exists) throw new HttpsError('not-found', 'Request not found.');
    const source = snapshot.data()!;
    if (source.status !== 'pending') throw new HttpsError('failed-precondition', 'Request already resolved.');
    let payload: AccountIntent;
    if (isRole) {
      if (!normalizeInviteRole(source.requestedRole) || source.requestedRole === 'admin')
        bad('Requested role is invalid.');
      payload = { action: decision === 'accept' ? 'role-accept' : 'role-deny', requestId };
    } else if (decision === 'accept') {
      const speaker = input.speaker as
        | { name?: unknown; images?: unknown; description?: string; shortDescription?: string }
        | undefined;
      const name = requireTrimmedSpeakerName(speaker?.name);
      requireSquareImage(speaker?.images);
      payload = {
        action: 'speaker-accept',
        requestId,
        speaker: {
          name,
          images: speaker!.images as NonNullable<
            Extract<AccountIntent, { action: 'speaker-accept' | 'speaker-deny' }>['speaker']
          >['images'],
          ...(speaker?.description ? { description: speaker.description } : {}),
          ...(speaker?.shortDescription ? { shortDescription: speaker.shortDescription } : {}),
        },
        createSpeakerList: input.createSpeakerList === true,
      };
    } else {
      const validation = validateDenySpeakerRequestInput({
        speakerRequestId: requestId,
        message: input.message as string,
      });
      if (!validation.ok) bad(validation.error);
      payload = { action: 'speaker-deny', requestId, message: validation.ok ? validation.value.message : '' };
    }
    return {
      kind: request.kind,
      entity: { type: isRole ? 'user' : 'speaker', id: isRole ? id(source.requesterUid) : requestId },
      payload,
      async reserve(tx, ref) {
        const fresh = (await tx.get(target)).data();
        if (
          !fresh ||
          fresh.status !== 'pending' ||
          fresh.requesterUid !== source.requesterUid ||
          fresh.requestedRole !== source.requestedRole
        )
          throw new HttpsError('failed-precondition', 'Request changed; refresh and retry.');
        await assertReservationAvailable(tx, fresh.temporalJobId, ref);
        if (isRole && decision === 'accept')
          await assertAccountClaimsResourceAvailable(tx, ref.projectId, id(fresh.requesterUid), ref.jobId);
        tx.update(target, { temporalJobId: ref.jobId });
      },
    };
  }
  if (request.kind === 'invite.create' || request.kind === 'invite.resend') {
    let previous: FirebaseFirestore.DocumentReference | undefined;
    let invitedEmail = normalizeInviteEmail(typeof input.email === 'string' ? input.email : '');
    let invitedRole = normalizeInviteRole(typeof input.role === 'string' ? input.role : '');
    if (request.kind === 'invite.resend') {
      previous = db().collection(ROLE_INVITES_COLLECTION).doc(id(input.inviteId));
      const old = (await previous.get()).data();
      if (!old || old.claimStatus === InviteClaimStatus.COMPLETE || typeof old.revokedAtMs === 'number')
        throw new HttpsError('failed-precondition', 'Invite cannot be resent.');
      const mail = old.email?.queueMailId ? await db().collection('mail').doc(old.email.queueMailId).get() : undefined;
      if (old.expiresAtMs > Date.now() && mail?.get('delivery.state') !== 'ERROR')
        throw new HttpsError('failed-precondition', 'Only expired or delivery-failed invites can be resent.');
      invitedEmail = normalizeInviteEmail(old.invitedEmail ?? '');
      invitedRole = normalizeInviteRole(old.invitedRole ?? '');
    }
    if (!isValidInviteEmail(invitedEmail) || !invitedRole) bad('Valid invite email and role required.');
    const target = db().collection(ROLE_INVITES_COLLECTION).doc();
    const { rawToken, tokenHash } = createInviteTokenArtifact();
    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + INVITE_EXPIRY_MS;
    const inviteUrl = buildInviteClaimUrl(rawToken);
    return {
      kind: request.kind,
      entity: { type: 'user', id: target.id },
      payload: { action: 'invite-email', inviteId: target.id, inviteUrl },
      clientResult: { inviteId: target.id, inviteUrl, invitedEmail, invitedRole, expiresAtMs },
      async reserve(tx, ref) {
        if (previous) {
          const old = (await tx.get(previous)).data();
          if (
            !old ||
            old.claimStatus === InviteClaimStatus.COMPLETE ||
            typeof old.revokedAtMs === 'number' ||
            old.resentByInviteId
          )
            throw new HttpsError('failed-precondition', 'Invite changed; refresh and retry.');
          tx.update(previous, { resentAtMs: createdAtMs, resentByInviteId: target.id });
        }
        tx.create(target, {
          invitedEmail,
          invitedRole,
          tokenHash,
          claimStatus: InviteClaimStatus.PENDING,
          createdByUid: actor.uid,
          createdByEmail: actor.email ?? null,
          createdAtMs,
          expiresAtMs,
          temporalJobId: ref.jobId,
          email: { status: InviteEmailStatus.NOT_ATTEMPTED },
          ...(previous ? { resendOfInviteId: previous.id } : {}),
        });
      },
    };
  }
  throw new HttpsError('invalid-argument', 'Unsupported account operation.');
}
