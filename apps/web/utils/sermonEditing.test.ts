import { createEmptySermon } from '../types/Sermon';
import { sermonStatusType, uploadStatus } from '../types/SermonTypes';
import {
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
    expect(canEditSermonRecord(pending)).toBe(false);
    expect(canEditSermonRecord(processing)).toBe(false);
  });

  it('disables audio editing for legacy sermons without trimDurationSeconds', () => {
    const sermon = createEmptySermon('user-1');
    delete sermon.trimDurationSeconds;
    sermon.status.audioStatus = sermonStatusType.PROCESSED;

    expect(canEditSermonRecord(sermon)).toBe(true);
    expect(canEditSermonAudio(sermon)).toBe(false);
  });

  it('allows audio editing for editable source-backed sermons with trim settings', () => {
    const sermon = createEmptySermon('user-1');
    sermon.status.audioStatus = sermonStatusType.PROCESSED;
    sermon.trimDurationSeconds = 1200;

    expect(canEditSermonRecord(sermon)).toBe(true);
    expect(canEditSermonAudio(sermon)).toBe(true);
  });

  it('blocks editing for externally published sermons', () => {
    const sermon = createEmptySermon('user-1');
    sermon.status.audioStatus = sermonStatusType.PROCESSED;
    sermon.trimDurationSeconds = 1200;
    sermon.status.soundCloud = uploadStatus.UPLOADED;

    expect(canEditSermonRecord(sermon)).toBe(false);
    expect(canEditSermonAudio(sermon)).toBe(false);
  });
});
