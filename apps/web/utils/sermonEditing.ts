import { Sermon, sermonStatusType, uploadStatus } from '../types/SermonTypes';

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

export function canEditSermonRecord(sermon?: Sermon | null): boolean {
  if (!sermon) return false;
  return !isSermonProcessingLocked(sermon) && !isSermonPublishedExternally(sermon);
}

export function canEditSermonAudio(sermon?: Sermon | null): boolean {
  if (!sermon) return false;
  if (!canEditSermonRecord(sermon)) return false;
  if (typeof sermon.trimDurationSeconds !== 'number' || sermon.trimDurationSeconds <= 0) return false;
  return Boolean(sermon.youtubeUrl) || sermon.audioSource !== 'subsplash';
}
