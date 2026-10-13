jest.mock('../publishing/durableOperationContext', () => ({
  ...jest.requireActual('../publishing/durableOperationContext'),
  releaseCanonicalProviderBindingsForCurrentJob: jest.fn(),
}));
jest.mock('../../../../packages/orchestration/src/provider-transaction', () => ({
  withProviderIndexedTransaction: (
    tx: unknown,
    _db: unknown,
    _project: unknown,
    run: (tx: unknown) => Promise<unknown>
  ) => run(tx),
}));
jest.mock('./authClaimsTransport', () => ({
  ACCOUNT_CLAIMS_TRANSPORT: 'single_shot_identity_toolkit',
  setAccountClaimsSingleShot: jest.fn(),
  revokeAccountSessionsSingleShot: jest.fn(),
  validateFrozenAccountClaims: jest.fn(),
  isConfirmedAccountTransportRejection: (error: unknown) =>
    jest
      .requireActual<typeof import('./authClaimsTransport')>('./authClaimsTransport')
      .isConfirmedAccountTransportRejection(error),
}));
jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), log: jest.fn(), debug: jest.fn() },
}));
jest.mock('firebase-functions/v2/https', () => ({
  onCall: (options: unknown, handler?: unknown) => handler ?? options,
  HttpsError: class extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { auth: jest.fn(), firestore: jest.fn() },
}));
jest.mock('../../invites/inviteEmail', () => ({ queueInviteEmail: jest.fn() }));
jest.mock('../../roleRequests/queueRoleRequestOutcomeEmail', () => ({ queueRoleRequestOutcomeEmail: jest.fn() }));
jest.mock('../../speakerRequests/queueSpeakerRequestOutcomeEmail', () => ({
  queueSpeakerRequestOutcomeEmail: jest.fn(),
}));
jest.mock('../../speakers/speakerMutations', () => ({
  createSpeakerMutation: jest.fn(),
  requireSquareImage: jest.fn(),
  requireTrimmedSpeakerName: jest.fn(),
}));

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setAccountClaimsSingleShot, revokeAccountSessionsSingleShot } from './authClaimsTransport';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { createAccountActivities } from './activities';
import { InviteClaimStatus } from '../../invites/inviteTypes';
import type { AccountIntent, AccountStore } from './types';

