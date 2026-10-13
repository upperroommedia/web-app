import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { WorkflowFailedError } from '@temporalio/client';
import {
  publishingWorkflow,
  publishingResume,
  publishingStatus,
  publishingCriticalRepair,
  publishingEvidenceAvailable,
} from './index';
jest.setTimeout(120000);
const ref = { jobId: 'publishing-native-test', projectId: 'test-project' };
const complete = () => ({ state: 'completed' as const });
function activityMocks(trace: string[] = []) {
  return {
    reportPublishingCancellationFailure: jest
      .fn()
      .mockResolvedValue({ state: 'blocked', code: 'PUBLISHING_CANCEL_REPAIR_REQUIRED', cancelOnly: true }),
    cleanupCancelledPublishing: jest.fn().mockResolvedValue({ state: 'completed', cancelOnly: true }),
    releasePublishingAudio: jest.fn().mockResolvedValue({ released: true }),
    repairPublishingCritical: jest.fn().mockResolvedValue(complete()),
    savePublishingCreateReviewCheckpoint: jest.fn().mockResolvedValue(undefined),
    loadPublishingCreateReviewContinuation: jest.fn().mockResolvedValue(undefined),
    compilePublishingCriticalRepairEvidence: jest.fn().mockResolvedValue({ state: 'ready' }),
    beginDurableReview: jest.fn().mockResolvedValue(undefined),
    beginDurableCriticalRepair: jest.fn().mockResolvedValue(undefined),
    beginDurableCleanup: jest.fn().mockResolvedValue(undefined),
    beginDurableJob: jest.fn().mockResolvedValue(undefined),
    finishDurableJob: jest.fn().mockResolvedValue(undefined),
    preparePublishingDeletePlan: jest.fn().mockImplementation(async () => {
      trace.push('delete-plan');
      return complete();
    }),
    loadPublishingPlan: jest.fn().mockResolvedValue({
      sermonId: 's1',
      generation: 1,
      action: 'publish',
      lists: true,
      series: true,
      soundcloud: true,
      needsMedia: true,
      needsSoundCloud: true,
    }),
    ensurePublishingMedia: jest.fn().mockImplementation(async () => {
      trace.push('media');
      return complete();
    }),
    ensurePublishingSoundCloud: jest.fn().mockImplementation(async () => {
      trace.push('soundcloud');
      return complete();
    }),
    checkPublishingMediaReady: jest.fn().mockResolvedValue(complete()),
    checkPublishingSoundCloudReady: jest.fn().mockResolvedValue(complete()),
    recoverPublishingActivityFailure: jest
      .fn()
      .mockResolvedValue({ state: 'needs_review', code: 'PROVIDER_CREATE_AMBIGUOUS', receiptId: 'a'.repeat(64) }),
    projectPublishingAttention: jest.fn().mockResolvedValue(undefined),
    replacePublishingAudio: jest.fn().mockResolvedValue(complete()),
    applyPublishingLists: jest.fn().mockImplementation(async () => {
      trace.push('lists');
      return complete();
    }),
    applyPublishingSeries: jest.fn().mockImplementation(async () => {
      trace.push('series');
      return complete();
    }),
    updatePublishingMemberships: jest.fn().mockResolvedValue(complete()),
    updatePublishingMetadata: jest.fn().mockResolvedValue(complete()),
    cleanupPublishingProviders: jest.fn().mockResolvedValue(complete()),
    commitPublishingProjection: jest.fn().mockImplementation(async () => {
      trace.push('projection');
      return complete();
    }),
    reconcilePublishingState: jest.fn().mockResolvedValue(complete()),
  };
}
async function withControls(
  activities: ReturnType<typeof activityMocks>,
  worker: Worker,
  environment: TestWorkflowEnvironment,
  run: () => Promise<void>
) {
  const controls = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: 'urm-controls',
    activities,
  });
  await controls.runUntil(() => worker.runUntil(run));
}
describe('native publishing workflows', () => {
  let environment: TestWorkflowEnvironment;
  beforeEach(async () => {
    environment = await TestWorkflowEnvironment.createLocal();
  });
  afterEach(async () => {
    await environment?.teardown();
  });
  it('compiles successful private evidence pages promptly without replaying denied desired work', async () => {
    const activities = activityMocks();
    activities.loadPublishingPlan.mockResolvedValue({
      sermonId: 's1',
      generation: 1,
      action: 'publish',
      lists: true,
      series: false,
      soundcloud: false,
      needsMedia: true,
      needsSoundCloud: false,
    });
    activities.ensurePublishingMedia.mockResolvedValue({
      state: 'blocked',
      code: 'PUBLISHING_PERMISSION_CHANGED',
    } as any);
    activities.compilePublishingCriticalRepairEvidence
      .mockResolvedValueOnce({ state: 'pending', progressed: true } as any)
      .mockResolvedValueOnce({ state: 'pending', progressed: true } as any)
      .mockResolvedValueOnce({ state: 'pending', progressed: true } as any)
      .mockResolvedValue({ state: 'ready' });
    // No timer interceptor: this proves real production pagination introduces
    // no thirty-second delay between successful metadata activities.
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities,
    });
    await withControls(activities, worker, environment, async () => {
      const handle = await environment.client.workflow.start(publishingWorkflow, {
        workflowId: 'review-progress-real-clock',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      const deadline = Date.now() + 10000;
      while (activities.compilePublishingCriticalRepairEvidence.mock.calls.length < 4 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(activities.compilePublishingCriticalRepairEvidence).toHaveBeenCalledTimes(4);
      expect(activities.ensurePublishingMedia).toHaveBeenCalledTimes(1);
      expect(activities.applyPublishingLists).not.toHaveBeenCalled();
      expect(activities.commitPublishingProjection).not.toHaveBeenCalled();
      await handle.cancel();
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
      const history = await handle.fetchHistory();
      expect(
        (history.events ?? []).some(
          (event) => event.timerStartedEventAttributes?.startToFireTimeout?.seconds?.toString() === '30'
        )
      ).toBe(false);
      await Worker.runReplayHistory({ workflowsPath: require.resolve('./index') }, history);
    });
  });
  it('backs off pending evidence without authoritative progress instead of cycling or replaying work', async () => {
    const activities = activityMocks();
    activities.loadPublishingPlan.mockResolvedValue({
      sermonId: 's1',
      generation: 1,
      action: 'publish',
      lists: true,
      series: false,
      soundcloud: false,
      needsMedia: true,
      needsSoundCloud: false,
    });
    activities.ensurePublishingMedia.mockResolvedValue({
      state: 'blocked',
      code: 'PUBLISHING_PERMISSION_CHANGED',
    } as any);
    activities.compilePublishingCriticalRepairEvidence.mockResolvedValue({ state: 'pending' } as any);
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities,
    });
    await withControls(activities, worker, environment, async () => {
      const handle = await environment.client.workflow.start(publishingWorkflow, {
        workflowId: 'review-no-progress-real-clock',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      let backedOff = false;
      const deadline = Date.now() + 10000;
      while (!backedOff && Date.now() < deadline) {
        backedOff =
          (await handle.fetchHistory()).events?.some(
            (event) => event.timerStartedEventAttributes?.startToFireTimeout?.seconds?.toString() === '30'
          ) ?? false;
        if (!backedOff) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(backedOff).toBe(true);
      expect(activities.compilePublishingCriticalRepairEvidence).toHaveBeenCalledTimes(1);
      expect(activities.ensurePublishingMedia).toHaveBeenCalledTimes(1);
      await handle.cancel();
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
      await Worker.runReplayHistory({ workflowsPath: require.resolve('./index') }, await handle.fetchHistory());
    });
  });
  it('durably orders Subsplash steps and waits all destinations before success', async () => {
    const trace: string[] = [];
    const activities = activityMocks(trace);
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities,
      interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
    });
    await withControls(activities, worker, environment, async () => {
      const handle = await environment.client.workflow.start(publishingWorkflow, {
        workflowId: 'publish-order',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      const result = await handle.result();
      expect(result).toEqual(complete());
      expect(trace.indexOf('media')).toBeLessThan(trace.indexOf('lists'));
      expect(trace.indexOf('lists')).toBeLessThan(trace.indexOf('series'));
      expect(trace[trace.length - 1]).toBe('projection');
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'succeeded');
      await Worker.runReplayHistory(
        {
          workflowsPath: require.resolve('./index'),
          interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
        },
        await handle.fetchHistory()
      );
    });
  });
  it('does not automatically repeat an ambiguous create and resumes only after signal', async () => {
    const activities = activityMocks();
    activities.ensurePublishingMedia
      .mockRejectedValueOnce(new Error('worker interruption after external POST'))
      .mockResolvedValue(complete());
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities,
      interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
    });
    await withControls(activities, worker, environment, async () => {
      const handle = await environment.client.workflow.start(publishingWorkflow, {
        workflowId: 'publish-ambiguity',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      for (let count = 0; count < 100; count += 1) {
        const status = await handle.query(publishingStatus);
        if (status.state === 'needs_review') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(activities.ensurePublishingMedia).toHaveBeenCalledTimes(1);
      expect(activities.recoverPublishingActivityFailure).toHaveBeenCalledWith(ref, 'subsplash-media', undefined);
      expect(activities.applyPublishingLists).not.toHaveBeenCalled();
      await handle.signal(publishingResume);
      await handle.result();
      expect(activities.ensurePublishingMedia).toHaveBeenCalledTimes(2);
    });
  });
  it('awaits processed audio before provider replacement, membership edits and metadata', async () => {
    const trace: string[] = [];
    const activities = {
      ...activityMocks(trace),
      preparePublishingAudio: jest.fn(async () => {
        trace.push('audio');
        return { ...ref, jobId: 'audio-edit', sermonId: 's1', revision: 1, requestVersion: 'v1' };
      }),
      registerMediaObserver: jest.fn(),
      readMediaCompletion: jest.fn(async () => {
        trace.push('ready');
        return { kind: 'succeeded' };
      }),
    };
    activities.loadPublishingPlan.mockResolvedValue({
      sermonId: 's1',
      generation: 1,
      action: 'update',
      requiresAudio: true,
      requiresMemberships: true,
    });
    activities.replacePublishingAudio.mockImplementation(async () => {
      trace.push('replace');
      return complete();
    });
    activities.updatePublishingMemberships.mockImplementation(async () => {
      trace.push('memberships');
      return complete();
    });
    activities.updatePublishingMetadata.mockImplementation(async () => {
      trace.push('metadata');
      return complete();
    });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('../index'),
      activities,
      interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
    });
    await withControls(activities, worker, environment, async () => {
      await environment.client.workflow.execute(publishingWorkflow, {
        workflowId: 'publish-edit-ordered',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      expect(trace).toEqual(['audio', 'ready', 'replace', 'memberships', 'metadata', 'projection']);
    });
  });
  it('drains media before destructive deletion and releases retained references before canonical deletion', async () => {
    const trace: string[] = [];
    const activities = {
      ...activityMocks(trace),
      preparePublishingDeletion: jest.fn(async () => ({
        ...ref,
        jobId: 'audio-job',
        sermonId: 's1',
        revision: 1,
        requestVersion: 'v1',
      })),
      prepareDeletionEffects: jest.fn(async () => {
        trace.push('effects');
      }),
      clearPublishingDeletionGuard: jest.fn(),
      releaseDeletedSermonArtifacts: jest.fn(async () => {
        trace.push('release');
      }),
      requestMediaCancellation: jest.fn(async () => {
        trace.push('cancel-media');
      }),
      registerMediaObserver: jest.fn(),
      readMediaCompletion: jest.fn(async () => {
        trace.push('drained');
        return { kind: 'cancelled' };
      }),
    };
    activities.loadPublishingPlan.mockResolvedValue({ sermonId: 's1', generation: 1, action: 'delete' });
    activities.cleanupPublishingProviders.mockImplementation(async () => {
      trace.push('providers');
      return complete();
    });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('../index'),
      activities,
      interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
    });
    await withControls(activities, worker, environment, async () => {
      await environment.client.workflow.execute(publishingWorkflow, {
        workflowId: 'publish-delete-drain',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      expect(trace).toEqual([
        'cancel-media',
        'drained',
        'delete-plan',
        'effects',
        'providers',
        'release',
        'projection',
      ]);
      expect(activities.clearPublishingDeletionGuard).not.toHaveBeenCalled();
    });
  });
  it('prepares and enters the critical phase before local-only deletion effects or artifact release', async () => {
    const trace: string[] = [],
      activities = {
        ...activityMocks(trace),
        preparePublishingDeletion: jest.fn(async () => null),
        prepareDeletionEffects: jest.fn(async () => {
          trace.push('effects');
        }),
        clearPublishingDeletionGuard: jest.fn(),
        releaseDeletedSermonArtifacts: jest.fn(async () => {
          trace.push('release');
        }),
      };
    activities.loadPublishingPlan.mockResolvedValue({
      sermonId: 's1',
      generation: 1,
      action: 'delete',
      needsMedia: false,
      needsSoundCloud: false,
    });
    activities.cleanupPublishingProviders.mockImplementation(async () => {
      trace.push('providers');
      return complete();
    });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities,
      interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
    });
    await withControls(activities, worker, environment, async () => {
      await environment.client.workflow.execute(publishingWorkflow, {
        workflowId: 'delete-local-only-plan',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      expect(trace).toEqual(['delete-plan', 'effects', 'providers', 'release', 'projection']);
      expect(activities.preparePublishingDeletePlan).toHaveBeenCalledTimes(1);
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'succeeded');
    });
  });
  it('cancellation during reversible preparation cannot reach deletion effects or retained artifacts', async () => {
    let started = false;
    const activities = {
      ...activityMocks(),
      preparePublishingDeletion: jest.fn(async () => null),
      prepareDeletionEffects: jest.fn(),
      clearPublishingDeletionGuard: jest.fn(),
      releaseDeletedSermonArtifacts: jest.fn(),
    };
    activities.loadPublishingPlan.mockResolvedValue({ sermonId: 's1', generation: 1, action: 'delete' });
    activities.preparePublishingDeletePlan.mockImplementation(async () => {
      started = true;
      const context = Context.current(),
        timer = setInterval(() => {
          try {
            context.heartbeat();
          } catch {}
        }, 50);
      try {
        await context.cancelled;
        throw new Error('Unexpected cancellation completion');
      } finally {
        clearInterval(timer);
      }
    });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities,
      interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
      maxHeartbeatThrottleInterval: '100 milliseconds',
      defaultHeartbeatThrottleInterval: '100 milliseconds',
    });
    await withControls(activities, worker, environment, async () => {
      const handle = await environment.client.workflow.start(publishingWorkflow, {
        workflowId: 'delete-local-preparation-cancel',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      for (let count = 0; count < 100 && !started; count++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(started).toBe(true);
      await handle.cancel();
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
      expect(activities.prepareDeletionEffects).not.toHaveBeenCalled();
      expect(activities.releaseDeletedSermonArtifacts).not.toHaveBeenCalled();
      expect(activities.commitPublishingProjection).not.toHaveBeenCalled();
      expect(activities.clearPublishingDeletionGuard).toHaveBeenCalledWith(ref);
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'cancelled');
    });
  });
  it('permission loss after a local-only critical plan preserves live review before irreversible effects', async () => {
    const activities = {
      ...activityMocks(),
      preparePublishingDeletion: jest.fn(async () => null),
      prepareDeletionEffects: jest.fn(async () => {
        throw ApplicationFailure.nonRetryable('Permission changed', 'PERMISSION_CHANGED');
      }),
      clearPublishingDeletionGuard: jest.fn(),
      releaseDeletedSermonArtifacts: jest.fn(),
    };
    activities.loadPublishingPlan.mockResolvedValue({ sermonId: 's1', generation: 1, action: 'delete' });
    activities.recoverPublishingActivityFailure.mockResolvedValue({ state: 'blocked', code: 'PERMISSION_CHANGED' });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities,
      interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
    });
    await withControls(activities, worker, environment, async () => {
      const handle = await environment.client.workflow.start(publishingWorkflow, {
        workflowId: 'delete-local-after-critical-revocation',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      let status;
      for (let count = 0; count < 100; count++) {
        status = await handle.query(publishingStatus);
        if (status.code === 'PERMISSION_CHANGED') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(status).toMatchObject({ state: 'blocked', step: 'delete-plan', code: 'PERMISSION_CHANGED' });
      expect(activities.preparePublishingDeletePlan).toHaveBeenCalledTimes(1);
      expect(activities.finishDurableJob).not.toHaveBeenCalled();
      expect(activities.releaseDeletedSermonArtifacts).not.toHaveBeenCalled();
      expect(activities.commitPublishingProjection).not.toHaveBeenCalled();
      await handle.cancel();
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
    });
  });
  it('keeps cancellation live for reviewed cleanup after a lost POST response without restarting publication', async () => {
    const activities = activityMocks();
    activities.ensurePublishingMedia.mockRejectedValue(new Error('lost response after POST'));
    activities.cleanupCancelledPublishing
      .mockResolvedValueOnce({
        state: 'needs_review',
        code: 'PROVIDER_CREATE_AMBIGUOUS',
        receiptId: 'a'.repeat(64),
        cancelOnly: true,
      })
      .mockResolvedValue({ state: 'completed', cancelOnly: true });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities,
      interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
    });
    await withControls(activities, worker, environment, async () => {
      const handle = await environment.client.workflow.start(publishingWorkflow, {
        workflowId: 'publish-cancel-unknown-review',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      for (let count = 0; count < 100; count++) {
        const status = await handle.query(publishingStatus);
        if (status.state === 'needs_review') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await handle.cancel();
      let status;
      for (let count = 0; count < 100; count++) {
        status = await handle.query(publishingStatus);
        if (status.state === 'cancel_requested' && activities.cleanupCancelledPublishing.mock.calls.length) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(status).toMatchObject({ state: 'cancel_requested', step: 'cleanup' });
      expect(activities.finishDurableJob).not.toHaveBeenCalled();
      expect(activities.ensurePublishingMedia).toHaveBeenCalledTimes(1);
      await handle.signal(publishingResume);
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
      expect(activities.cleanupCancelledPublishing).toHaveBeenCalledTimes(2);
      expect(activities.ensurePublishingMedia).toHaveBeenCalledTimes(1);
      expect(activities.applyPublishingLists).not.toHaveBeenCalled();
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'cancelled');
    });
  });
  it('continues long cancellation proof waits with bounded history and never restarts desired work', async () => {
    const activities = activityMocks();
    let checks = 0;
    activities.cleanupCancelledPublishing.mockImplementation(async () =>
      ++checks <= 201
        ? { state: 'blocked', code: 'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING', cancelOnly: true }
        : { state: 'completed', cancelOnly: true }
    );
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities,
      interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
    });
    await withControls(activities, worker, environment, async () => {
      const handle = await environment.client.workflow.start(publishingWorkflow, {
        workflowId: 'publish-long-cancel-proof',
        taskQueue: 'urm-orchestration',
        args: [ref, { cleanupOnly: true }],
      });
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
      expect(activities.beginDurableCleanup).toHaveBeenCalledTimes(2);
      expect(activities.beginDurableJob).not.toHaveBeenCalled();
      expect(activities.loadPublishingPlan).not.toHaveBeenCalled();
      expect(activities.ensurePublishingMedia).not.toHaveBeenCalled();
      expect(activities.ensurePublishingSoundCloud).not.toHaveBeenCalled();
      expect(activities.cleanupCancelledPublishing).toHaveBeenCalledTimes(202);
      expect(activities.releasePublishingAudio).toHaveBeenCalledTimes(1);
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'cancelled');
    });
  });
  it('drains desired work for reviewed critical repair, then keeps unknown allocations in the cleanup barrier', async () => {
    const activities = activityMocks();
    activities.applyPublishingLists.mockResolvedValue({ state: 'blocked', code: 'PUBLISHING_PERMISSION_CHANGED' });
    activities.cleanupCancelledPublishing
      .mockResolvedValueOnce({ state: 'needs_review', code: 'PROVIDER_CREATE_AMBIGUOUS', cancelOnly: true })
      .mockResolvedValue({ state: 'completed', cancelOnly: true });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities,
      interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
    });
    await withControls(activities, worker, environment, async () => {
      const handle = await environment.client.workflow.start(publishingWorkflow, {
        workflowId: 'publish-critical-repair',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      for (let count = 0; count < 100; count++) {
        const status = await handle.query(publishingStatus);
        if (status.step === 'lists' && status.state === 'blocked') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await handle.signal(publishingCriticalRepair, { certificateId: 'b'.repeat(64) });
      for (let count = 0; count < 100; count++) {
        const status = await handle.query(publishingStatus);
        if (status.step === 'cleanup' && activities.cleanupCancelledPublishing.mock.calls.length) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(activities.repairPublishingCritical).toHaveBeenCalledWith(ref, 'b'.repeat(64));
      expect(activities.applyPublishingLists).toHaveBeenCalledTimes(1);
      expect(activities.applyPublishingSeries).not.toHaveBeenCalled();
      expect(activities.commitPublishingProjection).not.toHaveBeenCalled();
      expect(activities.finishDurableJob).not.toHaveBeenCalled();
      await handle.signal(publishingResume);
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'cancelled');
    });
  });
  it('marks explicit cancellation durably without pretending it succeeded', async () => {
    const activities = activityMocks();
    activities.ensurePublishingMedia.mockResolvedValue({ state: 'needs_review', code: 'PROVIDER_CREATE_AMBIGUOUS' });
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities,
      interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
    });
    await withControls(activities, worker, environment, async () => {
      const handle = await environment.client.workflow.start(publishingWorkflow, {
        workflowId: 'publish-cancel',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      for (let count = 0; count < 100; count += 1) {
        const status = await handle.query(publishingStatus);
        if (status.state === 'needs_review') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await handle.cancel();
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'cancelled');
      expect(activities.commitPublishingProjection).not.toHaveBeenCalled();
    });
  });
  it('late original response wakes only the private evidence compiler', async () => {
    const activities = activityMocks();
    activities.ensurePublishingMedia.mockResolvedValue({
      state: 'needs_review',
      code: 'PROVIDER_MUTATION_UNRESOLVED',
    } as any);
    activities.compilePublishingCriticalRepairEvidence.mockResolvedValue({ state: 'unavailable' } as any);
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities,
      interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
    });
    await withControls(activities, worker, environment, async () => {
      const handle = await environment.client.workflow.start(publishingWorkflow, {
        workflowId: 'metadata-evidence-only',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      for (let i = 0; i < 100 && !activities.compilePublishingCriticalRepairEvidence.mock.calls.length; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      const prior = activities.compilePublishingCriticalRepairEvidence.mock.calls.length;
      await handle.signal(publishingEvidenceAvailable, {
        ...ref,
        generation: 1,
        sessionId: 'a'.repeat(64),
        factId: 'b'.repeat(64),
      });
      for (let i = 0; i < 100 && activities.compilePublishingCriticalRepairEvidence.mock.calls.length <= prior; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(activities.compilePublishingCriticalRepairEvidence.mock.calls.length).toBeGreaterThan(prior);
      expect(activities.ensurePublishingMedia).toHaveBeenCalledTimes(1);
      expect(activities.applyPublishingLists).not.toHaveBeenCalled();
      expect(activities.commitPublishingProjection).not.toHaveBeenCalled();
      await handle.cancel();
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
      await Worker.runReplayHistory(
        {
          workflowsPath: require.resolve('./index'),
          interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
        },
        await handle.fetchHistory()
      );
    });
  });
  it('review continuation does not reload a desired plan after metadata wakeup', async () => {
    const activities = activityMocks();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities,
      interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
    });
    await withControls(activities, worker, environment, async () => {
      const handle = await environment.client.workflow.start(publishingWorkflow, {
        workflowId: 'review-only-evidence',
        taskQueue: 'urm-orchestration',
        args: [ref, { reviewOnly: { step: 'projection' } }],
      });
      for (let i = 0; i < 100 && !activities.compilePublishingCriticalRepairEvidence.mock.calls.length; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      await handle.signal(publishingEvidenceAvailable, {
        ...ref,
        generation: 1,
        sessionId: 'a'.repeat(64),
        factId: 'c'.repeat(64),
      });
      await handle.signal(publishingResume);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(activities.loadPublishingPlan).not.toHaveBeenCalled();
      expect(activities.updatePublishingMetadata).not.toHaveBeenCalled();
      expect(activities.beginDurableReview).toHaveBeenCalledWith(ref);
      await handle.cancel();
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'cancelled');
    });
  });

  it('bounded deletion settlement waits remain reviewable and never report premature success', async () => {
    const activities = activityMocks();
    activities.loadPublishingPlan.mockResolvedValue({ sermonId: 's1', generation: 1, action: 'reconcile' } as any);
    activities.commitPublishingProjection.mockResolvedValue({
      state: 'failed',
      code: 'PUBLISHING_DELETION_SETTLEMENT_PENDING',
    } as any);
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities,
      interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
    });
    await withControls(activities, worker, environment, async () => {
      const handle = await environment.client.workflow.start(publishingWorkflow, {
        workflowId: 'deletion-settlement-budget',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      const wait = handle.result();
      wait.catch(() => {});
      for (let i = 0; i < 300 && !activities.projectPublishingAttention.mock.calls.length; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(activities.commitPublishingProjection).toHaveBeenCalledTimes(121);
      expect(activities.projectPublishingAttention).toHaveBeenCalledWith(
        ref,
        'projection',
        'PUBLISHING_DELETION_SETTLEMENT_REVIEW_REQUIRED',
        undefined
      );
      expect(activities.finishDurableJob).not.toHaveBeenCalled();
      await handle.cancel();
      await expect(wait).rejects.toBeInstanceOf(WorkflowFailedError);
    });
  });

  it('a source-approved reviewed create checkpoint resumes only its saved unfinished stages', async () => {
    const activities = activityMocks(),
      checkpointId = 'd'.repeat(64);
    activities.loadPublishingCreateReviewContinuation.mockResolvedValue({
      workflow: 'publishing',
      waitingStep: 'subsplash-media',
      completedStages: ['ensurePublishingSoundCloud', 'checkPublishingSoundCloudReady'],
      plan: {
        sermonId: 's1',
        generation: 1,
        action: 'publish',
        lists: true,
        series: true,
        soundcloud: true,
        needsMedia: true,
        needsSoundCloud: true,
      },
    } as any);
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'urm-orchestration',
      workflowsPath: require.resolve('./index'),
      activities,
      interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
    });
    await withControls(activities, worker, environment, async () => {
      const handle = await environment.client.workflow.start(publishingWorkflow, {
        workflowId: 'reviewed-create-stage-checkpoint',
        taskQueue: 'urm-orchestration',
        args: [ref, { reviewOnly: { step: 'subsplash-media', checkpointId } }],
      });
      for (let i = 0; i < 100 && !activities.compilePublishingCriticalRepairEvidence.mock.calls.length; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      await handle.signal(publishingEvidenceAvailable, {
        ...ref,
        generation: 1,
        sessionId: 'a'.repeat(64),
        factId: 'b'.repeat(64),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(activities.loadPublishingCreateReviewContinuation).not.toHaveBeenCalled();
      expect(activities.ensurePublishingMedia).not.toHaveBeenCalled();
      await handle.signal(publishingResume);
      await handle.result();
      expect(activities.loadPublishingCreateReviewContinuation).toHaveBeenCalledWith(ref, checkpointId);
      expect(activities.loadPublishingPlan).not.toHaveBeenCalled();
      expect(activities.ensurePublishingSoundCloud).not.toHaveBeenCalled();
      expect(activities.checkPublishingSoundCloudReady).not.toHaveBeenCalled();
      expect(activities.ensurePublishingMedia).toHaveBeenCalledTimes(1);
      expect(activities.checkPublishingMediaReady).toHaveBeenCalledTimes(1);
      expect(activities.applyPublishingLists).toHaveBeenCalledTimes(1);
      expect(activities.applyPublishingSeries).toHaveBeenCalledTimes(1);
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'succeeded');
      await Worker.runReplayHistory(
        {
          workflowsPath: require.resolve('./index'),
          interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
        },
        await handle.fetchHistory()
      );
    });
  });
  it('an unapproved checkpoint resume remains live without a desired activity', async () => {
    const activities = activityMocks(),
      worker = await Worker.create({
        connection: environment.nativeConnection,
        taskQueue: 'urm-orchestration',
        workflowsPath: require.resolve('./index'),
        activities,
        interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
      });
    await withControls(activities, worker, environment, async () => {
      const handle = await environment.client.workflow.start(publishingWorkflow, {
        workflowId: 'reviewed-create-no-authority',
        taskQueue: 'urm-orchestration',
        args: [ref, { reviewOnly: { step: 'subsplash-media', checkpointId: 'e'.repeat(64) } }],
      });
      await handle.signal(publishingResume);
      for (let i = 0; i < 100 && !activities.loadPublishingCreateReviewContinuation.mock.calls.length; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(activities.loadPublishingCreateReviewContinuation).toHaveBeenCalledTimes(1);
      expect(activities.loadPublishingPlan).not.toHaveBeenCalled();
      expect(activities.ensurePublishingMedia).not.toHaveBeenCalled();
      expect(activities.finishDurableJob).not.toHaveBeenCalled();
      await handle.cancel();
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
    });
  });

  it.each(['not_started', 'partial'])(
    'a certified %s stop preserves content without running desired or residual cleanup',
    async (providerEffects) => {
      const activities = activityMocks();
      activities.repairPublishingCritical.mockResolvedValue({
        state: 'completed',
        mode: 'partial_stop',
        contentPreserved: true,
        providerEffects,
      } as any);
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        taskQueue: 'urm-orchestration',
        workflowsPath: require.resolve('./index'),
        activities,
        interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
      });
      await withControls(activities, worker, environment, async () => {
        const handle = await environment.client.workflow.start(publishingWorkflow, {
          workflowId: `preserved-stop-${providerEffects}`,
          taskQueue: 'urm-orchestration',
          args: [ref, { criticalRepairCertificateId: 'f'.repeat(64) }],
        });
        await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
        expect(activities.repairPublishingCritical).toHaveBeenCalledTimes(1);
        expect(activities.cleanupCancelledPublishing).not.toHaveBeenCalled();
        expect(activities.releasePublishingAudio).not.toHaveBeenCalled();
        expect(activities.loadPublishingPlan).not.toHaveBeenCalled();
        expect(activities.cleanupPublishingProviders).not.toHaveBeenCalled();
        expect(activities.commitPublishingProjection).not.toHaveBeenCalled();
        expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'cancelled');
        await Worker.runReplayHistory(
          {
            workflowsPath: require.resolve('./index'),
            interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
          },
          await handle.fetchHistory()
        );
      });
    }
  );
});
