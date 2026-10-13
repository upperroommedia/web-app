import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { Transaction } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import {
  normalizeInviteEmail,
  normalizeInviteRole,
  resolveHighestRole,
  extractRoleClaim,
  InviteClaimStatus,
  InviteEmailStatus,
  ROLE_INVITES_COLLECTION,
} from '../../invites/inviteTypes';
import { queueInviteEmail } from '../../invites/inviteEmail';
import { queueRoleRequestOutcomeEmail } from '../../roleRequests/queueRoleRequestOutcomeEmail';
import { queueSpeakerRequestOutcomeEmail } from '../../speakerRequests/queueSpeakerRequestOutcomeEmail';
import { createSpeakerMutation, requireSquareImage, requireTrimmedSpeakerName } from '../../speakers/speakerMutations';
import { listProviderReceiptsForJob } from '../publishing/providerReceipts';
import { withProviderIndexedTransaction } from '../../../../packages/orchestration/src/provider-transaction';
import {
  runDurablePublishingOperation,
  releaseCanonicalProviderBindingsForCurrentJob,
} from '../publishing/durableOperationContext';
import {
  ACCOUNT_CLAIMS_TRANSPORT,
  setAccountClaimsSingleShot,
  revokeAccountSessionsSingleShot,
  validateFrozenAccountClaims,
  isConfirmedAccountTransportRejection,
} from './authClaimsTransport';
import { accountClaimsResourceRef } from './claimsResource';
import { AccountDomainError, validateAccountIntent } from './types';
import type { AccountIntent, AccountStepResult, AccountStore } from './types';

const db = () => firebaseAdmin.firestore();
const accountRef = (intent: AccountIntent) => {
  if (intent.action === 'role-assign') return db().collection('_durableAccountAssignments').doc(intent.assignmentId);
  if (intent.action === 'invite-claim' || intent.action === 'invite-email')
    return db().collection(ROLE_INVITES_COLLECTION).doc(intent.inviteId);
  return db()
    .collection(intent.action.startsWith('role-') ? 'roleRequests' : 'speakerRequests')
    .doc(intent.requestId);
};
const desiredStatus = (intent: AccountIntent) => (intent.action.endsWith('-accept') ? 'accepted' : 'denied');

