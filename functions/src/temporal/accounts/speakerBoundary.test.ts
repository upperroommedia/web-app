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
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { createSpeakerMutation } from '../../speakers/speakerMutations';
import { isDurablePublishingOperation } from '../publishing/durableOperationContext';
import { createAccountActivities } from './activities';
import type { AccountStore } from './types';
const ref = { projectId: 'project', jobId: 'job' };
it('preserves a qualified speaker receipt for review then generation-fences its completed checkpoint', async () => {
  const receiptId = 'b'.repeat(64),
    document: Record<string, unknown> = { status: 'pending', temporalJobId: 'job', requesterUid: 'requester' };
  const target = { get: async () => ({ exists: true, data: () => ({ ...document }) }) };
  const tx = { set: jest.fn((_ref, patch) => Object.assign(document, patch)) };
  (firebaseAdmin.firestore as jest.Mock).mockReturnValue({
    collection: () => ({ doc: () => target }),
    runTransaction: async (run: (tx: unknown) => Promise<unknown>) => run(tx),
  });
  (firebaseAdmin.auth as jest.Mock).mockReturnValue({
    getUser: jest.fn().mockResolvedValue({ uid: 'admin', disabled: false, customClaims: { role: 'admin' } }),
  });
  const store: AccountStore = {
    loadIntent: jest.fn().mockResolvedValue({
      payload: { action: 'speaker-accept', requestId: 'request', speaker: { name: 'Name', images: [] } },
      actorUid: 'admin',
      createdAt: 1,
    }),
    assertCurrent: jest.fn(),
    assertCurrentInTransaction: jest.fn(),
    recordStep: jest.fn(),
  };
  (createSpeakerMutation as jest.Mock)
    .mockImplementationOnce(async (input) => {
      expect(input.operationKey).toBe('durable:project:job:speaker-request:request');
      expect(isDurablePublishingOperation()).toBe(true);
      throw {
        details: { reason: 'PROVIDER_RESULT_AMBIGUOUS', receiptId },
        request: { headers: { Authorization: 'private' } },
      };
    })
    .mockResolvedValue({ speakerId: 'speaker', subsplashId: 'remote' });
  const activities = createAccountActivities(store);
  expect(await activities.createAccountSpeaker(ref)).toEqual({
    state: 'needs_review',
    code: 'PROVIDER_CREATE_AMBIGUOUS',
    receiptId,
  });
  expect(document.temporalSpeakerResult).toBeUndefined();
  expect(JSON.stringify((store.recordStep as jest.Mock).mock.calls)).not.toContain('private');
  expect(await activities.createAccountSpeaker(ref)).toEqual({ state: 'completed' });
  expect(store.assertCurrentInTransaction).toHaveBeenCalledWith(tx, ref);
  expect(document.temporalSpeakerResult).toEqual({ speakerId: 'speaker', subsplashId: 'remote' });
  expect(isDurablePublishingOperation()).toBe(false);
});
