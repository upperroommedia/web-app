import { createEmptySermon } from '../types/Sermon';
import { sermonStatusType, uploadStatus } from '../types/SermonTypes';
import { createEmptySermonList } from '../types/SermonList';
import { ListType } from '../types/List';
import {
  assertSermonNotProcessing,
  canEditSermonMetadata,
  canEditSermonAudio,
  requiresSoundCloudAudioPolicy,
  canEditSermonRecord,
  isSermonProcessingConflict,
  isSermonProcessingLocked,
  SermonProcessingConflictError,
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

  it('raises a recognizable conflict when processing starts during an edit', () => {
    const processing = createEmptySermon('user-1');
    processing.status.audioStatus = sermonStatusType.PROCESSING;

    expect(() => assertSermonNotProcessing(processing)).toThrow(SermonProcessingConflictError);

    try {
      assertSermonNotProcessing(processing);
    } catch (error) {
      expect(isSermonProcessingConflict(error)).toBe(true);
      expect((error as Error).message).toContain('Wait for processing to finish');
    }
  });

  it('allows a non-processing sermon through the edit guard', () => {
    const sermon = createEmptySermon('user-1');
    sermon.status.audioStatus = sermonStatusType.ERROR;

    expect(() => assertSermonNotProcessing(sermon)).not.toThrow();
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

  it('allows durable source-backed audio editing for externally published sermons', () => {
    const sermon = createEmptySermon('user-1');
    sermon.status.audioStatus = sermonStatusType.PROCESSED;
    sermon.trimDurationSeconds = 1200;
    sermon.status.soundCloud = uploadStatus.UPLOADED;

    expect(canEditSermonMetadata(sermon)).toBe(true);
    expect(canEditSermonRecord(sermon)).toBe(true);
    expect(canEditSermonAudio(sermon)).toBe(true);
  });

  it('allows durable audio editing when a list is already published', () => {
    const sermon = createEmptySermon('user-1');
    sermon.status.audioStatus = sermonStatusType.PROCESSED;
    sermon.trimDurationSeconds = 1200;

    const publishedList = createEmptySermonList(ListType.TOPIC_LIST);
    publishedList.uploadStatus = { status: uploadStatus.UPLOADED, listItemId: 'row-1' };

    const unpublishedList = createEmptySermonList(ListType.TOPIC_LIST);
    unpublishedList.uploadStatus = { status: uploadStatus.NOT_UPLOADED };

    expect(canEditSermonAudio(sermon, [publishedList, unpublishedList])).toBe(true);
  });

  it('allows durable audio editing when the sermon series is already published', () => {
    const sermon = createEmptySermon('user-1');
    sermon.status.audioStatus = sermonStatusType.PROCESSED;
    sermon.trimDurationSeconds = 1200;
    sermon.seriesPublishedToSubsplash = true;

    expect(canEditSermonAudio(sermon)).toBe(true);
  });

  it('requires an available original source and finite trim settings', () => {
    const sermon = createEmptySermon('user-1');
    sermon.status.audioStatus = sermonStatusType.PROCESSED;
    sermon.trimDurationSeconds = 1200;
    expect(canEditSermonAudio(sermon, [], false)).toBe(false);
    sermon.youtubeUrl = 'https://www.youtube.com/watch?v=source';
    expect(canEditSermonAudio(sermon, [], false)).toBe(true);
    sermon.trimDurationSeconds = NaN;
    expect(canEditSermonAudio(sermon)).toBe(false);
    sermon.trimDurationSeconds = 1200;
    sermon.sourceStartTime = -1;
    expect(canEditSermonAudio(sermon)).toBe(false);
  });

  it('uses a retained immutable source even when the legacy playback provider is Subsplash', () => {
    const sermon = createEmptySermon('user-1');
    sermon.status.audioStatus = sermonStatusType.PROCESSED;
    sermon.trimDurationSeconds = 1200;
    sermon.audioSource = 'subsplash';
    expect(canEditSermonAudio(sermon)).toBe(false);
    sermon.audioArtifacts = {
      jobId: 'job-1',
      requestVersion: 'v1',
      revision: 1,
      sourcePath: 'immutable/source',
      sourceDurationSeconds: 1500,
      processedPath: 'immutable/processed',
      finalPath: 'immutable/final',
      durationSeconds: 1200,
    };
    expect(canEditSermonAudio(sermon, [], true)).toBe(true);
  });
  it('requires an audio policy for a confirmed SoundCloud track even if a legacy status flag is stale', () => {
    const sermon = createEmptySermon('user-1');
    sermon.status.soundCloud = uploadStatus.NOT_UPLOADED;
    expect(requiresSoundCloudAudioPolicy(sermon)).toBe(false);
    sermon.soundCloudTrackId = 'track-1';
    expect(requiresSoundCloudAudioPolicy(sermon)).toBe(true);
    delete sermon.soundCloudTrackId;
    sermon.status.soundCloud = uploadStatus.UPLOADED;
    expect(requiresSoundCloudAudioPolicy(sermon)).toBe(true);
  });
});