/** Activity boundary: only fixed state/error codes are returned to history. */
export function createAccountActivities(store: AccountStore) {
  const commitAccount = async <T>(ref: DurableJobRef, mutate: (tx: Transaction) => Promise<T>): Promise<T> =>
    db().runTransaction(async (tx) => {
      await store.assertCurrentInTransaction(tx, ref);
      return withProviderIndexedTransaction(tx, db(), ref.projectId, mutate);
    });
  const checkpoint = (ref: DurableJobRef, intent: AccountIntent, patch: Record<string, unknown>) =>
    commitAccount(ref, async (tx) => {
      tx.set(accountRef(intent), patch, { merge: true });
    });
  const load = async (ref: DurableJobRef, completionOnly = false) => {
    const stored = await store.loadIntent<AccountIntent>(ref);
    const intent = validateAccountIntent(stored.payload);
    await store.assertCurrent(ref);
    const actor = await firebaseAdmin.auth().getUser(stored.actorUid);

    if (intent.action === 'invite-claim') {
      if (actor.uid !== intent.claimantUid) throw new AccountDomainError('INVITE_CLAIMANT_MISMATCH');
    }
    const snapshot = await accountRef(intent).get();
    if (!snapshot.exists) throw new AccountDomainError('ACCOUNT_REQUEST_MISSING');
    const document = snapshot.data()!;
    const appliedClaims = document.temporalClaimsAppliedJobId === ref.jobId;
    const resolvedSource =
      document.temporalJobId === ref.jobId &&
      document.status === desiredStatus(intent) &&
      document.resolvedByUid === actor.uid;
    const createdSpeaker = intent.action === 'speaker-accept' && Boolean(document.temporalSpeakerResult);
    const restrictedCompletion = completionOnly && (appliedClaims || resolvedSource || createdSpeaker);
    if (actor.disabled && !restrictedCompletion) throw new AccountDomainError('ACCOUNT_PERMISSION_CHANGED');
    if (intent.action !== 'invite-claim' && actor.customClaims?.role !== 'admin') {
      const finishingOwnDemotion =
        intent.action === 'role-assign' &&
        intent.targetUid === actor.uid &&
        actor.customClaims?.role === intent.role &&
        document.temporalClaimsRequestedJobId === ref.jobId;
      if (!finishingOwnDemotion && !restrictedCompletion) throw new AccountDomainError('ACCOUNT_PERMISSION_CHANGED');
    }
    if (intent.action === 'invite-claim' || intent.action === 'invite-email') {
      if (typeof document.revokedAtMs === 'number') throw new AccountDomainError('INVITE_REVOKED');
      if (intent.action === 'invite-claim') {
        // A completed claim remains replayable after expiry, only by its original owner.
        if (
          document.claimedByUid !== actor.uid ||
          normalizeInviteEmail(document.invitedEmail) !== normalizeInviteEmail(actor.email ?? '')
        )
          throw new AccountDomainError('INVITE_CLAIMANT_MISMATCH');
        if (
          !restrictedCompletion &&
          document.claimStatus !== InviteClaimStatus.COMPLETE &&
          (!Number.isFinite(document.expiresAtMs) || document.expiresAtMs <= Date.now())
        )
          throw new AccountDomainError('INVITE_EXPIRED');
        if (!normalizeInviteRole(document.invitedRole)) throw new AccountDomainError('INVITE_ROLE_INVALID');
      } else if (
        !Number.isFinite(document.expiresAtMs) ||
        document.expiresAtMs <= Date.now() ||
        document.claimStatus !== InviteClaimStatus.PENDING
      )
        throw new AccountDomainError('INVITE_NO_LONGER_SENDABLE');
    } else {
      if (document.temporalJobId !== ref.jobId) throw new AccountDomainError('ACCOUNT_RESOLUTION_SUPERSEDED');
      if (intent.action !== 'role-assign' && document.status !== 'pending' && document.status !== desiredStatus(intent))
        throw new AccountDomainError('ACCOUNT_ALREADY_RESOLVED');
    }
    return { intent, actor, document, createdAt: stored.createdAt };
  };
  const step = async (ref: DurableJobRef, name: string, run: () => Promise<void>): Promise<AccountStepResult> => {
    try {
      await run();
      const result = { state: 'completed' as const };
      await store.recordStep(ref, name, result);
      return result;
    } catch (error) {
      const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
      if (
        details &&
        typeof details === 'object' &&
        'reason' in details &&
        details.reason === 'PROVIDER_RESULT_AMBIGUOUS'
      ) {
        const receiptId =
          'receiptId' in details && typeof details.receiptId === 'string' && /^[a-f0-9]{64}$/.test(details.receiptId)
            ? details.receiptId
            : undefined;
        const result: AccountStepResult = {
          state: 'needs_review',
          code: 'PROVIDER_CREATE_AMBIGUOUS',
          ...(receiptId ? { receiptId } : {}),
        };
        await store.recordStep(ref, name, result);
        return result;
      }
      if (!(error instanceof AccountDomainError)) throw error;
      const result = { state: 'blocked' as const, code: error.code };
      await store.recordStep(ref, name, result);
      return result;
    }
  };
  return {
    async reportAccountAttention(ref: DurableJobRef, failedStep: string): Promise<AccountStepResult> {
      const receipts = failedStep === 'speaker' ? await listProviderReceiptsForJob(ref) : [];
      const unknown = receipts.find(
        (value) => value.receipt.state === 'executing' || value.receipt.state === 'needs_review'
      );
      const result: AccountStepResult = unknown
        ? { state: 'needs_review', code: 'PROVIDER_CREATE_AMBIGUOUS', receiptId: unknown.receiptId }
        : { state: 'needs_review', code: 'ACCOUNT_ACTIVITY_FAILED' };
      await store.recordStep(ref, failedStep, result);
      return result;
    },
    validateAccountOperation: (ref: DurableJobRef) =>
      step(ref, 'validate', async () => {
        await load(ref);
      }),
    applyAccountClaims: (ref: DurableJobRef) =>
      step(ref, 'claims', async () => {
        const { intent, actor, document } = await load(ref, true);
        if (intent.action !== 'role-accept' && intent.action !== 'invite-claim' && intent.action !== 'role-assign')
          return;
        if (intent.action === 'invite-claim' && document.claimStatus === InviteClaimStatus.COMPLETE) return;
        if (document.temporalClaimsAppliedJobId === ref.jobId) return;
        if (intent.action === 'invite-claim' && document.temporalClaimsAppliedJobId) {
          // A reviewed takeover completes the consumed grant; it cannot restore
          // an old privilege after a later administrator role change.
          await checkpoint(ref, intent, { temporalClaimsAppliedJobId: ref.jobId });
          return;
        }
        if (
          intent.action !== 'invite-claim' &&
          actor.customClaims?.role !== 'admin' &&
          !(
            intent.action === 'role-assign' &&
            intent.targetUid === actor.uid &&
            actor.customClaims?.role === intent.role &&
            document.temporalClaimsRequestedJobId === ref.jobId
          )
        )
          throw new AccountDomainError('ACCOUNT_PERMISSION_CHANGED');
        const uid =
          intent.action === 'invite-claim'
            ? intent.claimantUid
            : intent.action === 'role-assign'
            ? intent.targetUid
            : document.requesterUid;
        const role =
          intent.action === 'invite-claim'
            ? normalizeInviteRole(document.invitedRole)
            : normalizeInviteRole(intent.action === 'role-assign' ? intent.role : document.requestedRole);
        if (!role) throw new AccountDomainError('ACCOUNT_ROLE_INVALID');
        const user = await firebaseAdmin.auth().getUser(uid);
        if (user.disabled) throw new AccountDomainError('ACCOUNT_TARGET_DISABLED');
        // Freeze the exact merged claims under the same generation/execution fence
        // that acquires the UID resource. A timed-out RPC never loses this owner.
        const effectiveRole =
          intent.action === 'invite-claim' ? resolveHighestRole(extractRoleClaim(user.customClaims?.role), role) : role;
        const resourceRef = accountClaimsResourceRef(ref.projectId, uid);
        const frozenClaims = { ...user.customClaims, role: effectiveRole, temporalAccountClaimJobId: ref.jobId };
        const needsMutation = user.customClaims?.role !== effectiveRole;
        if (needsMutation) {
          try {
            validateFrozenAccountClaims({ ...frozenClaims, temporalAccountSessionOperationId: '0'.repeat(36) });
          } catch {
            throw new AccountDomainError('ACCOUNT_CLAIMS_PAYLOAD_INVALID');
          }
        }
        const execution = store.getExecutionIdentity?.();
        if (needsMutation && !execution) throw new AccountDomainError('ACCOUNT_EXECUTION_WITNESS_REQUIRED');
        // Permission may have changed while the target Auth lookup was pending.
        const currentActor = await firebaseAdmin.auth().getUser(actor.uid);
        if (
          currentActor.disabled ||
          (intent.action !== 'invite-claim' && currentActor.customClaims?.role !== 'admin' && needsMutation)
        )
          throw new AccountDomainError('ACCOUNT_PERMISSION_CHANGED');
        await commitAccount(ref, async (tx) => {
          const resource = (await tx.get(resourceRef)).data();
          if (
            resource?.state === 'started' ||
            (resource?.jobId !== ref.jobId && ['pending', 'started'].includes(resource?.sessionState))
          )
            throw new AccountDomainError('ACCOUNT_CLAIMS_RECONCILIATION_REQUIRED');
          tx.set(
            accountRef(intent),
            {
              temporalClaimsRequestedJobId: ref.jobId,
              temporalRequestedRole: effectiveRole,
            },
            { merge: true }
          );
          if (needsMutation)
            tx.set(resourceRef, {
              projectId: ref.projectId,
              uid,
              jobId: ref.jobId,
              state: 'started',
              transport: ACCOUNT_CLAIMS_TRANSPORT,
              ...(execution ? { execution } : {}),
              claims: { ...user.customClaims, role: effectiveRole, temporalAccountClaimJobId: ref.jobId },
              sessionCutoffSeconds: resource?.sessionCutoffSeconds ?? '0',
            });
        });
        if (needsMutation) {
          let requestMayHaveBeenSent = false;
          try {
            await setAccountClaimsSingleShot(
              ref.projectId,
              uid,
              {
                ...user.customClaims,
                role: effectiveRole,
                temporalAccountClaimJobId: ref.jobId,
              },
              async () => {
                // Credentials may refresh asynchronously. Reauthorize only the
                // unsent grant immediately after that wait, then fence its epoch.
                const sender = await firebaseAdmin.auth().getUser(actor.uid);
                if (sender.disabled || (intent.action !== 'invite-claim' && sender.customClaims?.role !== 'admin'))
                  throw new AccountDomainError('ACCOUNT_PERMISSION_CHANGED');
                await store.assertCurrent(ref);
                requestMayHaveBeenSent = true;
              }
            );
          } catch (error) {
            const rejected = isConfirmedAccountTransportRejection(error);
            if (!requestMayHaveBeenSent || rejected) {
              // Positive local proof: the transport never reached fetch. Release
              // only this exact attempt's reservation, including after supersession.
              await db().runTransaction(async (tx) => {
                const resource = (await tx.get(resourceRef)).data();
                if (
                  resource?.state === 'started' &&
                  resource.jobId === ref.jobId &&
                  JSON.stringify(resource.execution) === JSON.stringify(execution)
                )
                  tx.update(
                    resourceRef,
                    rejected
                      ? { state: 'rejected_no_effect', rejectionCode: error.rejectionCode }
                      : { state: 'cancelled_no_effect', noRequestIssued: true }
                  );
              });
            }
            if (rejected) throw new AccountDomainError('ACCOUNT_MUTATION_REJECTED');
            throw error;
          }
        }
        await commitAccount(ref, async (tx) => {
          const resource = (await tx.get(resourceRef)).data();
          if (needsMutation && (resource?.jobId !== ref.jobId || resource.state !== 'started'))
            throw new AccountDomainError('ACCOUNT_CLAIMS_RECONCILIATION_REQUIRED');
          tx.set(
            resourceRef,
            {
              projectId: ref.projectId,
              uid,
              jobId: ref.jobId,
              state: 'applied',
              sessionState: 'pending',
              sessionCutoffSeconds: String(
                Math.max(Math.floor(Date.now() / 1000), Number(resource?.sessionCutoffSeconds ?? 0))
              ),
            },
            { merge: true }
          );
          tx.set(accountRef(intent), { temporalClaimsAppliedJobId: ref.jobId }, { merge: true });
        });
      }),
    revokeAccountSessions: (ref: DurableJobRef) =>
      step(ref, 'sessions', async () => {
        const { intent, document } = await load(ref, true);
        if (intent.action !== 'role-accept' && intent.action !== 'invite-claim' && intent.action !== 'role-assign')
          return;
        if (intent.action === 'invite-claim' && document.claimStatus === InviteClaimStatus.COMPLETE) return;
        if (document.temporalClaimsAppliedJobId !== ref.jobId)
          throw new AccountDomainError('ACCOUNT_CLAIMS_NOT_APPLIED');
        if (document.temporalSessionsRevokedJobId === ref.jobId) return;
        const uid =
          intent.action === 'invite-claim'
            ? intent.claimantUid
            : intent.action === 'role-assign'
            ? intent.targetUid
            : document.requesterUid;
        const execution = store.getExecutionIdentity?.();
        if (!execution) throw new AccountDomainError('ACCOUNT_EXECUTION_WITNESS_REQUIRED');
        const resourceRef = accountClaimsResourceRef(ref.projectId, uid);
        const targetUser = await firebaseAdmin.auth().getUser(uid);
        const candidateBaseClaims = JSON.parse(JSON.stringify(targetUser.customClaims ?? {})) as Record<
          string,
          unknown
        >;
        const candidateOperationId = randomUUID();
        let cutoffSeconds!: string;
        let sessionClaims!: Record<string, unknown>;
        let sessionBaseClaims!: Record<string, unknown>;
        let alreadyApplied = false;
        await commitAccount(ref, async (tx) => {
          const resource = (await tx.get(resourceRef)).data();
          if (resource?.sessionState === 'started')
            throw new AccountDomainError('ACCOUNT_SESSIONS_RECONCILIATION_REQUIRED');
          if (resource && resource.jobId !== ref.jobId && ['pending', 'started'].includes(resource.sessionState))
            throw new AccountDomainError('ACCOUNT_SESSIONS_RECONCILIATION_REQUIRED');
          alreadyApplied = resource?.jobId === ref.jobId && resource.sessionState === 'applied';
          cutoffSeconds =
            resource?.jobId === ref.jobId && resource.sessionCutoffSeconds
              ? resource.sessionCutoffSeconds
              : String(Math.max(Math.floor(Date.now() / 1000), Number(resource?.sessionCutoffSeconds ?? 0)));
          const sameOperation = resource?.jobId === ref.jobId && resource.sessionOperationId && resource.sessionClaims;
          const sessionOperationId = sameOperation ? resource.sessionOperationId : candidateOperationId;
          sessionBaseClaims = sameOperation ? resource.sessionBaseClaims : candidateBaseClaims;
          sessionClaims = sameOperation
            ? resource.sessionClaims
            : { ...candidateBaseClaims, temporalAccountSessionOperationId: sessionOperationId };
          if (!alreadyApplied) {
            if (!sessionBaseClaims) throw new AccountDomainError('ACCOUNT_SESSIONS_RECONCILIATION_REQUIRED');
            try {
              validateFrozenAccountClaims(sessionClaims);
            } catch {
              throw new AccountDomainError('ACCOUNT_CLAIMS_PAYLOAD_INVALID');
            }
            tx.set(
              resourceRef,
              {
                projectId: ref.projectId,
                uid,
                jobId: ref.jobId,
                sessionState: 'started',
                sessionCutoffSeconds: cutoffSeconds,
                sessionExecution: execution,
                sessionClaims,
                sessionBaseClaims,
                sessionOperationId,
                sessionTransport: ACCOUNT_CLAIMS_TRANSPORT,
              },
              { merge: true }
            );
          }
        });
        if (!alreadyApplied) {
          let requestMayHaveBeenSent = false;
          try {
            await revokeAccountSessionsSingleShot(ref.projectId, uid, cutoffSeconds, sessionClaims, async () => {
              // Re-check the source's actual-grant proof after credential refresh.
              // A demoted approving actor may complete only this grant's cleanup.
              await load(ref, true);
              const target = await firebaseAdmin.auth().getUser(uid);
              if (!isDeepStrictEqual({ ...target.customClaims }, sessionBaseClaims))
                throw new AccountDomainError('ACCOUNT_SESSION_CLAIMS_CHANGED');
              await store.assertCurrent(ref);
              requestMayHaveBeenSent = true;
            });
          } catch (error) {
            const rejected = isConfirmedAccountTransportRejection(error);
            if (!requestMayHaveBeenSent || rejected)
              await db().runTransaction(async (tx) => {
                const resource = (await tx.get(resourceRef)).data();
                if (
                  resource?.jobId === ref.jobId &&
                  resource.sessionState === 'started' &&
                  JSON.stringify(resource.sessionExecution) === JSON.stringify(execution)
                )
                  tx.update(
                    resourceRef,
                    rejected
                      ? { sessionState: 'rejected_no_effect', sessionRejectionCode: error.rejectionCode }
                      : { sessionState: 'cancelled_no_effect', sessionNoRequestIssued: true }
                  );
              });
            if (rejected) throw new AccountDomainError('ACCOUNT_MUTATION_REJECTED');
            throw error;
          }
        }
        await commitAccount(ref, async (tx) => {
          const resource = (await tx.get(resourceRef)).data();
          if (resource?.jobId !== ref.jobId || !['started', 'applied'].includes(resource.sessionState))
            throw new AccountDomainError('ACCOUNT_SESSIONS_RECONCILIATION_REQUIRED');
          tx.update(resourceRef, { sessionState: 'applied' });
          tx.set(accountRef(intent), { temporalSessionsRevokedJobId: ref.jobId }, { merge: true });
        });
      }),
    createAccountSpeaker: (ref: DurableJobRef) =>
      step(ref, 'speaker', async () => {
        const { intent, actor, document } = await load(ref, true);
        if (intent.action !== 'speaker-accept' || document.temporalSpeakerResult) return;
        if (actor.disabled || actor.customClaims?.role !== 'admin')
          throw new AccountDomainError('ACCOUNT_PERMISSION_CHANGED');
        if (!intent.speaker) throw new AccountDomainError('SPEAKER_PAYLOAD_MISSING');
        requireTrimmedSpeakerName(intent.speaker.name);
        requireSquareImage(intent.speaker.images);
        const result = await runDurablePublishingOperation(
          ref.jobId,
          async () => {
            const result = await createSpeakerMutation({
              speaker: intent.speaker!,
              createSpeakerList: intent.createSpeakerList,
              operationKey: `durable:${ref.projectId}:${ref.jobId}:speaker-request:${intent.requestId}`,
            });
            await releaseCanonicalProviderBindingsForCurrentJob();
            return result;
          },
          (mutate) => commitAccount(ref, mutate),
          {
            getSourceStepIds: store.getSourceStepIds,
            markCritical: store.markCritical ? (reasonCode) => store.markCritical!(ref, reasonCode) : undefined,
          }
        );
        // Existing mutation has its own idempotent provider receipts. A retry never
        // synthesizes a new operation key or creates another external speaker.
        await checkpoint(ref, intent, { temporalSpeakerResult: result });
      }),
    resolveAccountDocument: (ref: DurableJobRef) =>
      step(ref, 'resolve', async () => {
        const { intent, actor, createdAt } = await load(ref, true);
        if (intent.action === 'invite-email') return;
        if (
          intent.action === 'invite-claim' &&
          (await accountRef(intent).get()).get('claimStatus') === InviteClaimStatus.COMPLETE
        )
          return;
        await commitAccount(ref, async (tx) => {
          const target = accountRef(intent);
          const document = (await tx.get(target)).data()!;
          if (intent.action === 'role-assign') {
            if (document.temporalSessionsRevokedJobId !== ref.jobId)
              throw new AccountDomainError('ACCOUNT_SESSIONS_NOT_REVOKED');
            tx.update(target, { status: 'completed', completedAtMs: createdAt });
          } else if (intent.action === 'invite-claim') {
            if (document.claimedByUid !== intent.claimantUid || typeof document.revokedAtMs === 'number')
              throw new AccountDomainError('INVITE_CLAIMANT_MISMATCH');
            if (document.temporalSessionsRevokedJobId !== ref.jobId)
              throw new AccountDomainError('ACCOUNT_SESSIONS_NOT_REVOKED');
            tx.update(target, {
              claimStatus: InviteClaimStatus.COMPLETE,
              roleAssignedAtMs: createdAt,
              roleFailureAtMs: FieldValue.delete(),
              roleFailureMessage: FieldValue.delete(),
            });
          } else {
            if (document.temporalJobId !== ref.jobId) throw new AccountDomainError('ACCOUNT_RESOLUTION_SUPERSEDED');
            if (intent.action === 'role-accept' && document.temporalSessionsRevokedJobId !== ref.jobId)
              throw new AccountDomainError('ACCOUNT_SESSIONS_NOT_REVOKED');
            const speaker = document.temporalSpeakerResult;
            if (intent.action === 'speaker-accept' && !speaker)
              throw new AccountDomainError('ACCOUNT_SPEAKER_NOT_CREATED');
            tx.update(target, {
              status: desiredStatus(intent),
              updatedAtMs: createdAt,
              resolvedAtMs: createdAt,
              resolvedByUid: actor.uid,
              resolvedByEmail: actor.email ?? null,
              ...(speaker ? { speakerId: speaker.speakerId, speakerNameAtResolution: speaker.speaker.name } : {}),
              ...(intent.action === 'speaker-deny' ? { declineMessage: intent.message ?? '' } : {}),
            });
          }
        });
      }),
    notifyAccountOutcome: (ref: DurableJobRef) =>
      step(ref, 'notification', async () =>
        runDurablePublishingOperation(
          ref.jobId,
          async () => {
            const { intent, actor, document, createdAt } = await load(ref, true);
            if (intent.action === 'invite-claim' || intent.action === 'role-assign') return;
            const idempotencyKey = `account:${ref.jobId}:notification`;
            if (intent.action === 'invite-email') {
              const email = await queueInviteEmail({
                inviteId: intent.inviteId,
                invitedEmail: document.invitedEmail,
                invitedRole: document.invitedRole,
                inviteUrl: intent.inviteUrl,
                expiresAtMs: document.expiresAtMs,
                idempotencyKey,
                temporalParentJobRef: ref,
              });
              if (email.status === InviteEmailStatus.QUEUE_FAILED) throw new Error('ACCOUNT_EMAIL_ENQUEUE_FAILED');
              await checkpoint(ref, intent, { email });
              return;
            }
            const common = {
              requesterEmail: document.requesterEmail,
              status: desiredStatus(intent) as 'accepted' | 'denied',
              resolvedByUid: actor.uid,
              resolvedByEmail: actor.email ?? null,
              resolvedAtMs: createdAt,
              idempotencyKey,
              temporalParentJobRef: ref,
            };
            const result =
              intent.action === 'role-accept' || intent.action === 'role-deny'
                ? await queueRoleRequestOutcomeEmail({
                    ...common,
                    roleRequestId: intent.requestId,
                    requestedRole: document.requestedRole,
                  })
                : await queueSpeakerRequestOutcomeEmail({
                    ...common,
                    speakerRequestId: intent.requestId,
                    speakerName: document.speakerName,
                    speakerId: document.speakerId,
                    message: intent.message,
                  });
            if (result.status === 'queue_failed') throw new Error('ACCOUNT_EMAIL_ENQUEUE_FAILED');
            await checkpoint(ref, intent, { resolutionNotification: result });
          },
          (mutate) => commitAccount(ref, mutate)
        )
      ),
  };
}
