jest.mock('./providerReceipts', () => ({ listProviderReceiptsForJob: jest.fn() }));
import { listProviderReceiptsForJob } from './providerReceipts';
import { createPublishingActivities } from './activities';
import type { PublishingDomainDependencies, PrivatePublishingIntent } from './types';

const intent: PrivatePublishingIntent = {
  sermonId: 'sermon-1',
  action: 'publish',
  generation: 1,
  actorUid: 'actor',
  payload: { privateUrl: 'https://example.invalid/token=private', description: 'Private description' },
  destinations: { listIds: ['list-1'], seriesId: 'series-1', soundcloud: true },
};
function dependencies(): PublishingDomainDependencies {
  return {
    loadIntent: jest.fn().mockResolvedValue(intent),
    assertCurrent: jest.fn().mockResolvedValue(undefined),
    recordStep: jest.fn().mockResolvedValue(undefined),
    ensureSubsplashMedia: jest.fn().mockResolvedValue(undefined),
    ensureSoundCloudTrack: jest.fn().mockResolvedValue(undefined),
    awaitSubsplashReady: jest.fn().mockResolvedValue(undefined),
    awaitSoundCloudReady: jest.fn().mockResolvedValue(undefined),
    mutateLists: jest.fn().mockResolvedValue(undefined),
    mutateSeries: jest.fn().mockResolvedValue(undefined),
    updateMemberships: jest.fn(),
    replaceAudio: jest.fn().mockResolvedValue(undefined),
    updateMetadata: jest.fn().mockResolvedValue(undefined),
    prepareDeletePlan: jest.fn().mockResolvedValue(undefined),
    deleteProviders: jest.fn().mockResolvedValue(undefined),
    commitProjection: jest.fn().mockResolvedValue(undefined),
    cancelEffects: jest.fn().mockResolvedValue({ state: 'completed' }),
    reconcile: jest.fn().mockResolvedValue(undefined),
  };
}
describe('publishing activity boundary', () => {
  it('exposes only routing references and selections in plan history', async () => {
    const plan = await createPublishingActivities(dependencies()).loadPublishingPlan({
      jobId: 'job-1',
      projectId: 'test',
    });
    expect(plan).toEqual({
      sermonId: 'sermon-1',
      action: 'publish',
      generation: 1,
      lists: true,
      series: true,
      soundcloud: true,
      needsMedia: true,
      requiresAudio: false,
      needsSoundCloud: true,
      requiresMemberships: false,
    });
    expect(JSON.stringify(plan)).not.toContain('private');
  });
  it('recovers interrupted activities from private receipts without blind provider replay', async () => {
    (listProviderReceiptsForJob as jest.Mock).mockResolvedValue([
      { receiptId: 'a'.repeat(64), receipt: { state: 'executing' } },
    ]);
    const deps = dependencies(),
      activities = createPublishingActivities(deps),
      ref = { projectId: 'test', jobId: 'job-1' };
    expect(await activities.recoverPublishingActivityFailure(ref, 'subsplash-media')).toEqual({
      state: 'needs_review',
      code: 'PROVIDER_CREATE_AMBIGUOUS',
      receiptId: 'a'.repeat(64),
    });
    (listProviderReceiptsForJob as jest.Mock).mockResolvedValue([
      { receiptId: 'b'.repeat(64), receipt: { state: 'confirmed' } },
    ]);
    expect(await activities.recoverPublishingActivityFailure(ref, 'memberships')).toEqual({
      state: 'failed',
      code: 'PUBLISHING_TRANSIENT',
    });
    expect(deps.ensureSubsplashMedia).not.toHaveBeenCalled();
    expect(deps.recordStep).toHaveBeenLastCalledWith(ref, 'lists', { state: 'failed', code: 'PUBLISHING_TRANSIENT' });
  });
  it('blocks interrupted work when scoped receipt evidence is unavailable', async () => {
    (listProviderReceiptsForJob as jest.Mock).mockRejectedValue(new Error('private datastore failure'));
    const deps = dependencies();
    expect(
      await createPublishingActivities(deps).recoverPublishingActivityFailure(
        { projectId: 'test', jobId: 'job-1' },
        'metadata'
      )
    ).toEqual({ state: 'blocked', code: 'PUBLISHING_PROVIDER_REPAIR_REQUIRED' });
    expect(deps.updateMetadata).not.toHaveBeenCalled();
  });
  it('retries sanitized transport failures while keeping an ambiguous create under review', async () => {
    const deps = dependencies();
    (deps.awaitSubsplashReady as jest.Mock).mockRejectedValue({
      code: 'ECONNABORTED',
      response: { status: 503, headers: { secret: 'private' } },
    });
    expect(
      await createPublishingActivities(deps).checkPublishingMediaReady({ jobId: 'job-1', projectId: 'test' })
    ).toEqual({ state: 'failed', code: 'PUBLISHING_TRANSIENT' });
    (deps.ensureSubsplashMedia as jest.Mock).mockRejectedValue({
      code: 'ECONNABORTED',
      details: { reason: 'PROVIDER_RESULT_AMBIGUOUS' },
    });
    expect(await createPublishingActivities(deps).ensurePublishingMedia({ jobId: 'job-1', projectId: 'test' })).toEqual(
      { state: 'needs_review', code: 'PROVIDER_CREATE_AMBIGUOUS' }
    );
  });
  it('checks active revision before performing a provider mutation', async () => {
    const deps = dependencies();
    (deps.assertCurrent as jest.Mock).mockRejectedValue(
      Object.assign(new Error('superseded'), { code: 'PUBLISHING_SUPERSEDED' })
    );
    await expect(
      createPublishingActivities(deps).ensurePublishingMedia({ jobId: 'job-1', projectId: 'test' })
    ).resolves.toEqual({ state: 'blocked', code: 'PUBLISHING_SUPERSEDED' });
    expect(deps.ensureSubsplashMedia).not.toHaveBeenCalled();
  });
  it('preserves confirmed receipt evidence after create acknowledgement and actor revocation without another provider effect', async () => {
    const deps = dependencies(),
      ref = { projectId: 'test', jobId: 'job-1' },
      receiptId = 'c'.repeat(64);
    (listProviderReceiptsForJob as jest.Mock).mockResolvedValue([{ receiptId, receipt: { state: 'confirmed' } }]);
    (deps.ensureSubsplashMedia as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Permission changed'), { code: 'PERMISSION_CHANGED' })
    );
    expect(await createPublishingActivities(deps).ensurePublishingMedia(ref)).toEqual({
      state: 'blocked',
      code: 'PUBLISHING_PERMISSION_CHANGED',
      receiptId,
    });
    expect(deps.ensureSubsplashMedia).toHaveBeenCalledTimes(1);
    (deps.assertCurrent as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Permission changed'), { code: 'PERMISSION_CHANGED' })
    );
    expect(await createPublishingActivities(deps).recoverPublishingActivityFailure(ref, 'subsplash-media')).toEqual({
      state: 'failed',
      code: 'PUBLISHING_TRANSIENT',
    });
    expect(deps.ensureSubsplashMedia).toHaveBeenCalledTimes(1);
  });
  it('records an ambiguous create as review required without leaking provider messages', async () => {
    const deps = dependencies();
    (deps.ensureSubsplashMedia as jest.Mock).mockRejectedValue(
      Object.assign(new Error('secret transport payload'), { code: 'PROVIDER_CREATE_AMBIGUOUS' })
    );
    const result = await createPublishingActivities(deps).ensurePublishingMedia({ jobId: 'job-1', projectId: 'test' });
    expect(result).toEqual({ state: 'needs_review', code: 'PROVIDER_CREATE_AMBIGUOUS' });
    expect(deps.recordStep).toHaveBeenCalledWith({ jobId: 'job-1', projectId: 'test' }, 'subsplash-media', result);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(deps.ensureSubsplashMedia).toHaveBeenCalledTimes(1);
  });
  it('keeps a permanently aborted graph change blocked for a fresh intent instead of replaying it', async () => {
    const deps = dependencies();
    (deps.mutateLists as jest.Mock).mockRejectedValue(
      Object.assign(new Error('canonical graph changed'), { code: 'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT' })
    );
    expect(await createPublishingActivities(deps).applyPublishingLists({ projectId: 'test', jobId: 'job-1' })).toEqual({
      state: 'blocked',
      code: 'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT',
    });
    expect(deps.mutateLists).toHaveBeenCalledTimes(1);
  });
  it('records completion only after the provider and projection adapter returns', async () => {
    const deps = dependencies();
    const order: string[] = [];
    (deps.ensureSoundCloudTrack as jest.Mock).mockImplementation(async () => {
      order.push('provider+projection');
    });
    (deps.recordStep as jest.Mock).mockImplementation(async () => {
      order.push('receipt');
    });
    expect(
      await createPublishingActivities(deps).ensurePublishingSoundCloud({ jobId: 'job-1', projectId: 'test' })
    ).toEqual({ state: 'completed' });
    expect(order).toEqual(['provider+projection', 'receipt']);
  });
});
