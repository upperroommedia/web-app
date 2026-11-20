const mockInfo = {
  namespace: 'urm-app-staging.qwejt',
  taskQueue: 'urm-media-kernel-recovery',
  activityType: 'admitMediaRecoveryWork',
  activityId: 'media-recovery-admit',
  workflowType: 'MediaRecoveryProbe',
  workflowExecution: {
    workflowId: 'media-recovery-12345678-1234-1234-1234-123456789abc',
    runId: '12345678-1234-1234-1234-123456789def',
  },
};
jest.mock('@temporalio/activity', () => ({
  Context: { current: () => ({ info: mockInfo, cancellationSignal: new AbortController().signal }) },
}));
import { createMediaRecoveryWorkActivities } from './media-recovery-work';
test('native Describe private errors never enter Activity failures or causes', async () => {
  const sentinel = 'PRIVATE-OPERATOR@example.test request-token-NEVER-EXPORT';
  const nativeDescribe = jest.fn(async () => {
    throw new Error(sentinel);
  });
  const activities = createMediaRecoveryWorkActivities({
    firestore: { projectId: 'urm-app-staging', databaseId: '(default)' } as never,
    auth: {} as never,
    bucket: { name: 'urm-app-staging.firebasestorage.app', storage: { retryOptions: { autoRetry: false } } } as never,
    client: {
      connection: { withDeadline: async (_: unknown, run: () => Promise<unknown>) => run() },
      workflow: {
        getHandle: () => ({
          describe: nativeDescribe,
        }),
      },
    } as never,
    witness: { instanceId: '12345678-1234-1234-1234-123456789aaa', buildId: 'a'.repeat(40) },
  });
  let failure: unknown;
  try {
    await activities.admitMediaRecoveryWork({
      operationId: '12345678-1234-1234-1234-123456789abc',
      startNonce: '12345678-1234-1234-1234-123456789aaa',
    });
  } catch (e) {
    failure = e;
  }
  expect(nativeDescribe).toHaveBeenCalledTimes(1);
  expect(failure).toMatchObject({ type: 'MEDIA_RECOVERY_WORK_UNCONFIRMED', nonRetryable: true });
  expect(String(failure)).not.toContain(sentinel);
  expect((failure as Error).cause).toBeUndefined();
});

import { mediaRecoveryNativeStart, mediaRecoveryPinnedVersion } from './media-recovery-work';
import { defaultPayloadConverter } from '@temporalio/common';
import { workerReadinessDigest as hash } from './readiness-probe';
const nativeInput = {
  operationId: '12345678-1234-1234-1234-123456789abc',
  startNonce: '12345678-1234-1234-1234-123456789aaa',
};
const nativeRun = '12345678-1234-1234-1234-123456789def';
const nativeFirst = () => ({
  eventId: '1',
  eventTime: { seconds: '2000', nanos: 0 },
  workflowExecutionStartedEventAttributes: {
    workflowType: { name: 'MediaRecoveryProbe' },
    taskQueue: { name: 'urm-media-kernel-recovery' },
    versioningOverride: {
      pinned: {
        behavior: 1,
        version: { deploymentName: 'urm-worker-media-recovery-staging', buildId: 'a'.repeat(40) },
      },
    },
    originalExecutionRunId: nativeRun,
    firstExecutionRunId: nativeRun,
    input: { payloads: [defaultPayloadConverter.toPayload(nativeInput)] },
  },
});
const nativeAttempt = () => ({
  deploymentVersion: { deploymentName: 'urm-worker-media-recovery-staging', buildId: 'a'.repeat(40) },
  nonce: nativeInput.startNonce,
  inputSHA256: hash(nativeInput),
  attemptedAt: new Date(1999999).toISOString(),
});
test('native original-start proof binds source input, queue, original chain and saved nonce/time', () => {
  expect(mediaRecoveryNativeStart(nativeFirst(), nativeAttempt(), nativeInput, nativeRun)).toMatch(/^[a-f0-9]{64}$/);
});
test.each(['preexisting', 'wrong-input', 'wrong-queue', 'continued', 'foreign-original', 'missing-nonce'])(
  'native original-start proof denies %s',
  (mode) => {
    const event = nativeFirst(),
      attempt = nativeAttempt();
    if (mode === 'preexisting') attempt.attemptedAt = new Date(2000001).toISOString();
    if (mode === 'wrong-input')
      event.workflowExecutionStartedEventAttributes.input.payloads = [
        defaultPayloadConverter.toPayload({ ...nativeInput, operationId: nativeInput.startNonce }),
      ];
    if (mode === 'wrong-queue') event.workflowExecutionStartedEventAttributes.taskQueue.name = 'urm-media';
    if (mode === 'continued')
      Object.assign(event.workflowExecutionStartedEventAttributes, { continuedExecutionRunId: nativeRun });
    if (mode === 'foreign-original')
      event.workflowExecutionStartedEventAttributes.originalExecutionRunId = nativeInput.startNonce;
    if (mode === 'missing-nonce') attempt.nonce = '';
    expect(() => mediaRecoveryNativeStart(event, attempt, nativeInput, nativeRun)).toThrow();
  }
);

test('native original-start proof denies an original pinned-override mismatch', () => {
  const event = nativeFirst();
  Object.assign(event.workflowExecutionStartedEventAttributes, {
    versioningOverride: { pinned: { behavior: 1, version: { deploymentName: 'foreign', buildId: 'b'.repeat(40) } } },
  });
  expect(() =>
    mediaRecoveryNativeStart(
      event,
      {
        ...nativeAttempt(),
        deploymentVersion: { deploymentName: 'urm-worker-media-recovery-staging', buildId: 'a'.repeat(40) },
      },
      nativeInput,
      nativeRun
    )
  ).toThrow();
});

test.each(['missing', 'auto', 'other-build', 'deprecated', 'ambiguous'])(
  'current native override denies %s despite last deployment match',
  (mode) => {
    const expected = { deploymentName: 'urm-worker-media-recovery-staging', buildId: 'a'.repeat(40) };
    const v: any = { pinned: { behavior: 1, version: expected } };
    if (mode === 'missing') delete v.pinned;
    if (mode === 'auto') {
      delete v.pinned;
      v.autoUpgrade = {};
    }
    if (mode === 'other-build') v.pinned.version = { ...expected, buildId: 'b'.repeat(40) };
    if (mode === 'deprecated') v.pinned.deployment = { seriesName: expected.deploymentName, buildId: expected.buildId };
    if (mode === 'ambiguous') v.autoUpgrade = {};
    expect(() => mediaRecoveryPinnedVersion(v, expected)).toThrow();
  }
);
