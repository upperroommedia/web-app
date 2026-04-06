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
    sermon.status.audioStatus === sermonStatusType.PENDING ||
    sermon.status.audioStatus === sermonStatusType.PROCESSING
  );
}

export function isSermonPublishedExternally(sermon?: Sermon | null): boolean {
  if (!sermon) return false;
  return (
    sermon.status.soundCloud === uploadStatus.UPLOADED ||
    sermon.status.subsplash === uploadStatus.UPLOADED
  );
}

export function isSermonPublishedAnywhere(
  sermon?: Sermon | null,
  publishedLists: PublishedListState[] = []
): boolean {
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

export function canEditSermonAudio(sermon?: Sermon | null, publishedLists: PublishedListState[] = []): boolean {
  if (!sermon) return false;
  if (!canEditSermonMetadata(sermon)) return false;
  if (isSermonPublishedAnywhere(sermon, publishedLists)) return false;
  if (typeof sermon.trimDurationSeconds !== 'number' || sermon.trimDurationSeconds <= 0) return false;
  return Boolean(sermon.youtubeUrl) || sermon.audioSource !== 'subsplash';
}
