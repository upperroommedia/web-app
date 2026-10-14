jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: jest.fn() },
}));
jest.mock('../../handleError', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../notifications/notificationSecrets', () => ({ adminBaseUrlSecretsWithRuntimeAlerts: [] }));
jest.mock('../../invites/inviteEmail', () => ({
  buildInviteClaimUrl: () => 'https://example.test/invite/claim?token=test',
  queueInviteEmail: jest.fn(),
}));
import type { Firestore } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/v2/https';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { createInviteHandler, createInviteHandlerSource } from '../../invites/createInvite';
import { queueInviteEmail } from '../../invites/inviteEmail';
import { InviteEmailStatus, ROLE_INVITES_COLLECTION, type CreateInviteInputType } from '../../invites/inviteTypes';
import type { LegacyAdmissionLease } from '../legacyAdmissionLease';
import { TEMPORAL_RELEASE_CONTROL_PATH } from '../releaseControl';

/** In-memory Firestore boundary; the real admission, effect and completion code executes. */
describe('createInvite legacy admission lifecycle', () => {
  const originalFlag = process.env.TASK_ORCHESTRATOR_ACCOUNTS;
  const request = {
    data: { email: 'invitee@example.test', role: 'uploader' },
    auth: { uid: 'admin-1', token: { role: 'admin' } },
  } as unknown as CallableRequest<CreateInviteInputType>;
  let documents: Map<string, Record<string, unknown>>;
  let events: string[];
  let failure: 'ack' | 'add' | 'update' | undefined;
  const ref = (path: string) => ({ path, id: path.split('/').at(-1) });
  const leaseRecord = () => [...documents.entries()].find(([path]) => path.startsWith('legacyAdmissionLeases/'))?.[1];
  beforeEach(() => {
    delete process.env.TASK_ORCHESTRATOR_ACCOUNTS;
    failure = undefined;
    events = [];
    documents = new Map([
      [
        TEMPORAL_RELEASE_CONTROL_PATH,
        {
          schemaVersion: 1,
          revision: 1,
          admission: 'open',
          domains: { accounts: { owner: 'legacy', admission: 'open' } },
        },
      ],
    ]);
    jest
      .mocked(queueInviteEmail)
      .mockReset()
      .mockImplementation(async () => {
        events.push('email');
        return { status: InviteEmailStatus.QUEUED, attemptedAtMs: 1, queueMailId: 'mail-1' };
      });
    const db = {
      doc: ref,
      collection: (name: string) => ({
        doc: (id: string) => ref(`${name}/${id}`),
        add: async (value: Record<string, unknown>) => {
          events.push('invite');
          if (leaseRecord()) expect(leaseRecord()?.effectsStarted).toBe(true);
          if (failure === 'add') throw new Error('INVITE_WRITE_UNCERTAIN');
          const path = `${name}/invite-1`;
          documents.set(path, value);
          return {
            ...ref(path),
            update: async (patch: Record<string, unknown>) => {
              events.push('invite-email-state');
              if (failure === 'update') throw new Error('EMAIL_STATE_WRITE_FAILED');
              documents.set(path, { ...documents.get(path), ...patch });
            },
          };
        },
      }),
      runTransaction: async (run: (tx: unknown) => Promise<unknown>) => {
        const pending = new Map<string, Record<string, unknown>>();
        const result = await run({
          get: async ({ path }: { path: string }) => ({
            exists: documents.has(path),
            data: () => documents.get(path),
            get: (key: string) => documents.get(path)?.[key],
          }),
          create: ({ path }: { path: string }, value: Record<string, unknown>) => {
            if (documents.has(path)) throw new Error('ALREADY_EXISTS');
            pending.set(path, value);
          },
          update: ({ path }: { path: string }, patch: Record<string, unknown>) => {
            if (patch.effectsStarted === true) {
              events.push('acknowledge');
              if (failure === 'ack') throw new Error('LEASE_ACK_FAILED');
            }
            pending.set(path, { ...documents.get(path), ...patch });
          },
        });
        for (const [path, value] of pending) documents.set(path, value);
        return result;
      },
    };
    jest.mocked(firebaseAdmin.firestore).mockReturnValue(db as unknown as Firestore);
  });
  afterAll(() => {
    if (originalFlag === undefined) delete process.env.TASK_ORCHESTRATOR_ACCOUNTS;
    else process.env.TASK_ORCHESTRATOR_ACCOUNTS = originalFlag;
  });

  it('acknowledges before the first write and completes successful creation', async () => {
    expect(await createInviteHandlerSource(request)).toMatchObject({ status: 'success' });
    expect(events).toEqual(['acknowledge', 'invite', 'email', 'invite-email-state']);
    expect(leaseRecord()).toMatchObject({ state: 'completed', outcome: 'succeeded', effectsStarted: true });
  });

  it('prevents both invite and email effects when acknowledgement fails', async () => {
    failure = 'ack';
    expect(await createInviteHandlerSource(request)).toMatchObject({ status: 'error', error: 'LEASE_ACK_FAILED' });
    expect(events).toEqual(['acknowledge']);
    expect(documents.has(`${ROLE_INVITES_COLLECTION}/invite-1`)).toBe(false);
    expect(leaseRecord()).toMatchObject({ state: 'completed', outcome: 'rejected_no_effect', effectsStarted: false });
  });

  it('retains an uncertain write attempt for review even when add rejects', async () => {
    failure = 'add';
    expect(await createInviteHandlerSource(request)).toMatchObject({
      status: 'error',
      error: 'INVITE_WRITE_UNCERTAIN',
    });
    expect(events).toEqual(['acknowledge', 'invite']);
    expect(leaseRecord()).toMatchObject({ state: 'needs_attention', outcome: 'unknown', effectsStarted: true });
  });

  it('does not misclassify an already persisted invite and queued email as no effect', async () => {
    failure = 'update';
    expect(await createInviteHandlerSource(request)).toMatchObject({
      status: 'error',
      error: 'EMAIL_STATE_WRITE_FAILED',
    });
    expect(documents.has(`${ROLE_INVITES_COLLECTION}/invite-1`)).toBe(true);
    expect(queueInviteEmail).toHaveBeenCalledTimes(1);
    expect(leaseRecord()).toMatchObject({ state: 'needs_attention', outcome: 'unknown', effectsStarted: true });
  });

  it('retains a persisted invite for review if email dispatch throws', async () => {
    jest.mocked(queueInviteEmail).mockRejectedValue(new Error('EMAIL_OUTCOME_UNKNOWN'));
    expect(await createInviteHandlerSource(request)).toMatchObject({ status: 'error', error: 'EMAIL_OUTCOME_UNKNOWN' });
    expect(documents.has(`${ROLE_INVITES_COLLECTION}/invite-1`)).toBe(true);
    expect(leaseRecord()).toMatchObject({ state: 'needs_attention', outcome: 'unknown', effectsStarted: true });
  });

  it.each([
    { ...request, auth: undefined },
    { ...request, data: { email: 'invalid', role: 'uploader' } },
    { ...request, data: { email: 'invitee@example.test', role: 'invalid' } },
  ])('does not acknowledge effects for an invalid request', async (invalid) => {
    const markEffectsStarted = jest.fn(async () => {});
    const lease: LegacyAdmissionLease = { leaseId: 'unused', heartbeat: async () => {}, markEffectsStarted };
    expect(await createInviteHandler(invalid as CallableRequest<CreateInviteInputType>, lease)).toMatchObject({
      status: 'error',
    });
    expect(markEffectsStarted).not.toHaveBeenCalled();
    expect(queueInviteEmail).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('preserves the direct server delegate without a legacy lease', async () => {
    expect(await createInviteHandler(request)).toMatchObject({ status: 'success' });
    expect(events).toEqual(['invite', 'email', 'invite-email-state']);
    expect(leaseRecord()).toBeUndefined();
  });

  it('rejects legacy invite creation while accounts are owned by Temporal', async () => {
    process.env.TASK_ORCHESTRATOR_ACCOUNTS = 'temporal';
    await expect(createInviteHandlerSource(request)).rejects.toThrow('moved to the durable task service');
    expect(events).toEqual([]);
    expect(leaseRecord()).toBeUndefined();
  });
});
