import { getSubsplashUnpublishStrategy } from './getSubsplashUnpublishStrategy';

describe('getSubsplashUnpublishStrategy', () => {
  it('returns none when the sermon has no subsplashId', () => {
    expect(getSubsplashUnpublishStrategy({
      hasSubsplashId: false,
      publishedListCount: 2,
      listCountToUnpublish: 2,
      seriesPublished: true,
      unpublishSeries: true,
      publishListCount: 0,
      publishSeries: false,
    })).toBe('none');
  });

  it('returns none when nothing is being unpublished from Subsplash', () => {
    expect(getSubsplashUnpublishStrategy({
      hasSubsplashId: true,
      publishedListCount: 2,
      listCountToUnpublish: 0,
      seriesPublished: false,
      unpublishSeries: false,
      publishListCount: 0,
      publishSeries: false,
    })).toBe('none');
  });

  it('deletes the media item when all published lists are being removed and no series remains', () => {
    expect(getSubsplashUnpublishStrategy({
      hasSubsplashId: true,
      publishedListCount: 3,
      listCountToUnpublish: 3,
      seriesPublished: false,
      unpublishSeries: false,
      publishListCount: 0,
      publishSeries: false,
    })).toBe('delete_media');
  });

  it('deletes the media item when only a published series membership remains and it is being unpublished', () => {
    expect(getSubsplashUnpublishStrategy({
      hasSubsplashId: true,
      publishedListCount: 0,
      listCountToUnpublish: 0,
      seriesPublished: true,
      unpublishSeries: true,
      publishListCount: 0,
      publishSeries: false,
    })).toBe('delete_media');
  });

  it('removes memberships when some published lists will still remain', () => {
    expect(getSubsplashUnpublishStrategy({
      hasSubsplashId: true,
      publishedListCount: 3,
      listCountToUnpublish: 2,
      seriesPublished: false,
      unpublishSeries: false,
      publishListCount: 0,
      publishSeries: false,
    })).toBe('remove_memberships');
  });

  it('removes memberships when a published series will still remain', () => {
    expect(getSubsplashUnpublishStrategy({
      hasSubsplashId: true,
      publishedListCount: 1,
      listCountToUnpublish: 1,
      seriesPublished: true,
      unpublishSeries: false,
      publishListCount: 0,
      publishSeries: false,
    })).toBe('remove_memberships');
  });

  it('removes memberships when the same operation is also publishing to new subsplash destinations', () => {
    expect(getSubsplashUnpublishStrategy({
      hasSubsplashId: true,
      publishedListCount: 1,
      listCountToUnpublish: 1,
      seriesPublished: false,
      unpublishSeries: false,
      publishListCount: 1,
      publishSeries: false,
    })).toBe('remove_memberships');
  });

  it('removes memberships when the same operation is publishing into a series', () => {
    expect(getSubsplashUnpublishStrategy({
      hasSubsplashId: true,
      publishedListCount: 1,
      listCountToUnpublish: 1,
      seriesPublished: false,
      unpublishSeries: false,
      publishListCount: 0,
      publishSeries: true,
    })).toBe('remove_memberships');
  });
});
