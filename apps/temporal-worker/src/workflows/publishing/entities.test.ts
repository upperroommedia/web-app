import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { publishingEntityWorkflow } from './entities';
import { publishingResume } from './index';
jest.setTimeout(120000);
async function createTestWorkers(
  environment: TestWorkflowEnvironment,
  activities: Record<string, any>,
  accelerateTimers = true
) {
  activities = {
    beginDurableCleanup: jest.fn(),
    compilePublishingCriticalRepairEvidence: jest.fn().mockResolvedValue({ state: 'ready' }),
    ...activities,
  };
  const provider = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: 'urm-orchestration',
    workflowsPath: require.resolve('./entities'),
    activities,
    ...(accelerateTimers ? { interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] } } : {}),
  });
  const controls = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: 'urm-controls',
    activities,
  });
  return { runUntil: (run: () => Promise<void>) => controls.runUntil(() => provider.runUntil(run)) };
}

it('recovers an activity interruption into receipt review without another mutation until an authorized resume', async () => {
  const environment = await TestWorkflowEnvironment.createLocal();
  const ref = { projectId: 'test-project', jobId: 'entity-crash-job' };
  const activities = {
    beginDurableJob: jest.fn(),
    finishDurableJob: jest.fn(),
    executePublishingEntityActivity: jest
      .fn()
      .mockRejectedValueOnce(new Error('worker crashed after POST'))
      .mockResolvedValue({ state: 'completed', result: { listId: 'canonical' } }),
    recoverPublishingEntityFailure: jest
      .fn()
      .mockResolvedValue({ state: 'needs_review', code: 'PROVIDER_CREATE_AMBIGUOUS', receiptId: 'a'.repeat(64) }),
    projectPublishingEntityAttention: jest.fn(),
  };
  try {
    const worker = await createTestWorkers(environment, activities);
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(publishingEntityWorkflow, {
        workflowId: 'entity-crash-review',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      for (let count = 0; count < 100 && !activities.recoverPublishingEntityFailure.mock.calls.length; count++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(activities.recoverPublishingEntityFailure).toHaveBeenCalledWith(ref);
      expect(activities.executePublishingEntityActivity).toHaveBeenCalledTimes(1);
      expect(activities.finishDurableJob).not.toHaveBeenCalled();
      await handle.signal(publishingResume);
      expect(await handle.result()).toEqual({ listId: 'canonical' });
      expect(activities.executePublishingEntityActivity).toHaveBeenCalledTimes(2);
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'succeeded');
      await Worker.runReplayHistory(
        {
          workflowsPath: require.resolve('./entities'),
          interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
        },
        await handle.fetchHistory()
      );
    });
  } finally {
    await environment.teardown();
  }
});
it('keeps an unknown allocation in cancellation cleanup until resolution and never reruns the desired mutation', async () => {
  const environment = await TestWorkflowEnvironment.createLocal();
  const ref = { projectId: 'test-project', jobId: 'entity-cancel-job' };
  const activities = {
    beginDurableJob: jest.fn(),
    finishDurableJob: jest.fn(),
    executePublishingEntityActivity: jest
      .fn()
      .mockResolvedValue({ state: 'needs_review', code: 'PROVIDER_CREATE_AMBIGUOUS', receiptId: 'a'.repeat(64) }),
    recoverPublishingEntityFailure: jest.fn(),
    cleanupCancelledPublishingEntity: jest
      .fn()
      .mockResolvedValueOnce({
        state: 'needs_review',
        code: 'PROVIDER_CREATE_AMBIGUOUS',
        receiptId: 'a'.repeat(64),
        cancelOnly: true,
      })
      .mockResolvedValue({ state: 'completed', cancelOnly: true }),
    projectPublishingEntityAttention: jest.fn(),
  };
  try {
    const worker = await createTestWorkers(environment, activities);
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(publishingEntityWorkflow, {
        workflowId: 'entity-cancel-review',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      for (let count = 0; count < 100 && !activities.executePublishingEntityActivity.mock.calls.length; count++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      await handle.cancel();
      for (let count = 0; count < 100 && !activities.cleanupCancelledPublishingEntity.mock.calls.length; count++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(activities.cleanupCancelledPublishingEntity).toHaveBeenCalledWith(ref);
      expect(activities.finishDurableJob).not.toHaveBeenCalled();
      expect(activities.executePublishingEntityActivity).toHaveBeenCalledTimes(1);
      await handle.signal(publishingResume);
      await expect(handle.result()).rejects.toThrow();
      expect(activities.cleanupCancelledPublishingEntity).toHaveBeenCalledTimes(2);
      expect(activities.executePublishingEntityActivity).toHaveBeenCalledTimes(1);
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'cancelled');
      await Worker.runReplayHistory(
        {
          workflowsPath: require.resolve('./entities'),
          interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
        },
        await handle.fetchHistory()
      );
    });
  } finally {
    await environment.teardown();
  }
});

it('keeps cancellation live when cleanup loses authority and resumes only the cleanup after administrator review', async () => {
  const environment = await TestWorkflowEnvironment.createLocal();
  const ref = { projectId: 'test-project', jobId: 'entity-cancel-authority' };
  const activities = {
    beginDurableJob: jest.fn(),
    finishDurableJob: jest.fn(),
    executePublishingEntityActivity: jest
      .fn()
      .mockResolvedValue({ state: 'needs_review', code: 'PROVIDER_CREATE_AMBIGUOUS' }),
    cleanupCancelledPublishingEntity: jest
      .fn()
      .mockRejectedValueOnce(ApplicationFailure.nonRetryable('Original actor revoked', 'ROLE_REVOKED'))
      .mockResolvedValue({ state: 'completed', cancelOnly: true }),
    reportPublishingEntityCancellationFailure: jest
      .fn()
      .mockResolvedValue({ state: 'blocked', code: 'PUBLISHING_CANCEL_REPAIR_REQUIRED', cancelOnly: true }),
    recoverPublishingEntityFailure: jest.fn(),
    projectPublishingEntityAttention: jest.fn(),
  };
  try {
    const worker = await createTestWorkers(environment, activities);
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(publishingEntityWorkflow, {
        workflowId: 'entity-cancel-authority-review',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      for (let count = 0; count < 100 && !activities.executePublishingEntityActivity.mock.calls.length; count++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      await handle.cancel();
      for (
        let count = 0;
        count < 100 && !activities.reportPublishingEntityCancellationFailure.mock.calls.length;
        count++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(activities.reportPublishingEntityCancellationFailure).toHaveBeenCalledWith(ref);
      expect(activities.finishDurableJob).not.toHaveBeenCalled();
      await handle.signal(publishingResume);
      await expect(handle.result()).rejects.toThrow();
      expect(activities.cleanupCancelledPublishingEntity).toHaveBeenCalledTimes(2);
      expect(activities.executePublishingEntityActivity).toHaveBeenCalledTimes(1);
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'cancelled');
      await Worker.runReplayHistory(
        {
          workflowsPath: require.resolve('./entities'),
          interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
        },
        await handle.fetchHistory()
      );
    });
  } finally {
    await environment.teardown();
  }
});
it.each(['PUBLISHING_CANCEL_PROVIDER_FETCH_PENDING', 'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING'])(
  'polls known pending %s during cancellation without resuming mutations',
  async (code) => {
    const environment = await TestWorkflowEnvironment.createLocal();
    const ref = { projectId: 'test-project', jobId: 'entity-cancel-fetch' };
    const activities = {
      beginDurableJob: jest.fn(),
      finishDurableJob: jest.fn(),
      executePublishingEntityActivity: jest
        .fn()
        .mockResolvedValue({ state: 'blocked', code: 'PUBLISHING_AUDIO_PROCESSING' }),
      cleanupCancelledPublishingEntity: jest
        .fn()
        .mockResolvedValueOnce({ state: 'blocked', code, cancelOnly: true })
        .mockResolvedValueOnce({ state: 'blocked', code, cancelOnly: true })
        .mockResolvedValue({ state: 'completed', cancelOnly: true }),
      reportPublishingEntityCancellationFailure: jest.fn(),
      recoverPublishingEntityFailure: jest.fn(),
      projectPublishingEntityAttention: jest.fn(),
    };
    let desiredCallsAtCleanup = 0,
      cleanupChecks = 0;
    activities.cleanupCancelledPublishingEntity.mockReset().mockImplementation(async () => {
      if (!cleanupChecks) desiredCallsAtCleanup = activities.executePublishingEntityActivity.mock.calls.length;
      return ++cleanupChecks <= 2
        ? { state: 'blocked', code, cancelOnly: true }
        : { state: 'completed', cancelOnly: true };
    });
    try {
      const workers = await createTestWorkers(environment, activities);
      await workers.runUntil(async () => {
        const handle = await environment.client.workflow.start(publishingEntityWorkflow, {
          workflowId: 'entity-cancel-fetch-wait',
          taskQueue: 'urm-orchestration',
          args: [ref],
        });
        for (let count = 0; count < 100 && !activities.executePublishingEntityActivity.mock.calls.length; count++)
          await new Promise((resolve) => setTimeout(resolve, 20));
        await handle.cancel();
        await expect(handle.result()).rejects.toThrow();
        expect(activities.cleanupCancelledPublishingEntity).toHaveBeenCalledTimes(3);
        expect(desiredCallsAtCleanup).toBeGreaterThan(0);
        expect(activities.executePublishingEntityActivity).toHaveBeenCalledTimes(desiredCallsAtCleanup);
        expect(activities.reportPublishingEntityCancellationFailure).not.toHaveBeenCalled();
        expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'cancelled');
        await Worker.runReplayHistory(
          {
            workflowsPath: require.resolve('./entities'),
            interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
          },
          await handle.fetchHistory()
        );
      });
    } finally {
      await environment.teardown();
    }
  }
);

it('continues cancellation after 200 bounded polls into cleanup-only history without replaying the mutation', async () => {
  // The Java time-skipping fixture cannot ContinueAsNew with this SDK. Use the actual dev server and shorten timers through a test-only interceptor.
  const environment = await TestWorkflowEnvironment.createLocal();
  const ref = { projectId: 'test-project', jobId: 'entity-cancel-rotation' };
  let checks = 0;
  const activities = {
    beginDurableJob: jest.fn(),
    beginDurableCleanup: jest.fn(),
    finishDurableJob: jest.fn(),
    executePublishingEntityActivity: jest
      .fn()
      .mockResolvedValue({ state: 'needs_review', code: 'PROVIDER_CREATE_AMBIGUOUS' }),
    cleanupCancelledPublishingEntity: jest.fn(async () =>
      ++checks <= 200
        ? { state: 'blocked', code: 'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING', cancelOnly: true }
        : { state: 'completed', cancelOnly: true }
    ),
    reportPublishingEntityCancellationFailure: jest.fn(),
    recoverPublishingEntityFailure: jest.fn(),
    projectPublishingEntityAttention: jest.fn(),
  };
  try {
    const workers = await createTestWorkers(environment, activities, true);
    await workers.runUntil(async () => {
      const handle = await environment.client.workflow.start(publishingEntityWorkflow, {
        workflowId: 'entity-cancel-rotation',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      for (let count = 0; count < 100 && !activities.executePublishingEntityActivity.mock.calls.length; count++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
      expect(activities.cleanupCancelledPublishingEntity).toHaveBeenCalledTimes(201);
      expect(activities.beginDurableJob).toHaveBeenCalledTimes(1);
      expect(activities.beginDurableCleanup).toHaveBeenCalledTimes(1);
      expect(activities.executePublishingEntityActivity).toHaveBeenCalledTimes(1);
      expect(activities.finishDurableJob).toHaveBeenCalledTimes(1);
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'cancelled');
    });
  } finally {
    await environment.teardown();
  }
});

it('waits for an earlier allocation owner before admitting the new provider mutation', async () => {
  const environment = await TestWorkflowEnvironment.createLocal();
  const ref = { projectId: 'test-project', jobId: 'entity-allocation-wait' };
  const activities = {
    beginDurableJob: jest.fn(),
    finishDurableJob: jest.fn(),
    executePublishingEntityActivity: jest
      .fn()
      .mockResolvedValueOnce({
        state: 'blocked',
        code: 'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
        blockingJobId: 'prior-job',
      })
      .mockResolvedValueOnce({
        state: 'blocked',
        code: 'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
        blockingJobId: 'prior-job',
      })
      .mockResolvedValue({ state: 'completed', result: { seriesId: 'canonical-series' } }),
    recoverPublishingEntityFailure: jest.fn(),
    projectPublishingEntityAttention: jest.fn(),
  };
  try {
    const workers = await createTestWorkers(environment, activities);
    await workers.runUntil(async () => {
      const handle = await environment.client.workflow.start(publishingEntityWorkflow, {
        workflowId: 'entity-allocation-wait',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      expect(await handle.result()).toEqual({ seriesId: 'canonical-series' });
      expect(activities.executePublishingEntityActivity).toHaveBeenCalledTimes(3);
      expect(activities.projectPublishingEntityAttention).not.toHaveBeenCalled();
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'succeeded');
      await Worker.runReplayHistory(
        {
          workflowsPath: require.resolve('./entities'),
          interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
        },
        await handle.fetchHistory()
      );
    });
  } finally {
    await environment.teardown();
  }
});

it('runs only certificate repair after the administrator critical signal, then drains cancellation', async () => {
  const environment = await TestWorkflowEnvironment.createLocal();
  const ref = { projectId: 'test-project', jobId: 'entity-critical-repair' };
  const activities = {
    beginDurableJob: jest.fn(),
    finishDurableJob: jest.fn(),
    executePublishingEntityActivity: jest
      .fn()
      .mockResolvedValue({ state: 'blocked', code: 'PUBLISHING_PERMISSION_CHANGED' }),
    recoverPublishingEntityFailure: jest.fn(),
    projectPublishingEntityAttention: jest.fn(),
    repairPublishingCritical: jest.fn().mockResolvedValue({ state: 'completed' }),
    cleanupCancelledPublishingEntity: jest.fn().mockResolvedValue({ state: 'completed', cancelOnly: true }),
    reportPublishingEntityCancellationFailure: jest.fn(),
  };
  try {
    const worker = await createTestWorkers(environment, activities);
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(publishingEntityWorkflow, {
        workflowId: 'entity-critical-repair',
        taskQueue: 'urm-orchestration',
        args: [ref],
      });
      for (let count = 0; count < 100 && !activities.executePublishingEntityActivity.mock.calls.length; count++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      await handle.signal('publishingCriticalRepair', { certificateId: 'c'.repeat(64) });
      await expect(handle.result()).rejects.toThrow();
      expect(activities.executePublishingEntityActivity).toHaveBeenCalledTimes(1);
      expect(activities.repairPublishingCritical).toHaveBeenCalledWith(ref, 'c'.repeat(64));
      expect(activities.cleanupCancelledPublishingEntity).toHaveBeenCalledTimes(1);
      expect(activities.finishDurableJob).toHaveBeenCalled();
    });
  } finally {
    await environment.teardown();
  }
});

it('continues a source-reviewed create through the dedicated tail without replaying the entity handler', async () => {
  const environment = await TestWorkflowEnvironment.createLocal(),
    ref = { projectId: 'test-project', jobId: 'entity-reviewed-tail' },
    checkpointId = 'd'.repeat(64);
  const activities = {
    beginDurableReview: jest.fn(),
    finishDurableJob: jest.fn(),
    compilePublishingCriticalRepairEvidence: jest.fn().mockResolvedValue({ state: 'ready' }),
    executePublishingEntityActivity: jest.fn(),
    loadPublishingCreateReviewContinuation: jest
      .fn()
      .mockResolvedValue({ workflow: 'publishingEntity', waitingStep: 'entity' }),
    executeReviewedPublishingEntityCreate: jest
      .fn()
      .mockResolvedValue({ state: 'completed', result: { seriesId: 'known-series' } }),
  };
  try {
    const workers = await createTestWorkers(environment, activities);
    await workers.runUntil(async () => {
      const handle = await environment.client.workflow.start(publishingEntityWorkflow, {
        workflowId: 'entity-reviewed-tail',
        taskQueue: 'urm-orchestration',
        args: [ref, { reviewOnly: true, createReviewCheckpointId: checkpointId }],
      });
      for (let n = 0; n < 100 && !activities.beginDurableReview.mock.calls.length; n++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      await handle.signal('publishingEvidenceAvailable', {
        ...ref,
        generation: 1,
        sessionId: 'a'.repeat(64),
        factId: 'b'.repeat(64),
      });
      for (let n = 0; n < 100 && !activities.compilePublishingCriticalRepairEvidence.mock.calls.length; n++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(activities.loadPublishingCreateReviewContinuation).not.toHaveBeenCalled();
      expect(activities.executeReviewedPublishingEntityCreate).not.toHaveBeenCalled();
      await handle.signal(publishingResume);
      expect(await handle.result()).toEqual({ seriesId: 'known-series' });
      expect(activities.loadPublishingCreateReviewContinuation).toHaveBeenCalledWith(ref, checkpointId);
      expect(activities.executeReviewedPublishingEntityCreate).toHaveBeenCalledWith(ref, checkpointId);
      expect(activities.executePublishingEntityActivity).not.toHaveBeenCalled();
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'succeeded');
      await Worker.runReplayHistory(
        {
          workflowsPath: require.resolve('./entities'),
          interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
        },
        await handle.fetchHistory()
      );
    });
  } finally {
    await environment.teardown();
  }
});

it('keeps a rejected reviewed-create checkpoint live and cancels only through cleanup', async () => {
  const environment = await TestWorkflowEnvironment.createLocal(),
    ref = { projectId: 'test-project', jobId: 'entity-rejected-tail' },
    checkpointId = 'e'.repeat(64);
  const activities = {
    beginDurableReview: jest.fn(),
    finishDurableJob: jest.fn(),
    compilePublishingCriticalRepairEvidence: jest.fn().mockResolvedValue({ state: 'ready' }),
    executePublishingEntityActivity: jest.fn(),
    loadPublishingCreateReviewContinuation: jest.fn().mockResolvedValue(undefined),
    executeReviewedPublishingEntityCreate: jest.fn(),
    cleanupCancelledPublishingEntity: jest.fn().mockResolvedValue({ state: 'completed', cancelOnly: true }),
  };
  try {
    const workers = await createTestWorkers(environment, activities);
    await workers.runUntil(async () => {
      const handle = await environment.client.workflow.start(publishingEntityWorkflow, {
        workflowId: 'entity-rejected-tail',
        taskQueue: 'urm-orchestration',
        args: [ref, { reviewOnly: true, createReviewCheckpointId: checkpointId, resumeRequested: true }],
      });
      for (let n = 0; n < 100 && !activities.loadPublishingCreateReviewContinuation.mock.calls.length; n++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(activities.loadPublishingCreateReviewContinuation).toHaveBeenCalledWith(ref, checkpointId);
      expect(activities.executeReviewedPublishingEntityCreate).not.toHaveBeenCalled();
      expect(activities.executePublishingEntityActivity).not.toHaveBeenCalled();
      expect(activities.finishDurableJob).not.toHaveBeenCalled();
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
      expect(activities.cleanupCancelledPublishingEntity).toHaveBeenCalledTimes(1);
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'cancelled');
      await Worker.runReplayHistory(
        {
          workflowsPath: require.resolve('./entities'),
          interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
        },
        await handle.fetchHistory()
      );
    });
  } finally {
    await environment.teardown();
  }
});

it('certified preserved-content stop closes as cancelled without generic entity cleanup', async () => {
  const environment = await TestWorkflowEnvironment.createLocal(),
    ref = { projectId: 'test-project', jobId: 'entity-preserved-stop' };
  const activities = {
    beginDurableCriticalRepair: jest.fn(),
    finishDurableJob: jest.fn(),
    repairPublishingCritical: jest.fn().mockResolvedValue({
      state: 'completed',
      mode: 'partial_stop',
      contentPreserved: true,
      providerEffects: 'not_started',
    }),
    executePublishingEntityActivity: jest.fn(),
    cleanupCancelledPublishingEntity: jest.fn(),
  };
  try {
    const workers = await createTestWorkers(environment, activities);
    await workers.runUntil(async () => {
      const handle = await environment.client.workflow.start(publishingEntityWorkflow, {
        workflowId: 'entity-preserved-stop',
        taskQueue: 'urm-orchestration',
        args: [ref, { criticalRepairCertificateId: 'f'.repeat(64) }],
      });
      await expect(handle.result()).rejects.toThrow();
      expect(activities.cleanupCancelledPublishingEntity).not.toHaveBeenCalled();
      expect(activities.executePublishingEntityActivity).not.toHaveBeenCalled();
      expect(activities.finishDurableJob).toHaveBeenCalledWith(ref, 'cancelled');
      await Worker.runReplayHistory(
        {
          workflowsPath: require.resolve('./entities'),
          interceptors: { workflowModules: [require.resolve('./fastTimers.testFixture')] },
        },
        await handle.fetchHistory()
      );
    });
  } finally {
    await environment.teardown();
  }
});
