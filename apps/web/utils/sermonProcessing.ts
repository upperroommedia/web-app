import { isDurableJobTerminal, type DurableJob } from '@upperroom/contracts/temporal';
import { sermonStatusType } from '../types/SermonTypes';
import { measuredStepPercent } from './durableJobPresentation';

export function getSermonProcessing(
  jobs: readonly DurableJob[],
  audioStatus: sermonStatusType | undefined,
  stale: boolean
) {
  const mediaJobs = jobs.filter((job) => job.kind === 'audio.process' || job.kind === 'upload.create');
  const active = mediaJobs.filter((job) => !isDurableJobTerminal(job.state));
  const job = active.find((candidate) => candidate.kind === 'audio.process') ?? active[0];
  const endedUpload =
    !job &&
    !stale &&
    audioStatus === sermonStatusType.PENDING &&
    mediaJobs[0]?.kind === 'upload.create' &&
    ['cancelled', 'superseded', 'failed'].includes(mediaJobs[0].state)
      ? mediaJobs[0]
      : undefined;
  const pending =
    !endedUpload && (job?.state === 'awaiting_source' || (!job && audioStatus === sermonStatusType.PENDING));
  const processing = Boolean(job && !pending) || (!job && audioStatus === sermonStatusType.PROCESSING);
  const step = job?.steps.find((current) => ['running', 'retrying', 'waiting'].includes(current.state));
  const measuring = !stale && job?.state === 'running' && step?.state === 'running';
  const percent = measuring && step ? measuredStepPercent(step) : undefined;
  const labels: Partial<Record<DurableJob['state'], string>> = {
    awaiting_source: 'Waiting for file',
    queued: 'Queued',
    cancel_requested: 'Cancellation requested',
    needs_attention: 'Needs attention',
    retrying: 'Retrying',
    waiting_for_auth: 'Waiting for YouTube sign-in',
    reconciling: 'Checking processing status',
  };
  const label = stale
    ? 'Reconnecting'
    : endedUpload
    ? endedUpload.state === 'failed'
      ? 'Upload failed'
      : 'Upload stopped'
    : (job && labels[job.state]) ?? step?.label ?? (pending ? 'Pending processing' : 'Processing audio');
  const showBar = processing && !stale && (!job || job.state === 'running' || job.state === 'queued');
  return { pending, processing, stopped: Boolean(endedUpload), label, percent, showBar };
}

/** The recorded audio job belongs to this accepted source and this Sermon. */
export function confirmedSermonAudioJob(source: DurableJob | undefined, audio: DurableJob | undefined) {
  if (
    source?.kind === 'upload.create' &&
    source.state === 'succeeded' &&
    audio?.kind === 'audio.process' &&
    audio.jobId === source.result?.mediaJobId &&
    audio.projectId === source.projectId &&
    audio.entity.type === source.entity.type &&
    audio.entity.id === source.entity.id
  )
    return audio;
}
