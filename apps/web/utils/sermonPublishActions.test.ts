import { buildBasicPublishActionPlan, createIdleDestinationActivityState, summarizeAdvancedSelectionChanges } from './sermonPublishActions';
import { ListType, OverflowBehavior } from '../types/List';
import { SermonList } from '../types/SermonList';
import { uploadStatus } from '../types/SermonTypes';

const buildList = (overrides: Partial<SermonList>): SermonList => ({
  id: overrides.id || 'list-1',
  name: overrides.name || 'List',
  images: overrides.images || [],
  overflowBehavior: overrides.overflowBehavior || OverflowBehavior.CREATENEWLIST,
  type: overrides.type || ListType.TOPIC_LIST,
  createdAtMillis: overrides.createdAtMillis ?? 0,
  updatedAtMillis: overrides.updatedAtMillis ?? 0,
  uploadStatus: overrides.uploadStatus || { status: uploadStatus.NOT_UPLOADED },
  publishGeneration: overrides.publishGeneration ?? 0,
  subsplashId: overrides.subsplashId,
});

describe('sermonPublishActions', () => {
  it('reports no changes when nothing is selected to publish or unpublish', () => {
    expect(
      summarizeAdvancedSelectionChanges({
        publishListCount: 0,
        unpublishListCount: 0,
        publishSeries: false,
        unpublishSeries: false,
        publishSoundCloud: false,
        unpublishSoundCloud: false,
      })
    ).toEqual({
      label: 'No destination changes selected',
      hasChanges: false,
      hasPublishChanges: false,
      hasUnpublishChanges: false,
      isMixedDirection: false,
      isPureUnpublish: false,
    });
  });

  it('builds a publish-only label across lists, series, and SoundCloud', () => {
    expect(
      summarizeAdvancedSelectionChanges({
        publishListCount: 2,
        unpublishListCount: 0,
        publishSeries: true,
        unpublishSeries: false,
        publishSoundCloud: true,
        unpublishSoundCloud: false,
      })
    ).toEqual({
      label: 'Publish to 2 lists, series, SoundCloud',
      hasChanges: true,
      hasPublishChanges: true,
      hasUnpublishChanges: false,
      isMixedDirection: false,
      isPureUnpublish: false,
    });
  });

  it('builds an unpublish-only label across lists, series, and SoundCloud', () => {
    expect(
      summarizeAdvancedSelectionChanges({
        publishListCount: 0,
        unpublishListCount: 1,
        publishSeries: false,
        unpublishSeries: true,
        publishSoundCloud: false,
        unpublishSoundCloud: true,
      })
    ).toEqual({
      label: 'Unpublish from 1 list, series, SoundCloud',
      hasChanges: true,
      hasPublishChanges: false,
      hasUnpublishChanges: true,
      isMixedDirection: false,
      isPureUnpublish: true,
    });
  });

  it('builds a mixed-direction label when publish and unpublish changes coexist', () => {
    expect(
      summarizeAdvancedSelectionChanges({
        publishListCount: 3,
        unpublishListCount: 1,
        publishSeries: false,
        unpublishSeries: true,
        publishSoundCloud: true,
        unpublishSoundCloud: false,
      })
    ).toEqual({
      label: 'Publish to 3 lists, SoundCloud and unpublish from 1 list, series',
      hasChanges: true,
      hasPublishChanges: true,
      hasUnpublishChanges: true,
      isMixedDirection: true,
      isPureUnpublish: false,
    });
  });

  describe('buildBasicPublishActionPlan', () => {
    it('builds a publish-only action for unpublished destinations', () => {
      expect(buildBasicPublishActionPlan({
        lists: [
          buildList({ id: 'list-a', uploadStatus: { status: uploadStatus.NOT_UPLOADED } }),
          buildList({ id: 'list-b', uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-1' } }),
        ],
        hasSeriesId: false,
        seriesPublished: false,
        canPublishToSeries: false,
        isSoundCloudUploaded: false,
        isDevelopment: false,
      })).toEqual({
        publishListIds: ['list-a'],
        unpublishListIds: ['list-b'],
        publishSeries: false,
        unpublishSeries: false,
        publishSoundCloud: true,
        unpublishSoundCloud: false,
        publishLabel: 'Publish to 1 list, SoundCloud',
        hasPublishTargets: true,
        hasUnpublishTargets: true,
        showPublishButton: true,
        showUnpublishButton: true,
      });
    });

    it('treats failed destinations as publish targets and excludes blocked series', () => {
      expect(buildBasicPublishActionPlan({
        lists: [
          buildList({ id: 'list-a', uploadStatus: { status: uploadStatus.ERROR, reason: 'Boom' } }),
        ],
        hasSeriesId: true,
        seriesPublished: false,
        canPublishToSeries: false,
        isSoundCloudUploaded: true,
        isDevelopment: false,
      })).toEqual({
        publishListIds: ['list-a'],
        unpublishListIds: [],
        publishSeries: false,
        unpublishSeries: false,
        publishSoundCloud: false,
        unpublishSoundCloud: true,
        publishLabel: 'Publish to 1 list',
        hasPublishTargets: true,
        hasUnpublishTargets: true,
        showPublishButton: true,
        showUnpublishButton: true,
      });
    });

    it('builds an unpublish-only state when everything is already published', () => {
      expect(buildBasicPublishActionPlan({
        lists: [
          buildList({ id: 'list-a', uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'row-1' } }),
        ],
        hasSeriesId: true,
        seriesPublished: true,
        canPublishToSeries: true,
        isSoundCloudUploaded: true,
        isDevelopment: false,
      })).toEqual({
        publishListIds: [],
        unpublishListIds: ['list-a'],
        publishSeries: false,
        unpublishSeries: true,
        publishSoundCloud: false,
        unpublishSoundCloud: true,
        publishLabel: 'Nothing to publish',
        hasPublishTargets: false,
        hasUnpublishTargets: true,
        showPublishButton: false,
        showUnpublishButton: true,
      });
    });

    it('treats an unresolved series publish state as publishable for newly assigned series', () => {
      expect(buildBasicPublishActionPlan({
        lists: [],
        hasSeriesId: true,
        seriesPublished: null,
        canPublishToSeries: true,
        isSoundCloudUploaded: true,
        isDevelopment: false,
      })).toEqual({
        publishListIds: [],
        unpublishListIds: [],
        publishSeries: true,
        unpublishSeries: false,
        publishSoundCloud: false,
        unpublishSoundCloud: true,
        publishLabel: 'Publish to series',
        hasPublishTargets: true,
        hasUnpublishTargets: true,
        showPublishButton: true,
        showUnpublishButton: true,
      });
    });

    it('returns no publish targets when nothing is configured or eligible', () => {
      expect(buildBasicPublishActionPlan({
        lists: [],
        hasSeriesId: false,
        seriesPublished: null,
        canPublishToSeries: false,
        isSoundCloudUploaded: false,
        isDevelopment: true,
      })).toEqual({
        publishListIds: [],
        unpublishListIds: [],
        publishSeries: false,
        unpublishSeries: false,
        publishSoundCloud: false,
        unpublishSoundCloud: false,
        publishLabel: 'Nothing to publish',
        hasPublishTargets: false,
        hasUnpublishTargets: false,
        showPublishButton: false,
        showUnpublishButton: false,
      });
    });
  });

  describe('createIdleDestinationActivityState', () => {
    it('starts with no active destination operations', () => {
      expect(createIdleDestinationActivityState()).toEqual({
        listOperation: 'idle',
        listIds: [],
        seriesOperation: 'idle',
        soundCloudOperation: 'idle',
      });
    });
  });
});
