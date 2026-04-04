import { summarizeAdvancedSelectionChanges } from './sermonPublishActions';

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
});