const ref = { projectId: 'urm-app-staging', jobId: 'job1' };
describe('durable account activity boundaries', () => {
  let document: Record<string, unknown>;
  let intent: AccountIntent;
  let actor: { uid: string; email: string; disabled: boolean; customClaims: Record<string, unknown> };
  let claims: jest.Mock;
  let revoke: jest.Mock;
  let store: AccountStore;
  beforeEach(() => {
    document = {
      claimedByUid: 'user1',
      invitedEmail: 'user@example.test',
      invitedRole: 'uploader',
      claimStatus: InviteClaimStatus.ROLE_PENDING,
      expiresAtMs: Date.now() + 60_000,
    };
    intent = { action: 'invite-claim', inviteId: 'invite1', claimantUid: 'user1' };
    actor = {
      uid: 'user1',
      email: 'user@example.test',
      disabled: false,
      customClaims: { role: 'admin', untouched: 'retain' },
    };
    claims = setAccountClaimsSingleShot as jest.Mock;
    claims
      .mockReset()
      .mockImplementation(
        async (_project: unknown, _uid: unknown, _claims: unknown, beforeSend?: () => Promise<void>) => {
          await beforeSend?.();
        }
      );
    revoke = revokeAccountSessionsSingleShot as jest.Mock;
    revoke.mockReset().mockImplementation(async (_p, _u, _cutoff, _claims, beforeSend) => {
      await beforeSend?.();
    });
    (firebaseAdmin.auth as jest.Mock).mockReturnValue({
      getUser: jest.fn().mockImplementation(async () => actor),
      setCustomUserClaims: claims,
      revokeRefreshTokens: revoke,
    });
    const resources = new Map<string, Record<string, unknown>>();
    const target = {
      get: async () => ({ exists: true, data: () => ({ ...document }) }),
      set: async (patch: Record<string, unknown>) => {
        Object.assign(document, patch);
      },
      update: async (patch: Record<string, unknown>) => {
        Object.assign(document, patch);
      },
    };
    const transaction = {
      get: async (target: { get: () => Promise<unknown> }) => target.get(),
      set: (target: { set: (patch: Record<string, unknown>) => unknown }, patch: Record<string, unknown>) =>
        target.set(patch),
      update: (target: { update: (patch: Record<string, unknown>) => unknown }, patch: Record<string, unknown>) =>
        target.update(patch),
    };
    (firebaseAdmin.firestore as unknown as jest.Mock).mockReturnValue({
      collection: (name: string) => ({
        doc: (id: string) =>
          name === '_durableAccountClaimResources'
            ? {
                get: async () => ({ data: () => resources.get(id) }),
                set: async (patch: Record<string, unknown>) => {
                  resources.set(id, patch);
                },
                update: async (patch: Record<string, unknown>) => {
                  Object.assign(resources.get(id)!, patch);
                },
              }
            : target,
      }),
      runTransaction: async (run: (tx: unknown) => Promise<unknown>) => run(transaction),
    });
    store = {
      loadIntent: jest.fn().mockImplementation(async () => ({ payload: intent, actorUid: 'user1', createdAt: 1234 })),
      assertCurrent: jest.fn().mockResolvedValue(undefined),
      getExecutionIdentity: () => ({
        workflowId: 'workflow',
        runId: 'run',
        activityId: 'activity',
        activityType: 'applyAccountClaims',
        scheduledAt: 100,
        attempt: 1,
      }),
      assertCurrentInTransaction: jest.fn().mockResolvedValue(undefined),
      recordStep: jest.fn().mockResolvedValue(undefined),
    };
  });
  it('preserves a higher role during invitation replay', async () => {
    expect(await createAccountActivities(store).applyAccountClaims(ref)).toEqual({ state: 'completed' });
    expect(claims).not.toHaveBeenCalled();
    expect(document.temporalClaimsAppliedJobId).toBe('job1');
  });
  it('merges unrelated claims when upgrading a user', async () => {
    actor.customClaims.role = 'user';
    await createAccountActivities(store).applyAccountClaims(ref);
    expect(claims).toHaveBeenCalledWith(
      ref.projectId,
      'user1',
      {
        role: 'uploader',
        untouched: 'retain',
        temporalAccountClaimJobId: ref.jobId,
      },
      expect.any(Function)
    );
  });
  it('rejects a revoked invitation before a side effect', async () => {
    document.revokedAtMs = 1;
    expect(await createAccountActivities(store).applyAccountClaims(ref)).toEqual({
      state: 'blocked',
      code: 'INVITE_REVOKED',
    });
    expect(claims).not.toHaveBeenCalled();
  });
  it('rejects an expired incomplete claim', async () => {
    document.expiresAtMs = 1;
    expect(await createAccountActivities(store).applyAccountClaims(ref)).toEqual({
      state: 'blocked',
      code: 'INVITE_EXPIRED',
    });
  });
  it('rechecks disabled actors on activity retry', async () => {
    actor.disabled = true;
    expect(await createAccountActivities(store).applyAccountClaims(ref)).toEqual({
      state: 'blocked',
      code: 'ACCOUNT_PERMISSION_CHANGED',
    });
  });
  it('never reapplies a consumed invite after an administrator later changes the role', async () => {
    document.claimStatus = InviteClaimStatus.COMPLETE;
    document.expiresAtMs = 1;
    actor.customClaims.role = 'user';
    const activities = createAccountActivities(store);
    expect(await activities.applyAccountClaims(ref)).toEqual({ state: 'completed' });
    expect(await activities.revokeAccountSessions(ref)).toEqual({ state: 'completed' });
    expect(claims).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('finishes only revocation after the approving admin loses permissions', async () => {
    intent = { action: 'role-accept', requestId: 'request1' };
    document = {
      temporalJobId: ref.jobId,
      status: 'pending',
      requesterUid: 'recipient1',
      requestedRole: 'publisher',
      temporalClaimsAppliedJobId: ref.jobId,
    };
    actor.customClaims.role = 'user';
    const activities = createAccountActivities(store);
    expect(await activities.applyAccountClaims(ref)).toEqual({ state: 'completed' });
    expect(claims).not.toHaveBeenCalled();
    expect(await activities.revokeAccountSessions(ref)).toEqual({ state: 'completed' });
    expect(revoke).toHaveBeenCalledWith(
      ref.projectId,
      'recipient1',
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
    expect(await activities.validateAccountOperation(ref)).toEqual({
      state: 'blocked',
      code: 'ACCOUNT_PERMISSION_CHANGED',
    });
  });

  it('finishes an authorized self-demotion after a crash before its claims checkpoint', async () => {
    intent = { action: 'role-assign', assignmentId: 'assignment1', targetUid: actor.uid, role: 'user' };
    document = { temporalJobId: ref.jobId, temporalClaimsRequestedJobId: ref.jobId };
    actor.customClaims.role = 'user';
    const activities = createAccountActivities(store);
    expect(await activities.applyAccountClaims(ref)).toEqual({ state: 'completed' });
    expect(claims).not.toHaveBeenCalled();
    expect(await activities.revokeAccountSessions(ref)).toEqual({ state: 'completed' });
    expect(revoke).toHaveBeenCalledWith(
      ref.projectId,
      actor.uid,
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('rejects a superseded execution after a delayed target Auth read before any grant/checkpoint', async () => {
    actor.customClaims.role = 'user';
    const getUser = firebaseAdmin.auth().getUser as jest.Mock;
    let release!: () => void;
    getUser
      .mockImplementationOnce(async () => actor)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(actor);
          })
      );
    const pending = createAccountActivities(store).applyAccountClaims(ref);
    while (!release) await Promise.resolve();
    (store.assertCurrentInTransaction as jest.Mock).mockRejectedValue(new Error('STALE_EXECUTION'));
    release();
    await expect(pending).rejects.toThrow('STALE_EXECUTION');
    expect(claims).not.toHaveBeenCalled();
    expect(document.temporalClaimsRequestedJobId).toBeUndefined();
    expect(document.temporalClaimsAppliedJobId).toBeUndefined();
  });

  it('rechecks the approving actor after the asynchronous target lookup', async () => {
    intent = { action: 'role-assign', assignmentId: 'assignment1', targetUid: 'recipient1', role: 'publisher' };
    document = { temporalJobId: ref.jobId };
    const getUser = firebaseAdmin.auth().getUser as jest.Mock;
    getUser
      .mockResolvedValueOnce(actor)
      .mockResolvedValueOnce({ ...actor, uid: 'recipient1', customClaims: { role: 'user' } })
      .mockResolvedValueOnce({ ...actor, customClaims: { role: 'user' } });
    expect(await createAccountActivities(store).applyAccountClaims(ref)).toEqual({
      state: 'blocked',
      code: 'ACCOUNT_PERMISSION_CHANGED',
    });
    expect(claims).not.toHaveBeenCalled();
    expect(document.temporalClaimsRequestedJobId).toBeUndefined();
  });

  it('sends zero real HTTP grants if admin permission is revoked during token refresh and releases the unsent lock', async () => {
    const { createSingleShotClaimsTransport } =
      jest.requireActual<typeof import('./authClaimsTransport')>('./authClaimsTransport');
    const server = createServer((_request, response) => {
      calls += 1;
      response.end('{}');
    });
    let calls = 0;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let tokenReady!: (token: string) => void;
    const transport = createSingleShotClaimsTransport({
      endpoint,
      getAccessToken: () =>
        new Promise((resolve) => {
          tokenReady = resolve;
        }),
    });
    claims.mockImplementation(transport);
    intent = { action: 'role-assign', assignmentId: 'assignment1', targetUid: 'recipient1', role: 'publisher' };
    document = { temporalJobId: ref.jobId };
    (firebaseAdmin.auth().getUser as jest.Mock).mockImplementation(async (uid) =>
      uid === actor.uid ? actor : { uid, disabled: false, customClaims: { role: 'user' } }
    );
    try {
      const pending = createAccountActivities(store).applyAccountClaims(ref);
      while (!tokenReady) await Promise.resolve();
      actor.customClaims.role = 'user';
      tokenReady('local-test-token');
      expect(await pending).toEqual({ state: 'blocked', code: 'ACCOUNT_PERMISSION_CHANGED' });
      expect(calls).toBe(0);
      actor.customClaims.role = 'admin';
      claims.mockImplementation(async (_p, _u, _c, beforeSend) => {
        await beforeSend();
      });
      expect(await createAccountActivities(store).applyAccountClaims(ref)).toEqual({ state: 'completed' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('releases an exactly owned positively rejected grant for a corrected retry', async () => {
    const actual = jest.requireActual<typeof import('./authClaimsTransport')>('./authClaimsTransport');
    actor.customClaims.role = 'user';
    claims.mockImplementationOnce(async (_p, _u, _c, beforeSend) => {
      await beforeSend();
      throw new actual.AccountTransportRejectedError('PERMISSION_DENIED');
    });
    const activities = createAccountActivities(store);
    expect(await activities.applyAccountClaims(ref)).toEqual({ state: 'blocked', code: 'ACCOUNT_MUTATION_REJECTED' });
    expect(document.temporalClaimsAppliedJobId).toBeUndefined();
    expect(await activities.applyAccountClaims(ref)).toEqual({ state: 'completed' });
    expect(claims).toHaveBeenCalledTimes(2);
  });

  it('never repeats an unacknowledged Auth RPC on Activity retry', async () => {
    actor.customClaims.role = 'user';
    claims.mockImplementation(async (_p, _u, _c, beforeSend) => {
      await beforeSend();
      throw new Error('lost Auth response');
    });
    const activities = createAccountActivities(store);
    await expect(activities.applyAccountClaims(ref)).rejects.toThrow('lost Auth response');
    expect(await activities.applyAccountClaims(ref)).toEqual({
      state: 'blocked',
      code: 'ACCOUNT_CLAIMS_RECONCILIATION_REQUIRED',
    });
    expect(claims).toHaveBeenCalledTimes(1);
    expect(document.temporalClaimsAppliedJobId).toBeUndefined();
  });

  it('keeps an in-flight old grant locked after generation changes so a newer job cannot race it', async () => {
    actor.customClaims.role = 'user';
    let release!: () => void;
    claims.mockImplementation(async (_p, _u, _c, beforeSend) => {
      await beforeSend();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const oldAttempt = createAccountActivities(store).applyAccountClaims(ref);
    while (!release) await Promise.resolve();
    (store.assertCurrentInTransaction as jest.Mock).mockRejectedValue(new Error('SUPERSEDED'));
    release();
    await expect(oldAttempt).rejects.toThrow('SUPERSEDED');
    (store.assertCurrentInTransaction as jest.Mock).mockResolvedValue(undefined);
    const newer = await createAccountActivities(store).applyAccountClaims({ ...ref, jobId: 'new-job' });
    expect(newer).toEqual({ state: 'blocked', code: 'ACCOUNT_CLAIMS_RECONCILIATION_REQUIRED' });
    expect(claims).toHaveBeenCalledTimes(1);
    expect(document.temporalClaimsAppliedJobId).toBeUndefined();
  });

  it('freezes the session cutoff across a proven unsent retry rather than recomputing the clock', async () => {
    const activities = createAccountActivities(store);
    await activities.applyAccountClaims(ref);
    revoke.mockRejectedValueOnce(new Error('credential unavailable before send'));
    await expect(activities.revokeAccountSessions(ref)).rejects.toThrow('credential unavailable');
    const firstCutoff = revoke.mock.calls[0][2];
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    try {
      expect(await activities.revokeAccountSessions(ref)).toEqual({ state: 'completed' });
      expect(revoke.mock.calls[1][2]).toBe(firstCutoff);
      expect(revoke.mock.calls[1][3]).toEqual(revoke.mock.calls[0][3]);
      expect(revoke.mock.calls[1][3].temporalAccountSessionOperationId).toMatch(/^[a-f0-9-]{36}$/);
    } finally {
      clock.mockRestore();
    }
  });

  it('never overwrites current access claims when they change during session credential refresh', async () => {
    const activities = createAccountActivities(store);
    await activities.applyAccountClaims(ref);
    revoke.mockImplementationOnce(async (_p, _u, _cutoff, _claims, beforeSend) => {
      actor.customClaims = { ...actor.customClaims, unrelated: 'changed externally' };
      await beforeSend();
    });
    expect(await activities.revokeAccountSessions(ref)).toEqual({
      state: 'blocked',
      code: 'ACCOUNT_SESSION_CLAIMS_CHANGED',
    });
    expect(document.temporalSessionsRevokedJobId).toBeUndefined();
    expect(revoke.mock.calls[0][3]).toMatchObject({
      role: 'admin',
      untouched: 'retain',
      temporalAccountSessionOperationId: expect.any(String),
    });
    expect(revoke.mock.calls[0][3].unrelated).toBeUndefined();
  });

  it('never repeats an unacknowledged session revoke on Activity retry', async () => {
    const activities = createAccountActivities(store);
    await activities.applyAccountClaims(ref);
    revoke.mockImplementation(async (_p, _u, _cutoff, _claims, beforeSend) => {
      await beforeSend();
      throw new Error('lost session response');
    });
    await expect(activities.revokeAccountSessions(ref)).rejects.toThrow('lost session response');
    expect(await activities.revokeAccountSessions(ref)).toEqual({
      state: 'blocked',
      code: 'ACCOUNT_SESSIONS_RECONCILIATION_REQUIRED',
    });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(document.temporalSessionsRevokedJobId).toBeUndefined();
  });

  it('rejects an old-generation revoke checkpoint and retains the uncertain session resource', async () => {
    const activities = createAccountActivities(store);
    await activities.applyAccountClaims(ref);
    let release!: () => void;
    revoke.mockImplementation(async (_p, _u, _cutoff, _claims, beforeSend) => {
      await beforeSend();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const pending = activities.revokeAccountSessions(ref);
    while (!release) await Promise.resolve();
    (store.assertCurrentInTransaction as jest.Mock).mockRejectedValue(new Error('SUPERSEDED'));
    release();
    await expect(pending).rejects.toThrow('SUPERSEDED');
    (store.assertCurrentInTransaction as jest.Mock).mockResolvedValue(undefined);
    expect(await activities.revokeAccountSessions(ref)).toEqual({
      state: 'blocked',
      code: 'ACCOUNT_SESSIONS_RECONCILIATION_REQUIRED',
    });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(document.temporalSessionsRevokedJobId).toBeUndefined();
  });

  it('never lowers the session cutoff across serialized role changes if the worker clock regresses', async () => {
    intent = { action: 'role-assign', assignmentId: 'assignment1', targetUid: actor.uid, role: 'publisher' };
    document = { temporalJobId: ref.jobId };
    const activities = createAccountActivities(store);
    await activities.applyAccountClaims(ref);
    await activities.revokeAccountSessions(ref);
    const earlierCutoff = revoke.mock.calls[0][2];
    const newer = { ...ref, jobId: 'new-job' };
    intent = { action: 'role-assign', assignmentId: 'assignment2', targetUid: actor.uid, role: 'user' };
    document = { temporalJobId: newer.jobId };
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 60_000);
    try {
      await activities.applyAccountClaims(newer);
      await activities.revokeAccountSessions(newer);
      expect(Number(revoke.mock.calls[1][2])).toBeGreaterThanOrEqual(Number(earlierCutoff));
    } finally {
      clock.mockRestore();
    }
  });

  it('orders and checkpoints token revocation after claims', async () => {
    const activities = createAccountActivities(store);
    expect(await activities.revokeAccountSessions(ref)).toEqual({
      state: 'blocked',
      code: 'ACCOUNT_CLAIMS_NOT_APPLIED',
    });
    expect(revoke).not.toHaveBeenCalled();
    await activities.applyAccountClaims(ref);
    await activities.revokeAccountSessions(ref);
    await activities.revokeAccountSessions(ref);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
