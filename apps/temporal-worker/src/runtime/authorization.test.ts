import { createActorAuthorization } from './authorization';
import { loadValidatedProviderOrphanReview } from '../../../../functions/src/temporal/publishing/orphanReview';
jest.mock('../../../../functions/src/temporal/publishing/orphanReview', () => ({
  loadValidatedProviderOrphanReview: jest.fn(),
}));
const intent: any = {
  actorUid: 'user1',
  kind: 'audio.process',
  entity: { type: 'sermon', id: 'sermon1' },
  payload: {},
};
const setup = (role: string, owner = 'user1') =>
  createActorAuthorization(
    { getUser: async () => ({ uid: 'user1', disabled: false, customClaims: { role } }) } as any,
    { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, get: () => owner }) }) }) } as any
  );
test('uploaders retain media permission only for their canonical sermon', async () => {
  await expect(setup('uploader')(intent)).resolves.toBeUndefined();
  await expect(setup('uploader', 'other')(intent)).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
});
test('role revocation invalidates admission before another effect', async () => {
  await expect(setup('user')(intent)).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
});
test('trusted system identity cannot run an unrelated user operation', async () => {
  await expect(setup('user')({ ...intent, actorUid: 'system:email', kind: 'email.deliver' })).resolves.toBeUndefined();
  await expect(setup('admin')({ ...intent, actorUid: 'system:email', kind: 'sermon.publish' })).rejects.toMatchObject({
    code: 'PERMISSION_CHANGED',
  });
});
test('invite claim targets must match the authenticated claimant', async () => {
  await expect(
    setup('user')({ ...intent, kind: 'invite.claim', payload: { claimantUid: 'other' } })
  ).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
});
test('maintenance identity can only run the admitted artifact cleanup operation', async () => {
  const authorize = setup('user');
  await expect(
    authorize({
      ...intent,
      actorUid: 'system:maintenance',
      kind: 'maintenance.run',
      payload: { operation: 'media_artifacts_cleanup' },
    })
  ).resolves.toBeUndefined();
  await expect(
    authorize({
      ...intent,
      actorUid: 'system:maintenance',
      kind: 'maintenance.run',
      payload: { operation: 'reconcile_all' },
    })
  ).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  await expect(authorize({ ...intent, actorUid: 'system:maintenance', kind: 'sermon.publish' })).rejects.toMatchObject({
    code: 'PERMISSION_CHANGED',
  });
});
test('publisher image deletion and derived series synchronization match admission permission', async () => {
  await expect(
    setup('publisher')({ ...intent, kind: 'image.delete', entity: { type: 'image', id: 'image1' } })
  ).resolves.toBeUndefined();
  await expect(
    setup('user')({ ...intent, actorUid: 'system:firebase-event', kind: 'series.sync_metadata' })
  ).resolves.toBeUndefined();
});
test('revoked publishing actors retain only admitted cancellation cleanup authority', async () => {
  const execution: any = { activityType: 'cleanupCancelledPublishing', workflowId: 'owned-workflow' };
  const proof: any = {
    schemaVersion: 1,
    projectId: 'test',
    jobId: 'job',
    workflowId: 'owned-workflow',
    generation: 1,
    actorUid: 'authorized-admin',
    authorizedAt: 100,
  };
  const job: any = { projectId: 'test', workflowId: 'owned-workflow', state: 'cancel_requested' };
  const authorize = createActorAuthorization(
    { getUser: async () => ({ uid: 'revoked', disabled: true, customClaims: { role: 'user' } }) } as any,
    {
      collection: (name: string) => ({
        doc: () => ({
          get: async () => ({
            exists: true,
            data: () => (name === 'durableJobCancellationIntents' ? proof : job),
            get: (key: string) => job[key],
          }),
        }),
      }),
    } as any,
    () => execution
  );
  const publishingIntent: any = {
    ...intent,
    projectId: 'test',
    jobId: 'job',
    generation: 1,
    kind: 'sermon.publish',
    actorUid: 'revoked',
  };
  await expect(authorize(publishingIntent)).resolves.toBeUndefined();
  execution.activityType = 'ensurePublishingMedia';
  await expect(authorize(publishingIntent)).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  execution.activityType = 'cleanupCancelledPublishing';
  proof.generation = 2;
  await expect(authorize(publishingIntent)).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
});
test('deleted accounts lose effect permission without being reported as a transient outage', async () => {
  const authorize = createActorAuthorization(
    {
      getUser: async () => {
        throw { code: 'auth/user-not-found' };
      },
    } as any,
    {} as any
  );
  await expect(authorize(intent)).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
});

