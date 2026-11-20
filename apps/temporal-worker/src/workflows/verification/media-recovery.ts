import { ApplicationFailure, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { MediaJobRef, MediaOutcome } from '../../../../process-audio/src/temporal/types';
/** Fixed private diagnostic: admission and a single acquire Activity only.
 * No merge, publication, providers, children, signals or continuation. */
export async function MediaRecoveryProbe(input: { operationId: string; startNonce: string }) {
  const info = workflowInfo();
  if (
    !input ||
    Object.keys(input).sort().join(',') !== 'operationId,startNonce' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.startNonce) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.operationId) ||
    info.workflowId !== `media-recovery-${input.operationId}` ||
    info.taskQueue !== 'urm-media-kernel-recovery' ||
    info.namespace !== 'urm-app-staging.qwejt' ||
    info.runId !== info.firstExecutionRunId ||
    info.runId !== info.originalExecutionRunId ||
    info.continuedFromExecutionRunId
  )
    throw ApplicationFailure.nonRetryable('Invalid private media diagnostic', 'INVALID_MEDIA_RECOVERY_PROBE');
  const admission = proxyActivities<{
    admitMediaRecoveryWork(x: {
      operationId: string;
      startNonce: string;
    }): Promise<{ ref: MediaJobRef; grantSHA256: string }>;
  }>({
    taskQueue: 'urm-media-kernel-recovery',
    activityId: 'media-recovery-admit',
    startToCloseTimeout: '30 seconds',
    scheduleToCloseTimeout: '90 seconds',
    retry: { maximumAttempts: 2 },
  });
  const work = await admission.admitMediaRecoveryWork(input);
  if (
    !work ||
    Object.keys(work).sort().join(',') !== 'grantSHA256,ref' ||
    !work.ref ||
    Object.keys(work.ref).sort().join(',') !== 'jobId,projectId,requestVersion,revision,sermonId' ||
    work.ref.projectId !== 'urm-app-staging' ||
    work.ref.jobId !== info.workflowId ||
    work.ref.sermonId !== info.workflowId ||
    work.ref.revision !== 1 ||
    !/^[a-f0-9]{16}$/.test(work.ref.requestVersion) ||
    !/^[a-f0-9]{64}$/.test(work.grantSHA256)
  )
    throw ApplicationFailure.nonRetryable('Invalid private media grant', 'INVALID_MEDIA_RECOVERY_GRANT');
  const media = proxyActivities<{ acquireMedia(ref: MediaJobRef): Promise<MediaOutcome> }>({
    taskQueue: 'urm-media-kernel-recovery',
    activityId: 'media-recovery-acquire',
    startToCloseTimeout: '30 seconds',
    scheduleToCloseTimeout: '90 seconds',
    heartbeatTimeout: '15 seconds',
    retry: { maximumAttempts: 2, initialInterval: '1 second', maximumInterval: '1 second' },
  });
  const result = await media.acquireMedia(work.ref);
  if (result?.kind !== 'ready')
    throw ApplicationFailure.nonRetryable(
      'Private source acquisition did not settle',
      'MEDIA_RECOVERY_ACQUISITION_UNCONFIRMED'
    );
  return { operationId: input.operationId, runId: info.runId, grantSHA256: work.grantSHA256 };
}
