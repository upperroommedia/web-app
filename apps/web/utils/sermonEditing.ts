import { Sermon, sermonStatusType, uploadStatus } from '../types/SermonTypes';

type PublishedListState = {
  id?: string;
  uploadStatus?: {
    status?: uploadStatus;
  };
};

export function isSermonProcessingLocked(sermon?: Sermon | null): boolean {
  if (!sermon) return false;
  return (
    sermon.status?.audioStatus === sermonStatusType.PENDING ||
    sermon.status?.audioStatus === sermonStatusType.PROCESSING
  );
}

export class SermonProcessingConflictError extends Error {
  constructor() {
    super(
      'Audio processing started while this sermon was being edited. Wait for processing to finish, then try again.'
    );
    this.name = 'SermonProcessingConflictError';
  }
}

export function assertSermonNotProcessing(sermon?: Sermon | null): void {
  if (isSermonProcessingLocked(sermon)) {
    throw new SermonProcessingConflictError();
  }
}

export function isSermonProcessingConflict(error: unknown): error is SermonProcessingConflictError {
  return error instanceof SermonProcessingConflictError;
}

export function isSermonPublishedExternally(sermon?: Sermon | null): boolean {
  if (!sermon) return false;
  return sermon.status.soundCloud === uploadStatus.UPLOADED || sermon.status.subsplash === uploadStatus.UPLOADED;
}

export function isSermonPublishedAnywhere(sermon?: Sermon | null, publishedLists: PublishedListState[] = []): boolean {
  if (!sermon) return false;

  if (isSermonPublishedExternally(sermon)) {
    return true;
  }

  if (sermon.seriesPublishedToSubsplash === true) {
    return true;
  }

  return publishedLists.some((list) => list.uploadStatus?.status === uploadStatus.UPLOADED);
}

export function canEditSermonMetadata(sermon?: Sermon | null): boolean {
  if (!sermon) return false;
  return !isSermonProcessingLocked(sermon);
}

export function canEditSermonRecord(sermon?: Sermon | null): boolean {
  return canEditSermonMetadata(sermon);
}

export function canEditSermonAudio(
  sermon?: Sermon | null,
  _publishedLists: PublishedListState[] = [],
  sourceAvailable?: boolean
): boolean {
  if (!sermon) return false;
  if (!canEditSermonMetadata(sermon)) return false;
  if (
    typeof sermon.trimDurationSeconds !== 'number' ||
    !Number.isFinite(sermon.trimDurationSeconds) ||
    sermon.trimDurationSeconds <= 0
  )
    return false;
  if (!Number.isFinite(sermon.sourceStartTime) || sermon.sourceStartTime < 0) return false;
  if (sermon.youtubeUrl) return true;
  if (sourceAvailable === false) return false;
  return Boolean(sermon.audioArtifacts?.sourcePath) || sermon.audioSource !== 'subsplash';
}

/** Legacy publication flags may lag a confirmed track ID; either requires an explicit audio policy. */
export function requiresSoundCloudAudioPolicy(sermon?: Sermon | null): boolean {
  return Boolean(sermon?.soundCloudTrackId) || sermon?.status.soundCloud === uploadStatus.UPLOADED;
}
