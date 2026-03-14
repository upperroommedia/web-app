import { Sermon, sermonStatusType, uploadStatus } from '../types/SermonTypes';

export const SERIES_PUBLISH_BLOCKED_MESSAGE =
  'This sermon audio is still processing. Wait until processing is complete before publishing to a Subsplash series.';

export const canPublishSermonToSeries = (sermon?: Sermon | null): boolean => {
  if (!sermon) {
    return false;
  }

  // If the media item is already in Subsplash, series assignment does not depend on local processing state.
  if (sermon.subsplashId || sermon.status?.subsplash === uploadStatus.UPLOADED) {
    return true;
  }

  return sermon.status?.audioStatus === sermonStatusType.PROCESSED;
};

