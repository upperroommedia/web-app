import { createEmptySermon } from '../types/Sermon';
import { sermonStatusType, uploadStatus } from '../types/SermonTypes';
import { createEmptySermonList } from '../types/SermonList';
import { ListType } from '../types/List';
import {
  canEditSermonMetadata,
  canEditSermonAudio,
  canEditSermonRecord,
  isSermonProcessingLocked,
} from './sermonEditing';

describe('sermonEditing helpers', () => {
  it('blocks all editing while audio is pending or processing', () => {
    const pending = createEmptySermon('user-1');
    pending.status.audioStatus = sermonStatusType.PENDING;

    const processing = createEmptySermon('user-1');
    processing.status.audioStatus = sermonStatusType.PROCESSING;

    expect(isSermonProcessingLocked(pending)).toBe(true);
    expect(isSermonProcessingLocked(processing)).toBe(true);
    expect(canEditSermonMetadata(pending)).toBe(false);
    expect(canEditSermonMetadata(processing)).toBe(false);
    expect(canEditSermonRecord(pending)).toBe(false);
    expect(canEditSermonRecord(processing)).toBe(false);
  });

  it('disables audio editing for legacy sermons without trimDurationSeconds', () => {
    const sermon = createEmptySermon('user-1');
    delete sermon.trimDurationSeconds;
    sermon.status.audioStatus = sermonStatusType.PROCESSED;

    expect(canEditSermonMetadata(sermon)).toBe(true);
    expect(canEditSermonRecord(sermon)).toBe(true);
    expect(canEditSermonAudio(sermon)).toBe(false);
  });

  it('allows audio editing for editable source-backed sermons with trim settings', () => {
    const sermon = createEmptySermon('user-1');
    sermon.status.audioStatus = sermonStatusType.PROCESSED;
    sermon.trimDurationSeconds = 1200;

    expect(canEditSermonMetadata(sermon)).toBe(true);
    expect(canEditSermonRecord(sermon)).toBe(true);
    expect(canEditSermonAudio(sermon)).toBe(true);
  });

  it('allows metadata editing but blocks audio editing for externally published sermons', () => {
    const sermon = createEmptySermon('user-1');
    sermon.status.audioStatus = sermonStatusType.PROCESSED;
    sermon.trimDurationSeconds = 1200;
    sermon.status.soundCloud = uploadStatus.UPLOADED;

    expect(canEditSermonMetadata(sermon)).toBe(true);
    expect(canEditSermonRecord(sermon)).toBe(true);
    expect(canEditSermonAudio(sermon)).toBe(false);
  });

  it('blocks audio editing when any published list would show an unpublish action', () => {
    const sermon = createEmptySermon('user-1');
    sermon.status.audioStatus = sermonStatusType.PROCESSED;
    sermon.trimDurationSeconds = 1200;

    const publishedList = createEmptySermonList(ListType.TOPIC_LIST);
    publishedList.uploadStatus = { status: uploadStatus.UPLOADED, listItemId: 'row-1' };

    const unpublishedList = createEmptySermonList(ListType.TOPIC_LIST);
    unpublishedList.uploadStatus = { status: uploadStatus.NOT_UPLOADED };

    expect(canEditSermonAudio(sermon, [publishedList, unpublishedList])).toBe(false);
  });

  it('blocks audio editing when the sermon series is already published', () => {
    const sermon = createEmptySermon('user-1');
    sermon.status.audioStatus = sermonStatusType.PROCESSED;
    sermon.trimDurationSeconds = 1200;
    sermon.seriesPublishedToSubsplash = true;

    expect(canEditSermonAudio(sermon)).toBe(false);
  });
});
