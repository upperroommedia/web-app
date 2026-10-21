import {
  validateHistoricalMediaRecoveryCapacity,
  validateMediaStartupCapacityEvidence,
  mediaStartupBudget,
} from './media-startup-capacity';
import { MEDIA_ALLOCATION_PROGRAM_SHA256 } from './media-capacity-allocation';
const GiB = 1024 ** 3;
function evidence() {
  const at = new Date(Date.now() - 3600000).toISOString();
  return {
    schemaVersion: 3,
    budgets: mediaStartupBudget,
    totalBytes: 100 * GiB,
    availableBytes: 90 * GiB,
    canaryBytes: 1024 * 1024,
    writeReadFsync: true,
    cleanupConfirmed: true,
    reservationReleased: true,
    observedAt: at,
    allocation: {
      schemaVersion: 1,
      requestedBytes: 64 * GiB,
      allocatedBytes: 64 * GiB,
      pythonSHA256: 'a'.repeat(64),
      programSHA256: MEDIA_ALLOCATION_PROGRAM_SHA256,
      filesystemDevice: 2,
      fileInode: 123,
      availableBytesAfterAllocation: 26 * GiB,
      minimumAvailableBytesWhileHeld: 26 * GiB,
      startedAt: at,
      releasedAt: at,
      cleanupConfirmed: true,
    },
    processing: {
      schemaVersion: 1,
      ffmpegSHA256: 'b'.repeat(64),
      ffprobeSHA256: 'c'.repeat(64),
      sourceBytes: 32044,
      outputBytes: 32044,
      sampleRate: 16000,
      channels: 1,
      durationSeconds: 1,
      pcmSamplesVerified: 16000,
      progressBeforeCancellation: true,
      cancelledChildDrained: true,
      retryCompleted: true,
    },
  };
}
test('historical exact startup can be read without renewing live capacity authority', () => {
  const e = evidence();
  expect(() => validateMediaStartupCapacityEvidence(e, e.observedAt)).toThrow();
  expect(validateHistoricalMediaRecoveryCapacity(e, e.observedAt, e.observedAt)).toEqual(e);
  expect(() => validateHistoricalMediaRecoveryCapacity(e, e.observedAt, new Date().toISOString())).toThrow();
});
test.each(['old-schema', 'before-birth', 'after-registration', 'sparse', 'undrained'])(
  'historical collection still rejects invalid original capacity / %s',
  (mode) => {
    const e = evidence();
    let birth = e.observedAt,
      registered = e.observedAt;
    if (mode === 'old-schema') e.schemaVersion = 2;
    if (mode === 'before-birth') birth = new Date(Date.parse(e.observedAt) + 1).toISOString();
    if (mode === 'after-registration') registered = new Date(Date.parse(e.observedAt) - 1).toISOString();
    if (mode === 'sparse') e.allocation.allocatedBytes = 1;
    if (mode === 'undrained') e.processing.cancelledChildDrained = false;
    expect(() => validateHistoricalMediaRecoveryCapacity(e, birth, registered)).toThrow();
  }
);

import { waitForMediaRecoveryEpisode } from './media-recovery-collector';
import { workerReadinessDigest as hash } from './readiness-probe';
import { randomUUID } from 'node:crypto';
function waitingFixture() {
  const id = randomUUID(),
    runId = randomUUID(),
    buildId = 'a'.repeat(40),
    op = { mediaRecoveryWorkflowStart: { nonce: randomUUID() } },
    control = { x: 'control' },
    state = { x: 'state' };
  const version = { deploymentName: 'urm-worker-media-recovery-staging', buildId };
  const describe = jest.fn(async () => ({
    raw: {
      workflowExecutionInfo: {
        status: 2,
        execution: { workflowId: `media-recovery-${id}`, runId },
        versioningInfo: {
          behavior: 1,
          deploymentVersion: version,
          versioningOverride: { pinned: { behavior: 1, version } },
        },
      },
    },
  }));
  const data: any = {
    temporalReleaseOperation: op,
    temporalRelease: control,
    temporalReleaseState: state,
    [`temporalMediaRecoveryStart-${id}`]: {
      stage: 'confirmed',
      runId,
      intentSHA256: hash(op.mediaRecoveryWorkflowStart),
    },
    [`temporalMediaRecoveryKernel-${id}`]: { stage: 'closed', close: { signal: 'SIGKILL', descendantsAbsent: true } },
    [`temporalMediaRecoveryReplacementKernel-${id}`]: {
      stage: 'closed',
      close: { code: 0, signal: null, descendantsAbsent: true },
    },
    [`temporalMediaRecoveryReplacementCompleted-${id}`]: {},
    [`temporalMediaRecoveryReplacementStop-${id}`]: {},
  };
  const db: any = {
    doc: (p: string) => p,
    runTransaction: jest.fn(async (fn: any) =>
      fn({
        get: async (p: string) => {
          const value = data[p.split('/').at(-1)!];
          return {
            exists: value !== undefined,
            data: () => value,
            get: (path: string) => path.split('.').reduce((v: any, k) => v?.[k], value),
          };
        },
      })
    ),
  };
  const client: any = {
    workflow: { getHandle: jest.fn(() => ({ describe })) },
    connection: { withDeadline: async (_end: number, fn: () => unknown) => fn() },
  };
  return {
    describe,
    db,
    options: {
      db,
      client,
      operationId: id,
      runId,
      plan: { buildId, expiresAt: Date.now() + 300000 },
      expectedRootSHA256: hash(op),
      expectedControlSHA256: hash(control),
      expectedStateSHA256: hash(state),
    },
  };
}
test('historical completed episode reconciles after the original polling window without renewed work', async () => {
  const f = waitingFixture();
  f.options.plan.expiresAt = Date.now() - 3600000;
  await expect(waitForMediaRecoveryEpisode(f.options)).resolves.toBeUndefined();
  expect(f.describe).toHaveBeenCalledTimes(1);
});
test.each(['never-settled', 'late-settlement'])(
  'GET-only episode wait bounds stalled native transactions / %s',
  async (mode) => {
    jest.useFakeTimers();
    try {
      const f = waitingFixture();
      let resolve: ((v: boolean) => void) | undefined;
      f.db.runTransaction.mockImplementation(
        () =>
          new Promise<boolean>((r) => {
            resolve = r;
          })
      );
      let result = 'pending';
      const promise = waitForMediaRecoveryEpisode(f.options).then(
        () => {
          result = 'accepted';
        },
        () => {
          result = 'rejected';
        }
      );
      await jest.advanceTimersByTimeAsync(5001);
      if (mode === 'late-settlement') {
        resolve!(true);
        await jest.advanceTimersByTimeAsync(1);
      }
      expect(result).toBe('rejected');
      expect(f.describe).not.toHaveBeenCalled();
      await promise;
    } finally {
      jest.useRealTimers();
    }
  }
);
