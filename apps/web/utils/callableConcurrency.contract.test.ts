import fs from 'fs';
import path from 'path';

const readFile = (relativePath: string): string => {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
};

describe('caller lock/idempotency contract adoption', () => {
  it('wires operation keys + lock busy parsing in admin publishing surfaces', () => {
    const managePublishingPopup = readFile('components/ManagePublishingPopup.tsx');
    const sermonPublishPanel = readFile('components/SermonPublishPanel.tsx');
    const seriesAdminPage = readFile('pages/admin/series/[seriesId].tsx');
    const sermonAdminPage = readFile('pages/admin/sermons/[sermonId].tsx');
    const seriesListAdminPage = readFile('pages/admin/series.tsx');
    const sermonsListAdminPage = readFile('pages/admin/sermons.tsx');

    expect(managePublishingPopup).toContain('SermonPublishPanel');
    expect(sermonPublishPanel).toContain("createSubsplashUploadIntentKey(");
    expect(sermonPublishPanel).toContain("createSubsplashListCreateIntentKey('manage-publishing-list-create', sermon.id, canonicalList.id)");
    expect(sermonPublishPanel).toContain("createSubsplashListAddIntentKey(");
    expect(sermonPublishPanel).toContain("createSubsplashListRemoveIntentKey(");
    expect(sermonPublishPanel).toContain("createSubsplashDeleteIntentKey('manage-publishing-delete', sermon.id)");
    expect(sermonPublishPanel).toContain("createSubsplashSeriesCreateIntentKey('manage-publishing-series-create', series.id)");
    expect(sermonPublishPanel).toContain("createSubsplashSeriesPublishIntentKey(");
    expect(sermonPublishPanel).toContain("createSubsplashSeriesReorderIntentKey(");
    expect(sermonPublishPanel).toContain("createSubsplashSeriesRollbackIntentKey(");
    expect(sermonPublishPanel).toContain("createSubsplashSeriesUnpublishIntentKey(");
    expect(sermonPublishPanel).toContain('parseLockBusyDetails(');

    expect(seriesAdminPage).toContain("createOperationKey('series-admin-upload', sermon.id)");
    expect(seriesAdminPage).toContain("createOperationKey('series-admin-unpublish-item', seriesItem.id)");
    expect(seriesAdminPage).toContain("createOperationKey('series-admin-reorder', seriesId)");
    expect(seriesAdminPage).toContain("createRetryIntentKey('series-admin-bulk-add', seriesId, intentFingerprint)");
    expect(seriesAdminPage).toContain('expectedPublishedMembershipHash');
    expect(seriesAdminPage).toContain('parseLockBusyDetails(');

    expect(sermonAdminPage).toContain('SermonPublishPanel');

    expect(seriesListAdminPage).toContain("createOperationKey('series-admin-delete', selectedSeries.id)");
    expect(seriesListAdminPage).toContain('parseLockBusyDetails(');
    expect(seriesListAdminPage).toContain('formatLockBusyRetryMessage(');

    expect(sermonsListAdminPage).toContain('parseLockBusyDetails(');
    expect(sermonsListAdminPage).toContain('formatLockBusyRetryMessage(');
  });

  it('propagates operation keys from API-layer mutation helpers', () => {
    const uploadFileApi = readFile('pages/api/uploadFile.tsx');
    const editSermonApi = readFile('pages/api/editSermon.ts');

    expect(uploadFileApi).toContain("createOperationKey('upload-file-add-intro-outro', props.sermon.id)");
    expect(editSermonApi).toContain("createOperationKey('edit-sermon-subsplash-edit', sermon.id)");
    expect(editSermonApi).toContain('parseLockBusyDetails(');
  });
});