test('private orphan review authority cannot run provider mutations or change its immutable scope', async () => {
  const reviewIntent: any = {
    ...intent,
    kind: 'provider.orphan_review',
    projectId: 'test',
    jobId: 'case',
    generation: 1,
  };
  const execution: any = {
    activityType: 'reviewProviderOrphanAcknowledgement',
    workflowId: 'provider-ack-review:test:case',
  };
  jest.mocked(loadValidatedProviderOrphanReview).mockResolvedValue({ intent: reviewIntent } as any);
  const authorize = createActorAuthorization({ getUser: jest.fn() } as any, {} as any, () => execution);
  await expect(authorize(reviewIntent)).resolves.toBeUndefined();
  execution.activityType = 'ensurePublishingMedia';
  await expect(authorize(reviewIntent)).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  execution.activityType = 'reviewProviderOrphanAcknowledgement';
  execution.workflowId = 'other-workflow';
  await expect(authorize(reviewIntent)).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  execution.workflowId = 'provider-ack-review:test:case';
  jest.mocked(loadValidatedProviderOrphanReview).mockRejectedValue(new Error('Immutable ACK changed'));
  await expect(authorize(reviewIntent)).rejects.toThrow('Immutable ACK changed');
});

test('a missing canonical sermon grants only source-proved frozen deletion continuation, even for admins', async () => {
  const deletion: any = { ...intent, kind: 'sermon.delete', jobId: 'job', projectId: 'urm-app', generation: 1 };
  const execution: any = { activityType: 'cleanupPublishingProviders', workflowId: 'owned' };
  const actor: any = { uid: 'user1', disabled: false, customClaims: { role: 'admin' } };
  const sourceProof = jest.fn(async () => ({ uploaderId: 'user1' }));
  const authorize = createActorAuthorization(
    { getUser: async () => actor } as any,
    { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) } as any,
    () => execution,
    undefined,
    sourceProof
  );
  await expect(authorize(deletion)).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  expect(sourceProof).not.toHaveBeenCalled();
  execution.activityType = 'commitPublishingProjection';
  await expect(authorize(deletion)).resolves.toBeUndefined();
  actor.customClaims.role = 'user';
  await expect(authorize(deletion)).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  actor.customClaims.role = 'publisher';
  await expect(authorize(deletion)).resolves.toBeUndefined();
  sourceProof.mockResolvedValueOnce({ uploaderId: 'different-owner' });
  await expect(authorize(deletion)).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
});
test('missing sermon cleanup cannot use an absent or unvalidated source header', async () => {
  const deletion: any = { ...intent, kind: 'sermon.delete', jobId: 'job', projectId: 'urm-app', generation: 1 };
  const authorize = createActorAuthorization(
    { getUser: async () => ({ uid: 'user1', disabled: false, customClaims: { role: 'admin' } }) } as any,
    { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) } as any,
    () => ({ activityType: 'commitPublishingProjection' } as any)
  );
  await expect(authorize(deletion)).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
});

test('a deleted list permits only its private frozen continuation and preserves current publisher permission', async () => {
  const deletion: any = {
    ...intent,
    kind: 'list.delete',
    entity: { type: 'list', id: 'list' },
    jobId: 'job',
    projectId: 'urm-app',
    generation: 1,
  };
  const execution: any = { activityType: 'executePublishingEntityActivity', workflowId: 'owned' };
  const actor: any = { uid: 'user1', disabled: false, customClaims: { role: 'publisher' } },
    proof = jest.fn(async () => {});
  const authorize = createActorAuthorization(
    { getUser: async () => actor } as any,
    { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) } as any,
    () => execution,
    undefined,
    undefined,
    proof
  );
  await expect(authorize(deletion)).resolves.toBeUndefined();
  expect(proof).toHaveBeenCalledWith(deletion, execution, undefined);
  actor.customClaims.role = 'user';
  await expect(authorize(deletion)).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  actor.customClaims.role = 'admin';
  execution.activityType = 'executePublishingMaintenancePage';
  await expect(authorize(deletion)).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
});
